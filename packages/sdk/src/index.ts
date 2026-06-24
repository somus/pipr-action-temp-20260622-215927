import { z } from "zod";

export { z };

const configFactoryBrand = Symbol.for("pipr.config.factory");
const builtinReadOnlyToolBrand = Symbol.for("pipr.builtin.readOnlyTool");

export type RepositoryPermission = "read" | "triage" | "write" | "maintain" | "admin";
export type ChangeRequestAction = "opened" | "updated" | "reopened" | "ready" | "closed";

export type DurationInput = number | `${number}s` | `${number}m` | `${number}h`;

export type SecretRef = {
  readonly kind: "pipr.secret";
  readonly name: string;
};

export type SecretOptions = {
  name: string;
};

export type ModelOptions = {
  id?: string;
  provider: string;
  model: string;
  apiKey?: SecretRef;
  options?: Record<string, unknown>;
};

export type ModelProfile = {
  readonly kind: "pipr.model";
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: SecretRef;
  readonly options?: Record<string, unknown>;
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = JsonObject | boolean;

export type SchemaParseResult<T> = { success: true; data: T } | { success: false; error: Error };

export type Schema<T> = {
  readonly kind: "pipr.schema";
  readonly id: string;
  readonly jsonSchema?: JsonSchema;
  parse(value: unknown): T;
  safeParse(value: unknown): SchemaParseResult<T>;
};

export type ZodSchema<T> = z.ZodType<T>;

export const reviewOutputSchemaId = "core/pr-review";

export type ReviewSummary = {
  title?: string;
  body: string;
};

export type ReviewFinding = {
  body: string;
  path: string;
  rangeId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
  suggestedFix?: string;
};

export type ReviewResult = {
  summary: ReviewSummary;
  inlineFindings: ReviewFinding[];
};

export type Markdown = string;

export type CommentValue =
  | Markdown
  | {
      main?: Markdown;
      inlineFindings?: readonly ReviewFinding[];
    };

export type PriorInlineFinding = {
  id: string;
  status: "open" | "resolved";
  path: string;
  rangeId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
};

export type PriorReview = {
  main?: Markdown;
  reviewedHeadSha?: string;
  inlineFindings: readonly PriorInlineFinding[];
};

export type PathFilter = {
  include?: string[];
  exclude?: string[];
};
export type PromptSource = string | PromptText;
export type PromptValue = unknown;

export type PromptText = {
  readonly kind: "pipr.prompt";
  readonly value: string;
};

export type JsonPromptOptions = {
  pretty?: boolean;
  maxCharacters?: number;
};

export type BuiltinToolCatalog = {
  readonly readOnly: readonly AgentTool[];
};

export type BuiltinSchemaCatalog = {
  readonly review: Schema<ReviewResult>;
  readonly summary: Schema<ReviewSummary>;
};

export type AgentTool<Input = unknown, Output = unknown> = {
  readonly kind: "pipr.tool";
  readonly name: string;
  readonly description?: string;
  readonly input?: Schema<Input>;
  readonly output?: Schema<Output>;
  run?(options: ToolRunOptions<Input>): Output | Promise<Output>;
  toModelOutput?(output: Output): PromptValue;
};

/** Returns whether a tool is one of pipr's built-in read-only tools. */
export function isBuiltinReadOnlyTool(tool: AgentTool): boolean {
  return Reflect.get(tool, builtinReadOnlyToolBrand) === true;
}

export type AgentPromptContext = {
  runId: string;
  repository: RepositoryInfo;
  change: ChangeRequestInfo;
  platform: PlatformInfo;
};

export type AgentDefinition<Input, Output> = {
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

export type AgentExtension<Input, Output> = Partial<AgentDefinition<Input, Output>> & {
  instructions?: PromptSource;
};

export type Agent<Input = unknown, Output = unknown> = {
  readonly kind: "pipr.agent";
  readonly name?: string;
  readonly definition: AgentDefinition<Input, Output>;
  extend(patch: AgentExtension<Input, Output>): Agent<Input, Output>;
};

export type TaskHandler<Input> = (context: TaskContext, input: Input) => void | Promise<void>;

export type TaskCheckOptions =
  | false
  | {
      enabled?: boolean;
      name?: string;
      required?: boolean;
    };

export type TaskDefinition<Input> = {
  name: string;
  check?: TaskCheckOptions;
  run: TaskHandler<Input>;
};

export type Task<Input = void> = {
  readonly kind: "pipr.task";
  readonly name: string;
  readonly check?: TaskCheckOptions;
  readonly handler: TaskHandler<Input>;
};

export type CommandOptions<Input> = {
  permission?: RepositoryPermission;
  description?: string;
  parse?: (arguments_: Record<string, string>) => Input;
};

export type CommandRegistrationOptions<Input> = CommandOptions<Input> & {
  pattern: string;
  task: Task<Input>;
};

export type LocalRegistrationOptions<Input> = {
  name: string;
  task: Task<Input>;
};

export type ReviewerOptions = {
  name?: string;
  model: ModelProfile;
  fallbacks?: ModelProfile[];
  instructions: PromptSource;
  prompt?: (
    input: DefaultReviewInput,
    context: AgentPromptContext,
  ) => PromptSource | Promise<PromptSource>;
  tools?: readonly AgentTool[];
  timeout?: DurationInput;
};

export type Reviewer = Agent<DefaultReviewInput, ReviewResult>;

export type ReviewEntrypoints = {
  changeRequest?: ChangeRequestAction[] | false;
  command?:
    | string
    | false
    | {
        pattern?: string;
        permission?: RepositoryPermission;
        description?: string;
      };
  local?: string | false;
};

type ReviewRecipeEntrypointOptions = {
  id: string;
  entrypoints?: ReviewEntrypoints;
  inlineComments?:
    | false
    | {
        max?: number;
      };
  comment?:
    | CommentValue
    | ((
        result: ReviewResult,
        context: ReviewCommentContext,
      ) => CommentValue | Promise<CommentValue>);
  check?: TaskCheckOptions;
  timeout?: DurationInput;
  paths?: PathFilter;
};

export type ReviewRecipeOptions =
  | (ReviewRecipeEntrypointOptions & { reviewer: Reviewer })
  | (ReviewRecipeEntrypointOptions & ReviewerOptions & { reviewer?: undefined });

export type DefaultReviewInput = {
  manifest: DiffManifest;
  change: ChangeRequestInfo;
};

export type ReviewCommentContext = {
  review: { id: string };
  repository: RepositoryInfo;
  change: ChangeRequestContext;
  platform: PlatformInfo;
};

export type PiprPlugin<Handle> = {
  setup(builder: PiprBuilder): Handle;
};

export type PluginToolDefinition<Input, Output> = {
  name: string;
  description: string;
  input: Schema<Input>;
  output: Schema<Output>;
  execute?(context: unknown, input: Input): Promise<Output>;
  run?(options: ToolRunOptions<Input>): Output | Promise<Output>;
  toModelOutput?(output: Output): PromptValue;
};

export type ToolRunOptions<Input> = {
  input: Input;
  ctx: unknown;
  signal?: AbortSignal;
};

export type ChangeRequestRegistrationOptions<Input> = {
  actions: ChangeRequestAction[];
  task: Task<Input>;
};

export type SchemaDefinition<T> = {
  id: string;
  schema: ZodSchema<T>;
};

export type JsonSchemaDefinition = {
  id: string;
  schema: JsonSchema;
};

export type AggregateCheckOptions =
  | false
  | {
      enabled?: boolean;
      name?: string;
    };

export type ChecksOptions = {
  aggregate?: AggregateCheckOptions;
};

export type CheckHandle = {
  pass(summary?: string): void;
  fail(summary?: string): void;
  neutral(summary?: string): void;
};

export type PiprBuilder = {
  readonly tools: BuiltinToolCatalog;
  readonly schemas: BuiltinSchemaCatalog;
  readonly on: {
    changeRequest<Input = void>(options: ChangeRequestRegistrationOptions<Input>): void;
  };
  secret(options: SecretOptions): SecretRef;
  model(options: ModelOptions): ModelProfile;
  agent<Input, Output>(definition: AgentDefinition<Input, Output>): Agent<Input, Output>;
  task<Input = void>(definition: TaskDefinition<Input>): Task<Input>;
  reviewer(options: ReviewerOptions): Reviewer;
  review(options: ReviewRecipeOptions): void;
  command<Input = void>(options: CommandRegistrationOptions<Input>): void;
  local<Input = void>(options: LocalRegistrationOptions<Input>): void;
  checks(options: ChecksOptions): void;
  limits(options: RuntimeLimits): void;
  use<Handle>(plugin: PiprPlugin<Handle>): Handle;
  tool<Input, Output>(definition: PluginToolDefinition<Input, Output>): AgentTool<Input, Output>;
  schema<T>(definition: SchemaDefinition<T>): Schema<T>;
  jsonSchema<T>(definition: JsonSchemaDefinition): Schema<T>;
  prompt(strings: TemplateStringsArray, ...values: PromptValue[]): PromptText;
  section(title: string, value: PromptValue): PromptText;
  json(value: unknown, options?: JsonPromptOptions): PromptText;
};

export type RuntimePlan = {
  models: ModelProfile[];
  agents: Agent[];
  tasks: Task<unknown>[];
  changeRequestTriggers: Array<{ actions: ChangeRequestAction[]; task: Task<unknown> }>;
  commands: Array<{
    pattern: string;
    permission: RepositoryPermission;
    description?: string;
    parse?: (arguments_: Record<string, string>) => unknown;
    task: Task<unknown>;
  }>;
  locals: Array<{ name: string; task: Task<unknown> }>;
  tools: AgentTool[];
  publication: {
    maxInlineComments?: number;
  };
  checks?: ChecksOptions;
  limits?: RuntimeLimits;
};

export type PiprConfigFactory = {
  readonly kind: "pipr.config-factory";
  readonly [configFactoryBrand]: true;
  build(): RuntimePlan;
};

export type RepositoryInfo = {
  root: string;
  owner?: string;
  name: string;
  defaultBranch?: string;
  remoteUrl?: string;
};

export type ChangeRequestInfo = {
  number?: number;
  title: string;
  description: string;
  url?: string;
  author?: { login: string };
  base: { ref?: string; sha: string };
  head: { ref?: string; sha: string };
  isFork?: boolean;
};

export type PlatformInfo = {
  id: string;
};

export type DiffManifest = {
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

export type DiffManifestOptions = {
  compressed?: boolean;
  includePreviews?: boolean;
  maxPreviewLines?: number;
  paths?: PathFilter;
};

export type DiffManifestLimits = {
  fullMaxBytes?: number;
  fullMaxEstimatedTokens?: number;
  condensedMaxBytes?: number;
  condensedMaxEstimatedTokens?: number;
  toolResponseMaxBytes?: number;
};

export type RuntimeLimits = {
  timeoutSeconds?: number;
  diffManifest?: DiffManifestLimits;
};

export type ChangeRequestContext = ChangeRequestInfo & {
  diffManifest(options?: DiffManifestOptions): Promise<DiffManifest>;
  changedFiles(): Promise<Array<{ path: string; previousPath?: string; status: string }>>;
  currentHeadSha(): Promise<string>;
};

export type PiRunner = {
  run<Input, Output>(
    agent: Agent<Input, Output>,
    input: Input,
    options?: {
      model?: ModelProfile;
      fallbacks?: ModelProfile[];
      instructions?: PromptSource;
      timeout?: DurationInput;
      paths?: PathFilter;
    },
  ): Promise<Output>;
};

export type TaskContext = {
  readonly run: { id: string };
  readonly repository: RepositoryInfo;
  readonly change: ChangeRequestContext;
  readonly platform: PlatformInfo;
  readonly pi: PiRunner;
  readonly review: {
    prior(): Promise<PriorReview>;
  };
  readonly check: CheckHandle;
  comment(value: CommentValue): Promise<void>;
  readonly log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
};

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const nonEmptyStringSchema = z.string().min(1);
const positiveIntegerSchema = z.number().int().positive();

const reviewSummarySchema = z.strictObject({
  title: nonEmptyStringSchema.optional(),
  body: nonEmptyStringSchema,
});

const reviewFindingShape = {
  body: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  rangeId: nonEmptyStringSchema,
  side: z.enum(["RIGHT", "LEFT"]),
  startLine: positiveIntegerSchema,
  endLine: positiveIntegerSchema,
  suggestedFix: nonEmptyStringSchema.optional(),
};

const reviewFindingSchema = z.strictObject(reviewFindingShape);

const reviewResultSchema = z.strictObject({
  summary: reviewSummarySchema,
  inlineFindings: z.array(reviewFindingSchema),
});

/** Defines a synchronous pipr configuration factory. */
export function definePipr(configure: (pipr: PiprBuilder) => void): PiprConfigFactory {
  return {
    kind: "pipr.config-factory",
    [configFactoryBrand]: true,
    build() {
      const builder = createBuilder();
      const result = configure(builder.api);
      if (
        typeof result === "object" &&
        result !== null &&
        typeof Reflect.get(result, "then") === "function"
      ) {
        throw new Error("definePipr configuration callback must be synchronous");
      }
      return builder.plan();
    },
  };
}

/** Checks that an unknown value is a pipr configuration factory. */
export function isPiprConfigFactory(value: unknown): value is PiprConfigFactory {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "pipr.config-factory" &&
    Reflect.get(value, configFactoryBrand) === true
  );
}

/** Builds a runtime plan from a pipr configuration factory. */
export function buildPiprPlan(factory: PiprConfigFactory): RuntimePlan {
  return factory.build();
}

/** Defines a typed pipr plugin installer. */
export function definePlugin<Handle>(setup: (builder: PiprBuilder) => Handle): PiprPlugin<Handle> {
  return { setup };
}

/** Defines a typed schema from a Zod schema. */
export function schema<T>(definition: SchemaDefinition<T>): Schema<T> {
  if (!definition || typeof definition.id !== "string") {
    throw new Error("pipr.schema requires { id, schema }");
  }
  assertUserSchemaId(definition.id);
  return createZodSchema(definition.id, definition.schema);
}

/** Defines a typed schema from JSON Schema. The generic type is caller supplied. */
export function jsonSchema<T>(definition: JsonSchemaDefinition): Schema<T> {
  if (!definition || typeof definition.id !== "string") {
    throw new Error("pipr.jsonSchema requires { id, schema }");
  }
  assertUserSchemaId(definition.id);
  const zodSchema = z.fromJSONSchema(definition.schema);
  return createSchema(definition.id, (value) => zodSchema.parse(value) as T, definition.schema);
}

export const schemas: BuiltinSchemaCatalog = {
  review: createZodSchema<ReviewResult>(reviewOutputSchemaId, reviewResultSchema),
  summary: createZodSchema<ReviewSummary>("core/summary", reviewSummarySchema),
};

export function md(strings: TemplateStringsArray, ...values: unknown[]): Markdown {
  let text = "";
  for (let index = 0; index < strings.length; index += 1) {
    text += strings[index] ?? "";
    if (index < values.length) {
      text += String(values[index] ?? "");
    }
  }
  return stripCommonIndent(text).trim();
}

function createBuilder(): { api: PiprBuilder; plan(): RuntimePlan } {
  const models: ModelProfile[] = [];
  const agents: Agent[] = [];
  const tasks: Task<unknown>[] = [];
  const changeRequestTriggers: RuntimePlan["changeRequestTriggers"] = [];
  const commands: RuntimePlan["commands"] = [];
  const locals: RuntimePlan["locals"] = [];
  const tools: AgentTool[] = [];
  const publication: RuntimePlan["publication"] = {};
  let checks: ChecksOptions | undefined;
  let limits: RuntimeLimits | undefined;

  const api: PiprBuilder = {
    tools: {
      readOnly: [
        {
          kind: "pipr.tool",
          name: "readOnly",
          [builtinReadOnlyToolBrand]: true,
        } as AgentTool,
      ],
    },
    schemas,
    on: {
      changeRequest(options) {
        if (!Array.isArray(options.actions) || !options.task) {
          throw new Error("pipr.on.changeRequest requires { actions, task }");
        }
        changeRequestTriggers.push({
          actions: options.actions,
          task: options.task as Task<unknown>,
        });
      },
    },
    secret(options) {
      if (!options || typeof options.name !== "string") {
        throw new Error("pipr.secret requires { name }");
      }
      if (!/^[A-Z_][A-Z0-9_]*$/.test(options.name)) {
        throw new Error(`Secret '${options.name}' must be an environment variable name`);
      }
      return { kind: "pipr.secret", name: options.name };
    },
    model(options) {
      if (!options || typeof options.provider !== "string" || typeof options.model !== "string") {
        throw new Error("pipr.model requires { provider, model }");
      }
      if (!options.provider || !options.model) {
        throw new Error("pipr.model requires provider and model");
      }
      const id = options.id ?? `${options.provider}/${options.model}`;
      const profile: ModelProfile = {
        kind: "pipr.model",
        id,
        provider: options.provider,
        model: options.model,
        apiKey: options.apiKey,
        options: options.options,
      };
      models.push(profile);
      return profile;
    },
    agent(definition) {
      const agent = createAgent(definition);
      agents.push(agent);
      return agent;
    },
    task(definition) {
      if (!definition.name || typeof definition.run !== "function") {
        throw new Error("pipr.task requires { name, run }");
      }
      const task = {
        kind: "pipr.task" as const,
        name: definition.name,
        check: definition.check,
        handler: definition.run,
      };
      tasks.push(task as Task<unknown>);
      return task;
    },
    reviewer(options) {
      return createReviewer(api, options);
    },
    review(options) {
      assertKnownReviewRecipeOptions(options);
      registerReviewRecipe(api, publication, options);
    },
    command(options) {
      if (typeof options.pattern !== "string" || !options.task) {
        throw new Error("pipr.command requires { pattern, task }");
      }
      const pattern = options.pattern;
      const tokens = pattern.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        throw new Error("Command pattern must not be empty");
      }
      if (tokens[0] !== "@pipr") {
        throw new Error(`Command pattern '${pattern}' must start with @pipr`);
      }
      commands.push({
        pattern,
        permission: options.permission ?? "write",
        description: options.description,
        parse: options.parse as ((arguments_: Record<string, string>) => unknown) | undefined,
        task: options.task as Task<unknown>,
      });
    },
    local(options) {
      if (!options.name || !options.task) {
        throw new Error("pipr.local requires { name, task }");
      }
      locals.push({ name: options.name, task: options.task as Task<unknown> });
    },
    checks(options) {
      checks = options;
    },
    limits(options) {
      limits = {
        ...limits,
        ...options,
        diffManifest:
          (options.diffManifest ?? limits?.diffManifest)
            ? { ...limits?.diffManifest, ...options.diffManifest }
            : undefined,
      };
    },
    use(plugin) {
      return plugin.setup(api);
    },
    tool(definition) {
      if (definition.name === "readOnly") {
        throw new Error("Tool name 'readOnly' is reserved for pipr built-in tools");
      }
      const execute = definition.execute;
      let run = definition.run;
      if (!run && !execute) {
        throw new Error(`Tool '${definition.name}' must define run`);
      }
      if (!run) {
        const executeTool = execute;
        if (!executeTool) {
          throw new Error(`Tool '${definition.name}' must define run`);
        }
        run = (options: ToolRunOptions<unknown>) =>
          executeTool(options.ctx, options.input as never);
      }
      const tool = {
        kind: "pipr.tool" as const,
        ...definition,
        run,
      };
      tools.push(tool);
      return tool;
    },
    schema,
    jsonSchema,
    prompt(strings, ...values) {
      let text = "";
      for (let index = 0; index < strings.length; index += 1) {
        text += strings[index] ?? "";
        if (index < values.length) {
          text += renderPromptValue(values[index]);
        }
      }
      return {
        kind: "pipr.prompt",
        value: stripCommonIndent(text).trim(),
      };
    },
    section(title, value) {
      const rendered = renderPromptValue(value);
      return {
        kind: "pipr.prompt",
        value: `## ${title}\n\n${rendered}`,
      };
    },
    json(value, options) {
      const text = JSON.stringify(value, null, options?.pretty === false ? 0 : 2);
      if (options?.maxCharacters !== undefined && text.length > options.maxCharacters) {
        throw new Error(`JSON prompt value exceeded ${options.maxCharacters} characters`);
      }
      return { kind: "pipr.prompt", value: text };
    },
  };

  return {
    api,
    plan() {
      assertUnique(
        tasks.map((task) => task.name),
        "task",
      );
      assertUnique(
        commands.map((command) => command.pattern),
        "command",
      );
      assertUnique(
        locals.map((local) => local.name),
        "local",
      );
      assertModelIdentity(models);
      return {
        models,
        agents,
        tasks,
        changeRequestTriggers,
        commands,
        locals,
        tools,
        publication,
        checks,
        limits,
      };
    },
  };
}

function registerReviewRecipe(
  api: PiprBuilder,
  publication: RuntimePlan["publication"],
  options: ReviewRecipeOptions,
): void {
  const id = options.id;
  const agent = options.reviewer ?? createReviewer(api, reviewRecipeReviewerOptions(options, id));

  const task = createReviewRecipeTask(api, id, agent, options);
  registerReviewRecipeEntrypoints(api, task, options);
  updateReviewRecipePublication(publication, options);
}

const reviewRecipeOptionKeys = new Set([
  "id",
  "entrypoints",
  "inlineComments",
  "comment",
  "check",
  "timeout",
  "paths",
  "reviewer",
  "name",
  "model",
  "fallbacks",
  "instructions",
  "prompt",
  "tools",
]);

function assertKnownReviewRecipeOptions(options: ReviewRecipeOptions): void {
  const unknownKeys = Object.keys(options).filter((key) => !reviewRecipeOptionKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`pipr.review received unsupported option fields: ${unknownKeys.join(", ")}.`);
  }
}

