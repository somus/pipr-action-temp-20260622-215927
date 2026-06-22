import { describe, expect, it } from "vitest";
import type { ValidatedReview } from "../../types.js";
import {
  buildPublicationPlan,
  extractFindingMarkers,
  prepareInlinePublicationItems,
  reduceMainSectionContributions,
  reviewToMainSectionContributions,
} from "../comment.js";

const validated: ValidatedReview = {
  review: {
    summary: { body: "Summary body." },
    inlineFindings: [],
  },
  validFindings: [
    {
      body: "This can fail.",
      path: "src/a.ts",
      rangeId: "range-1",
      side: "RIGHT",
      startLine: 10,
      endLine: 10,
      suggestedFix: "Use a safe call.",
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
    const body = buildPublicationPlan({
      event: { pullRequestNumber: 1, headSha: "abc123" },
      mainContributions: reviewToMainSectionContributions({
        sourceId: "pipr/review",
        validated,
      }),
      inlineItems: [],
      metadata: {
        runtimeVersion: "0.0.0",
        reviewedHeadSha: "abc123",
        providerModels: ["deepseek-v4-pro"],
        selectedTasks: ["review"],
        failedTasks: [],
        validFindings: validated.validFindings.length,
        droppedFindings: 0,
      },
    }).mainComment;

    expect(body).toContain("<!-- pipr:main-comment pr=1 -->");
    expect(body).toContain("# pipr Review");
  });

  it("renders the Main Review Comment from a MainCommentLayout", () => {
    const body = buildPublicationPlan({
      event: { pullRequestNumber: 1, headSha: "abc123" },
      mainContributions: reviewToMainSectionContributions({
        sourceId: "pipr/review",
        validated: { ...validated, validFindings: [] },
      }),
      inlineItems: [],
      metadata: {
        runtimeVersion: "0.0.0",
        reviewedHeadSha: "abc123",
        providerModels: ["deepseek-v4-pro"],
        selectedTasks: ["review"],
        failedTasks: [],
        validFindings: 0,
        droppedFindings: 0,
      },
      layout: {
        marker: "pipr:custom-main",
        heading: "Custom Review",
        sections: [
          { id: "findings", title: "Issues", order: 20, empty: "Nothing actionable." },
          { id: "summary", title: "Digest", order: 10 },
          { id: "metadata", title: "Trace", order: 30, collapsed: true },
        ],
      },
    }).mainComment;

    expect(body).toContain("<!-- pipr:custom-main pr=1 -->");
    expect(body).toContain("# Custom Review");
    expect(body.indexOf("## Digest")).toBeLessThan(body.indexOf("## Issues"));
    expect(body).toContain("Nothing actionable.");
    expect(body).toContain("<summary>Trace</summary>");
  });

  it("dedupes inline drafts with hidden markers", () => {
    const first = prepareInlinePublicationItems({ validated, manifest, reviewedHeadSha: "head" });
    const markers = extractFindingMarkers(first.map((draft) => draft.body));
    const second = prepareInlinePublicationItems({
      validated,
      manifest,
      reviewedHeadSha: "head",
      existingMarkers: markers,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(first[0]?.body).toContain("<!-- pipr:finding fingerprint=");
    expect(first[0]?.body).toContain(" head=head -->");
    expect(first[0]?.body).toContain("This can fail.");
    expect(first[0]?.body).toContain("Suggested fix:");
    expect(first[0]?.body).toContain("Use a safe call.");
    expect(first[0]?.body).not.toContain("Severity:");
    expect(first[0]?.body).not.toContain("Confidence:");
  });

  it("dedupes duplicate findings in the same draft batch", () => {
    const finding = validated.validFindings[0];
    if (!finding) {
      throw new Error("test fixture missing finding");
    }
    const drafts = prepareInlinePublicationItems({
      validated: {
        ...validated,
        validFindings: [finding, finding],
      },
      manifest,
      reviewedHeadSha: "head",
    });

    expect(drafts).toHaveLength(1);
  });

  it("rejects malformed inline comment drafts", () => {
    expect(() =>
      buildPublicationPlan({
        event: { pullRequestNumber: 1, headSha: "head" },
        mainContributions: [],
        inlineItems: [
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
          } as never,
        ],
        metadata: {
          runtimeVersion: "0.0.0",
          reviewedHeadSha: "head",
          selectedTasks: ["review"],
          failedTasks: [],
          validFindings: 0,
          droppedFindings: 0,
        },
      }),
    ).toThrow();
  });

  it("reduces main sections deterministically", () => {
    const reduced = reduceMainSectionContributions([
      {
        sourceId: "b/task",
        sectionId: "summary",
        policy: "replace",
        priority: 5,
        value: "B",
      },
      {
        sourceId: "a/task",
        sectionId: "summary",
        policy: "replace",
        priority: 5,
        value: "A",
      },
      {
        sourceId: "a/task",
        sectionId: "details",
        policy: "append",
        priority: 1,
        value: "one",
      },
      {
        sourceId: "b/task",
        sectionId: "details",
        policy: "append",
        priority: 2,
        value: "two",
      },
      {
        sourceId: "a/task",
        sectionId: "findings",
        policy: "list",
        priority: 1,
        value: "first",
      },
      {
        sourceId: "b/task",
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
        sourceId: "a/task",
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
        sourceId: "b/task",
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
        { sourceId: "a", sectionId: "summary", policy: "exclusive", priority: 1, value: "A" },
        { sourceId: "b", sectionId: "summary", policy: "exclusive", priority: 1, value: "B" },
      ]),
    ).toThrow("multiple exclusive writers");

    expect(() =>
      reduceMainSectionContributions([
        { sourceId: "a", sectionId: "summary", policy: "replace", priority: 1, value: "A" },
        { sourceId: "b", sectionId: "summary", policy: "append", priority: 1, value: "B" },
      ]),
    ).toThrow("mixed merge policies");
  });

  it("renders a publication plan with configured empty sections", () => {
    const plan = buildPublicationPlan({
      event: { pullRequestNumber: 1, headSha: "head" },
      mainContributions: reviewToMainSectionContributions({
        sourceId: "pipr/review",
        validated: { ...validated, validFindings: [] },
      }),
      inlineItems: [],
      metadata: {
        runtimeVersion: "0.0.0",
        reviewedHeadSha: "head",
        selectedTasks: ["review"],
        failedTasks: [],
        validFindings: 0,
        droppedFindings: 0,
      },
      layout: {
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
