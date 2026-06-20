import { describe, expect, it } from "vitest";
import type { ValidatedReview } from "../../types.js";
import {
  buildPublicationPlan,
  extractFindingMarkers,
  parseInlineCommentDrafts,
  prepareInlineCommentDrafts,
  reduceMainSectionContributions,
  renderMainComment,
  reviewToMainSectionContributions,
} from "../comment.js";

const validated: ValidatedReview = {
  review: {
    summary: { body: "Summary body." },
    inlineFindings: [],
  },
  validFindings: [
    {
      title: "Bug",
      body: "This can fail.",
      path: "src/a.ts",
      rangeId: "range-1",
      side: "RIGHT",
      startLine: 10,
      endLine: 10,
      severity: "high",
      category: "correctness",
      confidence: 0.9,
      evidenceSnippet: "fail()",
    },
  ],
  droppedFindings: [],
};
const manifest = {
  baseSha: "base",
  headSha: "head",
  mergeBaseSha: "base",
  files: [
    {
      path: "src/a.ts",
      status: "modified" as const,
      additions: 1,
      deletions: 0,
      hunks: [
        {
          hunkIndex: 1,
          header: "@@ -10,1 +10,1 @@",
          oldStart: 10,
          oldLines: 1,
          newStart: 10,
          newLines: 1,
          contentHash: "deadbeefcafe",
        },
      ],
      commentableRanges: [
        {
          id: "range-1",
          path: "src/a.ts",
          side: "RIGHT" as const,
          startLine: 10,
          endLine: 10,
          kind: "added" as const,
          hunkIndex: 1,
          hunkHeader: "@@ -10,1 +10,1 @@",
          hunkContentHash: "deadbeefcafe",
          preview: "fail()",
        },
      ],
    },
  ],
};

