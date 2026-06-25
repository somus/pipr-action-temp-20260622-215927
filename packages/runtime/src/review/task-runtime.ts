import type {
  CheckHandle,
  CommentValue,
  DiffManifestOptions,
  PathFilter,
  PriorReview,
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
import { type InlineCommentDraft, type PublicationPlan, runtimeVersion } from "./comment.js";
import { buildCommentPublishingPlan } from "./comment-publishing.js";
import { type PriorReviewState, priorReviewStateForSelectedTasks } from "./prior-state.js";
import { validatePrReview } from "./review.js";
import { type PiRunner, resolveProvider, runReviewAgent } from "./review-run.js";
import { runInternalVerifier } from "./verifier.js";

export type { PiRunner } from "./review-run.js";
export type DiffManifestBuilder = (options: BuildDiffManifestOptions) => DiffManifest;
export type RuntimeCheckConclusion = "success" | "failure" | "neutral";

export type RuntimeTaskCheckResult = {
  taskName: string;
  conclusion: RuntimeCheckConclusion;
  summary?: string;
};

export type RuntimeCheckSink = {
  setTaskResult(result: RuntimeTaskCheckResult): void;
};

const genericTaskFailureSummary = "Task failed; see logs for details.";

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
  loadInlineThreadContexts?: () => Promise<import("../hosts/types.js").InlineThreadContext[]>;
  checkSink?: RuntimeCheckSink;
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
  taskChecks: RuntimeTaskCheckResult[];
  repairAttempted: boolean;
};

type OutputState = {
  comment?: CommentContribution;
  findings: FindingContribution[];
  findingScopes: WeakMap<readonly ReviewFinding[], PathFilter>;
  providerModels: string[];
  repairAttempted: boolean;
  check?: Omit<RuntimeTaskCheckResult, "taskName">;
};

type CommentContribution = {
  taskName: string;
  value: CommentValue;
};

type FindingContribution = {
  finding: ReviewFinding;
  paths?: PathFilter;
};

const findingScopeMarker: unique symbol = Symbol("pipr.findingScope");

type ScopedReviewFinding = ReviewFinding & {
  [findingScopeMarker]?: PathFilter;
};

