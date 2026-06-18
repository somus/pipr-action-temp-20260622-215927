import { z } from "zod";
import { type PiThinkingLevel, type ProviderConfig, piThinkingLevelSchema } from "./types.js";

const piReadOnlyToolNamesSchema = z.tuple([
  z.literal("read"),
  z.literal("grep"),
  z.literal("find"),
  z.literal("ls"),
]);

export const piReadOnlyToolNames = ["read", "grep", "find", "ls"] as const;

export const piProviderInvocationSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1),
    thinking: piThinkingLevelSchema,
    tools: piReadOnlyToolNamesSchema,
  })
  .strict();

export type PiProviderInvocation = z.infer<typeof piProviderInvocationSchema>;

export function toPiProviderInvocation(provider: ProviderConfig): PiProviderInvocation {
  return piProviderInvocationSchema.parse({
    provider: provider.provider,
    model: provider.model,
    apiKeyEnv: provider.apiKeyEnv,
    thinking: toPiThinkingLevel(provider),
    tools: piReadOnlyToolNames,
  });
}

function toPiThinkingLevel(provider: ProviderConfig): PiThinkingLevel {
  return provider.thinking ?? "high";
}
