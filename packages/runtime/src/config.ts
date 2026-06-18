import { access, lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  assertNoRawSecrets,
  type PiprComponent,
  type PiprComponentKind,
  type PiprV1Config,
  validateComponentDocument,
  validateMaterializedProject,
  validatePiprConfigDocument,
} from "./schema.js";
import type {
  BlockRegistryEntry,
  PiprConfig,
  RegistryCollectionName,
  RegistryEntry,
  ResolvedConfig,
  RuntimeModuleSet,
  SourceMap,
  WorkflowRegistryEntry,
} from "./types.js";

const providerSchema = z
  .object({
    id: z.string().min(1),
    model: z.string().min(1),
    api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    thinking: z.enum(["enabled", "disabled"]).optional(),
    reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
  })
  .passthrough();

const configSchema = z.object({
  version: z.literal(1),
  extends: z.array(z.string()).default(["builtin:minimal"]),
  default_provider: z.string().min(1),
  providers: z.array(providerSchema).min(1),
  review: z.object({
    max_inline_comments: z.number().int().min(0).max(50),
    min_confidence: z.number().min(0).max(1),
  }),
});

const workflowStepSchema = z.object({
  block: z.string().min(1),
  with: z.unknown().optional(),
  output: z.string().min(1).optional(),
});

const registryEntrySchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
});

const workflowEntrySchema = registryEntrySchema.extend({
  events: z.array(z.string().min(1)).default([]),
  steps: z.array(workflowStepSchema).default([]),
});

const blockEntrySchema = registryEntrySchema.extend({
  steps: z.array(workflowStepSchema).optional(),
});

const registryModulesSchema = z
  .object({
    presets: z.array(registryEntrySchema).default([]),
    workflows: z.array(workflowEntrySchema).default([]),
    blocks: z.array(blockEntrySchema).default([]),
    agents: z.array(registryEntrySchema).default([]),
    schemas: z.array(registryEntrySchema).default([]),
    comments: z.array(registryEntrySchema).default([]),
    tools: z.array(registryEntrySchema).default([]),
  })
  .partial();

const rawSecretPattern = /(sk-|api[_-]?key|secret|token)[a-z0-9_-]{8,}/i;
const componentDirectories = [
  { name: "workflows", extensions: [".yaml", ".yml"], kind: "Workflow" },
  { name: "blocks", extensions: [".yaml", ".yml"], kind: "Block" },
  { name: "agents", extensions: [".md"], kind: "Agent" },
  { name: "comments", extensions: [".yaml", ".yml"], kind: "CommentTemplate" },
  { name: "commands", extensions: [".yaml", ".yml"], kind: "CommandSet" },
  { name: "schemas", extensions: [".json"], kind: "Schema" },
] as const;

export const builtinMinimalConfig: PiprConfig = {
  version: 1,
  extends: ["builtin:minimal"],
  default_provider: "deepseek",
  providers: [
    {
      id: "deepseek",
      model: "deepseek-v4-pro",
      thinking: "enabled",
      reasoning_effort: "high",
      api_key_env: "DEEPSEEK_API_KEY",
    },
  ],
  review: {
    max_inline_comments: 5,
    min_confidence: 0.75,
  },
};

export type LoadConfigOptions = {
  rootDir: string;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  requireProviderEnv?: boolean;
};

export type LoadMaterializedProjectOptions = {
  rootDir: string;
  configDir?: string;
};

export type LoadedMaterializedComponent = {
  id: string;
  kind: PiprComponent["kind"];
  document: PiprComponent;
  source: string;
  body?: string;
};

export type MaterializedProjectSources = {
  config: string;
  components: Record<string, string>;
};

export type MaterializedProject = {
  config: PiprV1Config;
  components: PiprComponent[];
  componentFiles: Record<string, LoadedMaterializedComponent>;
  sources: MaterializedProjectSources;
};