type TaskRunResult = {
  taskName: string;
  output: OutputState;
  error?: unknown;
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
  const runtimeOptions = { ...options, priorReviewState, priorMainComment };

  const manifestCache = new Map<string, DiffManifest>();
  const taskResults = await Promise.all(
    tasks.map(async (task, taskOrder) => {
      const output = createOutputState();
      try {
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
        publishTaskCheckResult(
          options.checkSink,
          task.name,
          output.check ?? { conclusion: "success" },
        );
        return { taskName: task.name, output };
      } catch (error) {
        const check = {
          conclusion: "failure" as const,
          summary: genericTaskFailureSummary,
        };
        publishTaskCheckResult(options.checkSink, task.name, check);
        return { taskName: task.name, output: { ...output, check }, error };
      }
    }),
  );
  const failedTask = taskResults.find((result) => result.error !== undefined);
  if (failedTask) {
    throw failedTask.error instanceof Error
      ? failedTask.error
      : new Error(String(failedTask.error));
  }
  const output = mergeTaskOutputs(taskResults);
  if (!output.comment) {
    throw new Error("ctx.comment(...) must be called exactly once per selected run");
  }

  const review = collectedReview(output);
  const validated = validatePrReview(review, diffManifest, {
    expectedHeadSha: options.event.change.head.sha,
    pathScopeForFinding: (_finding, index) => output.findings[index]?.paths,
  });
  const verifier = await runSynchronizeVerifier({
    options,
    config,
    provider,
    diffManifest,
    priorReviewState,
  });
  const publishing = buildCommentPublishingPlan({
    event: options.event,
    main:
      typeof output.comment.value === "string"
        ? output.comment.value
        : (output.comment.value.main ?? "Review completed."),
    validated,
    manifest: diffManifest,
    maxInlineComments: config.publication.maxInlineComments,
    priorReviewState: verifier.priorReviewState,
    threadActions: verifier.threadActions,
    metadata: {
      runtimeVersion,
      trustedConfigSha: options.trustedConfigSha,
      trustedConfigHash: options.trustedConfigHash,
      reviewedHeadSha: options.event.change.head.sha,
      providerModels:
        output.providerModels.length + verifier.providerModels.length > 0
          ? uniq([...output.providerModels, ...verifier.providerModels])
          : [provider.model],
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
    taskChecks: taskResults.map((result) =>
      runtimeTaskCheckResult(result.taskName, result.output.check ?? { conclusion: "success" }),
    ),
    repairAttempted: output.repairAttempted,
  };
}

async function runSynchronizeVerifier(options: {
  options: RunTaskRuntimeOptions;
  config: PiprConfig;
  provider: ProviderConfig;
  diffManifest: DiffManifest;
  priorReviewState: PriorReviewState | undefined;
}): Promise<Awaited<ReturnType<typeof runInternalVerifier>>> {
  if (options.options.event.rawAction !== "synchronize") {
    return {
      priorReviewState: options.priorReviewState,
      threadActions: [],
      providerModels: [],
    };
  }
  const config = options.config;
  return await runInternalVerifier({
    workspace: options.options.workspace,
    config,
    event: options.options.event,
    provider: options.provider,
    verifierProvider: resolveProvider(
      config,
      config.publication.autoResolve.model ?? config.defaultProvider,
    ),
    plan: options.options.plan,
    env: options.options.env,
    piExecutable: options.options.piExecutable,
    piRunner: options.options.piRunner,
    diffManifest: options.diffManifest,
    priorReviewState: options.priorReviewState,
    threadContexts: (await options.options.loadInlineThreadContexts?.()) ?? [],
    mode: { kind: "synchronize" },
  });
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
    review: {
      async prior() {
        return priorReviewForTask(options.priorMainComment, options.priorReviewState);
      },
    },
    check: createCheckHandle(options.output),
    async comment(value) {
      collectComment(options.output, value, options.taskName);
    },
    log: console,
  };
}

function mergeTaskOutputs(results: TaskRunResult[]): OutputState {
  const merged = createOutputState();
  for (const { output } of results) {
    if (output.comment) {
      if (merged.comment) {
        throw new Error(
          `ctx.comment(...) may be called once per selected run; received comments from '${merged.comment.taskName}' and '${output.comment.taskName}'`,
        );
      }
      merged.comment = output.comment;
    }
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
    findings: [],
    findingScopes: new WeakMap(),
    providerModels: [],
    repairAttempted: false,
  };
}

function createCheckHandle(state: OutputState): CheckHandle {
  return {
    pass(summary) {
      setCheckResult(state, "success", summary);
    },
    fail(summary) {
      setCheckResult(state, "failure", summary);
    },
    neutral(summary) {
      setCheckResult(state, "neutral", summary);
    },
  };
}

function setCheckResult(
  state: OutputState,
  conclusion: RuntimeCheckConclusion,
  summary: string | undefined,
): void {
  if (state.check) {
    throw new Error("ctx.check may be completed at most once per task");
  }
  state.check = summary ? { conclusion, summary } : { conclusion };
}

function publishTaskCheckResult(
  sink: RuntimeCheckSink | undefined,
  taskName: string,
  check: Omit<RuntimeTaskCheckResult, "taskName">,
): void {
  sink?.setTaskResult(runtimeTaskCheckResult(taskName, check));
}

function runtimeTaskCheckResult(
  taskName: string,
  check: Omit<RuntimeTaskCheckResult, "taskName">,
): RuntimeTaskCheckResult {
  return check.summary
    ? { taskName, conclusion: check.conclusion, summary: check.summary }
    : { taskName, conclusion: check.conclusion };
}

function collectComment(state: OutputState, value: CommentValue, taskName: string): void {
  if (state.comment) {
    throw new Error(
      `ctx.comment(...) may be called once per selected run; '${taskName}' called it more than once`,
    );
  }
  state.comment = { taskName, value };
  if (typeof value === "string") {
    return;
  }
  collectInlineFindings(state, value.inlineFindings);
}

function priorReviewForTask(
  priorMainComment: string | undefined,
  priorReviewState: PriorReviewState | undefined,
): PriorReview {
  return {
    ...(priorMainComment ? { main: visibleMainComment(priorMainComment) } : {}),
    ...(priorReviewState ? { reviewedHeadSha: priorReviewState.reviewedHeadSha } : {}),
    inlineFindings:
      priorReviewState?.findings.map((finding) => ({
        id: finding.id,
        status: finding.status,
        path: finding.path,
        rangeId: finding.rangeId,
        side: finding.side,
        startLine: finding.startLine,
        endLine: finding.endLine,
      })) ?? [],
  };
}

function visibleMainComment(body: string): string {
  const lines = body.split("\n").filter((line) => !line.startsWith("<!-- pipr:main-comment "));
  while (lines[0] === "") {
    lines.shift();
  }
  if (lines[0] === "# pipr Review") {
    lines.shift();
  }
  while (lines[0] === "") {
    lines.shift();
  }
  return lines.join("\n").trim();
}

function collectInlineFindings(
  state: OutputState,
  findings: readonly ReviewFinding[] | undefined,
): void {
  if (!findings) {
    return;
  }
  const arrayScope = state.findingScopes.get(findings);
  state.findings.push(
    ...findings.map((finding) => ({
      finding,
      paths: (finding as ScopedReviewFinding)[findingScopeMarker] ?? arrayScope,
    })),
  );
}

function trackResultFindingScope(
  state: OutputState,
  value: unknown,
  paths: PathFilter | undefined,
): void {
  if (!hasInlineFindings(value)) {
    return;
  }
  if (!paths) {
    return;
  }
  state.findingScopes.set(value.inlineFindings, paths);
  for (const finding of value.inlineFindings) {
    if (!isReviewFindingLike(finding)) {
      continue;
    }
    markFindingScope(finding, paths);
  }
}

function markFindingScope(finding: ReviewFinding, paths: PathFilter): void {
  Object.defineProperty(finding, findingScopeMarker, {
    value: paths,
    enumerable: true,
    configurable: true,
  });
}

function hasInlineFindings(value: unknown): value is { inlineFindings: readonly ReviewFinding[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { inlineFindings?: unknown }).inlineFindings)
  );
}

function isReviewFindingLike(value: unknown): value is ReviewFinding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { body?: unknown }).body === "string" &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { rangeId?: unknown }).rangeId === "string"
  );
}

function collectedReview(output: OutputState): PrReview {
  return {
    summary: { body: "Review completed." },
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
    main: options.reason,
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
    taskChecks: [],
    repairAttempted: false,
  };
}
