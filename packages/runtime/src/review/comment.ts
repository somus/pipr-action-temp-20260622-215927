import { compact } from "lodash-es";
import { z } from "zod";
import { createDiffRangeIndex } from "../diff/ranges.js";
import type {
  ChangeRequestEventContext,
  DiffManifest,
  ReviewFinding,
  ValidatedReview,
} from "../types.js";
import { commentableRangeSchema, reviewSideSchema } from "../types.js";
import { reviewFindingSchema } from "./contract.js";
import {
  buildPriorReviewState,
  findingIdFor,
  findingIdSchema,
  inlineFindingMarker,
  mainCommentMarker,
  matchFindingRecord,
  type PriorReviewState,
  priorReviewStateSchema,
  renderInlineFindingMarker,
  renderMainCommentMarker,
} from "./prior-state.js";
import { findingFingerprint } from "./review.js";

export const runtimeVersion = "0.0.0";

const mainSectionMergePolicySchema = z.enum(["exclusive", "replace", "append", "list"]);

const mainSectionListItemSchema = z.record(z.string(), z.json());
const mainSectionValueSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.array(mainSectionListItemSchema),
]);

export const mainSectionContributionSchema = z.strictObject({
  sourceId: z.string().min(1),
  sectionId: z.string().min(1),
  policy: mainSectionMergePolicySchema,
  priority: z.number().int(),
  value: mainSectionValueSchema,
  itemKey: z.string().min(1).optional(),
});

const mainSectionContributionsSchema = z.array(mainSectionContributionSchema);

export type MainSectionContribution = z.infer<typeof mainSectionContributionSchema>;
export type MainSectionMergePolicy = MainSectionContribution["policy"];

const inlinePublicationItemSchema = z
  .strictObject({
    finding: reviewFindingSchema,
    range: commentableRangeSchema,
    path: z.string().min(1),
    side: reviewSideSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    body: z.string().min(1),
    marker: z.string().min(1),
    findingId: findingIdSchema,
    reviewedHeadSha: z.string().min(1),
  })
  .superRefine((item, context) => {
    if (item.path !== item.finding.path) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "path must match finding.path",
      });
    }
    if (item.side !== item.finding.side) {
      context.addIssue({
        code: "custom",
        path: ["side"],
        message: "side must match finding.side",
      });
    }
    if (item.startLine !== item.finding.startLine) {
      context.addIssue({
        code: "custom",
        path: ["startLine"],
        message: "startLine must match finding.startLine",
      });
    }
    if (item.endLine !== item.finding.endLine) {
      context.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "endLine must match finding.endLine",
      });
    }
  });

const inlinePublicationItemsSchema = z.array(inlinePublicationItemSchema);

export type InlinePublicationItem = z.infer<typeof inlinePublicationItemSchema>;
export type InlineCommentDraft = InlinePublicationItem;

const publicationMetadataSchema = z.strictObject({
  runtimeVersion: z.string().min(1),
  trustedConfigSha: z.string().min(1).optional(),
  trustedConfigHash: z.string().min(1).optional(),
  reviewedHeadSha: z.string().min(1),
  providerModels: z.array(z.string().min(1)).optional(),
  taskMetadata: z.record(z.string(), z.json()).optional(),
  selectedTasks: z.array(z.string().min(1)),
  failedTasks: z.array(z.string().min(1)),
  validFindings: z.number().int().min(0),
  droppedFindings: z.number().int().min(0),
  cappedInlineFindings: z.number().int().min(0),
});
export const publicationTaskMetadataSchema = z.record(z.string(), z.json());

export type PublicationMetadata = z.infer<typeof publicationMetadataSchema>;

const publicationPlanSchema = z.strictObject({
  mainComment: z.string().min(1),
  mainMarker: z.string().min(1),
  changeNumber: z.number().int().positive(),
  inlineItems: inlinePublicationItemsSchema,
  metadata: publicationMetadataSchema,
  reviewState: priorReviewStateSchema,
});

export type PublicationPlan = z.infer<typeof publicationPlanSchema>;

export type MainCommentLayout = {
  marker: string;
  heading: string;
  sections: Array<{
    id: string;
    title: string;
    order: number;
    empty?: string;
    collapsed?: boolean;
  }>;
};

export type BuildPublicationPlanOptions = {
  event: Pick<ChangeRequestEventContext, "change">;
  layout?: MainCommentLayout;
  mainContributions: MainSectionContribution[];
  inlineItems: InlinePublicationItem[];
  metadata: Omit<PublicationMetadata, "cappedInlineFindings">;
  maxInlineComments?: number;
  reviewState?: PriorReviewState;
};