function reviewRecipeReviewerOptions(
  options: ReviewRecipeEntrypointOptions & ReviewerOptions,
  name: string,
): ReviewerOptions {
  if (!options.model || !options.instructions) {
    throw new Error("pipr.review requires model and instructions when reviewer is not provided");
  }
  return {
    name,
    model: options.model,
    fallbacks: options.fallbacks,
    instructions: options.instructions,
    prompt: options.prompt,
    tools: options.tools,
    timeout: options.timeout,
  };
}

function createReviewer(api: PiprBuilder, options: ReviewerOptions): Reviewer {
  return api.agent<DefaultReviewInput, ReviewResult>({
    name: options.name ?? "reviewer",
    model: options.model,
    fallbacks: options.fallbacks,
    instructions: options.instructions,
    tools: options.tools ?? api.tools.readOnly,
    output: api.schemas.review,
    timeout: options.timeout,
    prompt:
      options.prompt ??
      (() =>
        api.prompt`
          Review this change.
        `),
  });
}

function createReviewRecipeTask(
  api: PiprBuilder,
  id: string,
  agent: Agent<DefaultReviewInput, ReviewResult>,
  options: ReviewRecipeOptions,
): Task {
  return api.task({
    name: id,
    check: options.check,
    async run(context) {
      const manifest = await context.change.diffManifest({
        compressed: true,
        paths: options.paths,
      });
      if (options.paths && manifest.files.length === 0) {
        context.check.neutral("No changed files matched this review's path scope.");
        await context.comment({ main: "No changed files matched this review's path scope." });
        return;
      }
      const result = await context.pi.run(
        agent,
        { manifest, change: context.change },
        {
          timeout: options.timeout,
          paths: options.paths,
        },
      );
      const source =
        typeof options.comment === "function"
          ? await options.comment(result, {
              review: { id },
              repository: context.repository,
              change: context.change,
              platform: context.platform,
            })
          : (options.comment ?? defaultReviewComment(result, options.inlineComments !== false));
      await context.comment(source);
    },
  });
}

