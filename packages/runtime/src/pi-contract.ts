import { z } from "zod";

export const piThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const piBuiltinToolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const piReadOnlyToolNames = ["read", "grep", "find", "ls"] as const;
export const piRequiredCliFlags = [
  "--provider",
  "--model",
  "--mode",
  "--print",
  "--no-session",
  "--session-dir",
  "--tools",
  "--no-context-files",
  "--no-approve",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--thinking",
] as const;

const nonEmptyStringSchema = z.string().min(1);
export const piProviderIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);
export const piApiKeyEnvNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

export const piThinkingLevelSchema = z.enum(piThinkingLevels);
export const piBuiltinToolNameSchema = z.enum(piBuiltinToolNames);
export const piReadOnlyToolNameSchema = z.enum(piReadOnlyToolNames);
export const piReadOnlyToolNamesSchema = z.tuple([
  z.literal("read"),
  z.literal("grep"),
  z.literal("find"),
  z.literal("ls"),
]);

export const piProviderProfileSchema = z
  .object({
    id: piProviderIdSchema,
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
    apiKeyEnv: piApiKeyEnvNameSchema,
    thinking: piThinkingLevelSchema.optional(),
  })
  .strict();

export const piProviderInvocationSchema = z
  .object({
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
    apiKeyEnv: piApiKeyEnvNameSchema,
    thinking: piThinkingLevelSchema,
    tools: piReadOnlyToolNamesSchema,
  })
  .strict();

export type PiThinkingLevel = z.infer<typeof piThinkingLevelSchema>;
export type PiBuiltinToolName = z.infer<typeof piBuiltinToolNameSchema>;
export type PiReadOnlyToolName = z.infer<typeof piReadOnlyToolNameSchema>;
export type PiProviderProfile = z.infer<typeof piProviderProfileSchema>;
export type PiProviderInvocation = z.infer<typeof piProviderInvocationSchema>;

export function parsePiProviderProfile(value: unknown): PiProviderProfile {
  return piProviderProfileSchema.parse(value);
}

export function parsePiProviderInvocation(value: unknown): PiProviderInvocation {
  return piProviderInvocationSchema.parse(value);
}
