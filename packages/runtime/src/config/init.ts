import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPathContained, resolveContainedConfigDir } from "./paths.js";
import { loadRuntimeProject } from "./project.js";
import { embeddedSdkAssets } from "./sdk-assets.js";

export type InitOfficialMinimalProjectOptions = {
  rootDir: string;
  configDir?: string;
  force?: boolean;
};

export type InitOfficialMinimalProjectResult = {
  configDir: string;
  created: string[];
  overwritten: string[];
};

type StarterFile = {
  relativePath: string;
  contents: string;
};

export function listOfficialMinimalFiles(): string[] {
  return [
    path.join(".pipr", "config.ts"),
    path.join(".pipr", "tsconfig.json"),
    path.join(".pipr", "types", "pipr-sdk.d.ts"),
    path.join(".github", "workflows", "pipr.yml"),
  ];
}

export async function initOfficialMinimalProject(
  options: InitOfficialMinimalProjectOptions,
): Promise<InitOfficialMinimalProjectResult> {
  const { configDir, relativeConfigDir } = resolveContainedConfigDir(options);
  const rootDir = path.resolve(options.rootDir);
  const targets = (await starterFiles(relativeConfigDir)).map((file) => ({
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

async function starterFiles(relativeConfigDir: string): Promise<StarterFile[]> {
  return [
    { relativePath: path.join(relativeConfigDir, "config.ts"), contents: starterConfigTs },
    { relativePath: path.join(relativeConfigDir, "tsconfig.json"), contents: starterTsconfig },
    {
      relativePath: path.join(relativeConfigDir, "types", "pipr-sdk.d.ts"),
      contents: await sdkDeclaration(),
    },
    {
      relativePath: path.join(".github", "workflows", "pipr.yml"),
      contents: starterWorkflow(relativeConfigDir.split(path.sep).join("/")),
    },
  ];
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
  const declarations = await rawSdkDeclarations();
  const declaration = [
    "// biome-ignore-all format: generated from @pipr/sdk declarations",
    "// biome-ignore-all assist/source/organizeImports: generated from @pipr/sdk declarations",
    ...declarations.map((declaration) => declarationModuleBlock(declaration)),
    "",
  ].join("\n");
  assertStandaloneSdkDeclaration(declaration);
  return declaration;
}

function assertStandaloneSdkDeclaration(declaration: string): void {
  if (declaration.includes('from "zod"') || declaration.includes("z.ZodType")) {
    throw new Error("generated SDK declaration must be standalone and must not import zod");
  }
}

type SdkDeclarationModule = {
  moduleName: string;
  fileName: string;
};

const sdkDeclarationModules: SdkDeclarationModule[] = [
  { moduleName: "@pipr/sdk", fileName: "index.d.mts" },
  { moduleName: "@pipr/sdk/review", fileName: "review.d.mts" },
  { moduleName: "@pipr/sdk/tools", fileName: "tools.d.mts" },
];

async function rawSdkDeclarations(): Promise<Array<SdkDeclarationModule & { source: string }>> {
  const declarations = await Promise.all(
    sdkDeclarationModules.map(async (module) => {
      const declarationPath = await sdkDeclarationPath(module.fileName);
      return declarationPath
        ? { ...module, source: await Bun.file(declarationPath).text() }
        : undefined;
    }),
  );
  if (declarations.every((declaration) => declaration !== undefined)) {
    return declarations as Array<SdkDeclarationModule & { source: string }>;
  }
  const embedded = embeddedSdkAssets().declaration;
  if (embedded) {
    return [
      { ...sdkDeclarationModules[0], source: embedded } as SdkDeclarationModule & {
        source: string;
      },
    ];
  }
  throw new Error("Unable to locate @pipr/sdk declaration file. Build @pipr/sdk before pipr init.");
}

function declarationModuleBlock(module: SdkDeclarationModule & { source: string }): string {
  return [`declare module "${module.moduleName}" {`, declarationSource(module).trim(), "}"].join(
    "\n",
  );
}

function declarationSource(module: SdkDeclarationModule & { source: string }): string {
  const source = module.source
    .replace(/^declare /gm, "")
    .replace(/^import \{ z \} from "zod";$/gm, zodShimDeclaration())
    .replaceAll("z.ZodType", "ZodType")
    .replaceAll('from "./index.js"', 'from "@pipr/sdk"')
    .replaceAll('from "./index.mjs"', 'from "@pipr/sdk"')
    .replace(/^import .* from "@pipr\/sdk";$/gm, "")
    .replace(/^\/\/# sourceMappingURL=.*$/gm, "");
  return module.moduleName === "@pipr/sdk"
    ? source
    : source.replace(/^export \{(?<exports>.*)\};$/gm, 'export {$<exports>} from "@pipr/sdk";');
}

function zodShimDeclaration(): string {
  return [
    "type ZodInfer<T> = T extends { parse(value: unknown): infer Output } ? Output : never;",
    "type ZodType<T = unknown, Optional extends boolean = false> = {",
    "  readonly _piprOptional: Optional;",
    "  parse(value: unknown): T;",
    "  optional(): ZodType<T | undefined, true>;",
    "  min(value: number): ZodType<T, Optional>;",
    "  max(value: number): ZodType<T, Optional>;",
    "  int(): ZodType<T, Optional>;",
    "  positive(): ZodType<T, Optional>;",
    "  finite(): ZodType<T, Optional>;",
    "};",
    "type ZodAny = ZodType<unknown, boolean>;",
    "type ZodOptionalKeys<T extends Record<string, ZodAny>> = { [K in keyof T]: T[K] extends ZodType<unknown, true> ? K : never }[keyof T];",
    "type ZodObjectOutput<T extends Record<string, ZodAny>> = { [K in Exclude<keyof T, ZodOptionalKeys<T>>]: ZodInfer<T[K]> } & { [K in ZodOptionalKeys<T>]?: ZodInfer<T[K]> };",
    "const z: {",
    "  string(): ZodType<string>;",
    "  number(): ZodType<number>;",
    "  boolean(): ZodType<boolean>;",
    "  null(): ZodType<null>;",
    "  unknown(): ZodType<unknown>;",
    "  any(): ZodType<unknown>;",
    "  literal<T extends string | number | boolean | null>(value: T): ZodType<T>;",
    "  enum<const T extends readonly [string, ...string[]]>(values: T): ZodType<T[number]>;",
    "  array<T extends ZodAny>(schema: T): ZodType<Array<ZodInfer<T>>>;",
    "  record<T extends ZodAny>(key: ZodType<string>, value: T): ZodType<Record<string, ZodInfer<T>>>;",
    "  strictObject<T extends Record<string, ZodAny>>(shape: T): ZodType<ZodObjectOutput<T>>;",
    "  object<T extends Record<string, ZodAny>>(shape: T): ZodType<ZodObjectOutput<T>>;",
    "  looseObject<T extends Record<string, ZodAny>>(shape: T): ZodType<ZodObjectOutput<T> & Record<string, unknown>>;",
    "  union<const T extends readonly [ZodAny, ZodAny, ...ZodAny[]]>(schemas: T): ZodType<ZodInfer<T[number]>>;",
    "  json(): ZodType<JsonValue>;",
    "  fromJSONSchema(schema: JsonSchema): ZodType<unknown>;",
    "  toJSONSchema(schema: ZodAny): JsonSchema;",
    "};",
  ].join("\n");
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

const starterConfigTs = `import { definePipr } from "@pipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", {
    name: "deepseek",
    apiKey: pipr.secret("DEEPSEEK_API_KEY"),
    options: { thinking: "high" },
  });

  pipr.review({
    model,
    instructions: \`
      Review the pull request diff for correctness, security,
      maintainability, and test coverage.
      Return only actionable findings that target valid diff ranges.
    \`,
    inlineComments: { max: 5 },
    timeout: "5m",
  });
});
`;

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
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "  issues: write",
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
    "        with:",
    "          provider: deepseek",
    "          model: deepseek-v4-pro",
    "          api-key-env: DEEPSEEK_API_KEY",
  ];
  if (relativeConfigDir !== ".pipr") {
    lines.push(`          config-dir: ${relativeConfigDir}`);
  }
  lines.push("");
  return lines.join("\n");
}
