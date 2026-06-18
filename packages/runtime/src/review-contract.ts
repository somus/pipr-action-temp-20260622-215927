import { z } from "zod";

export const reviewFindingSchema = z
  .object({
    title: z.string().min(1),
    body: z.string().min(1),
    path: z.string().min(1),
    rangeId: z.string().min(1),
    side: z.enum(["RIGHT", "LEFT"]),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    severity: z.enum(["critical", "high", "medium", "low", "nit"]),
    category: z.enum([
      "correctness",
      "security",
      "tests",
      "performance",
      "maintainability",
      "docs",
      "architecture",
      "other",
    ]),
    confidence: z.number().min(0).max(1),
    evidenceSnippet: z.string().min(1),
    suggestedFix: z.string().optional(),
    semanticAnchor: z.string().optional(),
    fingerprintHint: z.string().optional(),
  })
  .strict();

export const prReviewSchema = z
  .object({
    summary: z
      .object({
        body: z.string().min(1),
      })
      .strict(),
    inlineFindings: z.array(reviewFindingSchema),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewFindingSeverity = ReviewFinding["severity"];
export type ReviewFindingCategory = ReviewFinding["category"];
export type PrReview = z.infer<typeof prReviewSchema>;

export const prReviewJsonSchema = z.toJSONSchema(prReviewSchema);

export function parsePrReview(value: unknown): PrReview {
  return prReviewSchema.parse(value);
}

export function reviewSchemaExample(): PrReview {
  return {
    summary: {
      body: "Concise pull request review summary.",
    },
    inlineFindings: [
      {
        title: "Short finding title",
        body: "Specific issue and why it matters.",
        path: "src/example.ts",
        rangeId: "rng_example",
        side: "RIGHT",
        startLine: 1,
        endLine: 1,
        severity: "medium",
        category: "correctness",
        confidence: 0.9,
        evidenceSnippet: "changed code excerpt",
        suggestedFix: "Optional fix.",
        semanticAnchor: "Optional symbol or behavior.",
        fingerprintHint: "Optional stable dedupe hint.",
      },
    ],
    metadata: {},
  };
}
