import crypto from "node:crypto";
import {
  type PrReview,
  parsePrReview,
  prReviewJsonSchema,
  prReviewSchema,
  type ReviewFinding,
  reviewFindingSchema,
  reviewSchemaExample,
} from "./review-contract.js";
import type { DiffManifest, ValidatedReview } from "./types.js";
import { parseValidatedReview } from "./types.js";

export {
  parsePrReview,
  prReviewJsonSchema,
  prReviewSchema,
  reviewFindingSchema,
  reviewSchemaExample,
};

export type ValidateReviewOptions = {
  maxInlineComments: number;
  minConfidence: number;
};

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

  return parseValidatedReview({
    review,
    validFindings,
    droppedFindings,
  });
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
