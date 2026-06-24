import type {
  CommentOptions,
  CommentSource,
  DiffManifestOptions,
  PathFilter,
  ReviewFinding,
  RuntimePlan,
  TaskContext,
} from "@pipr/sdk";
import { uniq } from "lodash-es";
import { selectRuntimeTasks } from "../config/task-selection.js";
import { type BuildDiffManifestOptions, buildDiffManifest } from "../diff/diff.js";
import { filterDiffManifestByPaths } from "../diff/path-filter.js";
import type {
  ChangeRequestEventContext,
  DiffManifest,
  PiprConfig,
  ProviderConfig,
  PrReview,
  ValidatedReview,
} from "../types.js";
import { parseDiffManifest, parsePiprConfig, parseProviderConfig } from "../types.js";
import {
  type InlineCommentDraft,
  type MainCommentContribution,
  type PublicationPlan,
  runtimeVersion,
} from "./comment.js";
import { buildCommentPublishingPlan } from "./comment-publishing.js";
import { type PriorReviewState, priorReviewStateForSelectedTasks } from "./prior-state.js";
import { validatePrReview } from "./review.js";
import { type PiRunner, resolveProvider, runReviewAgent } from "./review-run.js";

export type { PiRunner } from "./review-run.js";
export type DiffManifestBuilder = (options: BuildDiffManifestOptions) => DiffManifest;

export type RunTaskRuntimeOptions = {
  workspace: string;
  config: PiprConfig;
  event: ChangeRequestEventContext;
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
  priorReviewState?: PriorReviewState;
  priorMainComment?: string;
  loadPriorReviewState?: () => Promise<PriorReviewState | undefined>;
  loadPriorMainComment?: () => Promise<string | undefined>;
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
  mainContributions: MainCommentContribution[];
  findings: FindingContribution[];
  findingScopes: WeakMap<readonly ReviewFinding[], PathFilter>;
  providerModels: string[];
  repairAttempted: boolean;
};

type FindingContribution = {
  finding: ReviewFinding;
  paths?: PathFilter;
};

type TaskRunResult = {
  taskName: string;
  output: OutputState;
};

export async function runTaskRuntime(options: RunTaskRuntimeOptions): Promise<ReviewRuntimeResult> {
  const config = parsePiprConfig(options.config);
  const provider = options.providerOverride
    ? parseProviderConfig(options.providerOverride)
    : resolveProvider(config, config.defaultProvider);
  const diffManifest = parseDiffManifest(
    (options.diffManifestBuilder ?? buildDiffManifest)({
      cwd: options.workspace,
      baseSha: options.event.change.base.sha,
      headSha: options.event.change.head.sha,
    }),
  );
  const tasks = selectRuntimeTasks({
    plan: options.plan,
    event: options.event,
    taskName: options.taskName,
  });
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
  const selectedTasks = tasks.map((task) => task.name);
  const loadedPriorReviewState =
    options.priorReviewState ?? (await options.loadPriorReviewState?.());
  const priorMainComment = options.priorMainComment ?? (await options.loadPriorMainComment?.());
  const priorReviewState = priorReviewStateForSelectedTasks(loadedPriorReviewState, selectedTasks);
  const runtimeOptions = { ...options, priorReviewState };

  const manifestCache = new Map<string, DiffManifest>();
  const taskResults = await Promise.all(
    tasks.map(async (task, taskOrder) => {
      const output = createOutputState();
      await task.handler(
        createTaskContext({
          ...runtimeOptions,
          config,
          provider,
          diffManifest,
          manifestCache,
          output,
          taskName: task.name,
          taskOrder,
        }),
        task.name === options.taskName ? (options.taskInput as never) : (undefined as never),
      );
      return { taskName: task.name, output };
    }),
  );
  const output = mergeTaskOutputs(taskResults);

  const review = collectedReview(output);
  const validated = validatePrReview(review, diffManifest, {
    expectedHeadSha: options.event.change.head.sha,
    pathScopeForFinding: (_finding, index) => output.findings[index]?.paths,
  });
  const publishing = buildCommentPublishingPlan({
    event: options.event,
    mainContributions: output.mainContributions,
    validated,
    manifest: diffManifest,
    maxInlineComments: config.publication.maxInlineComments,
    priorReviewState,
    priorMainComment,
    metadata: {
      runtimeVersion,
      trustedConfigSha: options.trustedConfigSha,
      trustedConfigHash: options.trustedConfigHash,
      reviewedHeadSha: options.event.change.head.sha,
      providerModels:
        output.providerModels.length > 0 ? uniq(output.providerModels) : [provider.model],
      selectedTasks,
      failedTasks: [],
      validFindings: validated.validFindings.length,
      droppedFindings: validated.droppedFindings.length,
    },
  });
  const publicationPlan = publishing.publicationPlan;

  return {
    kind: "review",
    provider,
    diffManifest,
    review: validated.review,
    validated,
    publicationPlan,
    mainComment: publicationPlan.mainComment,
    inlineCommentDrafts: publishing.inlineCommentDrafts,
    repairAttempted: output.repairAttempted,
  };
}

