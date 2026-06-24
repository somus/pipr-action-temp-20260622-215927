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
    modules.map(async (module) => ({
      moduleName: module.moduleName,
      source: await Bun.file(
        path.join(sourceRoot, "packages", "sdk", "dist", module.fileName),
      ).text(),
    })),
  );
}
