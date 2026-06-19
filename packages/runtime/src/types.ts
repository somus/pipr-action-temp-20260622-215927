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

export const piprConfigSchema = z.strictObject({
  defaultProvider: nonEmptyStringSchema,
  providers: z.array(providerConfigSchema).min(1),
  publication: z.strictObject({
    maxInlineComments: z.number().int().min(0).max(50),
    minConfidence: z.number().min(0).max(1),
  }),
  limits: z
    .strictObject({
      timeoutSeconds: z.number().int().positive().max(3600),
    })
    .optional(),
});

export const registryCollectionNameSchema = z.enum([
  "presets",
  "workflows",
  "blocks",
  "agents",
  "schemas",
  "comments",
  "tools",
]);

const sourceModulesSchema = z.strictObject({
  presets: z.record(z.string(), z.string()).optional(),
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
  hunkHeader: nonEmptyStringSchema,
  summary: z.string().optional(),
  preview: z.string().optional(),
});

export const diffManifestFileSchema = z.strictObject({
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
});

export const diffManifestSchema = z.strictObject({
  baseSha: nonEmptyStringSchema,
  headSha: nonEmptyStringSchema,
  mergeBaseSha: nonEmptyStringSchema,
  files: z.array(diffManifestFileSchema),
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
});

export const workflowCommandInvocationSchema = z.strictObject({
  workflowId: nonEmptyStringSchema,
  commandName: nonEmptyStringSchema,
  requiredPermission: commandPermissionLevelSchema,
  line: nonEmptyStringSchema,
  inputs: z.record(z.string(), z.string()),
});

export const runtimeRegistrySchema = z.strictObject({
  presets: z.array(registryEntrySchema),
  workflows: z.array(workflowRegistryEntrySchema),
  blocks: z.array(blockRegistryEntrySchema),
  agents: z.array(registryEntrySchema),
  schemas: z.array(registryEntrySchema),
  comments: z.array(registryEntrySchema),
  tools: z.array(registryEntrySchema),
});

export const runtimeModuleSetSchema = z.strictObject({
  presets: z.array(registryEntrySchema).optional(),
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
export type FailurePolicy = z.infer<typeof failurePolicySchema>;
export type CommandPermissionLevel = z.infer<typeof commandPermissionLevelSchema>;
export type WorkflowInput = z.infer<typeof workflowInputSchema>;
export type WorkflowInputs = z.infer<typeof workflowInputsSchema>;
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