function defaultReviewComment(result: ReviewResult, includeInlineFindings: boolean): CommentValue {
  return {
    main: includeInlineFindings ? defaultReviewMarkdown(result) : result.summary.body,
    ...(includeInlineFindings ? { inlineFindings: result.inlineFindings } : {}),
  };
}

function defaultReviewMarkdown(result: ReviewResult): Markdown {
  const findings =
    result.inlineFindings.length === 0
      ? "No inline findings."
      : result.inlineFindings.map((finding) => `- ${finding.body}`).join("\n");
  return `## Summary\n\n${result.summary.body}\n\n## Findings\n\n${findings}`;
}

function registerReviewRecipeEntrypoints(
  api: PiprBuilder,
  task: Task,
  options: ReviewRecipeOptions,
): void {
  const changeRequest = reviewChangeRequestEntrypoint(options);
  if (changeRequest) {
    api.on.changeRequest({ actions: changeRequest, task });
  }
  const command = reviewCommandEntrypoint(options);
  if (command) {
    api.command({ pattern: command.pattern, ...command.options, task });
  }
  const local = reviewLocalEntrypoint(options);
  if (local) {
    api.local({ name: local, task });
  }
}

function reviewChangeRequestEntrypoint(
  options: ReviewRecipeOptions,
): ChangeRequestAction[] | undefined {
  const entrypoint = options.entrypoints?.changeRequest;
  return entrypoint === false
    ? undefined
    : (entrypoint ?? ["opened", "updated", "reopened", "ready"]);
}

