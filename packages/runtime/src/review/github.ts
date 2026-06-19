import { z } from "zod";
import type { CommentableRange, ReviewFinding } from "../types.js";
import { reviewSideSchema } from "../types.js";

export const githubReviewCommentLocationSchema = z
  .strictObject({
    path: z.string().min(1),
    commit_id: z.string().min(1),
    line: z.number().int().positive(),
    side: reviewSideSchema,
    start_line: z.number().int().positive().optional(),
    start_side: reviewSideSchema.optional(),
  })
  .superRefine((location, context) => {
    const hasStartLine = location.start_line !== undefined;
    const hasStartSide = location.start_side !== undefined;
    if (hasStartLine !== hasStartSide) {
      context.addIssue({
        code: "custom",
        message: "GitHub multi-line locations require start_line and start_side together",
      });
    }
    if (location.start_line !== undefined && location.start_line > location.line) {
      context.addIssue({
        code: "custom",
        message: "GitHub multi-line start_line must be before or equal to line",
      });
    }
  });

export type GithubReviewCommentLocation = z.infer<typeof githubReviewCommentLocationSchema>;

export function mapFindingToGithubReviewCommentLocation(options: {
  finding: ReviewFinding;
  range: CommentableRange;
  headSha: string;
}): GithubReviewCommentLocation {
  const { finding, range, headSha } = options;
  assertFindingMatchesRange(finding, range);
  const location: GithubReviewCommentLocation = {
    path: finding.path,
    commit_id: headSha,
    line: finding.endLine,
    side: finding.side,
  };
  if (finding.startLine !== finding.endLine) {
    location.start_line = finding.startLine;
    location.start_side = finding.side;
  }
  return githubReviewCommentLocationSchema.parse(location);
}

function assertFindingMatchesRange(finding: ReviewFinding, range: CommentableRange): void {
  if (finding.rangeId !== range.id) {
    throw new Error("finding rangeId does not match range");
  }
  if (finding.path !== range.path) {
    throw new Error("finding path does not match range path");
  }
  if (finding.side !== range.side) {
    throw new Error("finding side does not match range side");
  }
  if (finding.startLine < range.startLine || finding.endLine > range.endLine) {
    throw new Error("finding lines fall outside the commentable range");
  }
  if (finding.startLine > finding.endLine) {
    throw new Error("finding startLine is after endLine");
  }
}