describe("comments", () => {
  it("renders one main comment marker", () => {
    const body = renderMainComment({
      event: { pullRequestNumber: 1, headSha: "abc123" },
      review: validated.review,
      validFindings: validated.validFindings,
      droppedCount: 0,
      providerModel: "deepseek-v4-pro",
    });

    expect(body).toContain("<!-- pipr:main-comment pr=1 -->");
    expect(body).toContain("# pipr Review");
  });

  it("renders the Main Review Comment from a CommentTemplate", () => {
    const body = renderMainComment({
      event: { pullRequestNumber: 1, headSha: "abc123" },
      review: validated.review,
      validFindings: [],
      droppedCount: 0,
      providerModel: "deepseek-v4-pro",
      template: {
        apiVersion: "pipr.dev/v1",
        kind: "CommentTemplate",
        id: "pipr/main",
        marker: "pipr:custom-main",
        heading: "Custom Review",
        sections: [
          { id: "findings", title: "Issues", order: 20, empty: "Nothing actionable." },
          { id: "summary", title: "Digest", order: 10 },
          { id: "metadata", title: "Trace", order: 30, collapsed: true },
        ],
      },
    });

    expect(body).toContain("<!-- pipr:custom-main pr=1 -->");
    expect(body).toContain("# Custom Review");
    expect(body.indexOf("## Digest")).toBeLessThan(body.indexOf("## Issues"));
    expect(body).toContain("Nothing actionable.");
    expect(body).toContain("<summary>Trace</summary>");
  });

  it("dedupes inline drafts with hidden markers", () => {
    const first = prepareInlineCommentDrafts(validated, manifest, "head");
    const markers = extractFindingMarkers(first.map((draft) => draft.body));
    const second = prepareInlineCommentDrafts(validated, manifest, "head", markers);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(first[0]?.body).toContain("<!-- pipr:finding fingerprint=");
    expect(first[0]?.body).toContain(" head=head -->");
  });

  it("dedupes duplicate findings in the same draft batch", () => {
    const finding = validated.validFindings[0];
    if (!finding) {
      throw new Error("test fixture missing finding");
    }
    const drafts = prepareInlineCommentDrafts(
      {
        ...validated,
        validFindings: [finding, finding],
      },
      manifest,
      "head",
    );

    expect(drafts).toHaveLength(1);
  });

  it("rejects malformed inline comment drafts", () => {
    expect(() =>
      parseInlineCommentDrafts([
        {
          path: "src/a.ts",
          side: "RIGHT",
          startLine: 10,
          endLine: 10,
          body: "",
          marker: "pipr:finding:abc:head",
          fingerprint: "0123456789abcdef",
          reviewedHeadSha: "head",
          finding: validated.validFindings[0],
          range: manifest.files[0]?.commentableRanges[0],
        },
      ]),
    ).toThrow();
  });

  it("reduces main sections deterministically", () => {
    const reduced = reduceMainSectionContributions([
      {
        workflowId: "b/workflow",
        sectionId: "summary",
        policy: "replace",
        priority: 5,
        value: "B",
      },
      {
        workflowId: "a/workflow",
        sectionId: "summary",
        policy: "replace",
        priority: 5,
        value: "A",
      },
      {
        workflowId: "a/workflow",
        sectionId: "details",
        policy: "append",
        priority: 1,
        value: "one",
      },
      {
        workflowId: "b/workflow",
        sectionId: "details",
        policy: "append",
        priority: 2,
        value: "two",
      },
      {
        workflowId: "a/workflow",
        sectionId: "findings",
        policy: "list",
        priority: 1,
        value: "first",
      },
      {
        workflowId: "b/workflow",
        sectionId: "findings",
        policy: "list",
        priority: 2,
        value: "second",
      },
    ]);

    expect(reduced.get("summary")).toBe("A");
    expect(reduced.get("details")).toBe("two\n\none");
    expect(reduced.get("findings")).toBe("second\nfirst");
  });

  it("dedupes structured list items by itemKey", () => {
    const reduced = reduceMainSectionContributions([
      {
        workflowId: "a/workflow",
        sectionId: "findings",
        policy: "list",
        priority: 1,
        itemKey: "fingerprint",
        value: [
          { fingerprint: "duplicate", body: "- First" },
          { fingerprint: "unique", body: "- Unique" },
        ],
      },
      {
        workflowId: "b/workflow",
        sectionId: "findings",
        policy: "list",
        priority: 1,
        itemKey: "fingerprint",
        value: [{ fingerprint: "duplicate", body: "- Second" }],
      },
    ]);

    expect(reduced.get("findings")).toBe("- First\n- Unique");
  });

  it("rejects conflicting main section policies", () => {
    expect(() =>
      reduceMainSectionContributions([
        { workflowId: "a", sectionId: "summary", policy: "exclusive", priority: 1, value: "A" },
        { workflowId: "b", sectionId: "summary", policy: "exclusive", priority: 1, value: "B" },
      ]),
    ).toThrow("multiple exclusive writers");

    expect(() =>
      reduceMainSectionContributions([
        { workflowId: "a", sectionId: "summary", policy: "replace", priority: 1, value: "A" },
        { workflowId: "b", sectionId: "summary", policy: "append", priority: 1, value: "B" },
      ]),
    ).toThrow("mixed merge policies");
  });

  it("renders a publication plan with configured empty sections", () => {
    const plan = buildPublicationPlan({
      event: { pullRequestNumber: 1, headSha: "head" },
      mainContributions: reviewToMainSectionContributions({
        workflowId: "pipr/review",
        validated: { ...validated, validFindings: [] },
      }),
      inlineItems: [],
      metadata: {
        runtimeVersion: "0.0.0",
        reviewedHeadSha: "head",
        selectedWorkflows: ["pipr/review"],
        failedWorkflows: [],
        validFindings: 0,
        droppedFindings: 0,
      },
      template: {
        apiVersion: "pipr.dev/v1",
        kind: "CommentTemplate",
        id: "pipr/main",
        marker: "pipr:main-comment",
        heading: "Review",
        sections: [
          { id: "summary", title: "Summary", order: 10 },
          { id: "custom", title: "Custom", order: 20, empty: "Nothing here." },
          { id: "metadata", title: "Metadata", order: 30, collapsed: true },
        ],
      },
    });

    expect(plan.mainComment).toContain("Nothing here.");
    expect(plan.mainComment).toContain("<summary>Metadata</summary>");
  });
});
