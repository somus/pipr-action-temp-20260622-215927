import crypto from "node:crypto";
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

export { parsePrReview, prReviewJsonSchema, prReviewSchemaId, reviewSchemaExample };

export type ValidateReviewOptions = {
  minConfidence: number;
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
  const ranges = new Map(
    manifest.files.flatMap((file) => file.commentableRanges.map((range) => [range.id, range])),
  );
  const excludedFiles = new Map(
    manifest.files
      .filter((file) => file.excludedReason)
      .map((file) => [file.path, file.excludedReason ?? "excluded"]),
  );
  const seenFingerprints = new Set<string>();

  const validFindings: ReviewFinding[] = [];
  const droppedFindings: ValidatedReview["droppedFindings"] = [];

  for (const finding of review.inlineFindings) {
    const fingerprint = findingFingerprint(finding);
    const reason = findingDropReason({
      finding,
      fingerprint,
      range: ranges.get(finding.rangeId),
      excludedReason: excludedFiles.get(finding.path),
      minConfidence: options.minConfidence,
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
  minConfidence: number;
  seenFingerprints: Set<string>;
};

type FindingValidator = (context: FindingValidationContext) => string | undefined;

const findingValidators: FindingValidator[] = [
  validateConfidence,
  validateExcludedFile,
  validateKnownRange,
  validatePath,
  validateSide,
  validateLineOrder,
  validateLineBounds,
  validateRangePreview,
  validateEvidence,
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

function validateConfidence(context: FindingValidationContext): string | undefined {
  return context.finding.confidence < context.minConfidence
    ? `confidence ${context.finding.confidence} below ${context.minConfidence}`
    : undefined;
}

function validateExcludedFile(context: FindingValidationContext): string | undefined {
  return context.excludedReason
    ? `file excluded from inline comments: ${context.excludedReason}`
    : undefined;
}

function validateKnownRange(context: FindingValidationContext): string | undefined {
  return context.range ? undefined : `unknown rangeId '${context.finding.rangeId}'`;
}

function validatePath(context: FindingValidationContext): string | undefined {
  return context.range?.path !== context.finding.path
    ? "finding path does not match range path"
    : undefined;
}

function validateSide(context: FindingValidationContext): string | undefined {
  return context.range?.side !== context.finding.side
    ? "finding side does not match range side"
    : undefined;
}

function validateLineOrder(context: FindingValidationContext): string | undefined {
  return context.finding.startLine > context.finding.endLine
    ? "finding startLine is after endLine"
    : undefined;
}

function validateLineBounds(context: FindingValidationContext): string | undefined {
  const range = context.range;
  return range &&
    (context.finding.startLine < range.startLine || context.finding.endLine > range.endLine)
    ? "finding lines fall outside the commentable range"
    : undefined;
}

function validateRangePreview(context: FindingValidationContext): string | undefined {
  return context.range?.preview ? undefined : "range preview unavailable for evidence validation";
}

function validateEvidence(context: FindingValidationContext): string | undefined {
  return context.range?.preview &&
    !evidenceMatchesRange(context.finding.evidenceSnippet, context.range.preview)
    ? "finding evidenceSnippet was not found near the target range"
    : undefined;
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
  const basis = [
    ...location,
    finding.fingerprintHint ??
      [
        finding.title,
        finding.body,
        finding.severity,
        finding.category,
        finding.evidenceSnippet,
        finding.semanticAnchor ?? "",
      ].join("\n"),
  ].join("\n");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function evidenceMatchesRange(evidenceSnippet: string, rangePreview: string): boolean {
  const evidence = normalizeEvidence(evidenceSnippet);
  return evidence.length > 0 && normalizeEvidence(rangePreview).includes(evidence);
}

function normalizeEvidence(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
