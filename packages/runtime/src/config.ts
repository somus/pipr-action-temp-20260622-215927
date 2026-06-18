import { access, lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { resolveContainedConfigDir } from "./project-paths.js";
import {
  assertNoRawSecrets,
  type PiprComponent,
  type PiprComponentKind,
  type PiprV1Config,
  validateComponentDocument,
  validateMaterializedProject,
  validatePiprConfigDocument,
} from "./schema.js";

const componentDirectories = [
  { name: "workflows", extensions: [".yaml", ".yml"], kind: "Workflow" },
  { name: "blocks", extensions: [".yaml", ".yml"], kind: "Block" },
  { name: "agents", extensions: [".md"], kind: "Agent" },
  { name: "comments", extensions: [".yaml", ".yml"], kind: "CommentTemplate" },
  { name: "schemas", extensions: [".json"], kind: "Schema" },
] as const;

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
  const { configDir, projectDir } = resolveContainedConfigDir(options);
  const configPath = path.join(projectDir, "config.yaml");

  if (await fileExists(projectDir)) {
    await assertNotSymlink(projectDir);
  }
  if (!(await fileExists(configPath))) {
    throw new Error(`${configDir}/config.yaml is required. Run pipr init to create it.`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