export function buildPublicationPlan(options: BuildPublicationPlanOptions): PublicationPlan {
  const layout = options.layout ?? defaultMainCommentLayout();
  const reviewState =
    options.reviewState ??
    buildPriorReviewState({
      findings: options.inlineItems.map((item) => item.finding),
      reviewedHeadSha: options.metadata.reviewedHeadSha,
      selectedTasks: options.metadata.selectedTasks,
    }).state;
  const cappedInlineItems =
    options.maxInlineComments === undefined
      ? options.inlineItems
      : options.inlineItems.slice(0, options.maxInlineComments);
  const metadata = publicationMetadataSchema.parse({
    ...options.metadata,
    cappedInlineFindings: options.inlineItems.length - cappedInlineItems.length,
  });
  const reducedSections = reduceMainSectionContributions([
    ...options.mainContributions,
    metadataContribution(metadata),
  ]);
  return publicationPlanSchema.parse({
    mainComment: renderMainCommentFromSections({
      event: options.event,
      layout,
      reducedSections,
      reviewState,
    }),
    mainMarker: layout.marker,
    changeNumber: options.event.change.number,
    inlineItems: cappedInlineItems,
    metadata,
    reviewState,
  });
}

export function reduceMainSectionContributions(
  contributions: MainSectionContribution[],
): Map<string, string> {
  const sections = new Map<string, MainSectionContribution[]>();
  for (const contribution of mainSectionContributionsSchema.parse(contributions)) {
    const existing = sections.get(contribution.sectionId) ?? [];
    existing.push(contribution);
    sections.set(contribution.sectionId, existing);
  }

  return new Map(
    [...sections.entries()].map(([sectionId, sectionContributions]) => [
      sectionId,
      reduceMainSection(sectionId, sectionContributions),
    ]),
  );
}

export function reviewToMainSectionContributions(options: {
  sourceId: string;
  validated: ValidatedReview;
  summaryPolicy?: MainSectionMergePolicy;
  summaryPriority?: number;
}): MainSectionContribution[] {
  const summary = options.validated.review.summary;
  const contributions: MainSectionContribution[] = [
    {
      sourceId: options.sourceId,
      sectionId: "summary",
      policy: options.summaryPolicy ?? "exclusive",
      priority: options.summaryPriority ?? 100,
      value: summary.title ? `**${summary.title}**\n\n${summary.body}` : summary.body,
    },
  ];

  const findingItems = options.validated.validFindings.map((finding) => ({
    fingerprint: findingFingerprint(finding),
    body: `- ${finding.body}`,
  }));
  if (findingItems.length > 0) {
    contributions.push({
      sourceId: options.sourceId,
      sectionId: "findings",
      policy: "list",
      priority: 0,
      value: findingItems,
      itemKey: "fingerprint",
    });
  }
  return mainSectionContributionsSchema.parse(contributions);
}

export function prepareInlinePublicationItems(options: {
  validated: ValidatedReview;
  manifest: DiffManifest;
  reviewedHeadSha: string;
  reviewState?: PriorReviewState;
}): InlinePublicationItem[] {
  const ranges = createDiffRangeIndex(options.manifest);
  const seenFindingIds = new Set<string>();
  return inlinePublicationItemsSchema.parse(
    options.validated.validFindings.flatMap((finding) => {
      const range = ranges.rangeById(finding.rangeId);
      if (!range) {
        throw new Error(
          `Validated finding range '${finding.rangeId}' is missing from Diff Manifest`,
        );
      }
      const findingId = findingIdFor(finding, options.reviewState);
      const stateRecord = options.reviewState
        ? matchFindingRecord(options.reviewState, finding)
        : undefined;
      if (
        seenFindingIds.has(findingId) ||
        stateRecord?.lastCommentedHeadSha === options.reviewedHeadSha
      ) {
        return [];
      }
      seenFindingIds.add(findingId);
      const marker = inlineFindingMarker(findingId, options.reviewedHeadSha);
      return [
        inlinePublicationItemSchema.parse({
          finding,
          range,
          path: finding.path,
          side: finding.side,
          startLine: finding.startLine,
          endLine: finding.endLine,
          marker,
          findingId,
          reviewedHeadSha: options.reviewedHeadSha,
          body: renderInlineBody(finding, findingId, options.reviewedHeadSha),
        }),
      ];
    }),
  );
}

function defaultMainCommentLayout(): MainCommentLayout {
  return {
    marker: mainCommentMarker,
    heading: "pipr Review",
    sections: [
      { id: "summary", title: "Summary", order: 10, empty: "No summary was produced." },
      { id: "findings", title: "Findings", order: 20, empty: "No findings." },
      { id: "metadata", title: "Review metadata", order: 30, collapsed: true },
    ],
  };
}

function renderMainCommentFromSections(options: {
  event: Pick<ChangeRequestEventContext, "change">;
  layout: MainCommentLayout;
  reducedSections: Map<string, string>;
  reviewState: PriorReviewState;
}): string {
  return [
    renderMainCommentMarker({
      marker: options.layout.marker,
      changeNumber: options.event.change.number,
      reviewState: options.reviewState,
    }),
    "",
    `# ${options.layout.heading}`,
    "",
    ...options.layout.sections
      .toSorted((left, right) => left.order - right.order)
      .flatMap((section) => {
        const body = options.reducedSections.get(section.id) ?? section.empty ?? "";
        return section.collapsed
          ? renderCollapsedSection(section.title, body)
          : renderMarkdownSection(section.title, body);
      }),
  ].join("\n");
}

