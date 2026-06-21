import { describe, expect, it } from "vitest";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import type { PrReview } from "../../types.js";
import {
  parsePrReview,
  prReviewJsonSchema,
  reviewSchemaExample,
  validatePrReview,
} from "../review.js";

const manifest = reviewTestManifest({ includeExcludedLock: true });

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
        inlineFindings: { type: "array" },
      },
    });
    expect(prReviewJsonSchema).not.toHaveProperty(["properties", "nonInlineFindings"]);
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

  it("rejects non-inline findings in the MVP", () => {
    expect(() =>
      parsePrReview({
        summary: { body: "Looks fine." },
        inlineFindings: [],
        nonInlineFindings: [],
      }),
    ).toThrow();
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
      minConfidence: 0.75,
      expectedHeadSha: "head",
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
      minConfidence: 0.75,
    });

    expect(validated.validFindings).toHaveLength(0);
    expect(validated.droppedFindings.map((drop) => drop.reason)).toEqual([
      "confidence 0.5 below 0.75",
      "file excluded from inline comments: lock file",
    ]);
  });

  it("drops semantic mismatches and duplicate fingerprints", () => {
    const review: PrReview = {
      ...baseReview,
      inlineFindings: [
        { ...baseFinding, side: "LEFT" },
        { ...baseFinding, path: "src/other.ts" },
        { ...baseFinding, rangeId: "missing" },
        { ...baseFinding, evidenceSnippet: "not near target" },
        baseFinding,
        baseFinding,
      ],
    };

    const validated = validatePrReview(review, manifest, {
      minConfidence: 0.75,
      expectedHeadSha: "head",
    });

    expect(validated.validFindings).toHaveLength(1);
    expect(validated.droppedFindings.map((drop) => drop.reason)).toEqual([
      "finding side does not match range side",
      "finding path does not match range path",
      "unknown rangeId 'missing'",
      "finding evidenceSnippet was not found near the target range",
      "duplicate finding fingerprint",
    ]);
  });

  it("keeps repeated semantic findings when they target different ranges", () => {
    const review: PrReview = {
      ...baseReview,
      inlineFindings: [
        { ...baseFinding, fingerprintHint: "same-root-cause" },
        {
          ...baseFinding,
          rangeId: "range-2",
          startLine: 20,
          endLine: 21,
          fingerprintHint: "same-root-cause",
        },
      ],
    };

    const validated = validatePrReview(review, manifest, {
      minConfidence: 0.75,
      expectedHeadSha: "head",
    });

    expect(validated.validFindings).toHaveLength(2);
    expect(validated.droppedFindings).toHaveLength(0);
  });

  it("fails validation when the Diff Manifest head is stale", () => {
    expect(() =>
      validatePrReview(baseReview, manifest, {
        minConfidence: 0.75,
        expectedHeadSha: "new-head",
      }),
    ).toThrow("does not match expected head SHA");
  });
});
