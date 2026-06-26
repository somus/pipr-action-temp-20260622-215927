import { mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedSdkAssets } from "./sdk-assets.js";
import {
  embeddedSdkDeclaration,
  readSdkDeclarationSourceWithChunk,
  type SdkDeclarationModule,
} from "./sdk-declaration.js";

declare const PIPR_EMBEDDED_CONFIG_TYPE_SUPPORT: string | undefined;

export type ConfigTypeSupportFile = {
  relativePath: string;
  contents: string;
};

const starterTsconfig = `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "typeRoots": ["./types"],
    "types": ["pipr-sdk", "bun"]
  },
  "include": ["./**/*.ts"],
  "exclude": ["./types"]
}
`;

export async function generatedTypeSupportFiles(
  relativeConfigDir: string,
  options: { tsconfig?: boolean } = {},
): Promise<ConfigTypeSupportFile[]> {
  const files: ConfigTypeSupportFile[] = [];
  if (options.tsconfig !== false) {
    files.push({
      relativePath: path.join(relativeConfigDir, "tsconfig.json"),
      contents: starterTsconfig,
    });
  }
  files.push(
    {
      relativePath: path.join(relativeConfigDir, "types", "pipr-sdk", "index.d.ts"),
      contents: await sdkDeclaration(),
    },
    {
      relativePath: path.join(relativeConfigDir, "types", "bun", "index.d.ts"),
      contents: '/// <reference types="bun-types" />\n',
    },
    ...(await packageTypeSupportFiles(relativeConfigDir, "bun-types")),
    ...(await packageTypeSupportFiles(relativeConfigDir, "node")),
    ...(await packageTypeSupportFiles(relativeConfigDir, "undici-types")),
  );
  return files;
}

export async function writeGeneratedTypeSupport(
  configDir: string,
  options: { tsconfig?: boolean } = {},
): Promise<void> {
  for (const file of await generatedTypeSupportFiles("", options)) {
    const target = path.join(configDir, file.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await Bun.write(target, file.contents);
  }
}

function readEmbeddedConfigTypeSupport(): Record<string, string> | undefined {
  return typeof PIPR_EMBEDDED_CONFIG_TYPE_SUPPORT === "string" &&
    PIPR_EMBEDDED_CONFIG_TYPE_SUPPORT.length > 0
    ? (JSON.parse(PIPR_EMBEDDED_CONFIG_TYPE_SUPPORT) as Record<string, string>)
    : undefined;
}

async function packageTypeSupportFiles(
  relativeConfigDir: string,
  typePackage: "bun-types" | "node" | "undici-types",
): Promise<ConfigTypeSupportFile[]> {
  const embedded = readEmbeddedConfigTypeSupport();
  if (embedded) {
    const prefix = `${typePackage}/`;
    return Object.entries(embedded)
      .filter(([relativePath]) => relativePath.startsWith(prefix))
      .map(([relativePath, contents]) => ({
        relativePath: path.join(relativeConfigDir, "types", relativePath),
        contents,
      }));
  }

  const packageRoot = await typePackageRoot(typePackage);
  return (await declarationFiles(packageRoot)).map((file) => ({
    relativePath: path.join(relativeConfigDir, "types", typePackage, file.relativePath),
    contents: file.contents,
  }));
}

async function declarationFiles(
  packageRoot: string,
): Promise<Array<{ relativePath: string; contents: string }>> {
  const files: Array<{ relativePath: string; contents: string }> = [];
  const pending = [""];
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    for (const entry of await readdir(path.join(packageRoot, current), { withFileTypes: true })) {
      const relativePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
        files.push({
          relativePath,
          contents: await Bun.file(path.join(packageRoot, relativePath)).text(),
        });
      }
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function typePackageRoot(
  typePackage: "bun-types" | "node" | "undici-types",
): Promise<string> {
  const require = createRequire(import.meta.url);
  if (typePackage === "bun-types") {
    const bunRequire = createRequire(require.resolve("@types/bun/package.json"));
    return path.dirname(bunRequire.resolve("bun-types/package.json"));
  }
  if (typePackage === "node") {
    return path.dirname(require.resolve("@types/node/package.json"));
  }
  const nodeRequire = createRequire(require.resolve("@types/node/package.json"));
  return path.dirname(nodeRequire.resolve("undici-types/package.json"));
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
    const stats = await Bun.file(candidate).exists();
    if (stats) {
      return candidate;
    }
  }
  return undefined;
}
