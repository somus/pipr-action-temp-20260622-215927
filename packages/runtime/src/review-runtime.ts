import {
  type InlineCommentDraft,
  prepareInlineCommentDrafts,
  renderMainComment,
} from "./comment.js";
import { type BuildDiffManifestOptions, buildDiffManifest } from "./diff.js";
import { type PiRunOptions, type PiRunResult, runPi } from "./pi.js";
import { createRuntimeRegistry } from "./registry.js";
import { parsePrReview, validatePrReview } from "./review.js";
import type {
  DiffManifest,
  PiprConfig,
  ProviderConfig,
  PrReview,
  PullRequestEventContext,
  RuntimeRegistry,
  ValidatedReview,
} from "./types.js";
import { executeWorkflow, type WorkflowBlockHandlers } from "./workflow.js";

export type PiRunner = (options: PiRunOptions) => Promise<PiRunResult>;
export type DiffManifestBuilder = (options: BuildDiffManifestOptions) => DiffManifest;

export type RunReviewRuntimeOptions = {
  workspace: string;
  config: PiprConfig;
  event: PullRequestEventContext;
  registry?: RuntimeRegistry;
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
  const provider = resolveDefaultProvider(options.config);
  let repairAttempted = false;
  let diffManifest: DiffManifest | undefined;
  const workflow = await executeWorkflow({
    registry: options.registry ?? createRuntimeRegistry(),
    event: options.event,
    blocks: reviewWorkflowHandlers({
      options,
      provider,
      markRepairAttempted: () => {
        repairAttempted = true;
      },
      setDiffManifest: (manifest) => {
        diffManifest = manifest;
      },
    }),
  });
  const validated = requireContextValue<ValidatedReview>(workflow.context, "validated_review");
  const mainComment = requireContextValue<string>(workflow.context, "main_comment");
  const inlineCommentDrafts = requireContextValue<InlineCommentDraft[]>(
    workflow.context,
    "inline_comments",
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

function reviewWorkflowHandlers(options: {
  options: RunReviewRuntimeOptions;
  provider: ProviderConfig;
  markRepairAttempted: () => void;
  setDiffManifest: (manifest: DiffManifest) => void;
}): WorkflowBlockHandlers {
  const runtime = options.options;
  return {
    "context.diff_manifest": () => {
      const manifest = (runtime.diffManifestBuilder ?? buildDiffManifest)({
        cwd: runtime.workspace,
        baseSha: runtime.event.baseSha,
        headSha: runtime.event.headSha,
      });
      options.setDiffManifest(manifest);
      return manifest;
    },
    "agent.run": async (input) => {
      const diffManifest = readAgentInput(input);
      const result = await runReviewerAgent({
        provider: options.provider,
        diffManifest,
        event: runtime.event,
        workspace: runtime.workspace,
        piExecutable: runtime.piExecutable,
        piRunner: runtime.piRunner,
      });
      if (result.repairAttempted) {
        options.markRepairAttempted();
      }
      return result.review;
    },
    "validate.pr_review": (input) => {
      const value = requireRecord(input, "validate.pr_review input");
      return validatePrReview(value.review as PrReview, value.manifest as DiffManifest, {
        maxInlineComments: runtime.config.review.max_inline_comments,
        minConfidence: runtime.config.review.min_confidence,
      });
    },
    "publish.main_comment": (input) => {
      const validated = readValidatedReview(input, "publish.main_comment input");
      return renderMainComment({
        event: runtime.event,
        review: validated.review,
        validFindings: validated.validFindings,
        droppedCount: validated.droppedFindings.length,
        providerModel: options.provider.model,
      });
    },
    "publish.inline_comments": (input) =>
      prepareInlineCommentDrafts(readValidatedReview(input, "publish.inline_comments input")),
  };
}

function readAgentInput(input: unknown): DiffManifest {
  const value = requireRecord(input, "agent.run input");
  return value.input as DiffManifest;
}

function readValidatedReview(input: unknown, label: string): ValidatedReview {
  const value = requireRecord(input, label);
  return value.review as ValidatedReview;
}

function requireContextValue<T>(context: Record<string, unknown>, key: string): T {
  if (!hasOwn(context, key)) {
    throw new Error(`Review workflow did not produce '${key}'`);
  }
  return context[key] as T;
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
  workspace: string;
  piExecutable?: string;
  piRunner?: PiRunner;
}): Promise<{ review: PrReview; repairAttempted: boolean }> {
  const piRunner = options.piRunner ?? runPi;
  const prompt = buildReviewerPrompt({
    event: options.event,
    diffManifest: options.diffManifest,
  });
  const first = await runPiOnce(piRunner, {
    workspace: options.workspace,
    provider: options.provider,
    prompt,
    piExecutable: options.piExecutable,
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
    piExecutable: options.piExecutable,
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
}): string {
  return [
    "You are pipr's reviewer agent for a GitHub pull request.",
    "Return only valid JSON. Do not include Markdown fences or prose outside JSON.",
    "The JSON must match this shape:",
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
  ].join("\n\n");
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
  const provider = config.providers.find((item) => item.id === config.default_provider);
  if (!provider) {
    throw new Error(`default_provider '${config.default_provider}' does not match any provider id`);
  }
  return provider;
}

function reviewSchemaExample(): PrReview {
  return {
    summary: {
      body: "Concise pull request review summary.",
    },
    inlineFindings: [
      {
        title: "Short finding title",
        body: "Specific issue and why it matters.",
        path: "src/example.ts",
        rangeId: "rng_example",
        side: "RIGHT",
        startLine: 1,
        endLine: 1,
        severity: "medium",
        category: "correctness",
        confidence: 0.9,
        evidenceSnippet: "changed code excerpt",
        suggestedFix: "Optional fix.",
        semanticAnchor: "Optional symbol or behavior.",
        fingerprintHint: "Optional stable dedupe hint.",
      },
    ],
    metadata: {},
  };
}
