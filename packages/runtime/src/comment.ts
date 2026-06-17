import { findingFingerprint } from "./review.js";
import type { PrReview, PullRequestEventContext, ReviewFinding, ValidatedReview } from "./types.js";

export const mainCommentMarker = "pipr:main-comment";
export const findingMarkerPrefix = "pipr:finding";

export type RenderMainCommentOptions = {
  event: Pick<PullRequestEventContext, "pullRequestNumber" | "headSha">;
  review: PrReview;
  validFindings: ReviewFinding[];
  droppedCount: number;
  providerModel: string;
};

export function renderMainComment(options: RenderMainCommentOptions): string {
  const findingsText =
    options.validFindings.length === 0
      ? "No high-confidence findings."
      : options.validFindings
          .map((finding) => `- **${finding.title}**: ${finding.body}`)
          .join("\n");

  return [
    `<!-- ${mainCommentMarker} pr=${options.event.pullRequestNumber} -->`,
    "",
    "# pipr Review",
    "",
    "## Summary",
    "",
    options.review.summary.body,
    "",
    "## Findings",
    "",
    findingsText,
    "",
    "<details>",
    "<summary>Review metadata</summary>",
    "",
    `Last reviewed commit: \`${options.event.headSha}\`  `,
    `Model: \`${options.providerModel}\`  `,
    `Valid inline findings: \`${options.validFindings.length}\`  `,
    `Dropped findings: \`${options.droppedCount}\``,
    "",
    "</details>",
  ].join("\n");
}

export type InlineCommentDraft = {
  path: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
  body: string;
  marker: string;
};

export function prepareInlineCommentDrafts(
  validated: ValidatedReview,
  existingMarkers: Set<string> = new Set(),
): InlineCommentDraft[] {
  const seenMarkers = new Set(existingMarkers);
  return validated.validFindings.flatMap((finding) => {
    const fingerprint = findingFingerprint(finding);
    const marker = `${findingMarkerPrefix}:${fingerprint}`;
    if (seenMarkers.has(marker)) {
      return [];
    }
    seenMarkers.add(marker);
    return [
      {
        path: finding.path,
        side: finding.side,
        startLine: finding.startLine,
        endLine: finding.endLine,
        marker,
        body: renderInlineBody(finding, marker),
      },
    ];
  });
}

export function extractFindingMarkers(commentBodies: string[]): Set<string> {
  const markers = new Set<string>();
  const pattern = /<!--\s*(pipr:finding:[a-f0-9]+)\s*-->/g;
  for (const body of commentBodies) {
    for (const match of body.matchAll(pattern)) {
      markers.add(match[1] ?? "");
    }
  }
  markers.delete("");
  return markers;
}

function renderInlineBody(finding: ReviewFinding, marker: string): string {
  return [
    `<!-- ${marker} -->`,
    `**${finding.title}**`,
    "",
    finding.body,
    "",
    `Severity: \`${finding.severity}\`  `,
    `Confidence: \`${finding.confidence.toFixed(2)}\``,
    finding.suggestedFix ? `\nSuggested fix:\n\n${finding.suggestedFix}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
