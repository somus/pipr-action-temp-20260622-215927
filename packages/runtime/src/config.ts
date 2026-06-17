import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { PiprConfig, ResolvedConfig } from "./types.js";

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

const rawSecretPattern = /(sk-|api[_-]?key|secret|token)[a-z0-9_-]{8,}/i;

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

export async function loadConfig(options: LoadConfigOptions): Promise<ResolvedConfig> {
  const configDir = options.configDir ?? ".pipr";
  const configPath = path.join(options.rootDir, configDir, "config.yaml");
  const exists = await fileExists(configPath);

  if (!exists) {
    return validateResolvedConfig(
      {
        config: builtinMinimalConfig,
        source: "builtin:minimal",
        warnings: [`${configDir}/config.yaml not found; using builtin:minimal`],
      },
      options,
    );
  }

  const raw = await readFile(configPath, "utf8");
  const parsed = parse(raw) as Partial<PiprConfig> | null;
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

  return validateResolvedConfig({ config: merged, source: configPath, warnings: [] }, options);
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
