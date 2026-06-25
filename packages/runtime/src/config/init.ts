import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPathContained, resolveContainedConfigDir } from "./paths.js";
import { loadRuntimeProject } from "./project.js";
import { officialInitRecipeConfigTs } from "./recipes.js";
import { embeddedSdkAssets } from "./sdk-assets.js";
import {
  embeddedSdkDeclaration,
  readSdkDeclarationSourceWithChunk,
  type SdkDeclarationModule,
} from "./sdk-declaration.js";

export type InitOfficialMinimalProjectOptions = {
  rootDir: string;
  configDir?: string;
  force?: boolean;
  adapters?: readonly string[];
  recipe?: string;
};

export type InitOfficialMinimalProjectResult = {
  configDir: string;
  created: string[];
  overwritten: string[];
};

export const supportedOfficialInitAdapters = ["github"] as const;

export type OfficialInitAdapter = (typeof supportedOfficialInitAdapters)[number];

type StarterFile = {
  relativePath: string;
  contents: string;
};

export function listOfficialMinimalFiles(adapters?: readonly string[]): string[] {
  return officialMinimalFilePaths(resolveOfficialInitAdapters(adapters));
}

function resolveOfficialInitAdapters(adapters?: readonly string[]): OfficialInitAdapter[] {
  if (adapters === undefined) {
    return [...supportedOfficialInitAdapters];
  }
  if (adapters.length === 0) {
    return [];
  }
  const selected = new Set<OfficialInitAdapter>();
  for (const adapter of adapters) {
    if (adapter === "") {
      throw unsupportedAdapterError(adapter);
    }
    if (adapter === "none") {
      if (adapters.length > 1) {
        throw new Error("Adapter 'none' cannot be mixed with other init adapters.");
      }
      return [];
    }
    if (adapter !== "github") {
      throw unsupportedAdapterError(adapter);
    }
    selected.add(adapter);
  }
  return [...selected];
}

function officialMinimalFilePaths(adapters: readonly OfficialInitAdapter[]): string[] {
  const files = [
    path.join(".pipr", "config.ts"),
    path.join(".pipr", "tsconfig.json"),
    path.join(".pipr", "types", "pipr-sdk.d.ts"),
  ];
  if (adapters.includes("github")) {
    files.push(path.join(".github", "workflows", "pipr.yml"));
  }
  return files;
}

function unsupportedAdapterError(adapter: string): Error {
  return new Error(
    `Unsupported pipr init adapter '${adapter}'. Supported adapters: ` +
      `${supportedOfficialInitAdapters.join(", ")}; use 'none' to skip adapter files.`,
  );
}

export async function initOfficialMinimalProject(
  options: InitOfficialMinimalProjectOptions,
): Promise<InitOfficialMinimalProjectResult> {
  const { configDir, relativeConfigDir } = resolveContainedConfigDir(options);
  const adapters = resolveOfficialInitAdapters(options.adapters);
  const rootDir = path.resolve(options.rootDir);
  const targets = (await starterFiles(relativeConfigDir, adapters, options.recipe)).map((file) => ({
    ...file,
    absolutePath: path.join(rootDir, file.relativePath),
  }));
  await assertSafeTargetAncestors(targets, rootDir);
  const existing = await findExistingTargets(targets);
  if (existing.length > 0 && !options.force) {
    throw new Error(
      `Project already contains pipr files: ${existing.join(", ")}. ` +
        "Use --force to replace existing .pipr files.",
    );
  }

  const created: string[] = [];
  const overwritten: string[] = [];
  for (const target of targets) {
    await mkdir(path.dirname(target.absolutePath), { recursive: true });
    const existed = existing.includes(target.relativePath);
    await Bun.write(target.absolutePath, target.contents);
    if (existed) {
      overwritten.push(target.relativePath);
    } else {
      created.push(target.relativePath);
    }
  }

  await loadRuntimeProject({ rootDir: options.rootDir, configDir });
  return { configDir, created, overwritten };
}

async function starterFiles(
  relativeConfigDir: string,
  adapters: readonly OfficialInitAdapter[],
  recipe?: string,
): Promise<StarterFile[]> {
  const files = [
    {
      relativePath: path.join(relativeConfigDir, "config.ts"),
      contents: officialInitRecipeConfigTs(recipe),
    },
    { relativePath: path.join(relativeConfigDir, "tsconfig.json"), contents: starterTsconfig },
    {
      relativePath: path.join(relativeConfigDir, "types", "pipr-sdk.d.ts"),
      contents: await sdkDeclaration(),
    },
  ];
  if (adapters.includes("github")) {
    files.push({
      relativePath: path.join(".github", "workflows", "pipr.yml"),
      contents: starterWorkflow(relativeConfigDir.split(path.sep).join("/")),
    });
  }
  return files;
}

