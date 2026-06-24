import { z } from "zod";
import { createDiffRangeIndex } from "../diff/ranges.js";
import type { ChangeRequestEventContext, DiffManifest, ReviewFinding } from "../types.js";
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

export const runtimeVersion = "0.0.0";

const mainCommentContributionSchema = z.strictObject({
  key: z.string().min(1),
  order: z.number().int(),
  body: z.string().nullable(),
});
const mainCommentContributionsSchema = z.array(mainCommentContributionSchema);

export type MainCommentContribution = z.infer<typeof mainCommentContributionSchema>;

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
      context.addIssue({ code: "custom", path: ["path"], message: "path must match finding.path" });
    }
    if (item.side !== item.finding.side) {
      context.addIssue({ code: "custom", path: ["side"], message: "side must match finding.side" });
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
  selectedTasks: z.array(z.string().min(1)),
  failedTasks: z.array(z.string().min(1)),
  validFindings: z.number().int().min(0),
  droppedFindings: z.number().int().min(0),
  cappedInlineFindings: z.number().int().min(0),
});

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

export type BuildPublicationPlanOptions = {
  event: Pick<ChangeRequestEventContext, "change">;
  mainContributions: MainCommentContribution[];
  inlineItems: InlinePublicationItem[];
  metadata: Omit<PublicationMetadata, "cappedInlineFindings">;
  maxInlineComments?: number;
  reviewState?: PriorReviewState;
  priorMainComment?: string;
};

export function buildPublicationPlan(options: BuildPublicationPlanOptions): PublicationPlan {
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
  return publicationPlanSchema.parse({
    mainComment: renderMainComment({
      event: options.event,
      reviewState,
      contributions: reduceMainCommentContributions({
        priorMainComment: options.priorMainComment,
        contributions: options.mainContributions,
      }),
    }),
    mainMarker: mainCommentMarker,
    changeNumber: options.event.change.number,
    inlineItems: cappedInlineItems,
    metadata,
    reviewState,
  });
}

export function reduceMainCommentContributions(options: {
  priorMainComment?: string;
  contributions: MainCommentContribution[];
}): MainCommentContribution[] {
  const byKey = new Map<string, MainCommentContribution>();
  const seen = new Set<string>();
  for (const contribution of mainCommentContributionsSchema.parse(options.contributions)) {
    if (seen.has(contribution.key)) {
      throw new Error(`Main Review Comment contribution '${contribution.key}' was emitted twice`);
    }
    seen.add(contribution.key);
    if (contribution.body === null) {
      byKey.delete(contribution.key);
    } else {
      byKey.set(contribution.key, contribution);
    }
  }
  return [...byKey.values()].toSorted(
    (left, right) => left.order - right.order || left.key.localeCompare(right.key),
  );
}

export function extractMainCommentContributions(
  body: string | undefined,
): MainCommentContribution[] {
  if (!body) {
    return [];
  }
  const matches = body.matchAll(
    /<!--\s*pipr:contribution\s+key="(?<key>[^"]+)"\s+order="(?<order>-?\d+)"\s*-->\n?(?<body>.*?)\n?<!--\s*\/pipr:contribution\s*-->/gs,
  );
  return mainCommentContributionsSchema
    .parse(
      [...matches].map((match) => ({
        key: unescapeAttr(match.groups?.key ?? ""),
        order: Number(match.groups?.order),
        body: match.groups?.body ?? "",
      })),
    )
    .filter((item) => Number.isInteger(item.order));
}

export function prepareInlinePublicationItems(options: {
  validated: {
    validFindings: ReviewFinding[];
  };
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

function renderMainComment(options: {
  event: Pick<ChangeRequestEventContext, "change">;
  reviewState: PriorReviewState;
  contributions: MainCommentContribution[];
}): string {
  const blocks =
    options.contributions.length === 0
      ? ["_No comment contributions._"]
      : options.contributions.flatMap(renderContributionBlock);
  return [
    renderMainCommentMarker({
      marker: mainCommentMarker,
      changeNumber: options.event.change.number,
      reviewState: options.reviewState,
    }),
    "",
    "# pipr Review",
    "",
    ...blocks,
    "",
  ].join("\n");
}

function renderContributionBlock(contribution: MainCommentContribution): string[] {
  return [
    `<!-- pipr:contribution key="${escapeAttr(contribution.key)}" order="${contribution.order}" -->`,
    escapeContributionSentinels(contribution.body ?? ""),
    "<!-- /pipr:contribution -->",
    "",
  ];
}

function renderInlineBody(
  finding: ReviewFinding,
  findingId: string,
  reviewedHeadSha: string,
): string {
  return [
    renderInlineFindingMarker(findingId, reviewedHeadSha),
    `**${finding.title}**`,
    "",
    finding.body,
    finding.suggestedFix ? `\nSuggested fix:\n\n${finding.suggestedFix}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function unescapeAttr(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

function escapeContributionSentinels(value: string): string {
  return value.replaceAll(/<!--\s*(\/?\s*pipr:contribution\b[^>]*)-->/g, "&lt;!-- $1--&gt;");
}
