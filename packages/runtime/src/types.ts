import { z } from "zod";
import { commandLabels, isPiprCommandTrigger, piprHelpCommandLine } from "./commands/grammar.js";
import { piProviderProfileSchema } from "./pi/contract.js";
import { prReviewSchema, reviewFindingSchema } from "./review/contract.js";

export type {
  PrReview,
  ReviewFinding,
  ReviewFindingCategory,
  ReviewFindingSeverity,
} from "./review/contract.js";

const nonEmptyStringSchema = z.string().min(1);

export const providerConfigSchema = piProviderProfileSchema;

export const pathGlobPatternSchema = z
  .string()
  .min(1)
  .superRefine((pattern, context) => {
    if (pattern.includes("\0")) {
      context.addIssue({ code: "custom", message: "must not contain NUL bytes" });
    }
    if (pattern.includes("\\")) {
      context.addIssue({ code: "custom", message: "must use POSIX '/' separators" });
    }
    if (pattern.startsWith("/") || /^[A-Za-z]:\//.test(pattern)) {
      context.addIssue({ code: "custom", message: "must be repo-relative" });
    }
    if (pattern.startsWith("!")) {
      context.addIssue({ code: "custom", message: "must use paths.exclude instead of negation" });
    }
    if (pattern.split("/").includes("..")) {
      context.addIssue({ code: "custom", message: "must not contain '..' segments" });
    }
  });

export const pathFilterSchema = z.strictObject({
  include: z.array(pathGlobPatternSchema).min(1).optional(),
  exclude: z.array(pathGlobPatternSchema).min(1).optional(),
});

export const diffManifestLimitsConfigSchema = z.strictObject({
  fullMaxBytes: z.number().int().positive().optional(),
  fullMaxEstimatedTokens: z.number().int().positive().optional(),
  condensedMaxBytes: z.number().int().positive().optional(),
  condensedMaxEstimatedTokens: z.number().int().positive().optional(),
  toolResponseMaxBytes: z.number().int().positive().optional(),
});

export const piprConfigSchema = z.strictObject({
  defaultProvider: nonEmptyStringSchema,
  providers: z.array(providerConfigSchema).min(1),
  publication: z.strictObject({
    maxInlineComments: z.number().int().min(0).max(50).optional(),
    minConfidence: z.number().min(0).max(1),
  }),
  limits: z
    .strictObject({
      timeoutSeconds: z.number().int().positive().max(3600).optional(),
      diffManifest: diffManifestLimitsConfigSchema.optional(),
    })
    .optional(),
});

export const registryCollectionNameSchema = z.enum([
  "workflows",
  "blocks",
  "agents",
  "schemas",
  "comments",
  "tools",
]);

const sourceModulesSchema = z.strictObject({
  workflows: z.record(z.string(), z.string()).optional(),
  blocks: z.record(z.string(), z.string()).optional(),
  agents: z.record(z.string(), z.string()).optional(),
  schemas: z.record(z.string(), z.string()).optional(),
  comments: z.record(z.string(), z.string()).optional(),
  tools: z.record(z.string(), z.string()).optional(),
});

export const sourceMapSchema = z.strictObject({
  config: nonEmptyStringSchema,
  fields: z.record(z.string(), z.string()),
  modules: sourceModulesSchema,
});

export const pullRequestEventContextSchema = z.strictObject({
  eventName: nonEmptyStringSchema,
  action: nonEmptyStringSchema.optional(),
  repo: nonEmptyStringSchema,
  pullRequestNumber: z.number().int().positive(),
  baseSha: nonEmptyStringSchema,
  headSha: nonEmptyStringSchema,
  workspace: nonEmptyStringSchema,
});

export const fileStatusSchema = z.enum(["added", "modified", "removed", "renamed"]);
export const reviewSideSchema = z.enum(["RIGHT", "LEFT"]);
export const rangeKindSchema = z.enum(["added", "deleted", "context", "mixed"]);

export const commentableRangeSchema = z.strictObject({
  id: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  side: reviewSideSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  kind: rangeKindSchema,
  hunkIndex: z.number().int().positive(),
  hunkHeader: nonEmptyStringSchema,
  hunkContentHash: z.string().regex(/^[a-f0-9]{12}$/),
  summary: z.string().optional(),
  preview: z.string().optional(),
});