function renderMarkdownSection(title: string, body: string): string[] {
  return [`## ${title}`, "", body, ""];
}

function renderCollapsedSection(title: string, body: string): string[] {
  return ["<details>", `<summary>${title}</summary>`, "", body, "", "</details>", ""];
}

function reduceMainSection(sectionId: string, contributions: MainSectionContribution[]): string {
  const policy = readSectionPolicy(sectionId, contributions);
  return sectionPolicyReducers[policy](sectionId, contributions);
}

const sectionPolicyReducers: Record<
  MainSectionMergePolicy,
  (sectionId: string, contributions: MainSectionContribution[]) => string
> = {
  exclusive: reduceExclusiveSection,
  replace: reduceReplaceSection,
  append: reduceAppendSection,
  list: reduceListSection,
};

function readSectionPolicy(
  sectionId: string,
  contributions: MainSectionContribution[],
): MainSectionMergePolicy {
  const policies = new Set(contributions.map((contribution) => contribution.policy));
  if (policies.size !== 1) {
    throw new Error(`Main Review Comment section '${sectionId}' has mixed merge policies`);
  }
  const policy = contributions[0]?.policy;
  if (!policy) {
    throw new Error(`Main Review Comment section '${sectionId}' has no merge policy`);
  }
  return policy;
}

function reduceExclusiveSection(
  sectionId: string,
  contributions: MainSectionContribution[],
): string {
  if (contributions.length > 1) {
    throw new Error(`Main Review Comment section '${sectionId}' has multiple exclusive writers`);
  }
  return renderContributionValue(contributions[0]?.value ?? "");
}

function reduceReplaceSection(
  _sectionId: string,
  contributions: MainSectionContribution[],
): string {
  return renderContributionValue(toPriorityOrder(contributions)[0]?.value ?? "");
}

function reduceAppendSection(_sectionId: string, contributions: MainSectionContribution[]): string {
  return toPriorityOrder(contributions)
    .map((item) => renderContributionValue(item.value))
    .join("\n\n");
}

function reduceListSection(_sectionId: string, contributions: MainSectionContribution[]): string {
  const seen = new Set<string>();
  return toPriorityOrder(contributions)
    .flatMap((contribution) => contributionValues(contribution.value, contribution.itemKey, seen))
    .join("\n");
}

function toPriorityOrder(contributions: MainSectionContribution[]): MainSectionContribution[] {
  return contributions.toSorted(
    (left, right) => right.priority - left.priority || left.sourceId.localeCompare(right.sourceId),
  );
}

function renderContributionValue(value: MainSectionContribution["value"]): string {
  return contributionValues(value).join("\n");
}

function contributionValues(
  value: MainSectionContribution["value"],
  itemKey?: string,
  seen?: Set<string>,
): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    if (typeof item === "string") {
      return [item];
    }
    const dedupeKey = itemKey ? item[itemKey] : undefined;
    if (typeof dedupeKey === "string" || typeof dedupeKey === "number") {
      const key = String(dedupeKey);
      if (seen?.has(key)) {
        return [];
      }
      seen?.add(key);
    }
    return [renderListItem(item)];
  });
}

function renderListItem(item: Record<string, unknown>): string {
  if (typeof item.body === "string") {
    return item.body;
  }
  if (typeof item.value === "string") {
    return item.value;
  }
  return JSON.stringify(item);
}

function metadataContribution(metadata: PublicationMetadata): MainSectionContribution {
  const lines = compact([
    `Runtime: \`${metadata.runtimeVersion}\`  `,
    `Reviewed head: \`${metadata.reviewedHeadSha}\`  `,
    metadata.trustedConfigSha
      ? `Trusted config SHA: \`${metadata.trustedConfigSha}\`  `
      : undefined,
    metadata.trustedConfigHash
      ? `Trusted config hash: \`${metadata.trustedConfigHash}\`  `
      : undefined,
    metadata.providerModels?.length
      ? `Models: \`${metadata.providerModels.join(", ")}\`  `
      : undefined,
    metadata.taskMetadata
      ? `Task metadata: \`${JSON.stringify(metadata.taskMetadata)}\`  `
      : undefined,
    `Selected tasks: \`${metadata.selectedTasks.join(", ") || "none"}\`  `,
    `Failed tasks: \`${metadata.failedTasks.join(", ") || "none"}\`  `,
    `Valid inline findings: \`${metadata.validFindings}\`  `,
    `Dropped findings: \`${metadata.droppedFindings}\`  `,
    `Capped inline findings: \`${metadata.cappedInlineFindings}\``,
  ]);
  return {
    sourceId: "core/publication",
    sectionId: "metadata",
    policy: "append",
    priority: 0,
    value: lines.join("\n"),
  };
}

function renderInlineBody(
  finding: ReviewFinding,
  findingId: string,
  reviewedHeadSha: string,
): string {
  return [
    renderInlineFindingMarker(findingId, reviewedHeadSha),
    finding.body,
    finding.suggestedFix ? `\nSuggested fix:\n\n${finding.suggestedFix}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
