import { createDiffRangeIndex } from "../diff/ranges.js";
import type { CommentableRange, DiffManifest, ValidatedReview } from "../types.js";
import { parseValidatedReview } from "../types.js";
import {
  type PrReview,
  parsePrReview,
  prReviewJsonSchema,
  prReviewSchemaId,
  type ReviewFinding,
  reviewSchemaExample,
} from "./contract.js";
import { findingRangeMismatchReason } from "./range-validation.js";

export { parsePrReview, prReviewJsonSchema, prReviewSchemaId, reviewSchemaExample };

export type ValidateReviewOptions = {
  expectedHeadSha?: string;
};

export function validatePrReview(
  review: PrReview,
  manifest: DiffManifest,
  options: ValidateReviewOptions,
): ValidatedReview {
  if (options.expectedHeadSha && manifest.headSha !== options.expectedHeadSha) {
    throw new Error(
      `Diff Manifest head SHA '${manifest.headSha}' does not match expected head SHA '${options.expectedHeadSha}'`,
    );
  }
  const ranges = createDiffRangeIndex(manifest);
  const seenFingerprints = new Set<string>();

  const validFindings: ReviewFinding[] = [];
  const droppedFindings: ValidatedReview["droppedFindings"] = [];

  for (const finding of review.inlineFindings) {
    const fingerprint = findingFingerprint(finding);
    const reason = findingDropReason({
      finding,
      fingerprint,
      range: ranges.rangeById(finding.rangeId),
      excludedReason: ranges.excludedReason(finding.path),
      seenFingerprints,
    });

    if (reason) {
      droppedFindings.push({ finding, reason });
      continue;
    }

    seenFingerprints.add(fingerprint);
    validFindings.push(finding);
  }

  return parseValidatedReview({
    review,
    validFindings,
    droppedFindings,
  });
}

type FindingValidationContext = {
  finding: ReviewFinding;
  fingerprint: string;
  range?: CommentableRange;
  excludedReason?: string;
  seenFingerprints: Set<string>;
};

type FindingValidator = (context: FindingValidationContext) => string | undefined;

const findingValidators: FindingValidator[] = [
  validateExcludedFile,
  validateRangeMatch,
  validateDuplicateFingerprint,
];

function findingDropReason(context: FindingValidationContext): string | undefined {
  for (const validator of findingValidators) {
    const reason = validator(context);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}

function validateExcludedFile(context: FindingValidationContext): string | undefined {
  return context.excludedReason
    ? `file excluded from inline comments: ${context.excludedReason}`
    : undefined;
}

function validateRangeMatch(context: FindingValidationContext): string | undefined {
  return findingRangeMismatchReason(context.finding, context.range);
}

function validateDuplicateFingerprint(context: FindingValidationContext): string | undefined {
  return context.seenFingerprints.has(context.fingerprint)
    ? "duplicate finding fingerprint"
    : undefined;
}

export function findingFingerprint(finding: ReviewFinding): string {
  const location = [
    finding.path,
    finding.rangeId,
    finding.side,
    `${finding.startLine}-${finding.endLine}`,
  ];
  const basis = [...location, finding.body].join("\n");
  return new Bun.CryptoHasher("sha256").update(basis).digest("hex").slice(0, 16);
}
