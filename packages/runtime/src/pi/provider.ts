import type { ProviderConfig } from "../types.js";
import {
  type PiProviderInvocation,
  type PiThinkingLevel,
  parsePiProviderInvocation,
  piReadOnlyToolNames,
} from "./contract.js";

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
