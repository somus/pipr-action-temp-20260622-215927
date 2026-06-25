import type {
  Agent,
  AgentTool,
  DurationInput,
  PathFilter,
  RuntimePlan,
  Schema,
  TaskContext,
} from "@pipr/sdk";
import { isBuiltinReadOnlyTool, renderPromptValue } from "@pipr/sdk";
import { compact, uniqBy } from "lodash-es";
import { z } from "zod";
import { type PiReadOnlyToolName, piReadOnlyToolNames } from "../pi/contract.js";
import { type PiRunOptions, type PiRunResult, runPi } from "../pi/runner.js";
import { piRuntimeReadToolNames } from "../pi/runtime-tools.js";
import type {
  ChangeRequestEventContext,
  DiffManifest,
  PiprConfig,
  ProviderConfig,
} from "../types.js";
import { parseDiffManifest } from "../types.js";
import { type PreparedDiffManifestPrompt, prepareDiffManifestPrompt } from "./manifest-payload.js";
import type { PriorReviewState } from "./prior-state.js";
import { parsePrReview, prReviewSchemaId, reviewSchemaExample } from "./review.js";

export type PiRunner = (options: PiRunOptions) => Promise<PiRunResult>;

export type RunReviewAgentOptions = {
  agent: Agent;
  input: unknown;
  runOptions: Parameters<TaskContext["pi"]["run"]>[2];
  toolMode?: "read-only" | "none";
  runtime: {
    workspace: string;
    config: PiprConfig;
    event: ChangeRequestEventContext;
    provider: ProviderConfig;
    providerOverride?: ProviderConfig;
    plan: RuntimePlan;
    env?: NodeJS.ProcessEnv;
    piExecutable?: string;
    piRunner?: PiRunner;
    priorReviewState?: PriorReviewState;
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
  platform: { id: string };
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

type PreparedAgentContext = {
  agentTools: AgentToolResolution;
  agentRunContext: AgentRunContext;
  manifest?: DiffManifest;
  manifestPrompt?: PreparedDiffManifestPrompt;
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
  const manifest = readInputManifest(options.input);
  const manifestPrompt = manifest
    ? prepareDiffManifestPrompt(manifest, options.runtime.config.limits?.diffManifest)
    : undefined;
  const prepared: PreparedAgentContext = { agentTools, agentRunContext, manifest, manifestPrompt };
  const prompt = await renderAgentPrompt({ ...options, ...prepared });
  const providers = selectProviders(options.runtime, options.agent, options.runOptions);
  const retry = retrySettings(options.agent);
  const errors: string[] = [];
  const providerModels: string[] = [];
  let repairAttempted = false;

  for (const provider of providers) {
    providerModels.push(provider.model);
    const attempt = await runAgentWithProvider(
      { ...options, ...prepared },
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
  const runId = crypto.randomUUID();
  const repository = {
    root: runtime.workspace,
    name: runtime.event.repository.slug.split("/").at(-1) ?? "repo",
  };
  const change = {
    number: runtime.event.change.number,
    title: runtime.event.change.title,
    description: runtime.event.change.description,
    base: runtime.event.change.base,
    head: runtime.event.change.head,
  };
  const platform = { id: runtime.event.platform.id };
  return {
    prompt: { runId, repository, change, platform },
    tools: { run: { id: runId }, repository, change, platform },
  };
}

async function runAgentWithProvider(
  options: RunReviewAgentOptions & PreparedAgentContext,
  provider: ProviderConfig,
  prompt: string,
  retry: RetrySettings,
): Promise<AgentAttemptResult> {
  let output: string;
  try {
    output = (await runPiWithTransientRetries(options, provider, prompt, retry)).stdout;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      repairAttempted: false,
    };
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
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        repairAttempted: true,
      };
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
  options: RunReviewAgentOptions & PreparedAgentContext,
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
    primary ? resolveProvider(runtime.config, primary.id) : runtime.provider,
    ...fallbacks.map((model) => resolveProvider(runtime.config, model.id)),
  ];
  return uniqBy(providers, (provider) => provider.id);
}

async function renderAgentPrompt(
  options: RunReviewAgentOptions & PreparedAgentContext,
): Promise<string> {
  const prompt = await options.agent.definition.prompt(options.input as never, {
    ...options.agentRunContext.prompt,
  });
  return compact([
    promptSection("Role", "You are pipr's read-only change request agent."),
    promptSection("Tools", toolsPrompt(options.manifestPrompt, options.toolMode ?? "read-only")),
    customToolPrompt(options.agentTools),
    pathScopePrompt(options.runOptions?.paths),
    promptSection("Output", outputPrompt(options.agent.definition.output)),
    promptSection(
      "Diff Manifest",
      diffManifestPrompt(options.manifestPrompt, options.toolMode ?? "read-only"),
    ),
    promptSection("Instructions", renderPromptValue(options.agent.definition.instructions)),
    options.runOptions?.instructions
      ? promptSection("Run Instructions", renderPromptValue(options.runOptions.instructions))
      : undefined,
    priorFindingsPrompt(options.runtime.priorReviewState),
    promptSection("Prompt", renderPromptValue(prompt)),
  ]).join("\n\n");
}

function promptSection(title: string, body: string | undefined): string | undefined {
  if (!body?.trim()) {
    return undefined;
  }
  return `${title}:\n${body}`;
}

function toolsPrompt(
  manifestPrompt: PreparedDiffManifestPrompt | undefined,
  toolMode: "read-only" | "none",
): string {
  if (toolMode === "none") {
    return [
      "Available tools: none.",
      "Use only the prompt context. Do not request repository, filesystem, network, platform, or shell access.",
    ].join("\n");
  }
  const toolNames =
    manifestPrompt?.mode === "condensed"
      ? [...piReadOnlyToolNames, ...piRuntimeReadToolNames]
      : [...piReadOnlyToolNames];
  return [
    `Available tools: ${toolNames.join(", ")}.`,
    "Use tools only to inspect repository content and pipr-provided review context.",
    "Do not write files, edit code, run shell commands, call platform APIs, or publish comments.",
  ].join("\n");
}

function outputPrompt(schema: Schema<unknown>): string {
  return compact([
    `Schema ID: ${schema.id}.`,
    schema.jsonSchema ? `JSON Schema:\n${JSON.stringify(schema.jsonSchema, null, 2)}` : undefined,
    schema.id === prReviewSchemaId
      ? `Example:\n${JSON.stringify(reviewSchemaExample(), null, 2)}`
      : undefined,
    schema.id === prReviewSchemaId
      ? "`suggestedFix` is exact replacement code for the selected range. Do not include Markdown fences, prose, or labels in `suggestedFix`."
      : undefined,
    "Return exactly one JSON value matching the schema.",
    "Do not include Markdown, prose, explanations, or leading/trailing text.",
  ]).join("\n\n");
}

function pathScopePrompt(paths: PathFilter | undefined): string | undefined {
  if (!paths) {
    return undefined;
  }
  return [
    "Path scope:",
    "This run is scoped to repository paths matching this filter:",
    JSON.stringify(paths, null, 2),
    "Publishable inline findings must target only files matching this filter.",
    "Read tools may access the whole repository. Prefer matching files, and read non-matching files only when needed to understand or review matching files.",
  ].join("\n");
}

function priorFindingsPrompt(state: PriorReviewState | undefined): string | undefined {
  const openFindings = state?.findings.filter((finding) => finding.status === "open") ?? [];
  if (openFindings.length === 0) {
    return undefined;
  }
  return [
    "Prior pipr findings:",
    JSON.stringify(
      {
        reviewedHeadSha: state?.reviewedHeadSha,
        findings: openFindings.map((finding) => ({
          id: finding.id,
          path: finding.path,
          rangeId: finding.rangeId,
          side: finding.side,
          startLine: finding.startLine,
          endLine: finding.endLine,
        })),
      },
      null,
      2,
    ),
    "Re-check these findings against the current diff. If a prior finding still applies, emit one current inline finding for the same issue. If it no longer applies, omit it.",
  ].join("\n");
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
  options: RunReviewAgentOptions & PreparedAgentContext,
  provider: ProviderConfig,
  prompt: string,
): Promise<PiRunResult> {
  const result = await (options.runtime.piRunner ?? runPi)({
    workspace: options.runtime.workspace,
    provider,
    prompt,
    env: options.runtime.env,
    piExecutable: options.runtime.piExecutable,
    builtinTools: builtinToolsForPrompt(options.toolMode ?? "read-only"),
    runtimeTools:
      options.toolMode === "none"
        ? undefined
        : runtimeToolsForPrompt(options.manifest, options.manifestPrompt),
    timeoutSeconds: effectiveTimeoutSeconds(
      options.runOptions?.timeout ?? options.agent.definition.timeout,
      options.runtime.config.limits?.timeoutSeconds,
    ),
  });
  assertSuccessfulPiResult(result);
  return result;
}

function builtinToolsForPrompt(toolMode: "read-only" | "none"): readonly PiReadOnlyToolName[] {
  return toolMode === "none" ? [] : piReadOnlyToolNames;
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

function diffManifestPrompt(
  manifestPrompt: PreparedDiffManifestPrompt | undefined,
  toolMode: "read-only" | "none",
): string | undefined {
  if (!manifestPrompt) {
    return undefined;
  }
  return compact([
    "Use this as the authoritative changed-code context for this run.",
    "If your output includes publishable inline findings, each finding's path, rangeId, side, startLine, and endLine must come from a Diff Manifest commentable range.",
    "Do not invent publishable inline locations outside the Diff Manifest.",
    "",
    "Payload:",
    JSON.stringify(
      {
        mode: manifestPrompt.mode,
        metrics: manifestPrompt.metrics,
        limits: manifestPrompt.limits,
      },
      null,
      2,
    ),
    "",
    "Manifest:",
    JSON.stringify(manifestPrompt.manifest, null, 2),
    manifestPrompt.mode === "condensed" && toolMode === "read-only"
      ? condensedManifestToolsPrompt()
      : undefined,
  ]).join("\n");
}

function condensedManifestToolsPrompt(): string {
  return [
    "",
    "Condensed manifest helper tools:",
    "pipr_read_diff(path?, rangeId?) returns bounded full Diff Manifest slices.",
    "pipr_read_at_ref(path, ref, rangeId?) reads bounded base or head file content.",
    "Use these tools only when the condensed manifest lacks enough detail.",
  ].join("\n");
}

function assertSuccessfulPiResult(result: PiRunResult): void {
  if (result.exitCode === 0) {
    return;
  }
  const detail = result.stderr.trim() || result.stdout.trim() || "no output";
  throw new Error(`Pi agent failed with exit ${result.exitCode}: ${detail}`);
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
  let lastError = "";
  for (const payload of jsonPayloadCandidates(output)) {
    try {
      const json = JSON.parse(payload) as unknown;
      if (agent.definition.output.id === prReviewSchemaId) {
        return { ok: true, value: parsePrReview(json), repairAttempted: false };
      }
      return { ok: true, value: agent.definition.output.parse(json), repairAttempted: false };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, error: lastError };
}

function jsonPayloadCandidates(output: string): string[] {
  const trimmed = output.trim();
  const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(output.trim());
  if (match?.[1]) {
    return [match[1].trim()];
  }
  return [trimmed];
}

function buildRepairPrompt(options: {
  prompt: string;
  invalidOutput: string;
  error: string;
}): string {
  return [
    "Repair the previous output so it is valid JSON matching the requested schema.",
    "Return exactly one JSON value.",
    "Do not include Markdown, prose, explanations, or leading/trailing text.",
    "Schema validation error:",
    options.error,
    "Invalid output:",
    options.invalidOutput,
    "Original request:",
    options.prompt,
  ].join("\n\n");
}
