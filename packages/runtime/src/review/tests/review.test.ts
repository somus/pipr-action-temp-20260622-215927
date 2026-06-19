import { describe, expect, it } from "vitest";
import type { DiffManifest, PrReview } from "../../types.js";
import {
  parsePrReview,
  prReviewJsonSchema,
  reviewSchemaExample,
  validatePrReview,
} from "../review.js";

const manifest: DiffManifest = {
  baseSha: "base",
  headSha: "head",
  mergeBaseSha: "base",
  files: [
    {
      path: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      hunks: [
        {
          hunkIndex: 1,
          header: "@@ -9,1 +10,3 @@",
          oldStart: 9,
          oldLines: 1,
          newStart: 10,
          newLines: 3,
          contentHash: "deadbeefcafe",
        },
      ],
      commentableRanges: [
        {
          id: "range-1",
          path: "src/a.ts",
          side: "RIGHT",
          startLine: 10,
          endLine: 12,
          kind: "added",
          hunkIndex: 1,
          hunkHeader: "@@ -9,1 +10,3 @@",
          hunkContentHash: "deadbeefcafe",
        },
      ],
    },
    {
      path: "bun.lock",
      status: "modified",
      additions: 1,
      deletions: 1,
      excludedReason: "lock file",
      hunks: [],
      commentableRanges: [],
    },
  ],
};

const baseReview: PrReview = {
  summary: { body: "Looks fine." },
  inlineFindings: [
    {
      title: "Bug",
      body: "This can fail.",
      path: "src/a.ts",
      rangeId: "range-1",
      side: "RIGHT",
      startLine: 10,
      endLine: 11,
      severity: "high",
      category: "correctness",
      confidence: 0.9,
      evidenceSnippet: "const x = fail();",
    },
  ],
};
const baseFinding = baseReview.inlineFindings[0];
if (!baseFinding) {
  throw new Error("test fixture missing base finding");
}

describe("validatePrReview", () => {
  it("uses one Review Output Contract for examples and runtime schema", () => {
    expect(parsePrReview(reviewSchemaExample()).summary.body).toBe(
      "Concise pull request review summary.",
    );
    expect(prReviewJsonSchema).toMatchObject({
      type: "object",
      properties: {
        nonInlineFindings: {
          type: "array",
          prefixItems: [],
        },
      },
    });
  });

  it("rejects reviewer output outside the published schema contract", () => {
    expect(() =>
      parsePrReview({
        summary: { body: "Looks fine." },
      }),
    ).toThrow();
    expect(() =>
      parsePrReview({
        summary: { body: "Looks fine.", extra: true },
        inlineFindings: [],
      }),
    ).toThrow();
    expect(() =>
      parsePrReview({
        summary: { body: "Looks fine." },
        inlineFindings: [],
        extra: true,
      }),
    ).toThrow();
  });

  it("reserves non-inline findings as empty-only", () => {
    expect(
      parsePrReview({
        summary: { body: "Looks fine." },
        inlineFindings: [],
      }).nonInlineFindings,
    ).toBeUndefined();
    expect(
      parsePrReview({
        summary: { body: "Looks fine." },
        inlineFindings: [],
        nonInlineFindings: [],
      }).nonInlineFindings,
    ).toEqual([]);
    expect(() =>
      parsePrReview({
        summary: { body: "Looks fine." },
        inlineFindings: [],
        nonInlineFindings: [{ title: "Later" }],
      }),
    ).toThrow();
  });

  it("keeps findings inside a commentable range", () => {
    const validated = validatePrReview(baseReview, manifest, {
      maxInlineComments: 5,
      minConfidence: 0.75,
    });

    expect(validated.validFindings).toHaveLength(1);
    expect(validated.droppedFindings).toHaveLength(0);
  });

  it("drops low confidence and excluded-file findings", () => {
    const review: PrReview = {
      ...baseReview,
      inlineFindings: [
        { ...baseFinding, confidence: 0.5 },
        { ...baseFinding, path: "bun.lock", rangeId: "range-lock" },
      ],
    };

    const validated = validatePrReview(review, manifest, {
      maxInlineComments: 5,
      minConfidence: 0.75,
    });

    expect(validated.validFindings).toHaveLength(0);
    expect(validated.droppedFindings.map((drop) => drop.reason)).toEqual([
      "confidence 0.5 below 0.75",
      "file excluded from inline comments: lock file",
    ]);
  });

  it("honors a zero inline comment cap", () => {
    const validated = validatePrReview(baseReview, manifest, {
      maxInlineComments: 0,
      minConfidence: 0.75,
    });

    expect(validated.validFindings).toHaveLength(0);
    expect(validated.droppedFindings.map((drop) => drop.reason)).toEqual([
      "inline comment cap 0 reached",
    ]);
  });
});