export async function loadMaterializedProject(
  options: LoadMaterializedProjectOptions,
): Promise<MaterializedProject> {
  const configDir = options.configDir ?? ".pipr";
  const projectDir = path.join(options.rootDir, configDir);
  const configPath = path.join(projectDir, "config.yaml");

  if (await fileExists(projectDir)) {
    await assertNotSymlink(projectDir);
  }
  if (!(await fileExists(configPath))) {
    throw new Error(`${configDir}/config.yaml is required`);
  }
  await assertNotSymlink(configPath);

  const config = validatePiprConfigDocument(configPath, await readYamlObject(configPath));
  const componentFiles = await loadMaterializedComponents(projectDir);
  const components = componentFiles.map((componentFile) => componentFile.document);
  validateMaterializedProject({ config, components });

  return {
    config,
    components,
    componentFiles: Object.fromEntries(
      componentFiles.map((componentFile) => [componentFile.id, componentFile]),
    ),
    sources: {
      config: configPath,
      components: Object.fromEntries(
        componentFiles.map((componentFile) => [componentFile.id, componentFile.source]),
      ),
    },
  };
}

async function loadMaterializedComponents(
  projectDir: string,
): Promise<LoadedMaterializedComponent[]> {
  const components: LoadedMaterializedComponent[] = [];
  for (const directory of componentDirectories) {
    components.push(...(await loadMaterializedDirectory(projectDir, directory)));
  }
  return components;
}

async function loadMaterializedDirectory(
  projectDir: string,
  directory: (typeof componentDirectories)[number],
): Promise<LoadedMaterializedComponent[]> {
  const directoryPath = path.join(projectDir, directory.name);
  if (!(await fileExists(directoryPath))) {
    return [];
  }
  await assertNotSymlink(directoryPath);

  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() && hasExtension(entry.name, directory.extensions)) {
      throw new Error(`${path.join(directoryPath, entry.name)}: symbolic links are not supported`);
    }
  }
  const files = entries
    .filter((entry) => entry.isFile() && hasExtension(entry.name, directory.extensions))
    .sort((left, right) => left.name.localeCompare(right.name));

  const components: LoadedMaterializedComponent[] = [];
  for (const file of files) {
    const source = path.join(directoryPath, file.name);
    await assertNotSymlink(source);
    components.push(await loadMaterializedComponent(source, directory));
  }
  return components;
}

async function loadMaterializedComponent(
  source: string,
  directory: (typeof componentDirectories)[number],
): Promise<LoadedMaterializedComponent> {
  if (directory.name === "agents") {
    return loadAgentMarkdownComponent(source, directory.kind);
  }

  const document =
    directory.name === "schemas"
      ? validateComponentDocument(source, await readJsonObject(source))
      : validateComponentDocument(source, await readYamlObject(source));

  assertMaterializedDirectoryKind(source, document, directory.kind);
  return {
    id: document.id,
    kind: document.kind,
    document,
    source,
  };
}

async function loadAgentMarkdownComponent(
  source: string,
  expectedKind: PiprComponentKind,
): Promise<LoadedMaterializedComponent> {
  const { frontmatter, body } = parseMarkdownFrontmatter(source, await readFile(source, "utf8"));
  assertNoRawSecrets(source, body);
  const document = validateComponentDocument(source, frontmatter);
  assertMaterializedDirectoryKind(source, document, expectedKind);
  return {
    id: document.id,
    kind: document.kind,
    document,
    source,
    body,
  };
}

function assertMaterializedDirectoryKind(
  source: string,
  document: PiprComponent,
  expectedKind: PiprComponentKind,
): void {
  if (document.kind !== expectedKind) {
    throw new Error(`${source}: expected ${expectedKind}, got ${document.kind}`);
  }
}

