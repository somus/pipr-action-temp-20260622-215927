import type { MaterializedProject } from "../config/config.js";
import { type BuildDiffManifestOptions, buildDiffManifest } from "../diff/diff.js";
import { piReadOnlyToolNames } from "../pi/contract.js";
import { type PiRunOptions, type PiRunResult, runPi } from "../pi/runner.js";
import type {
  DiffManifest,
  PiprConfig,
  ProviderConfig,
  PrReview,
  PullRequestEventContext,
  RuntimeRegistry,
  ValidatedReview,
} from "../types.js";
import {
  parseDiffManifest,
  parsePiprConfig,
  parseProviderConfig,
  parseValidatedReview,
} from "../types.js";
import {
  executeWorkflow,
  selectWorkflowForEvent,
  type WorkflowBlockHandlers,
  type WorkflowState,
} from "../workflow/workflow.js";
import {
  type InlineCommentDraft,
  parseInlineCommentDrafts,
  prepareInlineCommentDrafts,
  renderMainComment,
} from "./comment.js";
import { parsePrReview, reviewSchemaExample, validatePrReview } from "./review.js";

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
  piExecutable?: string;
  piRunner?: PiRunner;
  diffManifestBuilder?: DiffManifestBuilder;
};

export type ReviewRuntimeResult = {
  provider: ProviderConfig;
  diffManifest: DiffManifest;
  review: PrReview;
  validated: ValidatedReview;
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
  let repairAttempted = false;
  let diffManifest: DiffManifest | undefined;
  assertReviewWorkflowContract(options.registry, options.event);
  const workflow = await executeWorkflow({
    registry: options.registry,
    event: options.event,
    config,
    blocks: reviewWorkflowHandlers({
      options: { ...options, config, providerOverride },
      provider,
      markRepairAttempted: () => {
        repairAttempted = true;
      },
      setDiffManifest: (manifest) => {
        diffManifest = manifest;
      },
      setProvider: (selectedProvider) => {
        provider = selectedProvider;
      },
      getProvider: () => provider,
    }),
  });
  const validated = parseValidatedReview(
    requireStepResult<ValidatedReview>(workflow.state, "review"),
  );
  const mainComment = requireStepResult<string>(workflow.state, "main-comment");
  const inlineCommentDrafts = parseInlineCommentDrafts(
    requireStepResult<InlineCommentDraft[]>(workflow.state, "inline-comments"),
  );

  return {
    provider,
    diffManifest: requireWorkflowValue(diffManifest, "diff_manifest"),
    review: validated.review,
    validated,
    mainComment,
    inlineCommentDrafts,
    repairAttempted,
  };
}

function assertReviewWorkflowContract(
  registry: RuntimeRegistry,
  event: Pick<PullRequestEventContext, "eventName" | "action">,
): void {
  const workflow = selectWorkflowForEvent(registry, event);
  if (!workflow) {
    return;
  }
  const stepIds = new Set(workflow.steps.map((step) => step.id));
  const missing = ["review", "main-comment", "inline-comments"].filter(
    (stepId) => !stepIds.has(stepId),
  );
  if (missing.length > 0) {
    throw new Error(
      `Review workflow '${workflow.id}' must include reserved step id(s): ${missing.join(", ")}`,
    );
  }
}

