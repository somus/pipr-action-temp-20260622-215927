import { describe, expect, it } from "vitest";
import {
  extractFindingMarkers,
  parseInlineCommentDrafts,
  prepareInlineCommentDrafts,
  renderMainComment,
} from "../src/comment.js";
import type { ValidatedReview } from "../src/types.js";

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
    const first = prepareInlineCommentDrafts(validated);
    const markers = extractFindingMarkers(first.map((draft) => draft.body));
    const second = prepareInlineCommentDrafts(validated, markers);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("dedupes duplicate findings in the same draft batch", () => {
    const finding = validated.validFindings[0];
    if (!finding) {
      throw new Error("test fixture missing finding");
    }
    const drafts = prepareInlineCommentDrafts({
      ...validated,
      validFindings: [finding, finding],
    });

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
          marker: "pipr:finding:abc",
        },
      ]),
    ).toThrow();
  });
});
