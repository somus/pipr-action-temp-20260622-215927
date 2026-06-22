import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPiprPlan, isPiprConfigFactory, type RuntimePlan } from "@pipr/sdk";
import { resolveContainedConfigDir } from "./paths.js";
import { embeddedSdkAssets } from "./sdk-assets.js";

export type LoadTypescriptConfigOptions = {
  rootDir: string;
  configDir?: string;
  typecheck?: boolean;
};

export type LoadedTypescriptConfig = {
  plan: RuntimePlan;
  source: string;
  tempRoot: string;
};

export async function loadTypescriptConfig(
  options: LoadTypescriptConfigOptions,
): Promise<LoadedTypescriptConfig> {
  const { projectDir, relativeConfigDir, configDir } = resolveContainedConfigDir(options);
  const sourceConfigPath = path.join(projectDir, "config.ts");
  if (!(await fileExists(sourceConfigPath))) {
    throw new Error(`${configDir}/config.ts is required. Run pipr init to create it.`);
  }
  if (options.typecheck) {
    await typecheckTypescriptConfig(projectDir);
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
  try {
    const tempConfigDir = path.join(tempRoot, relativeConfigDir);
    await cp(projectDir, tempConfigDir, {
      recursive: true,
      errorOnExist: false,
      force: true,
      filter: (source) => !isIgnoredConfigCopyPath(source, projectDir),
    });
    await installSdkStub(tempConfigDir);

    const configPath = path.join(tempConfigDir, "config.ts");
    const imported = await import(`${pathToFileURL(configPath).href}?pipr=${Date.now()}`);
    const factory = imported.default as unknown;
    if (!isPiprConfigFactory(factory)) {
      throw new Error(`${sourceConfigPath}: default export must be created by definePipr()`);
    }
    return {
      plan: buildPiprPlan(factory),
      source: sourceConfigPath,
      tempRoot,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function installSdkStub(configDir: string): Promise<void> {
  const sdkRoot = path.join(configDir, "node_modules", "@pipr", "sdk");
  await mkdir(sdkRoot, { recursive: true });
  await Bun.write(
    path.join(sdkRoot, "package.json"),
    JSON.stringify({ type: "module", exports: { ".": "./index.mjs" } }),
  );
  await Bun.write(path.join(sdkRoot, "index.mjs"), await sdkStubSource());
}

async function typecheckTypescriptConfig(configDir: string): Promise<void> {
  const tsconfigPath = path.join(configDir, "tsconfig.json");
  if (!(await fileExists(tsconfigPath))) {
    throw new Error(`${configDir}/tsconfig.json is required for pipr check. Run pipr init.`);
  }
  const tscPath = await typescriptCliPath();
  if (!tscPath) {
    await typecheckTypescriptConfigWithApi(configDir, tsconfigPath);
    return;
  }
  const result = Bun.spawnSync(
    [process.execPath, tscPath, "--noEmit", "--pretty", "false", "-p", tsconfigPath],
    {
      cwd: configDir,
      maxBuffer: 1024 * 1024 * 4,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    const output = [result.stdout?.toString().trim(), result.stderr?.toString().trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `TypeScript config check failed for ${path.join(configDir, "config.ts")}` +
        (output ? `:\n${output}` : ""),
    );
  }
}

async function typecheckTypescriptConfigWithApi(
  configDir: string,
  tsconfigPath: string,
): Promise<void> {
  const ts = await import("typescript");
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(formatTypeScriptDiagnostics(ts, [config.error], configDir));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, configDir);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length > 0) {
    throw new Error(
      `TypeScript config check failed for ${path.join(configDir, "config.ts")}:\n` +
        formatTypeScriptDiagnostics(ts, diagnostics, configDir),
    );
  }
}

function formatTypeScriptDiagnostics(
  ts: typeof import("typescript"),
  diagnostics: import("typescript").Diagnostic[],
  configDir: string,
): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => configDir,
    getNewLine: () => "\n",
  });
}

async function typescriptCliPath(): Promise<string | undefined> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../../../node_modules/typescript/bin/tsc"),
    path.resolve(moduleDir, "../../../node_modules/typescript/bin/tsc"),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function sdkStubSource(): Promise<string> {
  const sourcePath = await sdkSourcePath();
  if (sourcePath) {
    return `export * from ${JSON.stringify(pathToFileURL(sourcePath).href)};\n`;
  }
  const embedded = embeddedSdkAssets().module;
  if (embedded) {
    return embedded;
  }
  throw new Error("Unable to locate @pipr/sdk runtime module");
}

async function sdkSourcePath(): Promise<string | undefined> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../../sdk/src/index.ts"),
    path.resolve(moduleDir, "../../sdk/src/index.ts"),
    path.resolve(moduleDir, "../../../sdk/dist/index.mjs"),
    path.resolve(moduleDir, "../../sdk/dist/index.mjs"),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isIgnoredConfigCopyPath(source: string, configDir: string): boolean {
  const relative = path.relative(configDir, source);
  return (
    relative === "node_modules" ||
    relative.startsWith(`node_modules${path.sep}`) ||
    relative === "bun.lock"
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