function reviewCommandEntrypoint(options: ReviewRecipeOptions):
  | {
      pattern: string;
      options: CommandOptions<unknown>;
    }
  | undefined {
  const entrypoint = options.entrypoints?.command;
  if (entrypoint === false) {
    return undefined;
  }
  if (typeof entrypoint === "object") {
    return reviewObjectCommandEntrypoint(entrypoint);
  }
  return reviewStringCommandEntrypoint(entrypoint);
}

function reviewObjectCommandEntrypoint(
  entrypoint: Exclude<ReviewEntrypoints["command"], string | false | undefined>,
) {
  return {
    pattern: entrypoint.pattern ?? "@pipr review",
    options: {
      permission: entrypoint.permission ?? "write",
      description: entrypoint.description,
    },
  };
}

function reviewStringCommandEntrypoint(entrypoint: string | undefined) {
  return {
    pattern: entrypoint ?? "@pipr review",
    options: { permission: "write" as const },
  };
}

function reviewLocalEntrypoint(options: ReviewRecipeOptions): string | undefined {
  const entrypoint = options.entrypoints?.local;
  return entrypoint === false ? undefined : (entrypoint ?? "review");
}

function updateReviewRecipePublication(
  publication: RuntimePlan["publication"],
  options: ReviewRecipeOptions,
): void {
  const maxInlineComments =
    options.inlineComments === false ? 0 : (options.inlineComments?.max ?? 5);
  if (
    publication.maxInlineComments !== undefined &&
    publication.maxInlineComments !== maxInlineComments
  ) {
    throw new Error("pipr.review inlineComments settings must match across review recipes");
  }
  publication.maxInlineComments = maxInlineComments;
}

