import { z } from "zod";
import type { CommentTemplateComponent } from "../config/schema.js";
import type {
  DiffManifest,
  PrReview,
  PullRequestEventContext,
  ReviewFinding,
  ValidatedReview,
} from "../types.js";
import { commentableRangeSchema, reviewSideSchema } from "../types.js";
import { reviewFindingSchema } from "./contract.js";
import { findingFingerprint } from "./review.js";

export const mainCommentMarker = "pipr:main-comment";
export const findingMarkerPrefix = "pipr:finding";
export const runtimeVersion = "0.0.0";

const mainSectionMergePolicySchema = z.enum(["exclusive", "replace", "append", "list"]);

export const mainSectionContributionSchema = z.strictObject({
  workflowId: z.string().min(1),
  sectionId: z.string().min(1),
  policy: mainSectionMergePolicySchema,
  priority: z.number().int(),
  value: z.union([z.string(), z.array(z.string())]),
});

export const mainSectionContributionsSchema = z.array(mainSectionContributionSchema);

export type MainSectionContribution = z.infer<typeof mainSectionContributionSchema>;
export type MainSectionMergePolicy = MainSectionContribution["policy"];

export const inlinePublicationItemSchema = z
  .strictObject({
    finding: reviewFindingSchema,
    range: commentableRangeSchema,
    path: z.string().min(1),
    side: reviewSideSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    body: z.string().min(1),
    marker: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
    reviewedHeadSha: z.string().min(1),
  })
  .superRefine((item, context) => {
    if (item.path !== item.finding.path) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "path must match finding.path",
      });
    }
    if (item.side !== item.finding.side) {
      context.addIssue({
        code: "custom",
        path: ["side"],
        message: "side must match finding.side",
      });
    }
    if (item.startLine !== item.finding.startLine) {
      context.addIssue({
        code: "custom",
        path: ["startLine"],
        message: "startLine must match finding.startLine",
      });
    }
    if (item.endLine !== item.finding.endLine) {
      context.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "endLine must match finding.endLine",
      });
    }
  });

export const inlinePublicationItemsSchema = z.array(inlinePublicationItemSchema);

export type InlinePublicationItem = z.infer<typeof inlinePublicationItemSchema>;
export type InlineCommentDraft = InlinePublicationItem;

export const publicationMetadataSchema = z.strictObject({
  runtimeVersion: z.string().min(1),
  trustedConfigSha: z.string().min(1).optional(),
  trustedConfigHash: z.string().min(1).optional(),
  reviewedHeadSha: z.string().min(1),
  providerModel: z.string().min(1).optional(),
  selectedWorkflows: z.array(z.string().min(1)),
  failedWorkflows: z.array(z.string().min(1)),
  validFindings: z.number().int().min(0),
  droppedFindings: z.number().int().min(0),
  cappedInlineFindings: z.number().int().min(0),
});

export type PublicationMetadata = z.infer<typeof publicationMetadataSchema>;

export const publicationPlanSchema = z.strictObject({
  mainComment: z.string().min(1),
  mainMarker: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  inlineItems: inlinePublicationItemsSchema,
  metadata: publicationMetadataSchema,
});

export type PublicationPlan = z.infer<typeof publicationPlanSchema>;

export type BuildPublicationPlanOptions = {
  event: Pick<PullRequestEventContext, "pullRequestNumber" | "headSha">;
  template?: CommentTemplateComponent;
  mainContributions: MainSectionContribution[];
  inlineItems: InlinePublicationItem[];
  metadata: Omit<PublicationMetadata, "cappedInlineFindings">;
  maxInlineComments?: number;
};

export type RenderMainCommentOptions = {
  event: Pick<PullRequestEventContext, "pullRequestNumber" | "headSha">;
  review: PrReview;
  validFindings: ReviewFinding[];
  droppedCount: number;
  providerModel: string;
  template?: CommentTemplateComponent;
};

export function parseMainSectionContributions(value: unknown): MainSectionContribution[] {
  return mainSectionContributionsSchema.parse(value);
}

export function parseInlinePublicationItems(value: unknown): InlinePublicationItem[] {
  return inlinePublicationItemsSchema.parse(value);
}

export function parseInlineCommentDrafts(value: unknown): InlineCommentDraft[] {
  return parseInlinePublicationItems(value);
}

export function buildPublicationPlan(options: BuildPublicationPlanOptions): PublicationPlan {
  const template = options.template ?? defaultMainCommentTemplate();
  const cappedInlineItems =
    options.maxInlineComments === undefined
      ? options.inlineItems
      : options.inlineItems.slice(0, options.maxInlineComments);
  const metadata = publicationMetadataSchema.parse({
    ...options.metadata,
    cappedInlineFindings: options.inlineItems.length - cappedInlineItems.length,
  });
  const reducedSections = reduceMainSectionContributions([
    ...options.mainContributions,
    metadataContribution(metadata),
  ]);
  return publicationPlanSchema.parse({
    mainComment: renderMainCommentFromSections({
      event: options.event,
      template,
      reducedSections,
    }),
    mainMarker: template.marker,
    pullRequestNumber: options.event.pullRequestNumber,
    inlineItems: cappedInlineItems,
    metadata,
  });
}

