import { randomUUID } from "node:crypto";
import type { Agent, AgentTool, DurationInput, RuntimePlan, TaskContext } from "@pipr/sdk";
import { isBuiltinReadOnlyTool, renderPromptValue } from "@pipr/sdk";
import { compact, uniqBy } from "lodash-es";
import { z } from "zod";
import { piReadOnlyToolNames } from "../pi/contract.js";
import { type PiRunOptions, type PiRunResult, runPi } from "../pi/runner.js";
import { piRuntimeReadToolNames } from "../pi/runtime-tools.js";
import type {
  DiffManifest,
  PiprConfig,
  ProviderConfig,
  PullRequestEventContext,
} from "../types.js";
import { parseDiffManifest } from "../types.js";
import { type PreparedDiffManifestPrompt, prepareDiffManifestPrompt } from "./manifest-payload.js";
import { parsePrReview, prReviewSchemaId, reviewSchemaExample } from "./review.js";

export type PiRunner = (options: PiRunOptions) => Promise<PiRunResult>;

export type RunReviewAgentOptions = {
  agent: Agent;
  input: unknown;
  runOptions: Parameters<TaskContext["pi"]["run"]>[2];
  runtime: {
    workspace: string;
    config: PiprConfig;
    event: PullRequestEventContext;
    provider: ProviderConfig;
    providerOverride?: ProviderConfig;
    plan: RuntimePlan;
    env?: NodeJS.ProcessEnv;
    piExecutable?: string;
    piRunner?: PiRunner;
  };
};

export type RunReviewAgentResult = {
  value: unknown;
  repairAttempted: boolean;
  providerModels: string[];
};

type ParseAgentResult =
  | { ok: true; value: unknown; repairAttempted: boolean }
  | { ok: false; error: string };

type AgentToolResolution = {
  customTools: AgentTool[];
};

type PluginToolExecutionContext = {
  run: { id: string };
  repository: { root: string; name: string };
  change: {
    number: number;
    title: string;
    description: string;
    base: { sha: string };
    head: { sha: string };
  };
  platform: { id: "github" };
};

type AgentRunContext = {
  prompt: {
    runId: string;
    repository: PluginToolExecutionContext["repository"];
    change: PluginToolExecutionContext["change"];
    platform: PluginToolExecutionContext["platform"];
  };
  tools: PluginToolExecutionContext;
};

type RetrySettings = {
  invalidOutput: number;
  transientFailure: number;
};

const retrySettingsSchema = z.strictObject({
  invalidOutput: z.number().int().min(0),
  transientFailure: z.number().int().min(0),
});

type AgentAttemptResult =
  | { ok: true; value: unknown; repairAttempted: boolean }
  | { ok: false; error: string; repairAttempted: boolean };

export async function runReviewAgent(
  options: RunReviewAgentOptions,
): Promise<RunReviewAgentResult> {
  const agentTools = resolveAgentTools(options.agent, options.runtime.plan);
  const agentRunContext = createAgentRunContext(options.runtime);
  const prompt = await renderAgentPrompt({ ...options, agentTools, agentRunContext });
  const providers = selectProviders(options.runtime, options.agent, options.runOptions);
  const retry = retrySettings(options.agent);
  const errors: string[] = [];
  const providerModels: string[] = [];
  let repairAttempted = false;

  for (const provider of providers) {
    providerModels.push(provider.model);
    const attempt = await runAgentWithProvider(
      { ...options, agentTools, agentRunContext },
      provider,
      prompt,
      retry,
    );
    repairAttempted ||= attempt.repairAttempted;
    if (attempt.ok) {
      return { value: attempt.value, repairAttempted, providerModels };
    }
    errors.push(`${provider.id}: ${attempt.error}`);
  }

  throw new Error(`Pi agent failed for all configured models: ${errors.join("; ")}`);
}

export function resolveProvider(config: PiprConfig, providerId: string): ProviderConfig {
  const provider = config.providers.find((item) => item.id === providerId);
  if (!provider) {
    throw new Error(`Provider '${providerId}' does not match any provider id`);
  }
  return provider;
}

function createAgentRunContext(runtime: RunReviewAgentOptions["runtime"]): AgentRunContext {
  const runId = randomUUID();
  const repository = {
    root: runtime.workspace,
    name: runtime.event.repo.split("/").at(-1) ?? "repo",
  };
  const change = {
    number: runtime.event.pullRequestNumber,
    title: runtime.event.title,
    description: runtime.event.description,
    base: { sha: runtime.event.baseSha },
    head: { sha: runtime.event.headSha },
  };
  const platform = { id: "github" as const };
  return {
    prompt: { runId, repository, change, platform },
    tools: { run: { id: runId }, repository, change, platform },
  };
}

