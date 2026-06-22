import { randomUUID } from "node:crypto";
import type {
  DiffManifestOptions,
  ReviewFinding,
  ReviewSummary,
  RuntimePlan,
  TaskContext,
} from "@pipr/sdk";
import { renderPromptValue } from "@pipr/sdk";
import { selectRuntimeTasks } from "../config/task-selection.js";
import { type BuildDiffManifestOptions, buildDiffManifest } from "../diff/diff.js";
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
  type InlineCommentDraft,
  type MainSectionContribution,
  mainSectionContributionSchema,
  type PublicationPlan,
  publicationTaskMetadataSchema,
  runtimeVersion,
} from "./comment.js";
import { buildCommentPublishingPlan } from "./comment-publishing.js";
import { validatePrReview } from "./review.js";
import { type PiRunner, resolveProvider, runReviewAgent } from "./review-run.js";

export type { PiRunner } from "./review-run.js";
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
    expectedHeadSha: options.event.headSha,
  });
  const publishing = buildCommentPublishingPlan({
    event: options.event,
    sectionTemplates: output.sectionTemplates,
    summaries: output.summaries,
    sections: output.sections,
    validated,
    manifest: diffManifest,
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

function taskMetadata(output: OutputState) {
  return Object.keys(output.metadata).length > 0
    ? publicationTaskMetadataSchema.parse(output.metadata)
    : undefined;
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
        return result.value as never;
      },
    },
    output: createOutputCollector(options.output),
    log: console,
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

function collectedReview(output: OutputState): PrReview {
  return {
    summary: { body: output.summaries.length > 0 ? "Review completed." : "No summary produced." },
    inlineFindings: output.findings,
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
  const publishing = buildCommentPublishingPlan({
    event: options.event,
    sectionTemplates: createOutputState().sectionTemplates,
    summaries: [],
    sections: [],
    validated,
    manifest: options.diffManifest,
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

function resolveDefaultProvider(config: PiprConfig): ProviderConfig {
  return resolveProvider(config, config.defaultProvider);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
