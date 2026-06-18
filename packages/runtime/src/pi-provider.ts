import {
  type PiProviderInvocation,
  type PiThinkingLevel,
  parsePiProviderInvocation,
  piReadOnlyToolNames,
} from "./pi-contract.js";
import type { ProviderConfig } from "./types.js";

export function toPiProviderInvocation(provider: ProviderConfig): PiProviderInvocation {
  return parsePiProviderInvocation({
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
