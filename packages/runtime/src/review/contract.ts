import {
  parseReviewResult,
  type ReviewResult,
  reviewOutputSchemaId,
  type ReviewFinding as SdkReviewFinding,
  reviewSchemaExample as sdkReviewSchemaExample,
} from "@pipr/sdk";
import { z } from "zod";

export const prReviewSchemaId = reviewOutputSchemaId;

export const reviewFindingSchema = z.strictObject({
  body: z.string().min(1),
  path: z.string().min(1),
  rangeId: z.string().min(1),
  side: z.enum(["RIGHT", "LEFT"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  suggestedFix: z.string().min(1).optional(),
});

export const prReviewSchema = z.strictObject({
  summary: z.strictObject({
    title: z.string().min(1).optional(),
    body: z.string().min(1),
  }),
  inlineFindings: z.array(reviewFindingSchema),
});

export type ReviewFinding = SdkReviewFinding;
export type PrReview = ReviewResult;

export const prReviewJsonSchema = z.toJSONSchema(prReviewSchema);

export function parsePrReview(value: unknown): PrReview {
  return prReviewSchema.parse(parseReviewResult(value)) as PrReview;
}

export function reviewSchemaExample(): PrReview {
  return parsePrReview(sdkReviewSchemaExample());
}
