import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentTool,
  ChangeRequestAction,
  DiffManifestOptions,
  DurationInput,
  ReviewFinding,
  ReviewSummary,
  RuntimePlan,
  Task,
  TaskContext,
} from "@pipr/sdk";
import { isBuiltinReadOnlyTool, renderPromptValue } from "@pipr/sdk";
import { type BuildDiffManifestOptions, buildDiffManifest } from "../diff/diff.js";
import { piReadOnlyToolNames } from "../pi/contract.js";
import { type PiRunOptions, type PiRunResult, runPi } from "../pi/runner.js";
import { piRuntimeReadToolNames } from "../pi/runtime-tools.js";
import type {
  DiffManifest,
  PiprConfig,
  ProviderConfig,
  PrReview,
  PullRequestEventContext,
  ValidatedReview,
} from "../types.js";
import { parseDiffManifest, parsePiprConfig, parseProviderConfig } from "../types.js";
import {
  buildPublicationPlan,
  type InlineCommentDraft,
  type MainSectionContribution,
  mainSectionContributionSchema,
  type PublicationPlan,
  prepareInlinePublicationItems,
  publicationTaskMetadataSchema,
  reviewToMainSectionContributions,
  runtimeVersion,
} from "./comment.js";
import { type PreparedDiffManifestPrompt, prepareDiffManifestPrompt } from "./manifest-payload.js";
import {
  parsePrReview,
  prReviewSchemaId,
  reviewSchemaExample,
  validatePrReview,
} from "./review.js";

export type PiRunner = (options: PiRunOptions) => Promise<PiRunResult>;
export type DiffManifestBuilder = (options: BuildDiffManifestOptions) => DiffManifest;

export type RunTaskRuntimeOptions = {
  workspace: string;
  config: PiprConfig;
  event: PullRequestEventContext;
  plan: RuntimePlan;
  env?: NodeJS.ProcessEnv;
  providerOverride?: ProviderConfig;
  taskName?: string;
  taskInput?: unknown;
  trustedConfigSha?: string;
  trustedConfigHash?: string;
  piExecutable?: string;
  piRunner?: PiRunner;
  diffManifestBuilder?: DiffManifestBuilder;
};

export type ReviewRuntimeResult = {
  kind: "review" | "skipped";
  skipReason?: string;
  provider: ProviderConfig;
  diffManifest: DiffManifest;
  review: PrReview;
  validated: ValidatedReview;
  publicationPlan: PublicationPlan;
  mainComment: string;
  inlineCommentDrafts: InlineCommentDraft[];
  repairAttempted: boolean;
};

type OutputState = {
  summaries: MainSectionContribution[];
  sections: MainSectionContribution[];
  sectionTemplates: Map<string, { title: string; order: number; collapsed?: boolean }>;
  findings: ReviewFinding[];
  metadata: Record<string, unknown>;
  providerModels: string[];
  repairAttempted: boolean;
};