export function reduceMainSectionContributions(
  contributions: MainSectionContribution[],
): Map<string, string> {
  const sections = new Map<string, MainSectionContribution[]>();
  for (const contribution of mainSectionContributionsSchema.parse(contributions)) {
    const existing = sections.get(contribution.sectionId) ?? [];
    existing.push(contribution);
    sections.set(contribution.sectionId, existing);
  }

  return new Map(
    [...sections.entries()].map(([sectionId, sectionContributions]) => [
      sectionId,
      reduceMainSection(sectionId, sectionContributions),
    ]),
  );
}

export function reviewToMainSectionContributions(options: {
  workflowId: string;
  validated: ValidatedReview;
}): MainSectionContribution[] {
  const summary = options.validated.review.summary;
  const contributions: MainSectionContribution[] = [
    {
      workflowId: options.workflowId,
      sectionId: "summary",
      policy: "replace",
      priority: 100,
      value: summary.title ? `**${summary.title}**\n\n${summary.body}` : summary.body,
    },
  ];

  contributions.push(
    ...options.validated.validFindings.map((finding) => ({
      workflowId: options.workflowId,
      sectionId: "findings",
      policy: "list" as const,
      priority: findingPriority(finding),
      value: `- **${finding.title}**: ${finding.body}`,
    })),
  );
  return mainSectionContributionsSchema.parse(contributions);
}

export function prepareInlinePublicationItems(options: {
  validated: ValidatedReview;
  manifest: DiffManifest;
  reviewedHeadSha: string;
  existingMarkers?: Set<string>;
}): InlinePublicationItem[] {
  const ranges = new Map(
    options.manifest.files.flatMap((file) =>
      file.commentableRanges.map((range) => [range.id, range]),
    ),
  );
  const seenMarkers = new Set(options.existingMarkers);
  return parseInlinePublicationItems(
    options.validated.validFindings.flatMap((finding) => {
      const range = ranges.get(finding.rangeId);
      if (!range) {
        throw new Error(
          `Validated finding range '${finding.rangeId}' is missing from Diff Manifest`,
        );
      }
      const fingerprint = findingFingerprint(finding);
      const marker = findingMarker(fingerprint, options.reviewedHeadSha);
      if (seenMarkers.has(marker)) {
        return [];
      }
      seenMarkers.add(marker);
      return [
        inlinePublicationItemSchema.parse({
          finding,
          range,
          path: finding.path,
          side: finding.side,
          startLine: finding.startLine,
          endLine: finding.endLine,
          marker,
          fingerprint,
          reviewedHeadSha: options.reviewedHeadSha,
          body: renderInlineBody(finding, marker),
        }),
      ];
    }),
  );
}

export function prepareInlineCommentDrafts(
  validated: ValidatedReview,
  manifest: DiffManifest,
  reviewedHeadSha: string,
  existingMarkers: Set<string> = new Set(),
): InlineCommentDraft[] {
  return prepareInlinePublicationItems({ validated, manifest, reviewedHeadSha, existingMarkers });
}

export function extractFindingMarkers(commentBodies: string[]): Set<string> {
  const markers = new Set<string>();
  const pattern =
    /<!--\s*pipr:finding\s+fingerprint=(?<fingerprint>[a-f0-9]{16})\s+head=(?<head>[^\s]+)\s*-->/g;
  for (const body of commentBodies) {
    for (const match of body.matchAll(pattern)) {
      const fingerprint = match.groups?.fingerprint;
      const head = match.groups?.head;
      if (fingerprint && head) {
        markers.add(findingMarker(fingerprint, head));
      }
    }
  }
  return markers;
}