function createTaskContext(
  options: RunTaskRuntimeOptions & {
    config: PiprConfig;
    provider: ProviderConfig;
    diffManifest: DiffManifest;
    manifestCache: Map<string, DiffManifest>;
    output: OutputState;
    taskName: string;
    taskOrder: number;
  },
): TaskContext {
  return {
    run: { id: crypto.randomUUID() },
    repository: {
      root: options.workspace,
      name: options.event.repository.slug.split("/").at(-1) ?? "repo",
    },
    change: {
      number: options.event.change.number,
      title: options.event.change.title,
      description: options.event.change.description,
      url: options.event.change.url,
      author: options.event.change.author,
      base: options.event.change.base,
      head: options.event.change.head,
      isFork: options.event.change.isFork,
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
        return options.event.change.head.sha;
      },
    },
    platform: { id: options.event.platform.id },
    pi: {
      async run(agent, input, runOptions) {
        const result = await runReviewAgent({
          agent,
          input,
          runOptions,
          runtime: options,
        });
        options.output.providerModels.push(...result.providerModels);
        if (result.repairAttempted) {
          options.output.repairAttempted = true;
        }
        trackResultFindingScope(options.output, result.value, runOptions?.paths);
        return result.value as never;
      },
    },
    async comment(source, commentOptions) {
      await collectComment(options.output, source, {
        key: commentOptions?.key ?? `default/${options.taskName}`,
        order: commentOptions?.order ?? options.taskOrder,
        paths: commentOptions?.paths,
      });
    },
    log: console,
  };
}

function mergeTaskOutputs(results: TaskRunResult[]): OutputState {
  const merged = createOutputState();
  for (const { output } of results) {
    merged.mainContributions.push(...output.mainContributions);
    merged.findings.push(...output.findings);
    merged.providerModels.push(...output.providerModels);
    merged.repairAttempted ||= output.repairAttempted;
  }
  return merged;
}

function manifestForOptions(
  manifest: DiffManifest,
  options: DiffManifestOptions | undefined,
): DiffManifest {
  if (!manifestOptionsHaveEffect(options)) {
    return manifest;
  }
  const manifestOptions = options ?? {};
  const scopedManifest = filterDiffManifestByPaths(manifest, manifestOptions.paths);
  return parseDiffManifest({
    ...scopedManifest,
    files: scopedManifest.files.map((file) => ({
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

function manifestOptionsHaveEffect(options: DiffManifestOptions | undefined): boolean {
  return Boolean(
    options?.compressed ||
      options?.includePreviews === false ||
      options?.maxPreviewLines !== undefined ||
      options?.paths,
  );
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
): DiffManifest["files"][number]["commentableRanges"][number] {
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
    mainContributions: [],
    findings: [],
    findingScopes: new WeakMap(),
    providerModels: [],
    repairAttempted: false,
  };
}

async function collectComment(
  state: OutputState,
  source: CommentSource,
  options: Required<Pick<CommentOptions, "key" | "order">> & Pick<CommentOptions, "paths">,
): Promise<void> {
  const value = typeof source === "function" ? await source() : source;
  if (value === null) {
    state.mainContributions.push({ key: options.key, order: options.order, body: null });
    return;
  }
  if (typeof value === "string") {
    state.mainContributions.push({ key: options.key, order: options.order, body: value });
    return;
  }
  collectInlineFindings(state, value.inlineFindings, options.paths);
  if (value.main !== undefined) {
    state.mainContributions.push({ key: options.key, order: options.order, body: value.main });
  }
}

function collectInlineFindings(
  state: OutputState,
  findings: readonly ReviewFinding[] | undefined,
  paths: PathFilter | undefined,
): void {
  if (!findings) {
    return;
  }
  const scope = paths ?? state.findingScopes.get(findings);
  state.findings.push(...findings.map((finding) => ({ finding, paths: scope })));
}

function trackResultFindingScope(
  state: OutputState,
  value: unknown,
  paths: PathFilter | undefined,
): void {
  if (!paths || !hasInlineFindings(value)) {
    return;
  }
  state.findingScopes.set(value.inlineFindings, paths);
}

function hasInlineFindings(value: unknown): value is { inlineFindings: readonly ReviewFinding[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { inlineFindings?: unknown }).inlineFindings)
  );
}

function collectedReview(output: OutputState): PrReview {
  return {
    summary: {
      body:
        output.mainContributions.length > 0 || output.findings.length > 0
          ? "Review completed."
          : "No comment produced.",
    },
    inlineFindings: output.findings.map((item) => item.finding),
  };
}

function skippedTaskRuntimeResult(options: {
  config: PiprConfig;
  diffManifest: DiffManifest;
  event: ChangeRequestEventContext;
  provider: ProviderConfig;
  reason: string;
  trustedConfigSha?: string;
  trustedConfigHash?: string;
}): ReviewRuntimeResult {
  const review: PrReview = { summary: { body: options.reason }, inlineFindings: [] };
  const validated: ValidatedReview = { review, validFindings: [], droppedFindings: [] };
  const publishing = buildCommentPublishingPlan({
    event: options.event,
    mainContributions: [{ key: "runtime/skipped", order: 0, body: options.reason }],
    validated,
    manifest: options.diffManifest,
    maxInlineComments: options.config.publication.maxInlineComments,
    metadata: {
      runtimeVersion,
      trustedConfigSha: options.trustedConfigSha,
      trustedConfigHash: options.trustedConfigHash,
      reviewedHeadSha: options.event.change.head.sha,
      providerModels: [options.provider.model],
      selectedTasks: [],
      failedTasks: [],
      validFindings: 0,
      droppedFindings: 0,
    },
  });
  const publicationPlan = publishing.publicationPlan;
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