function reviewWorkflowHandlers(options: {
  options: RunReviewRuntimeOptions;
  provider: ProviderConfig;
  markRepairAttempted: () => void;
  setDiffManifest: (manifest: DiffManifest) => void;
  setProvider: (provider: ProviderConfig) => void;
  getProvider: () => ProviderConfig;
}): WorkflowBlockHandlers {
  const runtime = options.options;
  return {
    "core/run-agent": async (input) => {
      const agentInput = readAgentInput(input);
      const manifest = parseDiffManifest(
        (runtime.diffManifestBuilder ?? buildDiffManifest)({
          cwd: runtime.workspace,
          baseSha: runtime.event.baseSha,
          headSha: runtime.event.headSha,
        }),
      );
      options.setDiffManifest(manifest);
      const agent = resolveReviewerAgent(runtime.project, agentInput.agent);
      const provider =
        runtime.providerOverride ??
        (agent ? resolveProvider(runtime.config, agent.document.provider) : options.provider);
      options.setProvider(provider);
      const result = await runReviewerAgent({
        provider,
        diffManifest: manifest,
        event: runtime.event,
        env: runtime.env,
        workspace: runtime.workspace,
        agentInstructions: agent?.body,
        outputSchemaId: agent?.document.output.schema,
        piExecutable: runtime.piExecutable,
        piRunner: runtime.piRunner,
        timeoutSeconds: runtime.config.limits?.timeoutSeconds,
      });
      if (result.repairAttempted) {
        options.markRepairAttempted();
      }
      return validatePrReview(result.review, manifest, {
        maxInlineComments: runtime.config.publication.maxInlineComments,
        minConfidence: runtime.config.publication.minConfidence,
      });
    },
    "core/main-comment": (input) => {
      const value = requireRecord(input, "core/main-comment input");
      const validated = readValidatedReview(value, "core/main-comment input");
      return renderMainComment({
        event: runtime.event,
        review: validated.review,
        validFindings: validated.validFindings,
        droppedCount: validated.droppedFindings.length,
        providerModel: options.getProvider().model,
        template: resolveCommentTemplate(runtime.project, readOptionalTemplateId(value)),
      });
    },
    "core/inline-comments": (input) =>
      prepareInlineCommentDrafts(readValidatedReview(input, "core/inline-comments input")),
  };
}

type AgentRunInput = {
  agent?: string;
};

function readAgentInput(input: unknown): AgentRunInput {
  const value = requireRecord(input, "core/run-agent input");
  return {
    agent: typeof value.agent === "string" ? value.agent : undefined,
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
  if (agent.document.output.schema !== "pipr/pr-review") {
    throw new Error(
      `Reviewer Agent '${agentId}' uses unsupported output schema '${agent.document.output.schema}'`,
    );
  }
  return {
    document: agent.document,
    body: agent.body,
  };
}

function readValidatedReview(input: unknown, label: string): ValidatedReview {
  const value = requireRecord(input, label);
  return parseValidatedReview(value.review);
}

function readOptionalTemplateId(input: Record<string, unknown>): string | undefined {
  if (!hasOwn(input, "template")) {
    return undefined;
  }
  if (typeof input.template !== "string") {
    throw new Error("core/main-comment template must be a CommentTemplate id string");
  }
  return input.template;
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

function requireWorkflowValue<T>(value: T | undefined, key: string): T {
  if (value === undefined) {
    throw new Error(`Review workflow did not produce '${key}'`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

export async function runReviewerAgent(options: {
  provider: ProviderConfig;
  diffManifest: DiffManifest;
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
  const prompt = buildReviewerPrompt({
    event: options.event,
    diffManifest: options.diffManifest,
    agentInstructions: options.agentInstructions,
    outputSchemaId: options.outputSchemaId,
  });
  const first = await runPiOnce(piRunner, {
    workspace: options.workspace,
    provider: options.provider,
    prompt,
    env: options.env,
    piExecutable: options.piExecutable,
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
  diffManifest: DiffManifest;
  agentInstructions?: string;
  outputSchemaId?: string;
}): string {
  const outputSchemaId = options.outputSchemaId ?? "pipr/pr-review";
  return [
    "You are pipr's reviewer agent for a GitHub pull request.",
    options.agentInstructions ? `Agent Instructions:\n\n${options.agentInstructions}` : undefined,
    `Available Pi tools: ${piReadOnlyToolNames.join(", ")}.`,
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
    "Diff Manifest:",
    JSON.stringify(options.diffManifest, null, 2),
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
