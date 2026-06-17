import crypto from "node:crypto";
import { z } from "zod";
import type { DiffManifest, PrReview, ReviewFinding, ValidatedReview } from "./types.js";

const findingSchema = z.object({
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
});

export const prReviewSchema = z.object({
  summary: z.object({
    body: z.string().min(1),
  }),
  inlineFindings: z.array(findingSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ValidateReviewOptions = {
  maxInlineComments: number;
  minConfidence: number;
};

export function parsePrReview(value: unknown): PrReview {
  return prReviewSchema.parse(value) as PrReview;
}

export function validatePrReview(
  review: PrReview,
  manifest: DiffManifest,
  options: ValidateReviewOptions,
): ValidatedReview {
  const ranges = new Map(
    manifest.files.flatMap((file) => file.commentableRanges.map((range) => [range.id, range])),
  );
  const excludedFiles = new Map(
    manifest.files
      .filter((file) => file.excludedReason)
      .map((file) => [file.path, file.excludedReason ?? "excluded"]),
  );

  const validFindings: ReviewFinding[] = [];
  const droppedFindings: ValidatedReview["droppedFindings"] = [];

  for (const finding of review.inlineFindings) {
    const excludedReason = excludedFiles.get(finding.path);
    const range = ranges.get(finding.rangeId);
    let reason: string | undefined;

    if (finding.confidence < options.minConfidence) {
      reason = `confidence ${finding.confidence} below ${options.minConfidence}`;
    } else if (excludedReason) {
      reason = `file excluded from inline comments: ${excludedReason}`;
    } else if (!range) {
      reason = `unknown rangeId '${finding.rangeId}'`;
    } else if (range.path !== finding.path) {
      reason = "finding path does not match range path";
    } else if (range.side !== finding.side) {
      reason = "finding side does not match range side";
    } else if (finding.startLine < range.startLine || finding.endLine > range.endLine) {
      reason = "finding lines fall outside the commentable range";
    } else if (finding.startLine > finding.endLine) {
      reason = "finding startLine is after endLine";
    }

    if (reason) {
      droppedFindings.push({ finding, reason });
      continue;
    }

    if (validFindings.length >= options.maxInlineComments) {
      droppedFindings.push({
        finding,
        reason: `inline comment cap ${options.maxInlineComments} reached`,
      });
      continue;
    }

    validFindings.push(finding);
  }

  return {
    review,
    validFindings,
    droppedFindings,
  };
}

export function findingFingerprint(finding: ReviewFinding): string {
  const basis = finding.fingerprintHint
    ? finding.fingerprintHint
    : [
        finding.path,
        finding.rangeId,
        finding.side,
        finding.startLine,
        finding.endLine,
        finding.title,
        finding.body,
      ].join("\n");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}
