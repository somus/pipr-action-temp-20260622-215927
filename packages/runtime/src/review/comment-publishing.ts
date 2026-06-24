import type { ChangeRequestEventContext, DiffManifest, ValidatedReview } from "../types.js";
import {
  buildPublicationPlan,
  type InlineCommentDraft,
  type MainCommentContribution,
  type PublicationMetadata,
  type PublicationPlan,
  prepareInlinePublicationItems,
} from "./comment.js";
import { buildPriorReviewState, type PriorReviewState } from "./prior-state.js";

export type BuildCommentPublishingPlanOptions = {
  event: Pick<ChangeRequestEventContext, "change">;
  mainContributions: MainCommentContribution[];
  validated: ValidatedReview;
  manifest: DiffManifest;
  metadata: Omit<PublicationMetadata, "cappedInlineFindings">;
  maxInlineComments?: number;
  priorReviewState?: PriorReviewState;
  priorMainComment?: string;
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
    mainContributions: options.mainContributions,
    inlineItems: inlineCommentDrafts,
    maxInlineComments: options.maxInlineComments,
    metadata: options.metadata,
    reviewState,
    priorMainComment: options.priorMainComment,
  });
  return {
    publicationPlan,
    inlineCommentDrafts: publicationPlan.inlineItems,
  };
}