async function runAgentWithProvider(
  options: RunReviewAgentOptions & {
    agentTools: AgentToolResolution;
    agentRunContext: AgentRunContext;
  },
  provider: ProviderConfig,
  prompt: string,
  retry: RetrySettings,
): Promise<AgentAttemptResult> {
  let output: string;
  try {
    output = (await runPiWithTransientRetries(options, provider, prompt, retry)).stdout;
  } catch (error) {
    return { ok: false, error: errorMessage(error), repairAttempted: false };
  }

  let parsed = parseAgentOutput(output, options.agent);
  if (parsed.ok) {
    return { ok: true, value: parsed.value, repairAttempted: false };
  }

  let lastError = parsed.error;
  let lastOutput = output;
  for (let attempt = 0; attempt < retry.invalidOutput; attempt += 1) {
    const repairPrompt = buildRepairPrompt({
      prompt,
      invalidOutput: lastOutput,
      error: lastError,
    });
    try {
      lastOutput = (await runPiWithTransientRetries(options, provider, repairPrompt, retry)).stdout;
    } catch (error) {
      return { ok: false, error: errorMessage(error), repairAttempted: true };
    }
    parsed = parseAgentOutput(lastOutput, options.agent);
    if (parsed.ok) {
      return { ok: true, value: parsed.value, repairAttempted: true };
    }
    lastError = parsed.error;
  }

  return {
    ok: false,
    error: `Pi output failed schema validation after ${retry.invalidOutput} repair attempt(s): ${lastError}`,
    repairAttempted: retry.invalidOutput > 0,
  };
}

