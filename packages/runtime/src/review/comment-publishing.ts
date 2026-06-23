import type {
  ChangeRequestEventContext,
  DiffManifest,
  ReviewFinding,
  ValidatedReview,
} from "../types.js";
import {
  buildPublicationPlan,
  type InlineCommentDraft,
  type MainSectionContribution,
  type PublicationMetadata,
  type PublicationPlan,
  prepareInlinePublicationItems,
} from "./comment.js";
import {
  buildPriorReviewState,
  findingIdFor,
  type PriorFindingRecord,
  type PriorReviewState,
} from "./prior-state.js";

export type CommentSectionTemplate = {
  title: string;
  order: number;
  collapsed?: boolean;
};

export type BuildCommentPublishingPlanOptions = {
  event: Pick<ChangeRequestEventContext, "change">;
  sectionTemplates: Map<string, CommentSectionTemplate>;
  summaries: MainSectionContribution[];
  sections: MainSectionContribution[];
  validated: ValidatedReview;
  manifest: DiffManifest;
  metadata: Omit<PublicationMetadata, "cappedInlineFindings">;
  maxInlineComments?: number;
  priorReviewState?: PriorReviewState;
};

export type CommentPublishingPlan = {
  publicationPlan: PublicationPlan;
  inlineCommentDrafts: InlineCommentDraft[];
};

export function buildCommentPublishingPlan(
  options: BuildCommentPublishingPlanOptions,
): CommentPublishingPlan {
  const reviewState = buildPriorReviewState({
    priorState: options.priorReviewState,
    findings: options.validated.validFindings,
    reviewedHeadSha: options.event.change.head.sha,
    selectedTasks: options.metadata.selectedTasks,
  }).state;
  const inlineCommentDrafts = prepareInlinePublicationItems({
    validated: options.validated,
    manifest: options.manifest,
    reviewedHeadSha: options.event.change.head.sha,
    reviewState,
  });
  const publicationPlan = buildPublicationPlan({
    event: options.event,
    layout: mainCommentLayoutFor(options.sectionTemplates),
    mainContributions: [
      ...options.summaries,
      ...findingsSectionContribution(reviewState, options.validated.validFindings),
      ...options.sections,
    ],
    inlineItems: inlineCommentDrafts,
    maxInlineComments: options.maxInlineComments,
    metadata: options.metadata,
    reviewState,
  });
  return {
    publicationPlan,
    inlineCommentDrafts: publicationPlan.inlineItems,
  };
}

function findingsSectionContribution(
  reviewState: PriorReviewState,
  currentFindings: ReviewFinding[],
): MainSectionContribution[] {
  const findings = reviewState.findings.filter((finding) => finding.status === "open");
  if (findings.length === 0) {
    return [];
  }
  const currentFindingById = new Map(
    currentFindings.map((finding) => [findingIdFor(finding, reviewState), finding]),
  );
  return [
    {
      sourceId: "findings",
      sectionId: "findings",
      policy: "list",
      priority: 0,
      value: findings.map((finding) => ({
        id: finding.id,
        body: `- ${findingListBody(finding, currentFindingById.get(finding.id))}`,
      })),
      itemKey: "id",
    },
  ];
}

function findingListBody(finding: PriorFindingRecord, currentFinding: ReviewFinding | undefined) {
  if (currentFinding) {
    return currentFinding.body;
  }
  const end = finding.endLine === finding.startLine ? "" : `-${finding.endLine}`;
  return `Existing finding at ${finding.path}:${finding.startLine}${end} remains open. See Inline Review Comment.`;
}

function mainCommentLayoutFor(sectionTemplates: Map<string, CommentSectionTemplate>) {
  return {
    marker: "pipr:main-comment",
    heading: "pipr Review",
    sections: [...sectionTemplates.entries()].map(([id, section]) => ({
      id,
      title: section.title,
      order: section.order,
      collapsed: section.collapsed,
      empty: id === "findings" ? "No findings." : undefined,
    })),
  };
}
