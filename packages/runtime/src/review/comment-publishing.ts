import type { DiffManifest, PullRequestEventContext, ValidatedReview } from "../types.js";
import {
  buildPublicationPlan,
  type InlineCommentDraft,
  type MainSectionContribution,
  type PublicationMetadata,
  type PublicationPlan,
  prepareInlinePublicationItems,
  reviewToMainSectionContributions,
} from "./comment.js";

export type CommentSectionTemplate = {
  title: string;
  order: number;
  collapsed?: boolean;
};

export type BuildCommentPublishingPlanOptions = {
  event: Pick<PullRequestEventContext, "pullRequestNumber" | "headSha">;
  sectionTemplates: Map<string, CommentSectionTemplate>;
  summaries: MainSectionContribution[];
  sections: MainSectionContribution[];
  validated: ValidatedReview;
  manifest: DiffManifest;
  metadata: Omit<PublicationMetadata, "cappedInlineFindings">;
  maxInlineComments?: number;
};

export type CommentPublishingPlan = {
  publicationPlan: PublicationPlan;
  inlineCommentDrafts: InlineCommentDraft[];
};

export function buildCommentPublishingPlan(
  options: BuildCommentPublishingPlanOptions,
): CommentPublishingPlan {
  const inlineCommentDrafts = prepareInlinePublicationItems({
    validated: options.validated,
    manifest: options.manifest,
    reviewedHeadSha: options.event.headSha,
  });
  const publicationPlan = buildPublicationPlan({
    event: options.event,
    layout: mainCommentLayoutFor(options.sectionTemplates),
    mainContributions: [
      ...options.summaries,
      ...findingsSectionContribution(options.validated),
      ...options.sections,
    ],
    inlineItems: inlineCommentDrafts,
    maxInlineComments: options.maxInlineComments,
    metadata: options.metadata,
  });
  return {
    publicationPlan,
    inlineCommentDrafts: publicationPlan.inlineItems,
  };
}

function findingsSectionContribution(validated: ValidatedReview): MainSectionContribution[] {
  return reviewToMainSectionContributions({
    sourceId: "findings",
    validated,
  }).filter((contribution) => contribution.sectionId === "findings");
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
