import {
  type InlineCommentDraft,
  prepareInlineCommentDrafts,
  renderMainComment,
} from "./comment.js";
import { type BuildDiffManifestOptions, buildDiffManifest } from "./diff.js";
import { type PiRunOptions, type PiRunResult, runPi } from "./pi.js";
import { parsePrReview, validatePrReview } from "./review.js";
import type {
  DiffManifest,
  PiprConfig,
  ProviderConfig,
  PrReview,
  PullRequestEventContext,
  ValidatedReview,
} from "./types.js";

export type PiRunner = (options: PiRunOptions) => Promise<PiRunResult>;
export type DiffManifestBuilder = (options: BuildDiffManifestOptions) => DiffManifest;

export type RunReviewRuntimeOptions = {
  workspace: string;
  config: PiprConfig;
  event: PullRequestEventContext;
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
  const diffManifest = (options.diffManifestBuilder ?? buildDiffManifest)({
    cwd: options.workspace,
    baseSha: options.event.baseSha,
    headSha: options.event.headSha,
  });
  const agentResult = await runReviewerAgent({
    provider,
    diffManifest,
    event: options.event,
    workspace: options.workspace,
    piExecutable: options.piExecutable,
    piRunner: options.piRunner,
  });
  const validated = validatePrReview(agentResult.review, diffManifest, {
    maxInlineComments: options.config.review.max_inline_comments,
    minConfidence: options.config.review.min_confidence,
  });
  const mainComment = renderMainComment({
    event: options.event,
    review: agentResult.review,
    validFindings: validated.validFindings,
    droppedCount: validated.droppedFindings.length,
    providerModel: provider.model,
  });

  return {
    provider,
    diffManifest,
    review: agentResult.review,
    validated,
    mainComment,
    inlineCommentDrafts: prepareInlineCommentDrafts(validated),
    repairAttempted: agentResult.repairAttempted,
  };
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