/** Parses model output for pipr's main pull request review schema. */
export function parseReviewResult(value: unknown): ReviewResult {
  return reviewResultSchema.parse(value) as ReviewResult;
}

/** Parses a review summary value. */
export function parseReviewSummary(value: unknown): ReviewSummary {
  return reviewSummarySchema.parse(value);
}

/** Parses one inline review finding. */
export function parseReviewFinding(value: unknown): ReviewFinding {
  return reviewFindingSchema.parse(value) as ReviewFinding;
}

/** Returns a small valid example for the main pull request review schema. */
export function reviewSchemaExample(): ReviewResult {
  return {
    summary: {
      title: "Optional concise review title.",
      body: "Concise pull request review summary.",
    },
    inlineFindings: [
      {
        body: "Specific issue and why it matters.",
        path: "src/example.ts",
        rangeId: "rng_example",
        side: "RIGHT",
        startLine: 1,
        endLine: 1,
        suggestedFix: "Optional fix.",
      },
    ],
  };
}

function createAgent<Input, Output>(
  definition: AgentDefinition<Input, Output>,
): Agent<Input, Output> {
  return {
    kind: "pipr.agent",
    name: definition.name,
    definition,
    extend(patch) {
      return createAgent({
        ...definition,
        ...patch,
        instructions:
          patch.instructions === undefined
            ? definition.instructions
            : {
                kind: "pipr.prompt",
                value:
                  `${renderPromptValue(definition.instructions)}\n\n${renderPromptValue(patch.instructions)}`.trim(),
              },
      });
    },
  };
}