async function assertSafeTargetAncestors(
  targets: Array<StarterFile & { absolutePath: string }>,
  projectDir: string,
): Promise<void> {
  for (const target of targets) {
    await assertNoSymlinkAncestors(target.absolutePath, projectDir);
  }
}

async function assertNoSymlinkAncestors(filePath: string, projectDir: string): Promise<void> {
  const root = path.resolve(projectDir);
  let current = path.resolve(path.dirname(filePath));
  const ancestors: string[] = [];

  while (isPathContained(current, root)) {
    ancestors.push(current);
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }

  for (const ancestor of ancestors.reverse()) {
    const stats = await maybeLstat(ancestor);
    if (!stats) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${ancestor}: symbolic links are not supported`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`${ancestor}: expected a directory path`);
    }
  }
}

async function findExistingTargets(
  targets: Array<StarterFile & { absolutePath: string }>,
): Promise<string[]> {
  const existing: string[] = [];
  for (const target of targets) {
    const stats = await maybeLstat(target.absolutePath);
    if (!stats) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${target.absolutePath}: symbolic links are not supported`);
    }
    if (!stats.isFile()) {
      throw new Error(`${target.absolutePath}: expected a file path`);
    }
    existing.push(target.relativePath);
  }
  return existing;
}

async function maybeLstat(
  filePath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(filePath);
  } catch {
    return undefined;
  }
}

async function sdkDeclaration(): Promise<string> {
  const embedded = embeddedSdkAssets().declaration;
  if (embedded?.includes('declare module "@pipr/sdk"')) {
    assertStandaloneSdkDeclaration(embedded);
    return embedded;
  }
  const declaration = embeddedSdkDeclaration(await rawSdkDeclarations());
  assertStandaloneSdkDeclaration(declaration);
  return declaration;
}

function assertStandaloneSdkDeclaration(declaration: string): void {
  if (declaration.includes('from "zod"') || declaration.includes("z.ZodType")) {
    throw new Error("generated SDK declaration must be standalone and must not import zod");
  }
}

type SdkDeclarationAsset = {
  moduleName: string;
  fileName: string;
};

const sdkDeclarationModules: SdkDeclarationAsset[] = [
  { moduleName: "@pipr/sdk", fileName: "index.d.mts" },
  { moduleName: "@pipr/sdk/review", fileName: "review.d.mts" },
  { moduleName: "@pipr/sdk/tools", fileName: "tools.d.mts" },
];

async function rawSdkDeclarations(): Promise<SdkDeclarationModule[]> {
  const declarations = await Promise.all(
    sdkDeclarationModules.map(async (module) => {
      const declarationPath = await sdkDeclarationPath(module.fileName);
      return declarationPath
        ? { ...module, source: await readSdkDeclarationSourceWithChunk(module, declarationPath) }
        : undefined;
    }),
  );
  if (declarations.every((declaration) => declaration !== undefined)) {
    return declarations;
  }
  const embedded = embeddedSdkAssets().declaration;
  if (embedded) {
    return [{ moduleName: sdkDeclarationModules[0].moduleName, source: embedded }];
  }
  throw new Error("Unable to locate @pipr/sdk declaration file. Build @pipr/sdk before pipr init.");
}

async function sdkDeclarationPath(fileName: string): Promise<string | undefined> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../sdk/dist", fileName),
    path.resolve(moduleDir, "../../../sdk/dist", fileName),
  ];
  for (const candidate of candidates) {
    const stats = await maybeLstat(candidate);
    if (stats?.isFile()) {
      return candidate;
    }
  }
  return undefined;
}

const starterTsconfig = `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler"
  },
  "include": ["./**/*.ts"]
}
`;

function starterWorkflow(relativeConfigDir: string): string {
  const lines = [
    "name: pipr",
    "",
    "on:",
    "  pull_request:",
    "  issue_comment:",
    "    types: [created]",
    "  pull_request_review_comment:",
    "    types: [created]",
    "",
    "permissions:",
    "  contents: write",
    "  pull-requests: write",
    "  issues: write",
    "  checks: write",
    "",
    "jobs:",
    "  review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v6",
    "        with:",
    "          fetch-depth: 0",
    "      - uses: somus/pipr@main",
    "        env:",
    `          DEEPSEEK_API_KEY: $${["{{ ", "secrets.DEEPSEEK_API_KEY", " }}"].join("")}`,
    `          GITHUB_TOKEN: $${["{{ ", "github.token", " }}"].join("")}`,
  ];
  if (relativeConfigDir !== ".pipr") {
    lines.push("        with:");
    lines.push(`          config-dir: ${relativeConfigDir}`);
  }
  lines.push("");
  return lines.join("\n");
}
