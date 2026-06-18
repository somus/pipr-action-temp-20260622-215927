import { z } from "zod";
import { prReviewSchema, reviewFindingSchema } from "./review-contract.js";

export type {
  PrReview,
  ReviewFinding,
  ReviewFindingCategory,
  ReviewFindingSeverity,
} from "./review-contract.js";

const nonEmptyStringSchema = z.string().min(1);

export const piThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

export const providerConfigSchema = z
  .object({
    id: nonEmptyStringSchema,
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
    apiKeyEnv: nonEmptyStringSchema,
    thinking: piThinkingLevelSchema.optional(),
  })
  .strict();

export const piprConfigSchema = z
  .object({
    defaultProvider: nonEmptyStringSchema,
    providers: z.array(providerConfigSchema).min(1),
    publication: z
      .object({
        maxInlineComments: z.number().int().min(0).max(50),
        minConfidence: z.number().min(0).max(1),
      })
      .strict(),
    limits: z
      .object({
        timeoutSeconds: z.number().int().positive().max(3600),
      })
      .strict()
      .optional(),
  })
  .strict();

export const registryCollectionNameSchema = z.enum([
  "presets",
  "workflows",
  "blocks",
  "agents",
  "schemas",
  "comments",
  "tools",
]);

const sourceModulesSchema = z
  .object({
    presets: z.record(z.string(), z.string()).optional(),
    workflows: z.record(z.string(), z.string()).optional(),
    blocks: z.record(z.string(), z.string()).optional(),
    agents: z.record(z.string(), z.string()).optional(),
    schemas: z.record(z.string(), z.string()).optional(),
    comments: z.record(z.string(), z.string()).optional(),
    tools: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const sourceMapSchema = z
  .object({
    config: nonEmptyStringSchema,
    fields: z.record(z.string(), z.string()),
    modules: sourceModulesSchema,
  })
  .strict();

export const pullRequestEventContextSchema = z
  .object({
    eventName: nonEmptyStringSchema,
    action: nonEmptyStringSchema.optional(),
    repo: nonEmptyStringSchema,
    pullRequestNumber: z.number().int().positive(),
    baseSha: nonEmptyStringSchema,
    headSha: nonEmptyStringSchema,
    workspace: nonEmptyStringSchema,
  })
  .strict();

export const fileStatusSchema = z.enum(["added", "modified", "removed", "renamed"]);
export const reviewSideSchema = z.enum(["RIGHT", "LEFT"]);
export const rangeKindSchema = z.enum(["added", "deleted", "context", "mixed"]);

export const commentableRangeSchema = z
  .object({
    id: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
    side: reviewSideSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    kind: rangeKindSchema,
    hunkHeader: nonEmptyStringSchema,
    summary: z.string().optional(),
    preview: z.string().optional(),
  })
  .strict();

export const diffManifestFileSchema = z
  .object({
    path: nonEmptyStringSchema,
    previousPath: nonEmptyStringSchema.optional(),
    status: fileStatusSchema,
    language: nonEmptyStringSchema.optional(),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
    commentableRanges: z.array(commentableRangeSchema),
    riskSignals: z.array(z.string()).optional(),
    changedSymbols: z.array(z.string()).optional(),
    excludedReason: nonEmptyStringSchema.optional(),
  })
  .strict();

export const diffManifestSchema = z
  .object({
    baseSha: nonEmptyStringSchema,
    headSha: nonEmptyStringSchema,
    mergeBaseSha: nonEmptyStringSchema,
    files: z.array(diffManifestFileSchema),
  })
  .strict();

export const droppedFindingSchema = z
  .object({
    finding: reviewFindingSchema,
    reason: nonEmptyStringSchema,
  })
  .strict();

export const validatedReviewSchema = z
  .object({
    review: prReviewSchema,
    validFindings: z.array(reviewFindingSchema),
    droppedFindings: z.array(droppedFindingSchema),
  })
  .strict();

export const registryEntrySchema = z
  .object({
    id: nonEmptyStringSchema,
    description: nonEmptyStringSchema,
    source: nonEmptyStringSchema,
    sourceLocation: nonEmptyStringSchema.optional(),
  })
  .strict();

export const workflowStepSchema = z
  .object({
    block: nonEmptyStringSchema,
    with: z.unknown().optional(),
    output: nonEmptyStringSchema.optional(),
  })
  .strict();

export const workflowRegistryEntrySchema = registryEntrySchema
  .extend({
    events: z.array(nonEmptyStringSchema),
    steps: z.array(workflowStepSchema),
  })
  .strict();

export const blockRegistryEntrySchema = registryEntrySchema
  .extend({
    steps: z.array(workflowStepSchema).optional(),
  })
  .strict();

export const runtimeRegistrySchema = z
  .object({
    presets: z.array(registryEntrySchema),
    workflows: z.array(workflowRegistryEntrySchema),
    blocks: z.array(blockRegistryEntrySchema),
    agents: z.array(registryEntrySchema),
    schemas: z.array(registryEntrySchema),
    comments: z.array(registryEntrySchema),
    tools: z.array(registryEntrySchema),
  })
  .strict();

export const runtimeModuleSetSchema = z
  .object({
    presets: z.array(registryEntrySchema).optional(),
    workflows: z.array(workflowRegistryEntrySchema).optional(),
    blocks: z.array(blockRegistryEntrySchema).optional(),
    agents: z.array(registryEntrySchema).optional(),
    schemas: z.array(registryEntrySchema).optional(),
    comments: z.array(registryEntrySchema).optional(),
    tools: z.array(registryEntrySchema).optional(),
  })
  .strict();

export const resolvedConfigSchema = z
  .object({
    config: piprConfigSchema,
    source: nonEmptyStringSchema,
    sources: sourceMapSchema,
    modules: runtimeModuleSetSchema,
    warnings: z.array(z.string()),
  })
  .strict();

export type PiThinkingLevel = z.infer<typeof piThinkingLevelSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type PiprConfig = z.infer<typeof piprConfigSchema>;
export type RegistryCollectionName = z.infer<typeof registryCollectionNameSchema>;
export type SourceMap = z.infer<typeof sourceMapSchema>;
export type ResolvedConfig = z.infer<typeof resolvedConfigSchema>;
export type PullRequestEventContext = z.infer<typeof pullRequestEventContextSchema>;
export type FileStatus = z.infer<typeof fileStatusSchema>;
export type ReviewSide = z.infer<typeof reviewSideSchema>;
export type RangeKind = z.infer<typeof rangeKindSchema>;
export type CommentableRange = z.infer<typeof commentableRangeSchema>;
export type DiffManifestFile = z.infer<typeof diffManifestFileSchema>;
export type DiffManifest = z.infer<typeof diffManifestSchema>;
export type DroppedFinding = z.infer<typeof droppedFindingSchema>;
export type ValidatedReview = z.infer<typeof validatedReviewSchema>;
export type RegistryEntry = z.infer<typeof registryEntrySchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowRegistryEntry = z.infer<typeof workflowRegistryEntrySchema>;
export type BlockRegistryEntry = z.infer<typeof blockRegistryEntrySchema>;
export type RuntimeRegistry = z.infer<typeof runtimeRegistrySchema>;
export type RuntimeModuleSet = z.infer<typeof runtimeModuleSetSchema>;

export function parseProviderConfig(value: unknown): ProviderConfig {
  return providerConfigSchema.parse(value);
}

export function parsePiprConfig(value: unknown): PiprConfig {
  return piprConfigSchema.parse(value);
}

export function parsePullRequestEventContext(value: unknown): PullRequestEventContext {
  return pullRequestEventContextSchema.parse(value);
}

export function parseDiffManifest(value: unknown): DiffManifest {
  return diffManifestSchema.parse(value);
}

export function parseValidatedReview(value: unknown): ValidatedReview {
  return validatedReviewSchema.parse(value);
}

export function parseRuntimeRegistry(value: unknown): RuntimeRegistry {
  return runtimeRegistrySchema.parse(value);
}

export function parseResolvedConfig(value: unknown): ResolvedConfig {
  return resolvedConfigSchema.parse(value);
}
