// biome-ignore-all format: generated from @pipr/sdk declarations
// biome-ignore-all assist/source/organizeImports: generated from @pipr/sdk declarations
declare module "@pipr/sdk" {
type ZodInfer<T> = T extends { parse(value: unknown): infer Output } ? Output : never;
type ZodType<T = unknown, Optional extends boolean = false> = {
  readonly _piprOptional: Optional;
  parse(value: unknown): T;
  optional(): ZodType<T | undefined, true>;
  min(value: number): ZodType<T, Optional>;
  max(value: number): ZodType<T, Optional>;
  int(): ZodType<T, Optional>;
  positive(): ZodType<T, Optional>;
  finite(): ZodType<T, Optional>;
};
type ZodAny = ZodType<unknown, boolean>;
type ZodOptionalKeys<T extends Record<string, ZodAny>> = { [K in keyof T]: T[K] extends ZodType<unknown, true> ? K : never }[keyof T];
type ZodObjectOutput<T extends Record<string, ZodAny>> = { [K in Exclude<keyof T, ZodOptionalKeys<T>>]: ZodInfer<T[K]> } & { [K in ZodOptionalKeys<T>]?: ZodInfer<T[K]> };
const z: {
  string(): ZodType<string>;
  number(): ZodType<number>;
  boolean(): ZodType<boolean>;
  null(): ZodType<null>;
  unknown(): ZodType<unknown>;
  any(): ZodType<unknown>;
  literal<T extends string | number | boolean | null>(value: T): ZodType<T>;
  enum<const T extends readonly [string, ...string[]]>(values: T): ZodType<T[number]>;
  array<T extends ZodAny>(schema: T): ZodType<Array<ZodInfer<T>>>;
  record<T extends ZodAny>(key: ZodType<string>, value: T): ZodType<Record<string, ZodInfer<T>>>;
  strictObject<T extends Record<string, ZodAny>>(shape: T): ZodType<ZodObjectOutput<T>>;
  object<T extends Record<string, ZodAny>>(shape: T): ZodType<ZodObjectOutput<T>>;
  union<const T extends readonly [ZodAny, ZodAny, ...ZodAny[]]>(schemas: T): ZodType<ZodInfer<T[number]>>;
};

//#region src/index.d.ts
const configFactoryBrand: unique symbol;
type RepositoryPermission = "read" | "triage" | "write" | "maintain" | "admin";
type ChangeRequestAction = "opened" | "updated" | "reopened" | "ready" | "closed";
type DurationInput = number | `${number}s` | `${number}m` | `${number}h`;
type SecretRef = {
  readonly kind: "pipr.secret";
  readonly name: string;
};
type ModelOptions = {
  name?: string;
  apiKey?: SecretRef;
  options?: Record<string, unknown>;
};
type ModelProfile = {
  readonly kind: "pipr.model";
  readonly id: symbol;
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: SecretRef;
  readonly options?: Record<string, unknown>;
};
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
type JsonObject = {
  [key: string]: JsonValue;
};
type JsonSchema = JsonObject | boolean;
type SchemaParseResult<T> = {
  success: true;
  data: T;
} | {
  success: false;
  error: Error;
};
type Schema<T> = {
  readonly kind: "pipr.schema";
  readonly id: string;
  readonly jsonSchema?: JsonSchema;
  parse(value: unknown): T;
  safeParse(value: unknown): SchemaParseResult<T>;
};
type ZodSchema<T> = ZodType<T>;
const reviewOutputSchemaId = "core/pr-review";
type ReviewSummary = {
  title?: string;
  body: string;
};
type ReviewFinding<TData extends JsonObject = JsonObject> = {
  body: string;
  path: string;
  rangeId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
  suggestedFix?: string;
  data?: TData;
};
type ReviewResult<TData extends JsonObject = JsonObject> = {
  summary: ReviewSummary;
  inlineFindings: ReviewFinding<TData>[];
  metadata?: JsonObject;
};
type PathFilter = {
  include?: string[];
  exclude?: string[];
};
type PromptSource = string | PromptText;
type PromptValue = unknown;
type PromptText = {
  readonly kind: "pipr.prompt";
  readonly value: string;
};
type JsonPromptOptions = {
  pretty?: boolean;
  maxCharacters?: number;
};
type BuiltinToolCatalog = {
  readonly readOnly: readonly AgentTool[];
};
type BuiltinSchemaCatalog = {
  readonly review: Schema<ReviewResult>;
  readonly summary: Schema<ReviewSummary>;
};
type AgentTool<Input = unknown, Output = unknown> = {
  readonly kind: "pipr.tool";
  readonly name: string;
  readonly description?: string;
  readonly input?: Schema<Input>;
  readonly output?: Schema<Output>;
  run?(options: ToolRunOptions<Input>): Output | Promise<Output>;
  toModelOutput?(output: Output): PromptValue;
};
/** Returns whether a tool is one of pipr's built-in read-only tools. */
function isBuiltinReadOnlyTool(tool: AgentTool): boolean;
type AgentPromptContext = {
  runId: string;
  repository: RepositoryInfo;
  change: ChangeRequestInfo;
  platform: PlatformInfo;
};
type AgentDefinition<Input, Output> = {
  name?: string;
  model?: ModelProfile;
  fallbacks?: ModelProfile[];
  instructions: PromptSource;
  prompt(input: Input, context: AgentPromptContext): PromptSource | Promise<PromptSource>;
  output: Schema<Output>;
  tools?: readonly AgentTool[];
  retry?: {
    invalidOutput?: number;
    transientFailure?: number;
  };
  timeout?: DurationInput;
};
type AgentExtension<Input, Output> = Partial<AgentDefinition<Input, Output>> & {
  instructions?: PromptSource;
};
type Agent<Input = unknown, Output = unknown> = {
  readonly kind: "pipr.agent";
  readonly name?: string;
  readonly definition: AgentDefinition<Input, Output>;
  extend(patch: AgentExtension<Input, Output>): Agent<Input, Output>;
};
type TaskHandler<Input> = (context: TaskContext, input: Input) => void | Promise<void>;
type Task<Input = void> = {
  readonly kind: "pipr.task";
  readonly name: string;
  readonly handler: TaskHandler<Input>;
};
type CommandOptions<Input> = {
  permission?: RepositoryPermission;
  description?: string;
  parse?: (arguments_: Record<string, string>) => Input;
};
type ReviewerOptions = {
  name?: string;
  model: ModelProfile;
  fallbacks?: ModelProfile[];
  instructions: PromptSource;
  prompt?: (input: DefaultReviewInput, context: AgentPromptContext) => PromptSource | Promise<PromptSource>;
  tools?: readonly AgentTool[];
  timeout?: DurationInput;
};
type Reviewer = Agent<DefaultReviewInput, ReviewResult>;
type ReviewEntrypoints = {
  changeRequest?: ChangeRequestAction[] | false;
  command?: string | false | {
    pattern?: string;
    permission?: RepositoryPermission;
    description?: string;
  };
  local?: string | false;
};
type ReviewRecipeEntrypointOptions = {
  name?: string;
  entrypoints?: ReviewEntrypoints;
  on?: ChangeRequestAction[] | false;
  command?: string | false;
  commandPermission?: RepositoryPermission;
  localName?: string | false;
  inlineComments?: false | {
    max?: number;
  };
  summary?: boolean;
  timeout?: DurationInput;
  paths?: PathFilter;
};
type ReviewRecipeOptions = (ReviewRecipeEntrypointOptions & {
  reviewer: Reviewer;
}) | (ReviewRecipeEntrypointOptions & ReviewerOptions & {
  reviewer?: undefined;
});
type DefaultReviewInput = {
  manifest: DiffManifest;
  change: ChangeRequestInfo;
};
type PiprPlugin<Handle> = {
  setup(builder: PiprBuilder): Handle;
};
type PluginToolDefinition<Input, Output> = {
  name: string;
  description: string;
  input: Schema<Input>;
  output: Schema<Output>;
  execute?(context: unknown, input: Input): Promise<Output>;
  run?(options: ToolRunOptions<Input>): Output | Promise<Output>;
  toModelOutput?(output: Output): PromptValue;
};
type ToolRunOptions<Input> = {
  input: Input;
  ctx: unknown;
  signal?: AbortSignal;
};
type PiprBuilder = {
  readonly tools: BuiltinToolCatalog;
  readonly schemas: BuiltinSchemaCatalog;
  readonly on: {
    changeRequest<Input = void>(actions: ChangeRequestAction[], task: Task<Input>): void;
  };
  secret(name: string): SecretRef;
  model(specification: string, options?: ModelOptions): ModelProfile;
  agent<Input, Output>(definition: AgentDefinition<Input, Output>): Agent<Input, Output>;
  task<Input = void>(name: string, handler: TaskHandler<Input>): Task<Input>;
  reviewer(options: ReviewerOptions): Reviewer;
  review(options: ReviewRecipeOptions): void;
  command<Input = void>(pattern: string, options: CommandOptions<Input>, task: Task<Input>): void;
  local<Input = void>(name: string, task: Task<Input>): void;
  limits(options: RuntimeLimits): void;
  use<Handle>(plugin: PiprPlugin<Handle>): Handle;
  tool<Input, Output>(definition: PluginToolDefinition<Input, Output>): AgentTool<Input, Output>;
  schema<T>(id: string, zodSchema: ZodSchema<T>): Schema<T>;
  jsonSchema<T>(id: string, jsonSchema: JsonSchema): Schema<T>;
  prompt(strings: TemplateStringsArray, ...values: PromptValue[]): PromptText;
  section(title: string, value: PromptValue): PromptText;
  json(value: unknown, options?: JsonPromptOptions): PromptText;
};
type RuntimePlan = {
  models: ModelProfile[];
  agents: Agent[];
  tasks: Task<unknown>[];
  changeRequestTriggers: Array<{
    actions: ChangeRequestAction[];
    task: Task<unknown>;
  }>;
  commands: Array<{
    pattern: string;
    permission: RepositoryPermission;
    description?: string;
    parse?: (arguments_: Record<string, string>) => unknown;
    task: Task<unknown>;
  }>;
  locals: Array<{
    name: string;
    task: Task<unknown>;
  }>;
  tools: AgentTool[];
  publication: {
    maxInlineComments?: number;
  };
  limits?: RuntimeLimits;
};
type PiprConfigFactory = {
  readonly kind: "pipr.config-factory";
  readonly [configFactoryBrand]: true;
  build(): RuntimePlan;
};
type RepositoryInfo = {
  root: string;
  owner?: string;
  name: string;
  defaultBranch?: string;
  remoteUrl?: string;
};
type ChangeRequestInfo = {
  number?: number;
  title: string;
  description: string;
  url?: string;
  author?: {
    login: string;
  };
  base: {
    ref?: string;
    sha: string;
  };
  head: {
    ref?: string;
    sha: string;
  };
  isFork?: boolean;
};
type PlatformInfo = {
  id: string;
};
type DiffManifest = {
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  files: Array<{
    path: string;
    previousPath?: string;
    status: string;
    language?: string;
    additions: number;
    deletions: number;
    commentableRanges?: unknown[];
    ranges?: unknown[];
    preview?: string;
  }>;
};
type DiffManifestOptions = {
  compressed?: boolean;
  includePreviews?: boolean;
  maxPreviewLines?: number;
  paths?: PathFilter;
};
type DiffManifestLimits = {
  fullMaxBytes?: number;
  fullMaxEstimatedTokens?: number;
  condensedMaxBytes?: number;
  condensedMaxEstimatedTokens?: number;
  toolResponseMaxBytes?: number;
};
type RuntimeLimits = {
  timeoutSeconds?: number;
  diffManifest?: DiffManifestLimits;
};
type ChangeRequestContext = ChangeRequestInfo & {
  diffManifest(options?: DiffManifestOptions): Promise<DiffManifest>;
  changedFiles(): Promise<Array<{
    path: string;
    previousPath?: string;
    status: string;
  }>>;
  currentHeadSha(): Promise<string>;
};
type OutputCollector = {
  summary(value: ReviewSummary | string, options?: SummaryContributionOptions): void;
  findings(value: ReviewFinding[], options?: FindingContributionOptions): void;
  section<T>(id: string, value: T, options: SectionContributionOptions<T>): void;
  metadata(value: Record<string, unknown>): void;
};
type SummaryContributionOptions = {
  key?: string;
  merge?: "exclusive" | "replace" | "append";
  priority?: number;
};
type SectionContributionOptions<T> = {
  title: string;
  order?: number;
  merge?: "exclusive" | "replace" | "append" | "list";
  priority?: number;
  collapsed?: boolean;
  render?: (value: T) => string;
};
type FindingContributionOptions = {
  paths?: PathFilter;
};
type PiRunner = {
  run<Input, Output>(agent: Agent<Input, Output>, input: Input, options?: {
    model?: ModelProfile;
    fallbacks?: ModelProfile[];
    instructions?: PromptSource;
    timeout?: DurationInput;
    paths?: PathFilter;
  }): Promise<Output>;
};
type TaskContext = {
  readonly run: {
    id: string;
  };
  readonly repository: RepositoryInfo;
  readonly change: ChangeRequestContext;
  readonly platform: PlatformInfo;
  readonly pi: PiRunner;
  readonly output: OutputCollector;
  readonly log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
};
/** Defines a synchronous pipr configuration factory. */
function definePipr(configure: (pipr: PiprBuilder) => void): PiprConfigFactory;
/** Checks that an unknown value is a pipr configuration factory. */
function isPiprConfigFactory(value: unknown): value is PiprConfigFactory;
/** Builds a runtime plan from a pipr configuration factory. */
function buildPiprPlan(factory: PiprConfigFactory): RuntimePlan;
/** Defines a typed pipr plugin installer. */
function definePlugin<Handle>(setup: (builder: PiprBuilder) => Handle): PiprPlugin<Handle>;
/** Defines a typed schema from a Zod schema. */
function schema<T>(id: string, zodSchema: ZodSchema<T>): Schema<T>;
/** Defines a typed schema from JSON Schema. The generic type is caller supplied. */
function jsonSchema<T>(id: string, schemaDefinition: JsonSchema): Schema<T>;
const schemas: BuiltinSchemaCatalog;
/** Parses model output for pipr's main pull request review schema. */
function parseReviewResult(value: unknown): ReviewResult;
/** Parses a review summary value. */
function parseReviewSummary(value: unknown): ReviewSummary;
/** Parses one inline review finding. */
function parseReviewFinding(value: unknown): ReviewFinding;
/** Returns a small valid example for the main pull request review schema. */
function reviewSchemaExample(): ReviewResult;
/** Renders a prompt source/value into plain text for Pi prompts. */
function renderPromptValue(value: PromptValue): string;
//#endregion
export { Agent, AgentDefinition, AgentExtension, AgentPromptContext, AgentTool, BuiltinSchemaCatalog, BuiltinToolCatalog, ChangeRequestAction, ChangeRequestContext, ChangeRequestInfo, CommandOptions, DefaultReviewInput, DiffManifest, DiffManifestLimits, DiffManifestOptions, DurationInput, FindingContributionOptions, JsonObject, JsonPrimitive, JsonPromptOptions, JsonSchema, JsonValue, ModelOptions, ModelProfile, OutputCollector, PathFilter, PiRunner, PiprBuilder, PiprConfigFactory, PiprPlugin, PlatformInfo, PluginToolDefinition, PromptSource, PromptText, PromptValue, RepositoryInfo, RepositoryPermission, ReviewEntrypoints, ReviewFinding, ReviewRecipeOptions, ReviewResult, ReviewSummary, Reviewer, ReviewerOptions, RuntimeLimits, RuntimePlan, Schema, SchemaParseResult, SecretRef, SectionContributionOptions, SummaryContributionOptions, Task, TaskContext, TaskHandler, ToolRunOptions, ZodSchema, buildPiprPlan, definePipr, definePlugin, isBuiltinReadOnlyTool, isPiprConfigFactory, jsonSchema, parseReviewFinding, parseReviewResult, parseReviewSummary, renderPromptValue, reviewOutputSchemaId, reviewSchemaExample, schema, schemas, z };
}
declare module "@pipr/sdk/review" {
export { type AgentPromptContext, type ChangeRequestAction, type DefaultReviewInput, type PathFilter, type ReviewEntrypoints, type ReviewFinding, type ReviewRecipeOptions, type ReviewResult, type ReviewSummary, type Reviewer, type ReviewerOptions, parseReviewFinding, parseReviewResult, parseReviewSummary, reviewSchemaExample, schemas } from "@pipr/sdk";
}
declare module "@pipr/sdk/tools" {
export { type AgentTool, type BuiltinSchemaCatalog, type BuiltinToolCatalog, type JsonObject, type JsonValue, type PluginToolDefinition, type PromptSource, type PromptText, type PromptValue, type Schema, type SchemaParseResult, type ToolRunOptions, isBuiltinReadOnlyTool, renderPromptValue, schemas } from "@pipr/sdk";
}