export async function loadConfig(options: LoadConfigOptions): Promise<ResolvedConfig> {
  const configDir = options.configDir ?? ".pipr";
  const configPath = path.join(options.rootDir, configDir, "config.yaml");
  const registryPath = path.join(options.rootDir, configDir, "registry.yaml");
  const exists = await fileExists(configPath);
  const modules = await loadRegistryModules(registryPath);

  if (!exists) {
    return validateResolvedConfig(
      {
        config: builtinMinimalConfig,
        source: "builtin:minimal",
        sources: defaultSources("builtin:minimal", modules.sources),
        modules: modules.modules,
        warnings: [`${configDir}/config.yaml not found; using builtin:minimal`],
      },
      options,
    );
  }

  const raw = await readFile(configPath, "utf8");
  const parsed = parseYamlObject<Partial<PiprConfig>>(configPath, raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${configPath}: expected a YAML object`);
  }

  const extendsBuiltin = parsed.extends?.includes("builtin:minimal") ?? true;
  const base = extendsBuiltin ? builtinMinimalConfig : emptyConfig();
  for (const preset of parsed.extends ?? []) {
    if (preset !== "builtin:minimal") {
      throw new Error(`${configPath}: unknown preset '${preset}'`);
    }
  }

  const merged: PiprConfig = {
    ...base,
    ...parsed,
    version: parsed.version ?? base.version,
    extends: parsed.extends ?? base.extends,
    default_provider: parsed.default_provider ?? base.default_provider,
    providers: parsed.providers ?? base.providers,
    review: {
      ...base.review,
      ...(parsed.review ?? {}),
    },
  };

  return validateResolvedConfig(
    {
      config: merged,
      source: configPath,
      sources: configSources(configPath, parsed, modules.sources, extendsBuiltin),
      modules: modules.modules,
      warnings: [],
    },
    options,
  );
}

export function validateResolvedConfig(
  resolved: ResolvedConfig,
  options: Pick<LoadConfigOptions, "env" | "requireProviderEnv"> = {},
): ResolvedConfig {
  const secretPath = findRawSecretPath(resolved.config);
  if (secretPath) {
    throw new Error(`Raw secret-looking value found at ${secretPath}; use api_key_env instead`);
  }

  const parsed = configSchema.parse(resolved.config) as PiprConfig;
  const providerIds = new Set<string>();
  for (const provider of parsed.providers) {
    if (providerIds.has(provider.id)) {
      throw new Error(`Duplicate provider id '${provider.id}'`);
    }
    providerIds.add(provider.id);
  }

  if (!providerIds.has(parsed.default_provider)) {
    throw new Error(`default_provider '${parsed.default_provider}' does not match any provider id`);
  }

  if (options.requireProviderEnv) {
    const env = options.env ?? process.env;
    const missing = parsed.providers.filter((provider) => !env[provider.api_key_env]);
    if (missing.length > 0) {
      throw new Error(
        `Missing provider env vars: ${missing.map((provider) => provider.api_key_env).join(", ")}`,
      );
    }
  }

  return { ...resolved, config: parsed };
}

function emptyConfig(): PiprConfig {
  return {
    version: 1,
    extends: [],
    default_provider: "",
    providers: [],
    review: {
      max_inline_comments: 5,
      min_confidence: 0.75,
    },
  };
}

function defaultSources(
  source: "builtin:minimal" | "runtime:defaults",
  moduleSources: SourceMap["modules"] = {},
): SourceMap {
  return {
    config: source,
    fields: {
      version: `${source}#version`,
      extends: `${source}#extends`,
      default_provider: `${source}#default_provider`,
      providers: `${source}#providers`,
      review: `${source}#review`,
    },
    modules: moduleSources,
  };
}

function configSources(
  configPath: string,
  parsed: Partial<PiprConfig>,
  moduleSources: SourceMap["modules"],
  extendsBuiltin: boolean,
): SourceMap {
  const sources = defaultSources(
    extendsBuiltin ? "builtin:minimal" : "runtime:defaults",
    moduleSources,
  );
  sources.config = configPath;
  for (const field of ["version", "extends", "default_provider", "providers", "review"] as const) {
    if (field in parsed) {
      sources.fields[field] = `${configPath}#${field}`;
    }
  }
  return sources;
}

type LoadedRegistryModules = {
  modules: RuntimeModuleSet;
  sources: SourceMap["modules"];
};

