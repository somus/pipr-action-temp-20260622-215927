import type { MaterializedProject } from "../config/config.js";
import { type BuildDiffManifestOptions, buildDiffManifest } from "../diff/diff.js";
import { diffManifestHasPathMatch, filterDiffManifestByPaths } from "../diff/path-filter.js";
import { piReadOnlyToolNames } from "../pi/contract.js";
import { type PiRunOptions, type PiRunResult, runPi } from "../pi/runner.js";
import { piRuntimeReadToolNames } from "../pi/runtime-tools.js";
import { isRecord, requireRecord } from "../shared/record.js";
import type {
  DiffManifest,
  DiffManifestLimitsConfig,
  PiprConfig,
  ProviderConfig,
  PrReview,
  PullRequestEventContext,
  RuntimeRegistry,
  ValidatedReview,
  WorkflowRegistryEntry,
} from "../types.js";
import {
  parseDiffManifest,
  parsePiprConfig,
  parseProviderConfig,
  parseValidatedReview,
} from "../types.js";
import {
  executeWorkflow,
  selectWorkflowsForEvent,
  type WorkflowBlockHandlers,
  type WorkflowState,
} from "../workflow/workflow.js";
import {
  bindAgentInputs,
  renderAgentBodyTemplate,
  resolveAgentProviderTemplate,
} from "./agent-template.js";
import {
  buildPublicationPlan,
  type InlineCommentDraft,
  type MainSectionContribution,
  type MainSectionMergePolicy,
  mainSectionContributionSchema,
  type PublicationPlan,
  parseInlinePublicationItems,
  parseMainSectionContributions,
  prepareInlinePublicationItems,
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

export type RunReviewRuntimeOptions = {
  workspace: string;
  config: PiprConfig;
  event: PullRequestEventContext;
  env?: NodeJS.ProcessEnv;
  project?: MaterializedProject;
  registry: RuntimeRegistry;
  providerOverride?: ProviderConfig;
  workflowId?: string;
  workflowInputs?: unknown;
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

type ParseReviewResult = { ok: true; review: PrReview } | { ok: false; error: string };

export async function runReviewRuntime(
  options: RunReviewRuntimeOptions,
): Promise<ReviewRuntimeResult> {
  const config = parsePiprConfig(options.config);
  const providerOverride = options.providerOverride
    ? parseProviderConfig(options.providerOverride)
    : undefined;
  let provider = providerOverride ?? resolveDefaultProvider(config);
  const fallbackProvider = provider;
  let repairAttempted = false;
  const diffManifest = parseDiffManifest(
    (options.diffManifestBuilder ?? buildDiffManifest)({
      cwd: options.workspace,
      baseSha: options.event.baseSha,
      headSha: options.event.headSha,
    }),
  );
  const candidateWorkflows = resolveCandidateWorkflows(
    options.registry,
    options.event,
    options.workflowId,
  );
  const selectedWorkflows = candidateWorkflows.filter((workflow) =>
    diffManifestHasPathMatch(diffManifest, workflow.paths),
  );
  if (selectedWorkflows.length === 0) {
    return skippedReviewRuntimeResult({
      config,
      diffManifest,
      event: options.event,
      provider,
      reason: skipReason(candidateWorkflows, options.workflowId),
      trustedConfigSha: options.trustedConfigSha,
      trustedConfigHash: options.trustedConfigHash,
    });
  }

  for (const workflow of selectedWorkflows) {
    assertReviewWorkflowContract(workflow);
  }
  const mainCommentTemplateId = readSelectedMainCommentTemplateId(selectedWorkflows);

  const workflowRuns = await Promise.all(
    selectedWorkflows.map((selectedWorkflow) =>
      runSelectedReviewWorkflow({
        selectedWorkflow,
        diffManifest,
        options: { ...options, config, providerOverride },
        event: options.event,
        config,
        fallbackProvider,
        workflowId: options.workflowId,
        workflowInputs: options.workflowInputs,
      }),
    ),
  );
  repairAttempted = workflowRuns.some((run) => run.repairAttempted);
  provider = workflowRuns.at(-1)?.provider ?? fallbackProvider;
  const workflowResults = workflowRuns.map((run) => ({
    workflow: run.workflow,
    validated: run.validated,
    failures: run.failures,
  }));
  const mainContributions = workflowRuns.flatMap((run) => run.mainContributions);
  const inlineCommentDrafts = workflowRuns.flatMap((run) => run.inlineCommentDrafts);
  const providerModels = workflowRuns.flatMap((run) => run.providerModels);

  const validated = aggregateValidatedReviews(workflowResults);
  const dedupedInlineCommentDrafts = dedupeInlinePublicationItems(inlineCommentDrafts);
  const publicationPlan = buildPublicationPlan({
    event: options.event,
    template: resolveCommentTemplate(options.project, mainCommentTemplateId),
    mainContributions,
    inlineItems: dedupedInlineCommentDrafts,
    maxInlineComments: config.publication.maxInlineComments,
    metadata: {
      runtimeVersion,
      trustedConfigSha: options.trustedConfigSha,
      trustedConfigHash: options.trustedConfigHash,
      reviewedHeadSha: options.event.headSha,
      providerModels: uniqueStrings(providerModels),
      selectedWorkflows: selectedWorkflows.map((workflow) => workflow.id),
      failedWorkflows: workflowResults
        .filter((result) => result.failures > 0)
        .map((result) => result.workflow.id),
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
    repairAttempted,
  };
}

type SelectedReviewWorkflowRun = {
  workflow: WorkflowRegistryEntry;
  validated: ValidatedReview;
  failures: number;
  mainContributions: MainSectionContribution[];
  inlineCommentDrafts: InlineCommentDraft[];
  providerModels: string[];
  provider: ProviderConfig;
  repairAttempted: boolean;
};

async function runSelectedReviewWorkflow(options: {
  selectedWorkflow: WorkflowRegistryEntry;
  diffManifest: DiffManifest;
  options: RunReviewRuntimeOptions;
  event: PullRequestEventContext;
  config: PiprConfig;
  fallbackProvider: ProviderConfig;
  workflowId?: string;
  workflowInputs?: unknown;
}): Promise<SelectedReviewWorkflowRun> {
  const workflowManifest = filterDiffManifestByPaths(
    options.diffManifest,
    options.selectedWorkflow.paths,
  );
  const selectedProviders = new Map<string, ProviderConfig>();
  let repairAttempted = false;
  const workflow = await executeWorkflow({
    registry: options.options.registry,
    workflowId: options.selectedWorkflow.id,
    event: options.event,
    inputs: options.selectedWorkflow.id === options.workflowId ? options.workflowInputs : undefined,
    config: options.config,
    blocks: reviewWorkflowHandlers({
      options: options.options,
      provider: options.fallbackProvider,
      diffManifest: workflowManifest,
      markRepairAttempted: () => {
        repairAttempted = true;
      },
      setStepProvider: (stepId, selectedProvider) => {
        selectedProviders.set(stepId, selectedProvider);
      },
    }),
  });
  assertWorkflowCompleted(options.selectedWorkflow, workflow.failures);
  const workflowProviders = [...selectedProviders.values()];
  const provider = selectedProviders.get("review") ?? options.fallbackProvider;
  return {
    workflow: workflow.workflow,
    validated: parseValidatedReview(requireStepResult<ValidatedReview>(workflow.state, "review")),
    failures: workflow.failures.length,
    mainContributions: parseMainSectionContributions(
      requireStepResult<MainSectionContribution[]>(workflow.state, "main-comment"),
    ),
    inlineCommentDrafts: parseInlinePublicationItems(
      requireStepResult<InlineCommentDraft[]>(workflow.state, "inline-comments"),
    ),
    providerModels:
      workflowProviders.length > 0
        ? workflowProviders.map((selectedProvider) => selectedProvider.model)
        : [provider.model],
    provider,
    repairAttempted,
  };
}

function resolveCandidateWorkflows(
  registry: RuntimeRegistry,
  event: Pick<PullRequestEventContext, "eventName" | "action">,
  workflowId?: string,
): WorkflowRegistryEntry[] {
  if (!workflowId) {
    return selectWorkflowsForEvent(registry, event);
  }
  const workflow = registry.workflows.find((entry) => entry.id === workflowId);
  if (!workflow) {
    throw new Error(`Unknown workflow '${workflowId}'`);
  }
  return [workflow];
}

function assertReviewWorkflowContract(workflow: WorkflowRegistryEntry): void {
  const stepIds = new Set(workflow.steps.map((step) => step.id));
  const missing = ["review", "main-comment", "inline-comments"].filter(
    (stepId) => !stepIds.has(stepId),
  );
  if (missing.length > 0) {
    throw new Error(
      `Review workflow '${workflow.id}' must include reserved step id(s): ${missing.join(", ")}`,
    );
  }
  const invalid = reservedReviewSteps.filter((reserved) =>
    workflow.steps.some((step) => step.id === reserved.id && step.block !== reserved.block),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Review workflow '${workflow.id}' reserved step(s) must use runtime block(s): ${invalid
        .map((reserved) => `${reserved.id} -> ${reserved.block}`)
        .join(", ")}`,
    );
  }
}

function assertWorkflowCompleted(
  workflow: WorkflowRegistryEntry,
  failures: Array<{ stepId: string; message: string }>,
): void {
  if (failures.length === 0) {
    return;
  }
  const details = failures.map((failure) => `${failure.stepId}: ${failure.message}`).join("; ");
  throw new Error(`Review workflow '${workflow.id}' failed: ${details}`);
}

const reservedReviewSteps = [
  { id: "review", block: "core/run-agent" },
  { id: "main-comment", block: "core/main-comment" },
  { id: "inline-comments", block: "core/inline-comments" },
];

function skippedReviewRuntimeResult(options: {
  config: PiprConfig;
  diffManifest: DiffManifest;
  event: PullRequestEventContext;
  provider: ProviderConfig;
  reason: string;
  trustedConfigSha?: string;
  trustedConfigHash?: string;
}): ReviewRuntimeResult {
  const review: PrReview = { summary: { body: options.reason }, inlineFindings: [] };
  const validated: ValidatedReview = {
    review,
    validFindings: [],
    droppedFindings: [],
  };
  const publicationPlan = buildPublicationPlan({
    event: options.event,
    mainContributions: [],
    inlineItems: [],
    maxInlineComments: options.config.publication.maxInlineComments,
    metadata: {
      runtimeVersion,
      trustedConfigSha: options.trustedConfigSha,
      trustedConfigHash: options.trustedConfigHash,
      reviewedHeadSha: options.event.headSha,
      providerModels: [options.provider.model],
      selectedWorkflows: [],
      failedWorkflows: [],
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

function skipReason(
  candidateWorkflows: WorkflowRegistryEntry[],
  workflowId: string | undefined,
): string {
  if (candidateWorkflows.length === 0) {
    return workflowId
      ? `Workflow '${workflowId}' was not enabled`
      : "No enabled workflows matched the pull request event";
  }
  if (workflowId) {
    return `Workflow '${workflowId}' skipped because no changed files matched its paths`;
  }
  return "No enabled workflows matched the pull request event and changed file paths";
}

function aggregateValidatedReviews(
  workflowResults: Array<{ workflow: WorkflowRegistryEntry; validated: ValidatedReview }>,
): ValidatedReview {
  if (workflowResults.length === 1) {
    return workflowResults[0]?.validated as ValidatedReview;
  }
  const validFindings = workflowResults.flatMap((result) => result.validated.validFindings);
  const droppedFindings = workflowResults.flatMap((result) => result.validated.droppedFindings);
  return {
    review: {
      summary: {
        body: workflowResults
          .map((result) => workflowSummaryLine(result.workflow.id, result.validated.review))
          .join("\n\n"),
      },
      inlineFindings: validFindings,
    },
    validFindings,
    droppedFindings,
  };
}

function workflowSummaryLine(workflowId: string, review: PrReview): string {
  const title = review.summary.title ? `${review.summary.title}: ` : "";
  return `**${workflowId}**: ${title}${review.summary.body}`;
}

function dedupeInlinePublicationItems(items: InlineCommentDraft[]): InlineCommentDraft[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.marker)) {
      return false;
    }
    seen.add(item.marker);
    return true;
  });
}

function readSelectedMainCommentTemplateId(workflows: WorkflowRegistryEntry[]): string | undefined {
  const explicitTemplateIds = workflows
    .map((workflow) => readMainCommentStepTemplateId(workflow))
    .filter((templateId): templateId is string => templateId !== undefined);
  if (explicitTemplateIds.length === 0) {
    return undefined;
  }
  const templateIds = workflows.map(
    (workflow) => readMainCommentStepTemplateId(workflow) ?? "pipr/main",
  );
  const unique = uniqueStrings(templateIds);
  if (unique.length > 1) {
    throw new Error(
      `Selected workflows use mixed Main Review Comment templates: ${unique.join(", ")}`,
    );
  }
  return unique[0];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

type MaterializedAgent = {
  document: Extract<MaterializedProject["components"][number], { kind: "Agent" }>;
  body?: string;
};

type ResolvedAgentRun = {
  agent?: MaterializedAgent;
  inputs: ReturnType<typeof bindAgentInputs> | Record<string, never>;
};

type ReviewWorkflowHandlersOptions = {
  options: RunReviewRuntimeOptions;
  provider: ProviderConfig;
  diffManifest: DiffManifest;
  markRepairAttempted: () => void;
  setStepProvider: (stepId: string, provider: ProviderConfig) => void;
};

function reviewWorkflowHandlers(options: ReviewWorkflowHandlersOptions): WorkflowBlockHandlers {
  const runtime = options.options;
  return {
    "core/run-agent": (input, _context, meta) => runAgentBlock(input, options, meta.stepId),
    "core/main-comment": (input, context) => {
      const value = requireRecord(input, "core/main-comment input");
      return mainCommentContributions(value, context);
    },
    "core/inline-comments": (input) =>
      prepareInlinePublicationItems({
        validated: readValidatedReview(input, "core/inline-comments input"),
        manifest: options.diffManifest,
        reviewedHeadSha: runtime.event.headSha,
      }),
  };
}

function mainCommentContributions(
  input: Record<string, unknown>,
  context: Record<string, unknown>,
): MainSectionContribution[] {
  const workflowId = readWorkflowId(context);
  if (Object.hasOwn(input, "sectionId") || Object.hasOwn(input, "value")) {
    return [
      mainSectionContributionSchema.parse({
        workflowId,
        sectionId: readRequiredString(input, "sectionId", "core/main-comment sectionId"),
        policy: readMergePolicy(input, "merge", "core/main-comment merge"),
        priority: readOptionalInteger(input, "priority") ?? 0,
        value: input.value,
        itemKey: readOptionalString(input, "itemKey", "core/main-comment itemKey"),
      }),
    ];
  }
  const validated = readValidatedReview(input, "core/main-comment input");
  return reviewToMainSectionContributions({
    workflowId,
    validated,
    summaryPolicy: readMergePolicy(input, "merge", "core/main-comment merge"),
    summaryPriority: readOptionalInteger(input, "priority"),
  });
}

async function runAgentBlock(
  input: unknown,
  options: ReviewWorkflowHandlersOptions,
  stepId: string,
): Promise<ValidatedReview> {
  const runtime = options.options;
  const agentRun = resolveAgentRun(runtime.project, input);
  const agentManifest = agentRun.agent
    ? filterDiffManifestByPaths(options.diffManifest, agentRun.agent.document.paths)
    : options.diffManifest;
  if (agentManifest.files.length === 0) {
    return emptyValidatedReview(skippedAgentSummary(agentRun.agent));
  }

  const provider = selectAgentProvider(runtime, options.provider, agentRun);
  options.setStepProvider(stepId, provider);
  const result = await runReviewerAgent({
    provider,
    diffManifest: agentManifest,
    diffManifestLimits: runtime.config.limits?.diffManifest,
    event: runtime.event,
    env: runtime.env,
    workspace: runtime.workspace,
    agentInstructions: renderAgentInstructions(agentRun),
    outputSchemaId: agentRun.agent?.document.output.schema,
    piExecutable: runtime.piExecutable,
    piRunner: runtime.piRunner,
    timeoutSeconds: runtime.config.limits?.timeoutSeconds,
  });
  if (result.repairAttempted) {
    options.markRepairAttempted();
  }
  return validatePrReview(result.review, agentManifest, {
    minConfidence: runtime.config.publication.minConfidence,
    expectedHeadSha: runtime.event.headSha,
  });
}

function resolveAgentRun(
  project: MaterializedProject | undefined,
  input: unknown,
): ResolvedAgentRun {
  const agentInput = readAgentInput(input);
  const agent = resolveReviewerAgent(project, agentInput.agent);
  return {
    agent,
    inputs: agent
      ? bindAgentInputs(agent.document, agentInput.inputs)
      : readNoAgentInputs(agentInput.inputs),
  };
}

function selectAgentProvider(
  runtime: RunReviewRuntimeOptions,
  fallbackProvider: ProviderConfig,
  agentRun: ResolvedAgentRun,
): ProviderConfig {
  if (runtime.providerOverride) {
    return runtime.providerOverride;
  }
  return agentRun.agent
    ? resolveAgentProvider(runtime.config, agentRun.agent.document, agentRun.inputs)
    : fallbackProvider;
}

function renderAgentInstructions(agentRun: ResolvedAgentRun): string | undefined {
  return agentRun.agent
    ? renderAgentBodyTemplate(agentRun.agent.document.id, agentRun.agent.body, agentRun.inputs)
    : undefined;
}

function skippedAgentSummary(agent: MaterializedAgent | undefined): string {
  return `Agent '${agent?.document.id ?? "core/run-agent"}' skipped because no changed files matched its paths`;
}

type AgentRunInput = {
  agent?: string;
  inputs?: unknown;
};

function readAgentInput(input: unknown): AgentRunInput {
  const value = requireRecord(input, "core/run-agent input");
  return {
    agent: typeof value.agent === "string" ? value.agent : undefined,
    inputs: Object.hasOwn(value, "inputs") ? value.inputs : undefined,
  };
}

function readNoAgentInputs(inputs: unknown): Record<string, never> {
  if (inputs !== undefined) {
    throw new Error("core/run-agent inputs require an Agent id");
  }
  return {};
}

function emptyValidatedReview(summary: string): ValidatedReview {
  return {
    review: {
      summary: { body: summary },
      inlineFindings: [],
    },
    validFindings: [],
    droppedFindings: [],
  };
}

function resolveReviewerAgent(
  project: MaterializedProject | undefined,
  agentId: string | undefined,
):
  | {
      document: Extract<MaterializedProject["components"][number], { kind: "Agent" }>;
      body?: string;
    }
  | undefined {
  if (!project || !agentId) {
    return undefined;
  }
  const agent = project.componentFiles[agentId];
  if (!agent) {
    throw new Error(`Unknown reviewer Agent '${agentId}'`);
  }
  if (agent.document.kind !== "Agent") {
    throw new Error(`Reviewer Agent '${agentId}' resolved to ${agent.document.kind}`);
  }
  if (agent.document.output.schema !== prReviewSchemaId) {
    throw new Error(
      `Reviewer Agent '${agentId}' uses unsupported output schema '${agent.document.output.schema}'`,
    );
  }
  return {
    document: agent.document,
    body: agent.body,
  };
}

function resolveAgentProvider(
  config: PiprConfig,
  agent: Extract<MaterializedProject["components"][number], { kind: "Agent" }>,
  inputs: ReturnType<typeof bindAgentInputs>,
): ProviderConfig {
  const provider = resolveAgentProviderTemplate(agent.provider, inputs);
  if (typeof provider === "string") {
    return resolveProvider(config, provider);
  }
  if (!isRecord(provider)) {
    throw new Error(`Agent '${agent.id}' provider must resolve to provider id or provider object`);
  }
  if (Object.hasOwn(provider, "id")) {
    throw new Error(`Agent '${agent.id}' inline provider must not include id`);
  }
  return parseProviderConfig({
    id: inlineProviderId(agent.id),
    ...provider,
  });
}

function inlineProviderId(agentId: string): string {
  return `inline_${agentId.replace(/[^a-z0-9_-]/g, "_")}`;
}

function readValidatedReview(input: unknown, label: string): ValidatedReview {
  const value = requireRecord(input, label);
  return parseValidatedReview(value.review);
}

function readRequiredString(input: Record<string, unknown>, key: string, label: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(
  input: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  if (!Object.hasOwn(input, key)) {
    return undefined;
  }
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function readOptionalInteger(input: Record<string, unknown>, key: string): number | undefined {
  if (!Object.hasOwn(input, key)) {
    return undefined;
  }
  const value = input[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`core/main-comment ${key} must be an integer`);
  }
  return value;
}

function readMergePolicy(
  input: Record<string, unknown>,
  key: string,
  label: string,
): MainSectionMergePolicy {
  if (!Object.hasOwn(input, key)) {
    return "exclusive";
  }
  const value = input[key];
  if (value !== "exclusive" && value !== "replace" && value !== "append" && value !== "list") {
    throw new Error(`${label} must be exclusive, replace, append, or list`);
  }
  return value;
}

function readOptionalTemplateId(input: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(input, "template")) {
    return undefined;
  }
  if (typeof input.template !== "string") {
    throw new Error("core/main-comment template must be a CommentTemplate id string");
  }
  return input.template;
}

function readMainCommentStepTemplateId(workflow: WorkflowRegistryEntry): string | undefined {
  const step = workflow.steps.find((item) => item.id === "main-comment");
  const input = step?.with;
  return input && typeof input === "object" && !Array.isArray(input)
    ? readOptionalTemplateId(input as Record<string, unknown>)
    : undefined;
}

function readWorkflowId(context: Record<string, unknown>): string {
  return typeof context.workflowId === "string" ? context.workflowId : "pipr/review";
}

function resolveCommentTemplate(
  project: MaterializedProject | undefined,
  templateId: unknown,
): Extract<MaterializedProject["components"][number], { kind: "CommentTemplate" }> | undefined {
  if (!project || typeof templateId !== "string") {
    return undefined;
  }
  const template = project.componentFiles[templateId];
  if (!template) {
    throw new Error(`Unknown Main Review Comment template '${templateId}'`);
  }
  if (template.document.kind !== "CommentTemplate") {
    throw new Error(
      `Main Review Comment template '${templateId}' resolved to ${template.document.kind}`,
    );
  }
  return template.document;
}

function requireStepResult<T>(state: WorkflowState, stepId: string): T {
  const output = state.steps[stepId]?.outputs.result;
  if (output === undefined) {
    throw new Error(`Review workflow did not produce step '${stepId}' result`);
  }
  return output as T;
}

export async function runReviewerAgent(options: {
  provider: ProviderConfig;
  diffManifest: DiffManifest;
  diffManifestLimits?: DiffManifestLimitsConfig;
  event: PullRequestEventContext;
  env?: NodeJS.ProcessEnv;
  workspace: string;
  agentInstructions?: string;
  outputSchemaId?: string;
  piExecutable?: string;
  piRunner?: PiRunner;
  timeoutSeconds?: number;
}): Promise<{ review: PrReview; repairAttempted: boolean }> {
  const piRunner = options.piRunner ?? runPi;
  const manifestPrompt = prepareDiffManifestPrompt(
    options.diffManifest,
    options.diffManifestLimits,
  );
  const prompt = buildReviewerPrompt({
    event: options.event,
    diffManifestPrompt: manifestPrompt,
    agentInstructions: options.agentInstructions,
    outputSchemaId: options.outputSchemaId,
  });
  const first = await runPiOnce(piRunner, {
    workspace: options.workspace,
    provider: options.provider,
    prompt,
    env: options.env,
    piExecutable: options.piExecutable,
    runtimeTools:
      manifestPrompt.mode === "condensed"
        ? {
            manifest: options.diffManifest,
            toolResponseMaxBytes: manifestPrompt.limits.toolResponseMaxBytes,
          }
        : undefined,
    timeoutSeconds: options.timeoutSeconds,
  });
  const parsed = parseReviewOutput(first.stdout);
  if (parsed.ok) {
    return { review: parsed.review, repairAttempted: false };
  }

  const repair = await runPiOnce(piRunner, {
    workspace: options.workspace,
    provider: options.provider,
    prompt: buildRepairPrompt({
      originalPrompt: prompt,
      invalidOutput: first.stdout,
      error: parsed.error,
    }),
    env: options.env,
    piExecutable: options.piExecutable,
    runtimeTools:
      manifestPrompt.mode === "condensed"
        ? {
            manifest: options.diffManifest,
            toolResponseMaxBytes: manifestPrompt.limits.toolResponseMaxBytes,
          }
        : undefined,
    timeoutSeconds: options.timeoutSeconds,
  });
  const repaired = parseReviewOutput(repair.stdout);
  if (repaired.ok) {
    return { review: repaired.review, repairAttempted: true };
  }

  throw new Error(
    `Pi reviewer output failed schema validation after repair attempt: ${repaired.error}`,
  );
}

export function buildReviewerPrompt(options: {
  event: PullRequestEventContext;
  diffManifestPrompt: PreparedDiffManifestPrompt;
  agentInstructions?: string;
  outputSchemaId?: string;
}): string {
  const outputSchemaId = options.outputSchemaId ?? prReviewSchemaId;
  const runtimeToolText =
    options.diffManifestPrompt.mode === "condensed"
      ? "Runtime-owned tools attached: pipr_read_diff(path?, rangeId?) and pipr_read_at_ref(path, ref, rangeId). Use them when the condensed manifest lacks needed context. Ref reads are range-scoped and may return unavailable for opposite-side ranges."
      : "Runtime-owned pipr read tools are not attached because the full Diff Manifest is available.";
  const availableTools =
    options.diffManifestPrompt.mode === "condensed"
      ? [...piReadOnlyToolNames, ...piRuntimeReadToolNames]
      : piReadOnlyToolNames;
  return [
    "You are pipr's reviewer agent for a GitHub pull request.",
    options.agentInstructions ? `Agent Instructions:\n\n${options.agentInstructions}` : undefined,
    `Available Pi tools: ${availableTools.join(", ")}.`,
    runtimeToolText,
    "Do not use bash, write, edit, GitHub APIs, or comment publishing tools.",
    "Return only valid JSON. Do not include Markdown fences or prose outside JSON.",
    `Output Schema ID: ${outputSchemaId}`,
    "The JSON must match this schema shape:",
    JSON.stringify(reviewSchemaExample(), null, 2),
    "Rules:",
    "- inlineFindings must only target commentableRanges from the Diff Manifest.",
    "- rangeId, path, side, startLine, and endLine must match the chosen range.",
    "- Use same-range inline comments only.",
    "- Set confidence from 0 to 1.",
    "- Use inlineFindings: [] when no high-confidence finding exists.",
    "Pull Request:",
    JSON.stringify(
      {
        repo: options.event.repo,
        pullRequestNumber: options.event.pullRequestNumber,
        baseSha: options.event.baseSha,
        headSha: options.event.headSha,
      },
      null,
      2,
    ),
    "Diff Manifest Payload:",
    JSON.stringify(
      {
        mode: options.diffManifestPrompt.mode,
        fullBytes: options.diffManifestPrompt.metrics.full.bytes,
        fullEstimatedTokens: options.diffManifestPrompt.metrics.full.estimatedTokens,
        selectedBytes: options.diffManifestPrompt.metrics.selected.bytes,
        selectedEstimatedTokens: options.diffManifestPrompt.metrics.selected.estimatedTokens,
      },
      null,
      2,
    ),
    "Diff Manifest:",
    JSON.stringify(options.diffManifestPrompt.manifest, null, 2),
  ]
    .filter((part) => part !== undefined)
    .join("\n\n");
}

function buildRepairPrompt(options: {
  originalPrompt: string;
  invalidOutput: string;
  error: string;
}): string {
  return [
    "Repair the previous reviewer output so it is valid JSON matching the requested schema.",
    "Return only the repaired JSON.",
    "Schema validation error:",
    options.error,
    "Invalid output:",
    options.invalidOutput,
    "Original review request:",
    options.originalPrompt,
  ].join("\n\n");
}

async function runPiOnce(piRunner: PiRunner, options: PiRunOptions): Promise<PiRunResult> {
  const result = await piRunner(options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    throw new Error(`Pi reviewer failed with exit ${result.exitCode}: ${detail}`);
  }
  return result;
}

function parseReviewOutput(output: string): ParseReviewResult {
  try {
    return { ok: true, review: parsePrReview(JSON.parse(output)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
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