export const diffHunkSchema = z.strictObject({
  hunkIndex: z.number().int().positive(),
  header: nonEmptyStringSchema,
  oldStart: z.number().int().min(0),
  oldLines: z.number().int().min(0),
  newStart: z.number().int().min(0),
  newLines: z.number().int().min(0),
  contentHash: z.string().regex(/^[a-f0-9]{12}$/),
});

export const diffManifestFileSchema = z.strictObject({
  path: nonEmptyStringSchema,
  previousPath: nonEmptyStringSchema.optional(),
  status: fileStatusSchema,
  language: nonEmptyStringSchema.optional(),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  hunks: z.array(diffHunkSchema),
  commentableRanges: z.array(commentableRangeSchema),
  signals: z.array(z.string()).optional(),
  changedSymbols: z.array(z.string()).optional(),
  excludedReason: nonEmptyStringSchema.optional(),
});

export const diffManifestSchema = z.strictObject({
  baseSha: nonEmptyStringSchema,
  headSha: nonEmptyStringSchema,
  mergeBaseSha: nonEmptyStringSchema,
  files: z.array(diffManifestFileSchema),
});

export const diffManifestPromptMetricsSchema = z.strictObject({
  bytes: z.number().int().min(0),
  estimatedTokens: z.number().int().min(0),
});

export const droppedFindingSchema = z.strictObject({
  finding: reviewFindingSchema,
  reason: nonEmptyStringSchema,
});

export const validatedReviewSchema = z.strictObject({
  review: prReviewSchema,
  validFindings: z.array(reviewFindingSchema),
  droppedFindings: z.array(droppedFindingSchema),
});

export const registryEntrySchema = z.strictObject({
  id: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  source: nonEmptyStringSchema,
  sourceLocation: nonEmptyStringSchema.optional(),
});

export const failurePolicySchema = z.enum(["fail", "continue", "skip-output"]);
export const jsonSchemaMapSchema = z.record(z.string(), z.unknown());
export const commandPermissionLevelSchema = z.enum([
  "read",
  "triage",
  "write",
  "maintain",
  "admin",
]);

export const workflowInputSchema = z.strictObject({
  type: z.literal("string"),
  required: z.boolean().optional(),
  default: z.string().optional(),
  enum: z.array(z.string().min(1)).optional(),
});

export const workflowInputsSchema = z.record(z.string(), workflowInputSchema);

export const agentInputSchema = z
  .strictObject({
    type: z.enum(["string", "json"]),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    enum: z.array(z.string().min(1)).optional(),
  })
  .superRefine((input, context) => {
    if (input.type === "string") {
      if (input.default !== undefined && typeof input.default !== "string") {
        context.addIssue({ code: "custom", path: ["default"], message: "must be string" });
      }
      return;
    }
    if (input.enum !== undefined) {
      context.addIssue({ code: "custom", path: ["enum"], message: "is only supported for string" });
    }
    if (input.default !== undefined && !z.json().safeParse(input.default).success) {
      context.addIssue({ code: "custom", path: ["default"], message: "must be JSON value" });
    }
  });

export const agentInputsSchema = z.record(z.string(), agentInputSchema);

const reservedWorkflowCommandLabels = new Set([piprHelpCommandLine]);

export const workflowCommandSchema = z
  .strictObject({
    name: nonEmptyStringSchema,
    aliases: z.array(nonEmptyStringSchema).min(1).optional(),
    pattern: nonEmptyStringSchema.optional(),
    requiredPermission: commandPermissionLevelSchema.optional(),
  })
  .superRefine((command, context) => {
    const labels = commandLabels(command);
    if (labels.length === 0) {
      context.addIssue({
        code: "custom",
        message: "workflow command requires at least one alias or pattern",
      });
      return;
    }
    for (const label of labels) {
      if (!isPiprCommandTrigger(label)) {
        context.addIssue({
          code: "custom",
          message: `workflow command trigger '${label}' must use @pipr as the first token`,
        });
      }
      if (reservedWorkflowCommandLabels.has(label)) {
        context.addIssue({
          code: "custom",
          message: `workflow command trigger '${label}' is reserved`,
        });
      }
    }
  });

export const workflowStepSchema = z.strictObject({
  id: nonEmptyStringSchema,
  block: nonEmptyStringSchema,
  with: z.unknown().optional(),
  failurePolicy: failurePolicySchema.optional(),
});