async function loadRegistryModules(registryPath: string): Promise<LoadedRegistryModules> {
  if (!(await fileExists(registryPath))) {
    return { modules: {}, sources: {} };
  }

  const raw = await readFile(registryPath, "utf8");
  const parsed = parseYamlObject<RuntimeModuleSet>(registryPath, raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${registryPath}: expected a YAML object`);
  }

  const parsedModules = registryModulesSchema.parse(parsed) as RuntimeModuleSet;
  const sources: SourceMap["modules"] = {};
  const modules: RuntimeModuleSet = {
    presets: sourceEntries("presets", parsedModules.presets, registryPath, sources),
    workflows: sourceEntries("workflows", parsedModules.workflows, registryPath, sources),
    blocks: sourceEntries("blocks", parsedModules.blocks, registryPath, sources),
    agents: sourceEntries("agents", parsedModules.agents, registryPath, sources),
    schemas: sourceEntries("schemas", parsedModules.schemas, registryPath, sources),
    comments: sourceEntries("comments", parsedModules.comments, registryPath, sources),
    tools: sourceEntries("tools", parsedModules.tools, registryPath, sources),
  };
  return { modules, sources };
}

function sourceEntries<T extends RegistryEntry>(
  collection: RegistryCollectionName,
  entries: T[] | undefined,
  registryPath: string,
  sources: SourceMap["modules"],
): T[] | undefined {
  if (!entries) {
    return undefined;
  }
  sources[collection] = {};
  return entries.map((entry) => withSource(collection, entry, registryPath, sources));
}

function withSource<T extends RegistryEntry | WorkflowRegistryEntry | BlockRegistryEntry>(
  collection: RegistryCollectionName,
  entry: T,
  registryPath: string,
  sources: SourceMap["modules"],
): T {
  const sourceLocation = `${registryPath}#${collection}.${entry.id}`;
  sources[collection] = {
    ...(sources[collection] ?? {}),
    [entry.id]: sourceLocation,
  };
  return { ...entry, source: registryPath, sourceLocation };
}

function parseYamlObject<T>(filePath: string, raw: string): T | null {
  try {
    return parse(raw) as T | null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${filePath}: ${message}`);
  }
}

async function readYamlObject(filePath: string): Promise<Record<string, unknown>> {
  const parsed = parseYamlObject<unknown>(filePath, await readFile(filePath, "utf8"));
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new Error(`${filePath}: expected a YAML object`);
  }
  return parsed;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${filePath}: ${message}`);
  }

  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new Error(`${filePath}: expected a JSON object`);
  }
  return parsed;
}

function parseMarkdownFrontmatter(
  filePath: string,
  raw: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") {
    throw new Error(`${filePath}: expected YAML frontmatter`);
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (endIndex === -1) {
    throw new Error(`${filePath}: expected closing YAML frontmatter delimiter`);
  }

  const frontmatter = parseYamlObject<unknown>(filePath, lines.slice(1, endIndex).join("\n"));
  if (!isRecord(frontmatter) || Array.isArray(frontmatter)) {
    throw new Error(`${filePath}: expected YAML frontmatter object`);
  }

  return { frontmatter, body: lines.slice(endIndex + 1).join("\n") };
}

function hasExtension(fileName: string, extensions: readonly string[]): boolean {
  return extensions.includes(path.extname(fileName));
}

async function assertNotSymlink(filePath: string): Promise<void> {
  if ((await lstat(filePath)).isSymbolicLink()) {
    throw new Error(`${filePath}: symbolic links are not supported`);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function findRawSecretPath(value: unknown, pathParts: string[] = []): string | undefined {
  if (typeof value === "string") {
    return findRawSecretStringPath(value, pathParts);
  }

  if (Array.isArray(value)) {
    return findRawSecretInEntries(value.entries(), pathParts);
  }

  if (isRecord(value)) {
    return findRawSecretInEntries(Object.entries(value), pathParts);
  }

  return undefined;
}

function findRawSecretStringPath(value: string, pathParts: string[]): string | undefined {
  if (isSecretEnvPath(pathParts)) {
    return undefined;
  }
  return rawSecretPattern.test(value) ? pathParts.join(".") : undefined;
}

function findRawSecretInEntries(
  entries: Iterable<[string | number, unknown]>,
  pathParts: string[],
): string | undefined {
  for (const [key, item] of entries) {
    const found = findRawSecretPath(item, [...pathParts, String(key)]);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function isSecretEnvPath(pathParts: string[]): boolean {
  const key = pathParts.at(-1) ?? "";
  return key.endsWith("_env") || key === "api_key_env";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
