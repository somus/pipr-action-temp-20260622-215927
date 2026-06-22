import { describe, expect, it } from "bun:test";
import type { DiffManifest, ValidatedReview } from "../../types.js";
import { mainSectionContributionSchema, runtimeVersion } from "../comment.js";
import { buildCommentPublishingPlan } from "../comment-publishing.js";

const event = { pullRequestNumber: 1, headSha: "head" };

const manifest: DiffManifest = {
  baseSha: "base",
  headSha: "head",
  mergeBaseSha: "base",
  files: [
    {
      path: "src/a.ts",
      status: "modified",
      additions: 2,
      deletions: 0,
      hunks: [
        {
          hunkIndex: 1,
          header: "@@ -10,2 +10,2 @@",
          oldStart: 10,
          oldLines: 2,
          newStart: 10,
          newLines: 2,
          contentHash: "deadbeefcafe",
        },
      ],
      commentableRanges: [
        {
          id: "range-1",
          path: "src/a.ts",
          side: "RIGHT",
          startLine: 10,
          endLine: 10,
          kind: "added",
          hunkIndex: 1,
          hunkHeader: "@@ -10,2 +10,2 @@",
          hunkContentHash: "deadbeefcafe",
          preview: "fail()",
        },
        {
          id: "range-2",
          path: "src/a.ts",
          side: "RIGHT",
          startLine: 11,
          endLine: 11,
          kind: "added",
          hunkIndex: 1,
          hunkHeader: "@@ -10,2 +10,2 @@",
          hunkContentHash: "deadbeefcafe",
          preview: "break()",
        },
      ],
    },
  ],
};

const validated: ValidatedReview = {
  review: { summary: { body: "Review completed." }, inlineFindings: [] },
  validFindings: [
    {
      body: "First finding.",
      path: "src/a.ts",
      rangeId: "range-1",
      side: "RIGHT",
      startLine: 10,
      endLine: 10,
    },
    {
      body: "Second finding.",
      path: "src/a.ts",
      rangeId: "range-2",
      side: "RIGHT",
      startLine: 11,
      endLine: 11,
    },
  ],
  droppedFindings: [],
};

describe("buildCommentPublishingPlan", () => {
  it("assembles main comment sections and returns capped inline drafts", () => {
    const publishing = buildCommentPublishingPlan({
      event,
      sectionTemplates: new Map([
        ["summary", { title: "Summary", order: 10 }],
        ["findings", { title: "Findings", order: 20 }],
        ["details", { title: "Details", order: 30 }],
        ["metadata", { title: "Review metadata", order: 40, collapsed: true }],
      ]),
      summaries: [
        mainSectionContributionSchema.parse({
          sourceId: "review",
          sectionId: "summary",
          policy: "append",
          priority: 100,
          value: "Summary body.",
        }),
      ],
      sections: [
        mainSectionContributionSchema.parse({
          sourceId: "details",
          sectionId: "details",
          policy: "append",
          priority: 0,
          value: "Extra details.",
        }),
      ],
      validated,
      manifest,
      maxInlineComments: 1,
      metadata: {
        runtimeVersion,
        reviewedHeadSha: event.headSha,
        providerModels: ["deepseek-v4-pro"],
        selectedTasks: ["review"],
        failedTasks: [],
        validFindings: 2,
        droppedFindings: 0,
      },
    });

    expect(publishing.publicationPlan.mainComment).toContain("## Summary\n\nSummary body.");
    expect(publishing.publicationPlan.mainComment).toContain("## Findings\n\n- First finding.");
    expect(publishing.publicationPlan.mainComment).toContain("- Second finding.");
    expect(publishing.publicationPlan.mainComment).toContain("## Details\n\nExtra details.");
    expect(publishing.publicationPlan.metadata.cappedInlineFindings).toBe(1);
    expect(publishing.publicationPlan.inlineItems).toHaveLength(1);
    expect(publishing.inlineCommentDrafts).toEqual(publishing.publicationPlan.inlineItems);
    expect(publishing.inlineCommentDrafts[0]?.finding.body).toBe("First finding.");
  });
});
