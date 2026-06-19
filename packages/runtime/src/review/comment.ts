import { z } from "zod";
import type { CommentTemplateComponent } from "../config/schema.js";
import type {
  PrReview,
  PullRequestEventContext,
  ReviewFinding,
  ValidatedReview,
} from "../types.js";
import { reviewSideSchema } from "../types.js";
import { findingFingerprint } from "./review.js";

export const mainCommentMarker = "pipr:main-comment";
export const findingMarkerPrefix = "pipr:finding";

export type RenderMainCommentOptions = {
  event: Pick<PullRequestEventContext, "pullRequestNumber" | "headSha">;
  review: PrReview;
  validFindings: ReviewFinding[];
  droppedCount: number;
  providerModel: string;
  template?: CommentTemplateComponent;
};

export function renderMainComment(options: RenderMainCommentOptions): string {
  const template = options.template ?? defaultMainCommentTemplate();
  return [
    `<!-- ${template.marker} pr=${options.event.pullRequestNumber} -->`,
    "",
    `# ${template.heading}`,
    "",
    ...template.sections
      .toSorted((left, right) => left.order - right.order)
      .flatMap((section) => renderMainCommentSection(section, options)),
  ].join("\n");
}

function defaultMainCommentTemplate(): CommentTemplateComponent {
  return {
    apiVersion: "pipr.dev/v1",
    kind: "CommentTemplate",
    id: "pipr/main",
    marker: mainCommentMarker,
    heading: "pipr Review",
    sections: [
      { id: "summary", title: "Summary", order: 10, empty: "No summary was produced." },
      { id: "findings", title: "Findings", order: 20, empty: "No high-confidence findings." },
      { id: "metadata", title: "Review metadata", order: 30, collapsed: true },
    ],
  };
}

function renderMainCommentSection(
  section: CommentTemplateComponent["sections"][number],
  options: RenderMainCommentOptions,
): string[] {
  switch (section.id) {
    case "summary":
      return renderMarkdownSection(section.title, options.review.summary.body || section.empty);
    case "findings":
      return renderMarkdownSection(section.title, renderFindings(options, section.empty));
    case "metadata":
      return renderMetadataSection(section, options);
    default:
      throw new Error(`Unknown Main Review Comment section '${section.id}'`);
  }
}

function renderFindings(options: RenderMainCommentOptions, emptyText?: string): string {
  const findingsText =
    options.validFindings.length === 0
      ? (emptyText ?? "No high-confidence findings.")
      : options.validFindings
          .map((finding) => `- **${finding.title}**: ${finding.body}`)
          .join("\n");
  return findingsText;
}

function renderMarkdownSection(title: string, body: string | undefined): string[] {
  return [`## ${title}`, "", body ?? "", ""];
}

function renderMetadataSection(
  section: CommentTemplateComponent["sections"][number],
  options: RenderMainCommentOptions,
): string[] {
  const lines = [
    `Last reviewed commit: \`${options.event.headSha}\`  `,
    `Model: \`${options.providerModel}\`  `,
    `Valid inline findings: \`${options.validFindings.length}\`  `,
    `Dropped findings: \`${options.droppedCount}\``,
  ];
  if (!section.collapsed) {
    return renderMarkdownSection(section.title, lines.join("\n"));
  }
  return ["<details>", `<summary>${section.title}</summary>`, "", ...lines, "", "</details>", ""];
}

export const inlineCommentDraftSchema = z
  .object({
    path: z.string().min(1),
    side: reviewSideSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    body: z.string().min(1),
    marker: z.string().min(1),
  })
  .strict();

export type InlineCommentDraft = z.infer<typeof inlineCommentDraftSchema>;

export const inlineCommentDraftsSchema = z.array(inlineCommentDraftSchema);

export function parseInlineCommentDrafts(value: unknown): InlineCommentDraft[] {
  return inlineCommentDraftsSchema.parse(value);
}

export function prepareInlineCommentDrafts(
  validated: ValidatedReview,
  existingMarkers: Set<string> = new Set(),
): InlineCommentDraft[] {
  const seenMarkers = new Set(existingMarkers);
  return parseInlineCommentDrafts(
    validated.validFindings.flatMap((finding) => {
      const fingerprint = findingFingerprint(finding);
      const marker = `${findingMarkerPrefix}:${fingerprint}`;
      if (seenMarkers.has(marker)) {
        return [];
      }
      seenMarkers.add(marker);
      return [
        inlineCommentDraftSchema.parse({
          path: finding.path,
          side: finding.side,
          startLine: finding.startLine,
          endLine: finding.endLine,
          marker,
          body: renderInlineBody(finding, marker),
        }),
      ];
    }),
  );
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
