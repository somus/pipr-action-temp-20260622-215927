import path from "node:path";
import { embeddedSdkDeclaration, type SdkDeclarationModule } from "@pipr/runtime";

export type { SdkDeclarationModule };
export { embeddedSdkDeclaration };

export async function readSdkDeclarationModules(
  sourceRoot: string,
): Promise<SdkDeclarationModule[]> {
  const modules = [
    { moduleName: "@pipr/sdk", fileName: "index.d.mts" },
    { moduleName: "@pipr/sdk/review", fileName: "review.d.mts" },
    { moduleName: "@pipr/sdk/tools", fileName: "tools.d.mts" },
  ];
  return await Promise.all(
    modules.map(async (module) => {
      const declarationPath = path.join(sourceRoot, "packages", "sdk", "dist", module.fileName);
      return {
        moduleName: module.moduleName,
        source: await readSdkDeclarationSource(module, declarationPath),
      };
    }),
  );
}

async function readSdkDeclarationSource(
  module: { moduleName: string },
  declarationPath: string,
): Promise<string> {
  const source = await Bun.file(declarationPath).text();
  if (module.moduleName !== "@pipr/sdk") {
    return source;
  }
  const chunkFileName = source.match(/from "\.\/(?<chunk>index-[A-Za-z0-9_-]+)\.mjs"/)?.groups
    ?.chunk;
  if (!chunkFileName) {
    return source;
  }
  const chunkPath = path.join(path.dirname(declarationPath), `${chunkFileName}.d.mts`);
  const chunk = await Bun.file(chunkPath).text();
  return `${chunk.replace(/^export \{.*\};$/gm, "")}\n${source}`;
}