type TaskRunResult = {
  taskName: string;
  output: OutputState;
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

export async function runTaskRuntime(options: RunTaskRuntimeOptions): Promise<ReviewRuntimeResult> {
  const config = parsePiprConfig(options.config);
  const provider = options.providerOverride
    ? parseProviderConfig(options.providerOverride)
    : resolveDefaultProvider(config);
  const diffManifest = parseDiffManifest(
    (options.diffManifestBuilder ?? buildDiffManifest)({
      cwd: options.workspace,
      baseSha: options.event.baseSha,
      headSha: options.event.headSha,
    }),
  );
  const tasks = selectedTasks(options.plan, options.event, options.taskName);
  if (tasks.length === 0) {
    return skippedTaskRuntimeResult({
      config,
      diffManifest,
      event: options.event,
      provider,
      reason: options.taskName
        ? `Task '${options.taskName}' was not registered`
        : "No tasks matched the change request event",
      trustedConfigSha: options.trustedConfigSha,
      trustedConfigHash: options.trustedConfigHash,
    });
  }

  const manifestCache = new Map<string, DiffManifest>();
  const taskResults = await Promise.all(
    tasks.map(async (task) => {
      const output = createOutputState();
      await task.handler(
        createTaskContext({
          ...options,
          config,
          provider,
          diffManifest,
          manifestCache,
          output,
        }),
        task.name === options.taskName ? (options.taskInput as never) : (undefined as never),
      );
      return { taskName: task.name, output };
    }),
  );
  const output = mergeTaskOutputs(taskResults);

  const review = collectedReview(output);
  const validated = validatePrReview(review, diffManifest, {
    minConfidence: config.publication.minConfidence,
    expectedHeadSha: options.event.headSha,
  });
  const inlineCommentDrafts = prepareInlinePublicationItems({
    validated,
    manifest: diffManifest,
    reviewedHeadSha: options.event.headSha,
  });
  const mainContributions = [
    ...output.summaries,
    ...findingsSectionContribution(validated),
    ...output.sections,
  ];
  const publicationPlan = buildPublicationPlan({
    event: options.event,
    layout: mainCommentLayoutFor(output),
    mainContributions,
    inlineItems: inlineCommentDrafts,
    maxInlineComments: config.publication.maxInlineComments,
    metadata: {
      runtimeVersion,
      trustedConfigSha: options.trustedConfigSha,
      trustedConfigHash: options.trustedConfigHash,
      reviewedHeadSha: options.event.headSha,
      providerModels:
        output.providerModels.length > 0 ? uniqueStrings(output.providerModels) : [provider.model],
      taskMetadata: taskMetadata(output),
      selectedTasks: tasks.map((task) => task.name),
      failedTasks: [],
      validFindings: validated.validFindings.length,
      droppedFindings: validated.droppedFindings.length,
    },
  });

  return {
    kind: "review",
    provider,
    diffManifest,
    review: validated.review,
    validated,
    publicationPlan,
    mainComment: publicationPlan.mainComment,
    inlineCommentDrafts: publicationPlan.inlineItems,
    repairAttempted: output.repairAttempted,
  };
}

function taskMetadata(output: OutputState) {
  return Object.keys(output.metadata).length > 0
    ? publicationTaskMetadataSchema.parse(output.metadata)
    : undefined;
}

function selectedTasks(
  plan: RuntimePlan,
  event: Pick<PullRequestEventContext, "action">,
  taskName?: string,
): Task[] {
  if (taskName) {
    return plan.tasks.filter((task) => task.name === taskName);
  }
  const action = changeRequestAction(event.action);
  if (!action) {
    return [];
  }
  return uniqueTasks(
    plan.changeRequestTriggers
      .filter((trigger) => trigger.actions.includes(action))
      .map((trigger) => trigger.task),
  );
}

function changeRequestAction(action: string | undefined): ChangeRequestAction | undefined {
  if (action === "synchronize") {
    return "updated";
  }
  if (action === "ready_for_review") {
    return "ready";
  }
  if (
    action === "opened" ||
    action === "reopened" ||
    action === "ready" ||
    action === "closed" ||
    action === "updated"
  ) {
    return action;
  }
  return undefined;
}

function uniqueTasks(tasks: Task[]): Task[] {
  return [...new Map(tasks.map((task) => [task.name, task])).values()];
}

function createTaskContext(
  options: RunTaskRuntimeOptions & {
    config: PiprConfig;
    provider: ProviderConfig;
    diffManifest: DiffManifest;
    manifestCache: Map<string, DiffManifest>;
    output: OutputState;
  },
): TaskContext {
  return {
    run: { id: randomUUID() },
    repository: { root: options.workspace, name: options.event.repo.split("/").at(-1) ?? "repo" },
    change: {
      number: options.event.pullRequestNumber,
      title: options.event.title,
      description: options.event.description,
      base: { sha: options.event.baseSha },
      head: { sha: options.event.headSha },
      async diffManifest(manifestOptions?: DiffManifestOptions) {
        const key = JSON.stringify(manifestOptions ?? {});
        const cached = options.manifestCache.get(key);
        if (cached) {
          return cloneDiffManifest(cached) as never;
        }
        const manifest = manifestForOptions(options.diffManifest, manifestOptions);
        options.manifestCache.set(key, manifest);
        return cloneDiffManifest(manifest) as never;
      },
      async changedFiles() {
        return options.diffManifest.files.map((file) => ({
          path: file.path,
          previousPath: file.previousPath,
          status: file.status,
        }));
      },
      async currentHeadSha() {
        return options.event.headSha;
      },
    },
    platform: { id: "github" },
    pi: {
      async run(agent, input, runOptions) {
        const result = await runPlanAgent({
          agent,
          input,
          runOptions,
          runtime: options,
        });
        if (result.repairAttempted) {
          options.output.repairAttempted = true;
        }
        return result.value as never;
      },
    },
    output: createOutputCollector(options.output),
    log: console,
  };
}

function createAgentRunContext(runtime: RunTaskRuntimeOptions): AgentRunContext {
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

function mergeTaskOutputs(results: TaskRunResult[]): OutputState {
  const merged = createOutputState();
  for (const { output } of results) {
    merged.summaries.push(...output.summaries);
    merged.sections.push(...output.sections);
    for (const [id, layoutSection] of output.sectionTemplates) {
      merged.sectionTemplates.set(id, layoutSection);
    }
    merged.findings.push(...output.findings);
    Object.assign(merged.metadata, output.metadata);
    merged.providerModels.push(...output.providerModels);
    merged.repairAttempted ||= output.repairAttempted;
  }
  return merged;
}

function manifestForOptions(
  manifest: DiffManifest,
  options: DiffManifestOptions | undefined,
): DiffManifest {
  if (
    !options?.compressed &&
    options?.includePreviews !== false &&
    options?.maxPreviewLines === undefined
  ) {
    return manifest;
  }
  const manifestOptions = options ?? {};
  return parseDiffManifest({
    ...manifest,
    files: manifest.files.map((file) => ({
      ...withoutCompressedFileFields(file, manifestOptions.compressed === true),
      commentableRanges: file.commentableRanges.map((range) => ({
        ...rangeFieldsForOptions(range, manifestOptions),
        ...(manifestOptions.includePreviews === false
          ? {}
          : { preview: truncatePreview(range.preview, manifestOptions.maxPreviewLines) }),
      })),
    })),
  });
}

function cloneDiffManifest(manifest: DiffManifest): DiffManifest {
  return parseDiffManifest(structuredClone(manifest));
}

function withoutCompressedFileFields(
  file: DiffManifest["files"][number],
  compressed: boolean,
): DiffManifest["files"][number] {
  if (!compressed) {
    return file;
  }
  const { signals: _signals, changedSymbols: _changedSymbols, ...rest } = file;
  return rest;
}

function withoutCompressedRangeFields(
  range: DiffManifest["files"][number]["commentableRanges"][number],
  compressed: boolean,
) {
  if (!compressed) {
    return range;
  }
  const { summary: _summary, ...rest } = range;
  return rest;
}

function rangeFieldsForOptions(
  range: DiffManifest["files"][number]["commentableRanges"][number],
  options: DiffManifestOptions,
): Record<string, unknown> {
  const fields = withoutCompressedRangeFields(range, options.compressed === true);
  if (options.includePreviews === false) {
    const { preview: _preview, ...rest } = fields;
    return rest;
  }
  return fields;
}

function truncatePreview(
  preview: string | undefined,
  maxLines: number | undefined,
): string | undefined {
  if (preview === undefined || maxLines === undefined) {
    return preview;
  }
  return preview.split("\n").slice(0, maxLines).join("\n");
}

function createOutputState(): OutputState {
  return {
    summaries: [],
    sections: [],
    sectionTemplates: new Map([
      ["summary", { title: "Summary", order: 10 }],
      ["findings", { title: "Findings", order: 20 }],
      ["metadata", { title: "Review metadata", order: 100, collapsed: true }],
    ]),
    findings: [],
    metadata: {},
    providerModels: [],
    repairAttempted: false,
  };
}

function createOutputCollector(state: OutputState): TaskContext["output"] {
  return {
    summary(value, options = {}) {
      const summary = typeof value === "string" ? value : renderSummary(value);
      state.summaries.push(
        mainSectionContributionSchema.parse({
          sourceId: options.key ?? "summary",
          sectionId: "summary",
          policy: options.merge ?? "exclusive",
          priority: options.priority ?? 100,
          value: summary,
        }),
      );
    },
    findings(value) {
      state.findings.push(...value);
    },
    section(id, value, options) {
      state.sectionTemplates.set(id, {
        title: options.title,
        order: options.order ?? 50,
        collapsed: options.collapsed,
      });
      state.sections.push(
        mainSectionContributionSchema.parse({
          sourceId: id,
          sectionId: id,
          policy: options.merge ?? "exclusive",
          priority: options.priority ?? 0,
          value: renderSectionValue(value, options.render),
        }),
      );
    },
    metadata(value) {
      Object.assign(state.metadata, value);
    },
  };
}

function renderSummary(summary: ReviewSummary): string {
  return summary.title ? `**${summary.title}**\n\n${summary.body}` : summary.body;
}

function renderSectionValue<T>(value: T, render?: (value: T) => string): unknown {
  if (render) {
    return render(value);
  }
  if (isNativeSectionValue(value)) {
    return value;
  }
  return renderPromptValue(value);
}

function isNativeSectionValue(value: unknown): value is MainSectionContribution["value"] {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string")) ||
    (Array.isArray(value) && value.every(isRecord))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runPlanAgent(options: {
  agent: Agent;
  input: unknown;
  runOptions: Parameters<TaskContext["pi"]["run"]>[2];
  runtime: RunTaskRuntimeOptions & {
    config: PiprConfig;
    provider: ProviderConfig;
    output: OutputState;
  };
}): Promise<{ value: unknown; repairAttempted: boolean }> {
  const agentTools = resolveAgentTools(options.agent, options.runtime.plan);
  const agentRunContext = createAgentRunContext(options.runtime);
  const prompt = await renderAgentPrompt({ ...options, agentTools, agentRunContext });
  const providers = selectProviders(options.runtime, options.agent, options.runOptions);
  const retry = retrySettings(options.agent);
  const errors: string[] = [];
  let repairAttempted = false;

  for (const provider of providers) {
    options.runtime.output.providerModels.push(provider.model);
    const attempt = await runAgentWithProvider(
      { ...options, agentTools, agentRunContext },
      provider,
      prompt,
      retry,
    );
    repairAttempted ||= attempt.repairAttempted;
    if (attempt.ok) {
      return { value: attempt.value, repairAttempted };
    }
    errors.push(`${provider.id}: ${attempt.error}`);
  }

  throw new Error(`Pi agent failed for all configured models: ${errors.join("; ")}`);
}

type RetrySettings = {
  invalidOutput: number;
  transientFailure: number;
};

type AgentAttemptResult =
  | { ok: true; value: unknown; repairAttempted: boolean }
  | { ok: false; error: string; repairAttempted: boolean };

async function runAgentWithProvider(
  options: {
    agent: Agent;
    agentTools: AgentToolResolution;
    agentRunContext: AgentRunContext;
    input: unknown;
    runOptions: Parameters<TaskContext["pi"]["run"]>[2];
    runtime: RunTaskRuntimeOptions & { config: PiprConfig };
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
  options: {
    agent: Agent;
    agentTools: AgentToolResolution;
    agentRunContext: AgentRunContext;
    input: unknown;
    runOptions: Parameters<TaskContext["pi"]["run"]>[2];
    runtime: RunTaskRuntimeOptions & { config: PiprConfig };
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
  return {
    invalidOutput: nonNegativeInteger(agent.definition.retry?.invalidOutput ?? 1, "invalidOutput"),
    transientFailure: nonNegativeInteger(
      agent.definition.retry?.transientFailure ?? 0,
      "transientFailure",
    ),
  };
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Agent retry.${label} must be a non-negative integer`);
  }
  return value;
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
  runtime: { providerOverride?: ProviderConfig; config: PiprConfig; provider: ProviderConfig },
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
  return uniqueProviders(providers);
}

function uniqueProviders(providers: ProviderConfig[]): ProviderConfig[] {
  return [...new Map(providers.map((provider) => [provider.id, provider])).values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function renderAgentPrompt(options: {
  agent: Agent;
  agentTools: AgentToolResolution;
  agentRunContext: AgentRunContext;
  input: unknown;
  runOptions: Parameters<TaskContext["pi"]["run"]>[2];
  runtime: RunTaskRuntimeOptions;
}): Promise<string> {
  const prompt = await options.agent.definition.prompt(options.input as never, {
    ...options.agentRunContext.prompt,
  });
  const availableTools = [...piReadOnlyToolNames];
  return [
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
  ]
    .filter((part) => part !== undefined)
    .join("\n\n");
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
  options: {
    agent: Agent;
    agentTools: AgentToolResolution;
    agentRunContext: AgentRunContext;
    input: unknown;
    runOptions: Parameters<TaskContext["pi"]["run"]>[2];
    runtime: RunTaskRuntimeOptions & { config: PiprConfig };
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
  return [
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
  ]
    .filter((part) => part !== undefined)
    .join("\n\n");
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

function collectedReview(output: OutputState): PrReview {
  return {
    summary: { body: output.summaries.length > 0 ? "Review completed." : "No summary produced." },
    inlineFindings: output.findings,
  };
}

function findingsSectionContribution(validated: ValidatedReview): MainSectionContribution[] {
  return reviewToMainSectionContributions({
    sourceId: "findings",
    validated,
  }).filter((contribution) => contribution.sectionId === "findings");
}

function mainCommentLayoutFor(output: OutputState) {
  return {
    marker: "pipr:main-comment",
    heading: "pipr Review",
    sections: [...output.sectionTemplates.entries()].map(([id, section]) => ({
      id,
      title: section.title,
      order: section.order,
      collapsed: section.collapsed,
      empty: id === "findings" ? "No high-confidence findings." : undefined,
    })),
  };
}

function skippedTaskRuntimeResult(options: {
  config: PiprConfig;
  diffManifest: DiffManifest;
  event: PullRequestEventContext;
  provider: ProviderConfig;
  reason: string;
  trustedConfigSha?: string;
  trustedConfigHash?: string;
}): ReviewRuntimeResult {
  const review: PrReview = { summary: { body: options.reason }, inlineFindings: [] };
  const validated: ValidatedReview = { review, validFindings: [], droppedFindings: [] };
  const publicationPlan = buildPublicationPlan({
    event: options.event,
    layout: mainCommentLayoutFor(createOutputState()),
    mainContributions: [],
    inlineItems: [],
    maxInlineComments: options.config.publication.maxInlineComments,
    metadata: {
      runtimeVersion,
      trustedConfigSha: options.trustedConfigSha,
      trustedConfigHash: options.trustedConfigHash,
      reviewedHeadSha: options.event.headSha,
      providerModels: [options.provider.model],
      selectedTasks: [],
      failedTasks: [],
      validFindings: 0,
      droppedFindings: 0,
    },
  });
  return {
    kind: "skipped",
    skipReason: options.reason,
    provider: options.provider,
    diffManifest: options.diffManifest,
    review,
    validated,
    publicationPlan,
    mainComment: publicationPlan.mainComment,
    inlineCommentDrafts: [],
    repairAttempted: false,
  };
}

function resolveDefaultProvider(config: PiprConfig): ProviderConfig {
  return resolveProvider(config, config.defaultProvider);
}

function resolveProvider(config: PiprConfig, providerId: string): ProviderConfig {
  const provider = config.providers.find((item) => item.id === providerId);
  if (!provider) {
    throw new Error(`Provider '${providerId}' does not match any provider id`);
  }
  return provider;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