export function renderMainComment(options: RenderMainCommentOptions): string {
  const metadata: Omit<PublicationMetadata, "cappedInlineFindings"> = {
    runtimeVersion,
    reviewedHeadSha: options.event.headSha,
    providerModel: options.providerModel,
    selectedWorkflows: ["pipr/review"],
    failedWorkflows: [],
    validFindings: options.validFindings.length,
    droppedFindings: options.droppedCount,
  };
  return buildPublicationPlan({
    event: options.event,
    template: options.template,
    mainContributions: reviewToMainSectionContributions({
      workflowId: "pipr/review",
      validated: {
        review: options.review,
        validFindings: options.validFindings,
        droppedFindings: [],
      },
    }),
    inlineItems: [],
    metadata,
  }).mainComment;
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

function renderMainCommentFromSections(options: {
  event: Pick<PullRequestEventContext, "pullRequestNumber">;
  template: CommentTemplateComponent;
  reducedSections: Map<string, string>;
}): string {
  return [
    `<!-- ${options.template.marker} pr=${options.event.pullRequestNumber} -->`,
    "",
    `# ${options.template.heading}`,
    "",
    ...options.template.sections
      .toSorted((left, right) => left.order - right.order)
      .flatMap((section) => {
        const body = options.reducedSections.get(section.id) ?? section.empty ?? "";
        return section.collapsed
          ? renderCollapsedSection(section.title, body)
          : renderMarkdownSection(section.title, body);
      }),
  ].join("\n");
}

function renderMarkdownSection(title: string, body: string): string[] {
  return [`## ${title}`, "", body, ""];
}

function renderCollapsedSection(title: string, body: string): string[] {
  return ["<details>", `<summary>${title}</summary>`, "", body, "", "</details>", ""];
}

function reduceMainSection(sectionId: string, contributions: MainSectionContribution[]): string {
  const policy = readSectionPolicy(sectionId, contributions);
  return sectionPolicyReducers[policy](sectionId, contributions);
}

const sectionPolicyReducers: Record<
  MainSectionMergePolicy,
  (sectionId: string, contributions: MainSectionContribution[]) => string
> = {
  exclusive: reduceExclusiveSection,
  replace: reduceReplaceSection,
  append: reduceAppendSection,
  list: reduceListSection,
};

function readSectionPolicy(
  sectionId: string,
  contributions: MainSectionContribution[],
): MainSectionMergePolicy {
  const policies = new Set(contributions.map((contribution) => contribution.policy));
  if (policies.size !== 1) {
    throw new Error(`Main Review Comment section '${sectionId}' has mixed merge policies`);
  }
  const policy = contributions[0]?.policy;
  if (!policy) {
    throw new Error(`Main Review Comment section '${sectionId}' has no merge policy`);
  }
  return policy;
}

function reduceExclusiveSection(
  sectionId: string,
  contributions: MainSectionContribution[],
): string {
  if (contributions.length > 1) {
    throw new Error(`Main Review Comment section '${sectionId}' has multiple exclusive writers`);
  }
  return renderContributionValue(contributions[0]?.value ?? "");
}

function reduceReplaceSection(
  _sectionId: string,
  contributions: MainSectionContribution[],
): string {
  return renderContributionValue(toPriorityOrder(contributions)[0]?.value ?? "");
}

function reduceAppendSection(_sectionId: string, contributions: MainSectionContribution[]): string {
  return toPriorityOrder(contributions)
    .map((item) => renderContributionValue(item.value))
    .join("\n\n");
}

function reduceListSection(_sectionId: string, contributions: MainSectionContribution[]): string {
  return toPriorityOrder(contributions)
    .flatMap((item) => contributionValues(item.value))
    .join("\n");
}

function toPriorityOrder(contributions: MainSectionContribution[]): MainSectionContribution[] {
  return contributions.toSorted(
    (left, right) =>
      right.priority - left.priority || left.workflowId.localeCompare(right.workflowId),
  );
}

function renderContributionValue(value: MainSectionContribution["value"]): string {
  return contributionValues(value).join("\n");
}

function contributionValues(value: MainSectionContribution["value"]): string[] {
  return Array.isArray(value) ? value : [value];
}

function metadataContribution(metadata: PublicationMetadata): MainSectionContribution {
  const lines = [
    `Runtime: \`${metadata.runtimeVersion}\`  `,
    `Reviewed head: \`${metadata.reviewedHeadSha}\`  `,
    metadata.trustedConfigSha
      ? `Trusted config SHA: \`${metadata.trustedConfigSha}\`  `
      : undefined,
    metadata.trustedConfigHash
      ? `Trusted config hash: \`${metadata.trustedConfigHash}\`  `
      : undefined,
    metadata.providerModel ? `Model: \`${metadata.providerModel}\`  ` : undefined,
    `Selected workflows: \`${metadata.selectedWorkflows.join(", ") || "none"}\`  `,
    `Failed workflows: \`${metadata.failedWorkflows.join(", ") || "none"}\`  `,
    `Valid inline findings: \`${metadata.validFindings}\`  `,
    `Dropped findings: \`${metadata.droppedFindings}\`  `,
    `Capped inline findings: \`${metadata.cappedInlineFindings}\``,
  ].filter((line): line is string => line !== undefined);
  return {
    workflowId: "core/publication",
    sectionId: "metadata",
    policy: "append",
    priority: 0,
    value: lines.join("\n"),
  };
}

function findingPriority(finding: ReviewFinding): number {
  return severityPriority(finding.severity) * 100 + Math.round(finding.confidence * 100);
}

function severityPriority(severity: ReviewFinding["severity"]): number {
  switch (severity) {
    case "critical":
      return 5;
    case "high":
      return 4;
    case "medium":
      return 3;
    case "low":
      return 2;
    case "nit":
      return 1;
  }
}

function findingMarker(fingerprint: string, reviewedHeadSha: string): string {
  return `${findingMarkerPrefix}:${fingerprint}:${reviewedHeadSha}`;
}

function renderInlineBody(finding: ReviewFinding, marker: string): string {
  const [, fingerprint = "", reviewedHeadSha = ""] = marker.split(":").slice(1);
  return [
    `<!-- ${findingMarkerPrefix} fingerprint=${fingerprint} head=${reviewedHeadSha} -->`,
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