async function runPiWithTransientRetries(
  options: RunReviewAgentOptions & {
    agentTools: AgentToolResolution;
    agentRunContext: AgentRunContext;
  },
  provider: ProviderConfig,
  prompt: string,
  retry: RetrySettings,
): Promise<PiRunResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retry.transientFailure; attempt += 1) {
    try {
      return await runPiForPrompt(options, provider, prompt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function retrySettings(agent: Agent): RetrySettings {
  return retrySettingsSchema.parse({
    invalidOutput: agent.definition.retry?.invalidOutput ?? 1,
    transientFailure: agent.definition.retry?.transientFailure ?? 0,
  });
}

function resolveAgentTools(agent: Agent, _plan: RuntimePlan): AgentToolResolution {
  const unsupported: AgentTool[] = [];
  for (const tool of agent.definition.tools ?? []) {
    if (isBuiltinReadOnlyTool(tool)) {
      continue;
    }
    unsupported.push(tool);
  }
  if (unsupported.length > 0) {
    throw new Error(
      `Agent '${agent.name ?? "anonymous-agent"}' declares custom Pi tools that are not executable in the MVP: ${unsupported
        .map((tool) => tool.name)
        .join(", ")}`,
    );
  }
  return { customTools: [] };
}

function selectProviders(
  runtime: {
    providerOverride?: ProviderConfig;
    config: PiprConfig;
    provider: ProviderConfig;
  },
  agent: Agent,
  runOptions: Parameters<TaskContext["pi"]["run"]>[2],
): ProviderConfig[] {
  if (runtime.providerOverride) {
    return [runtime.provider];
  }
  const primary = runOptions?.model ?? agent.definition.model;
  const fallbacks = runOptions?.fallbacks ?? agent.definition.fallbacks ?? [];
  const providers = [
    primary ? resolveProvider(runtime.config, primary.name) : runtime.provider,
    ...fallbacks.map((model) => resolveProvider(runtime.config, model.name)),
  ];
  return uniqBy(providers, (provider) => provider.id);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function renderAgentPrompt(
  options: RunReviewAgentOptions & {
    agentTools: AgentToolResolution;
    agentRunContext: AgentRunContext;
  },
): Promise<string> {
  const prompt = await options.agent.definition.prompt(options.input as never, {
    ...options.agentRunContext.prompt,
  });
  const availableTools = [...piReadOnlyToolNames];
  return compact([
    "You are pipr's agent for a change request.",
    `Available Pi tools: ${availableTools.join(", ")}.`,
    "Do not use bash, write, edit, platform APIs, or comment publishing tools.",
    customToolPrompt(options.agentTools),
    "Return only valid JSON. Do not include Markdown fences or prose outside JSON.",
    `Output Schema ID: ${options.agent.definition.output.id}`,
    options.agent.definition.output.id === prReviewSchemaId
      ? `The JSON must match this schema shape:\n${JSON.stringify(reviewSchemaExample(), null, 2)}`
      : undefined,
    `Instructions:\n${renderPromptValue(options.agent.definition.instructions)}`,
    options.runOptions?.instructions
      ? `Run Instructions:\n${renderPromptValue(options.runOptions.instructions)}`
      : undefined,
    `Prompt:\n${renderPromptValue(prompt)}`,
  ]).join("\n\n");
}

function customToolPrompt(agentTools: AgentToolResolution): string | undefined {
  if (agentTools.customTools.length === 0) {
    return undefined;
  }
  return [
    "Custom plugin tools:",
    ...agentTools.customTools.map(
      (tool) => `${tool.name}: ${tool.description ?? "No description."}`,
    ),
  ].join("\n");
}

async function runPiForPrompt(
  options: RunReviewAgentOptions & {
    agentTools: AgentToolResolution;
    agentRunContext: AgentRunContext;
  },
  provider: ProviderConfig,
  prompt: string,
): Promise<PiRunResult> {
  const manifest = readInputManifest(options.input);
  const manifestPrompt = manifest
    ? prepareDiffManifestPrompt(manifest, options.runtime.config.limits?.diffManifest)
    : undefined;
  const result = await (options.runtime.piRunner ?? runPi)({
    workspace: options.runtime.workspace,
    provider,
    prompt: withManifestToolContext(prompt, manifestPrompt),
    env: options.runtime.env,
    piExecutable: options.runtime.piExecutable,
    runtimeTools: runtimeToolsForPrompt(manifest, manifestPrompt),
    timeoutSeconds: effectiveTimeoutSeconds(
      options.runOptions?.timeout ?? options.agent.definition.timeout,
      options.runtime.config.limits?.timeoutSeconds,
    ),
  });
  assertSuccessfulPiResult(result);
  return result;
}

function effectiveTimeoutSeconds(
  timeout: DurationInput | undefined,
  fallback: number | undefined,
): number | undefined {
  return timeout === undefined ? fallback : parseDurationSeconds(timeout);
}

function parseDurationSeconds(value: DurationInput): number {
  if (typeof value === "number") {
    return value;
  }
  const match = /^(?<amount>\d+)(?<unit>[smh])$/.exec(value);
  if (!match?.groups) {
    throw new Error(`Invalid duration '${value}'`);
  }
  const amount = Number(match.groups.amount);
  const unit = match.groups.unit;
  if (unit === "h") {
    return amount * 60 * 60;
  }
  if (unit === "m") {
    return amount * 60;
  }
  return amount;
}

function runtimeToolsForPrompt(
  manifest: DiffManifest | undefined,
  manifestPrompt: PreparedDiffManifestPrompt | undefined,
): Parameters<typeof runPi>[0]["runtimeTools"] {
  if (!manifest || manifestPrompt?.mode !== "condensed") {
    return undefined;
  }
  return {
    manifest,
    toolResponseMaxBytes: manifestPrompt.limits.toolResponseMaxBytes,
  };
}

function assertSuccessfulPiResult(result: PiRunResult): void {
  if (result.exitCode === 0) {
    return;
  }
  const detail = result.stderr.trim() || result.stdout.trim() || "no output";
  throw new Error(`Pi agent failed with exit ${result.exitCode}: ${detail}`);
}

function withManifestToolContext(
  prompt: string,
  manifestPrompt: PreparedDiffManifestPrompt | undefined,
): string {
  if (!manifestPrompt) {
    return prompt;
  }
  const availableTools =
    manifestPrompt.mode === "condensed"
      ? [...piReadOnlyToolNames, ...piRuntimeReadToolNames]
      : [...piReadOnlyToolNames];
  return compact([
    prompt,
    "Diff Manifest Payload:",
    JSON.stringify(
      {
        mode: manifestPrompt.mode,
        metrics: manifestPrompt.metrics,
        limits: manifestPrompt.limits,
      },
      null,
      2,
    ),
    "Diff Manifest:",
    JSON.stringify(manifestPrompt.manifest, null, 2),
    "Diff Manifest Runtime Context:",
    JSON.stringify(
      {
        mode: manifestPrompt.mode,
        availableTools,
        runtimeReadTools:
          manifestPrompt.mode === "condensed" ? ["pipr_read_diff", "pipr_read_at_ref"] : [],
      },
      null,
      2,
    ),
    manifestPrompt.mode === "condensed"
      ? [
          "Condensed manifest helper tools:",
          "pipr_read_diff(path?, rangeId?) returns bounded full Diff Manifest data.",
          "pipr_read_at_ref(path, ref, rangeId) reads bounded base or head file content.",
        ].join("\n")
      : undefined,
  ]).join("\n\n");
}

function readInputManifest(input: unknown): DiffManifest | undefined {
  if (typeof input !== "object" || input === null || !("manifest" in input)) {
    return undefined;
  }
  try {
    return parseDiffManifest((input as { manifest: unknown }).manifest);
  } catch {
    return undefined;
  }
}

function parseAgentOutput(output: string, agent: Agent): ParseAgentResult {
  try {
    const json = JSON.parse(output) as unknown;
    if (agent.definition.output.id === prReviewSchemaId) {
      return { ok: true, value: parsePrReview(json), repairAttempted: false };
    }
    return { ok: true, value: agent.definition.output.parse(json), repairAttempted: false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function buildRepairPrompt(options: {
  prompt: string;
  invalidOutput: string;
  error: string;
}): string {
  return [
    "Repair the previous output so it is valid JSON matching the requested schema.",
    "Return only the repaired JSON.",
    "Schema validation error:",
    options.error,
    "Invalid output:",
    options.invalidOutput,
    "Original request:",
    options.prompt,
  ].join("\n\n");
}