export const workflowRegistryEntrySchema = registryEntrySchema.extend({
  inputs: workflowInputsSchema.optional(),
  paths: pathFilterSchema.optional(),
  events: z.array(nonEmptyStringSchema),
  commands: z.array(workflowCommandSchema).optional(),
  failurePolicy: failurePolicySchema.optional(),
  steps: z.array(workflowStepSchema),
});

export const blockRegistryEntrySchema = registryEntrySchema.extend({
  inputs: jsonSchemaMapSchema.optional(),
  outputs: jsonSchemaMapSchema.optional(),
  steps: z.array(workflowStepSchema).optional(),
  output: z.record(z.string(), z.unknown()).optional(),
  failurePolicy: failurePolicySchema.optional(),
  execution: z
    .strictObject({
      mode: z.literal("parallel-dag"),
    })
    .optional(),
});

export const workflowCommandInvocationSchema = z.strictObject({
  workflowId: nonEmptyStringSchema,
  commandName: nonEmptyStringSchema,
  requiredPermission: commandPermissionLevelSchema,
  line: nonEmptyStringSchema,
  inputs: z.record(z.string(), z.string()),
});

export const runtimeRegistrySchema = z.strictObject({
  workflows: z.array(workflowRegistryEntrySchema),
  blocks: z.array(blockRegistryEntrySchema),
  agents: z.array(registryEntrySchema),
  schemas: z.array(registryEntrySchema),
  comments: z.array(registryEntrySchema),
  tools: z.array(registryEntrySchema),
});

export const runtimeModuleSetSchema = z.strictObject({
  workflows: z.array(workflowRegistryEntrySchema).optional(),
  blocks: z.array(blockRegistryEntrySchema).optional(),
  agents: z.array(registryEntrySchema).optional(),
  schemas: z.array(registryEntrySchema).optional(),
  comments: z.array(registryEntrySchema).optional(),
  tools: z.array(registryEntrySchema).optional(),
});

export const resolvedConfigSchema = z.strictObject({
  config: piprConfigSchema,
  source: nonEmptyStringSchema,
  sources: sourceMapSchema,
  modules: runtimeModuleSetSchema,
  warnings: z.array(z.string()),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type PathFilter = z.infer<typeof pathFilterSchema>;
export type DiffManifestLimitsConfig = z.infer<typeof diffManifestLimitsConfigSchema>;
export type PiprConfig = z.infer<typeof piprConfigSchema>;
export type RegistryCollectionName = z.infer<typeof registryCollectionNameSchema>;
export type SourceMap = z.infer<typeof sourceMapSchema>;
export type ResolvedConfig = z.infer<typeof resolvedConfigSchema>;
export type PullRequestEventContext = z.infer<typeof pullRequestEventContextSchema>;
export type FileStatus = z.infer<typeof fileStatusSchema>;
export type ReviewSide = z.infer<typeof reviewSideSchema>;
export type RangeKind = z.infer<typeof rangeKindSchema>;
export type CommentableRange = z.infer<typeof commentableRangeSchema>;
export type DiffHunk = z.infer<typeof diffHunkSchema>;
export type DiffManifestFile = z.infer<typeof diffManifestFileSchema>;
export type DiffManifest = z.infer<typeof diffManifestSchema>;
export type DiffManifestPromptMetrics = z.infer<typeof diffManifestPromptMetricsSchema>;
export type DroppedFinding = z.infer<typeof droppedFindingSchema>;
export type ValidatedReview = z.infer<typeof validatedReviewSchema>;
export type RegistryEntry = z.infer<typeof registryEntrySchema>;
export type FailurePolicy = z.infer<typeof failurePolicySchema>;
export type CommandPermissionLevel = z.infer<typeof commandPermissionLevelSchema>;
export type WorkflowInput = z.infer<typeof workflowInputSchema>;
export type WorkflowInputs = z.infer<typeof workflowInputsSchema>;
export type AgentInput = z.infer<typeof agentInputSchema>;
export type AgentInputs = z.infer<typeof agentInputsSchema>;
export type WorkflowCommand = z.infer<typeof workflowCommandSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowRegistryEntry = z.infer<typeof workflowRegistryEntrySchema>;
export type BlockRegistryEntry = z.infer<typeof blockRegistryEntrySchema>;
export type WorkflowCommandInvocation = z.infer<typeof workflowCommandInvocationSchema>;
export type RuntimeRegistry = z.infer<typeof runtimeRegistrySchema>;
export type RuntimeModuleSet = z.input<typeof runtimeModuleSetSchema>;

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
