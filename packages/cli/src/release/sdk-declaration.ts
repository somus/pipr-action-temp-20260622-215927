import path from "node:path";

export type SdkDeclarationModule = {
  moduleName: string;
  source: string;
};

export function embeddedSdkDeclaration(modules: SdkDeclarationModule[]): string {
  const declaration = [
    "// biome-ignore-all format: generated from @pipr/sdk declarations",
    "// biome-ignore-all assist/source/organizeImports: generated from @pipr/sdk declarations",
    ...modules.map(declarationModuleBlock),
    "",
  ].join("\n");
  if (declaration.includes('from "zod"') || declaration.includes("z.ZodType")) {
    throw new Error("embedded SDK declaration must be standalone and must not import zod");
  }
  return declaration;
}

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

function declarationModuleBlock(options: SdkDeclarationModule): string {
  return [`declare module "${options.moduleName}" {`, declarationSource(options).trim(), "}"].join(
    "\n",
  );
}

function declarationSource(options: SdkDeclarationModule): string {
  const source = options.source
    .replace(/^declare /gm, "")
    .replace(/^import \{ z \} from "zod";$/gm, zodShimDeclaration())
    .replaceAll("z.ZodType", "ZodType")
    .replaceAll('from "./index.js"', 'from "@pipr/sdk"')
    .replaceAll('from "./index.mjs"', 'from "@pipr/sdk"')
    .replace(/^import .* from "@pipr\/sdk";$/gm, "")
    .replace(/^\/\/# sourceMappingURL=.*$/gm, "");
  return options.moduleName === "@pipr/sdk"
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
    "  union<const T extends readonly [ZodAny, ZodAny, ...ZodAny[]]>(schemas: T): ZodType<ZodInfer<T[number]>>;",
    "};",
  ].join("\n");
}
