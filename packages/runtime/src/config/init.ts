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
  return ["config.ts", "tsconfig.json", path.join("types", "pipr-sdk.d.ts")];
}

export async function initOfficialMinimalProject(
  options: InitOfficialMinimalProjectOptions,
): Promise<InitOfficialMinimalProjectResult> {
  const { configDir, projectDir } = resolveContainedConfigDir(options);
  const targets = (await starterFiles()).map((file) => ({
    ...file,
    absolutePath: path.join(projectDir, file.relativePath),
  }));
  await assertSafeTargetAncestors(targets, projectDir);
  const existing = await findExistingTargets(targets);
  if (existing.length > 0 && !options.force) {
    throw new Error(
      `${configDir} already contains pipr files: ${existing.join(", ")}. ` +
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

async function starterFiles(): Promise<StarterFile[]> {
  return [
    { relativePath: "config.ts", contents: starterConfigTs },
    { relativePath: "tsconfig.json", contents: starterTsconfig },
    { relativePath: path.join("types", "pipr-sdk.d.ts"), contents: await sdkDeclaration() },
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
  const declaration = await rawSdkDeclaration();
  return [
    "// biome-ignore-all format: generated from @pipr/sdk declarations",
    "// biome-ignore-all assist/source/organizeImports: generated from @pipr/sdk declarations",
    'declare module "@pipr/sdk" {',
    declaration
      .replace(/^declare /gm, "")
      .replace(/^\/\/# sourceMappingURL=.*$/gm, "")
      .trim(),
    "}",
    "",
  ].join("\n");
}

async function rawSdkDeclaration(): Promise<string> {
  const declarationPath = await sdkDeclarationPath();
  if (declarationPath) {
    return await Bun.file(declarationPath).text();
  }
  const embedded = embeddedSdkAssets().declaration;
  if (embedded) {
    return embedded;
  }
  throw new Error("Unable to locate @pipr/sdk declaration file. Build @pipr/sdk before pipr init.");
}

async function sdkDeclarationPath(): Promise<string | undefined> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../sdk/dist/index.d.mts"),
    path.resolve(moduleDir, "../../../sdk/dist/index.d.mts"),
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