function createSchema<T>(
  id: string,
  parseValue: (value: unknown) => T,
  schemaJson?: JsonSchema,
): Schema<T> {
  return {
    kind: "pipr.schema",
    id,
    jsonSchema: schemaJson,
    parse(value) {
      return parseValue(value);
    },
    safeParse(value) {
      try {
        return { success: true, data: parseValue(value) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
  };
}

function createZodSchema<T>(id: string, zodSchema: ZodSchema<T>): Schema<T> {
  return createSchema(id, (value) => zodSchema.parse(value), jsonSchemaFromZod(id, zodSchema));
}

function assertUserSchemaId(id: string): void {
  if (id.startsWith("core/")) {
    throw new Error(`Schema id '${id}' uses the reserved core/ namespace`);
  }
}

function jsonSchemaFromZod<T>(id: string, schemaDefinition: ZodSchema<T>): JsonSchema {
  try {
    return z.toJSONSchema(schemaDefinition) as JsonSchema;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Schema '${id}' could not be converted to JSON Schema. Use JSON-Schema-representable Zod or pipr.jsonSchema<T>(). ${detail}`,
    );
  }
}

/** Renders a prompt source/value into plain text for Pi prompts. */
export function renderPromptValue(value: PromptValue): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object" && value !== null && Reflect.get(value, "kind") === "pipr.prompt") {
    return (value as PromptText).value;
  }
  return JSON.stringify(value, null, 2);
}

function stripCommonIndent(value: string): string {
  const lines = value.replaceAll("\t", "  ").split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const indent = Math.min(...nonEmpty.map((line) => line.match(/^ */)?.[0].length ?? 0));
  return lines.map((line) => line.slice(indent)).join("\n");
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label} '${value}'`);
    }
    seen.add(value);
  }
}

function assertModelIdentity(models: ModelProfile[]): void {
  const ids = new Set<string>();
  const effectiveConfigs = new Map<string, string>();
  const providerModels = new Map<string, string>();

  for (const model of models) {
    const effectiveConfig = stableJson({
      provider: model.provider,
      model: model.model,
      apiKeyEnv: model.apiKey?.name,
      options: model.options,
    });
    const providerModel = `${model.provider}/${model.model}`;

    assertUniqueModelId({ model, providerModel, effectiveConfig, ids, effectiveConfigs });
    ids.add(model.id);

    const existingConfigId = effectiveConfigs.get(effectiveConfig);
    if (existingConfigId) {
      throw new Error(
        `Duplicate model config for '${model.id}'. Reuse model '${existingConfigId}' instead.`,
      );
    }
    effectiveConfigs.set(effectiveConfig, model.id);

    assertExplicitIdForRepeatedProviderModel(model, providerModel, providerModels);
    providerModels.set(providerModel, model.id);
  }
}

function assertUniqueModelId(options: {
  model: ModelProfile;
  providerModel: string;
  effectiveConfig: string;
  ids: Set<string>;
  effectiveConfigs: Map<string, string>;
}): void {
  if (!options.ids.has(options.model.id)) {
    return;
  }
  if (options.model.id !== options.providerModel) {
    throw new Error(`Duplicate model id '${options.model.id}'`);
  }
  const existingConfigId = options.effectiveConfigs.get(options.effectiveConfig);
  if (existingConfigId) {
    throw new Error(
      `Duplicate model config for '${options.model.id}'. Reuse model '${existingConfigId}' instead.`,
    );
  }
  throw explicitModelIdError(options.providerModel);
}

function assertExplicitIdForRepeatedProviderModel(
  model: ModelProfile,
  providerModel: string,
  providerModels: Map<string, string>,
): void {
  const existingProviderModelId = providerModels.get(providerModel);
  if (
    existingProviderModelId &&
    (model.id === providerModel || existingProviderModelId === providerModel)
  ) {
    throw explicitModelIdError(providerModel);
  }
}

function explicitModelIdError(providerModel: string): Error {
  return new Error(
    `Model '${providerModel}' is configured more than once with different options. Add an explicit id.`,
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableJsonValue(item)]),
    );
  }
  return value;
}
