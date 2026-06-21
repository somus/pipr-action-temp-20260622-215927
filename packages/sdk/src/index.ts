const configFactoryBrand = Symbol.for("pipr.config.factory");
const builtinReadOnlyToolBrand = Symbol.for("pipr.builtin.readOnlyTool");

export type RepositoryPermission = "read" | "triage" | "write" | "maintain" | "admin";
export type ChangeRequestAction = "opened" | "updated" | "reopened" | "ready" | "closed";

export type DurationInput = number | `${number}s` | `${number}m` | `${number}h`;

export type SecretRef = {
  readonly kind: "pipr.secret";
  readonly name: string;
};

export type ModelOptions = {
  name?: string;
  apiKey?: SecretRef;
  options?: Record<string, unknown>;
};

export type ModelProfile = {
  readonly kind: "pipr.model";
  readonly id: symbol;
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: SecretRef;
  readonly options?: Record<string, unknown>;
};

export type SchemaParseResult<T> = { success: true; data: T } | { success: false; error: Error };

export type Schema<T> = {
  readonly kind: "pipr.schema";
  readonly id: string;
  parse(value: unknown): T;
  safeParse(value: unknown): SchemaParseResult<T>;
};

export type ReviewSummary = {
  title?: string;
  body: string;
  risk?: "low" | "medium" | "high" | "critical";
};

export type ReviewFinding = {
  title: string;
  body: string;
  path: string;
  rangeId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
  severity: "critical" | "high" | "medium" | "low" | "nit";
  category:
    | "correctness"
    | "security"
    | "tests"
    | "performance"
    | "maintainability"
    | "docs"
    | "architecture"
    | "other";
  confidence: number;
  evidenceSnippet: string;
  suggestedFix?: string;
  semanticAnchor?: string;
  fingerprintHint?: string;
};

export type ReviewResult = {
  summary: ReviewSummary;
  inlineFindings: ReviewFinding[];
};

export type ReviewCandidates = {
  summary?: ReviewSummary;
  candidates: Array<ReviewFinding & { candidateId: string }>;
};

export type ConsolidatedReview = ReviewResult;

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
  readonly reviewCandidates: Schema<ReviewCandidates>;
  readonly consolidatedReview: Schema<ConsolidatedReview>;
  readonly summary: Schema<ReviewSummary>;
};

export type AgentTool<Input = unknown, Output = unknown> = {
  readonly kind: "pipr.tool";
  readonly name: string;
  readonly description?: string;
  readonly input?: Schema<Input>;
  readonly output?: Schema<Output>;
};

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

export type Task<Input = void> = {
  readonly kind: "pipr.task";
  readonly name: string;
  readonly handler: TaskHandler<Input>;
};

export type CommandOptions<Input> = {
  permission?: RepositoryPermission;
  description?: string;
  parse?: (arguments_: Record<string, string>) => Input;
};

export type ReviewRecipeOptions = {
  name?: string;
  model: ModelProfile;
  fallbacks?: ModelProfile[];
  instructions: PromptSource;
  prompt?: (
    input: DefaultReviewInput,
    context: AgentPromptContext,
  ) => PromptSource | Promise<PromptSource>;
  tools?: readonly AgentTool[];
  on?: ChangeRequestAction[] | false;
  command?: string | false;
  commandPermission?: RepositoryPermission;
  localName?: string | false;
  inlineComments?:
    | false
    | {
        max?: number;
        minConfidence?: number;
      };
  summary?: boolean;
  timeout?: DurationInput;
};

export type DefaultReviewInput = {
  manifest: DiffManifest;
  change: ChangeRequestInfo;
};

export type PiprPlugin<Handle> = {
  setup(builder: PiprBuilder): Handle;
};

export type PluginToolDefinition<Input, Output> = {
  name: string;
  description: string;
  input: Schema<Input>;
  output: Schema<Output>;
  execute(context: unknown, input: Input): Promise<Output>;
};

export type PiprBuilder = {
  readonly tools: BuiltinToolCatalog;
  readonly schemas: BuiltinSchemaCatalog;
  readonly on: {
    changeRequest<Input = void>(actions: ChangeRequestAction[], task: Task<Input>): void;
  };
  secret(name: string): SecretRef;
  model(specification: string, options?: ModelOptions): ModelProfile;
  agent<Input, Output>(definition: AgentDefinition<Input, Output>): Agent<Input, Output>;
  task<Input = void>(name: string, handler: TaskHandler<Input>): Task<Input>;
  review(options: ReviewRecipeOptions): void;
  command<Input = void>(pattern: string, options: CommandOptions<Input>, task: Task<Input>): void;
  local<Input = void>(name: string, task: Task<Input>): void;
  limits(options: RuntimeLimits): void;
  use<Handle>(plugin: PiprPlugin<Handle>): Handle;
  tool<Input, Output>(definition: PluginToolDefinition<Input, Output>): AgentTool<Input, Output>;
  prompt(strings: TemplateStringsArray, ...values: PromptValue[]): PromptText;
  section(title: string, value: PromptValue): PromptText;
  json(value: unknown, options?: JsonPromptOptions): PromptText;
  compactManifest(manifest: DiffManifest): PromptText;
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
    minConfidence?: number;
  };
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

export type OutputCollector = {
  summary(value: ReviewSummary | string, options?: SummaryContributionOptions): void;
  findings(value: ReviewFinding[]): void;
  section<T>(id: string, value: T, options: SectionContributionOptions<T>): void;
  metadata(value: Record<string, unknown>): void;
};

export type SummaryContributionOptions = {
  key?: string;
  merge?: "exclusive" | "replace" | "append";
  priority?: number;
};

export type SectionContributionOptions<T> = {
  title: string;
  order?: number;
  merge?: "exclusive" | "replace" | "append" | "list";
  priority?: number;
  collapsed?: boolean;
  render?: (value: T) => string;
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
    },
  ): Promise<Output>;
};

export type TaskContext = {
  readonly run: { id: string };
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

export function definePipr(configure: (pipr: PiprBuilder) => void): PiprConfigFactory {
  return {
    kind: "pipr.config-factory",
    [configFactoryBrand]: true,
    build() {
      const builder = createBuilder();
      const result = configure(builder.api);
      if (isPromiseLike(result)) {
        throw new Error("definePipr configuration callback must be synchronous");
      }
      return builder.plan();
    },
  };
}

export function isPiprConfigFactory(value: unknown): value is PiprConfigFactory {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "pipr.config-factory" &&
    Reflect.get(value, configFactoryBrand) === true
  );
}

export function buildPiprPlan(factory: PiprConfigFactory): RuntimePlan {
  return factory.build();
}

export function definePlugin<Handle>(setup: (builder: PiprBuilder) => Handle): PiprPlugin<Handle> {
  return { setup };
}

export const schemas: BuiltinSchemaCatalog = {
  review: createSchema<ReviewResult>("core/pr-review", parseReviewResult),
  reviewCandidates: createSchema<ReviewCandidates>("core/review-candidates", parseReviewCandidates),
  consolidatedReview: createSchema<ConsolidatedReview>(
    "core/consolidated-review",
    parseReviewResult,
  ),
  summary: createSchema<ReviewSummary>("core/summary", parseReviewSummary),
};

function createBuilder(): { api: PiprBuilder; plan(): RuntimePlan } {
  const models: ModelProfile[] = [];
  const agents: Agent[] = [];
  const tasks: Task<unknown>[] = [];
  const changeRequestTriggers: RuntimePlan["changeRequestTriggers"] = [];
  const commands: RuntimePlan["commands"] = [];
  const locals: RuntimePlan["locals"] = [];
  const tools: AgentTool[] = [];
  const publication: RuntimePlan["publication"] = {};
  let limits: RuntimeLimits | undefined;

  const api: PiprBuilder = {
    tools: { readOnly: [createBuiltinReadOnlyTool()] },
    schemas,
    on: {
      changeRequest(actions, task) {
        changeRequestTriggers.push({ actions, task: task as Task<unknown> });
      },
    },
    secret(name) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
        throw new Error(`Secret '${name}' must be an environment variable name`);
      }
      return { kind: "pipr.secret", name };
    },
    model(specification, options = {}) {
      const [provider, ...modelParts] = specification.split("/");
      const model = modelParts.join("/");
      if (!provider || !model) {
        throw new Error(`Model specification '${specification}' must use <provider>/<model>`);
      }
      const profile: ModelProfile = {
        kind: "pipr.model",
        id: Symbol(options.name ?? specification),
        name: options.name ?? model.replace(/[^a-zA-Z0-9_-]/g, "-"),
        provider,
        model,
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
    task(name, handler) {
      const task = { kind: "pipr.task" as const, name, handler };
      tasks.push(task as Task<unknown>);
      return task;
    },
    review(options) {
      registerReviewRecipe(api, publication, options);
    },
    command(pattern, options, task) {
      assertCommandPattern(pattern);
      commands.push({
        pattern,
        permission: options.permission ?? "write",
        description: options.description,
        parse: options.parse as ((arguments_: Record<string, string>) => unknown) | undefined,
        task: task as Task<unknown>,
      });
    },
    local(name, task) {
      locals.push({ name, task: task as Task<unknown> });
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
      const tool = { kind: "pipr.tool" as const, ...definition };
      tools.push(tool);
      return tool;
    },
    prompt(strings, ...values) {
      return {
        kind: "pipr.prompt",
        value: renderPromptTemplate(strings, values),
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
    compactManifest(manifest) {
      return {
        kind: "pipr.prompt",
        value: JSON.stringify(compactManifest(manifest), null, 2),
      };
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
      return {
        models,
        agents,
        tasks,
        changeRequestTriggers,
        commands,
        locals,
        tools,
        publication,
        limits,
      };
    },
  };
}

function createBuiltinReadOnlyTool(): AgentTool {
  return {
    kind: "pipr.tool",
    name: "readOnly",
    [builtinReadOnlyToolBrand]: true,
  } as AgentTool;
}

function registerReviewRecipe(
  api: PiprBuilder,
  publication: RuntimePlan["publication"],
  options: ReviewRecipeOptions,
): void {
  const name = options.name ?? "review";
  const agent = createReviewRecipeAgent(api, name, options);
  const task = createReviewRecipeTask(api, name, agent, options);
  registerReviewRecipeTriggers(api, task, options);
  updateReviewRecipePublication(publication, options);
}

function createReviewRecipeAgent(
  api: PiprBuilder,
  name: string,
  options: ReviewRecipeOptions,
): Agent<DefaultReviewInput, ReviewResult> {
  return api.agent<DefaultReviewInput, ReviewResult>({
    name,
    model: options.model,
    fallbacks: options.fallbacks,
    instructions: options.instructions,
    tools: options.tools ?? api.tools.readOnly,
    output: api.schemas.review,
    timeout: options.timeout,
    prompt: options.prompt ?? defaultReviewRecipePrompt(api),
  });
}

function defaultReviewRecipePrompt(api: PiprBuilder): (input: DefaultReviewInput) => PromptSource {
  return (input) =>
    api.prompt`
      Review this change.

      ${api.section("Changed files and valid comment locations", api.compactManifest(input.manifest))}
    `;
}

function createReviewRecipeTask(
  api: PiprBuilder,
  name: string,
  agent: Agent<DefaultReviewInput, ReviewResult>,
  options: ReviewRecipeOptions,
): Task {
  return api.task(name, async (context) => {
    const manifest = await context.change.diffManifest({ compressed: true });
    const result = await context.pi.run(agent, { manifest, change: context.change });
    if (options.summary !== false) {
      context.output.summary(result.summary, { key: name, merge: "append" });
    }
    if (options.inlineComments !== false) {
      context.output.findings(result.inlineFindings);
    }
  });
}

function registerReviewRecipeTriggers(
  api: PiprBuilder,
  task: Task,
  options: ReviewRecipeOptions,
): void {
  if (options.on !== false) {
    api.on.changeRequest(options.on ?? ["opened", "updated", "reopened", "ready"], task);
  }
  if (options.command !== false) {
    api.command(
      options.command ?? "@pipr review",
      {
        permission: options.commandPermission ?? "write",
      },
      task,
    );
  }
  if (options.localName !== false) {
    api.local(options.localName ?? "review", task);
  }
}

function updateReviewRecipePublication(
  publication: RuntimePlan["publication"],
  options: ReviewRecipeOptions,
): void {
  const next = reviewRecipePublication(options);
  if (
    publication.maxInlineComments !== undefined &&
    (publication.maxInlineComments !== next.maxInlineComments ||
      publication.minConfidence !== next.minConfidence)
  ) {
    throw new Error("pipr.review inlineComments settings must match across review recipes");
  }
  publication.maxInlineComments = next.maxInlineComments;
  publication.minConfidence = next.minConfidence;
}

function reviewRecipePublication(options: ReviewRecipeOptions): RuntimePlan["publication"] {
  return {
    maxInlineComments: options.inlineComments === false ? 0 : (options.inlineComments?.max ?? 5),
    minConfidence: options.inlineComments === false ? 1 : options.inlineComments?.minConfidence,
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
            : joinPromptSources(definition.instructions, patch.instructions),
      });
    },
  };
}

function createSchema<T>(id: string, parseValue: (value: unknown) => T): Schema<T> {
  return {
    kind: "pipr.schema",
    id,
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

function parseReviewResult(value: unknown): ReviewResult {
  const record = requireRecord(value, "ReviewResult");
  if (record.nonInlineFindings !== undefined) {
    throw new Error("ReviewResult.nonInlineFindings is not supported in the MVP");
  }
  const summary = parseReviewSummary(record.summary);
  const inlineFindings = requireArray(record.inlineFindings, "ReviewResult.inlineFindings").map(
    parseReviewFinding,
  );
  return { summary, inlineFindings };
}

function parseReviewCandidates(value: unknown): ReviewCandidates {
  const record = requireRecord(value, "ReviewCandidates");
  const summary = record.summary === undefined ? undefined : parseReviewSummary(record.summary);
  const candidates = requireArray(record.candidates, "ReviewCandidates.candidates").map(
    (candidate) => {
      const parsed = parseReviewFinding(candidate) as ReviewFinding & { candidateId: string };
      parsed.candidateId = requireString(
        requireRecord(candidate, "candidate").candidateId,
        "candidateId",
      );
      return parsed;
    },
  );
  return summary === undefined ? { candidates } : { summary, candidates };
}

function parseReviewSummary(value: unknown): ReviewSummary {
  const record = requireRecord(value, "ReviewSummary");
  const summary: ReviewSummary = { body: requireString(record.body, "summary.body") };
  if (record.title !== undefined) {
    summary.title = requireString(record.title, "summary.title");
  }
  if (record.risk !== undefined) {
    summary.risk = requireEnum(record.risk, "summary.risk", ["low", "medium", "high", "critical"]);
  }
  return summary;
}

function parseReviewFinding(value: unknown): ReviewFinding {
  const record = requireRecord(value, "ReviewFinding");
  const finding: ReviewFinding = {
    title: requireString(record.title, "finding.title"),
    body: requireString(record.body, "finding.body"),
    path: requireString(record.path, "finding.path"),
    rangeId: requireString(record.rangeId, "finding.rangeId"),
    side: requireEnum(record.side, "finding.side", ["RIGHT", "LEFT"]),
    startLine: requirePositiveInteger(record.startLine, "finding.startLine"),
    endLine: requirePositiveInteger(record.endLine, "finding.endLine"),
    severity: requireEnum(record.severity, "finding.severity", [
      "critical",
      "high",
      "medium",
      "low",
      "nit",
    ]),
    category: requireEnum(record.category, "finding.category", [
      "correctness",
      "security",
      "tests",
      "performance",
      "maintainability",
      "docs",
      "architecture",
      "other",
    ]),
    confidence: requireConfidence(record.confidence, "finding.confidence"),
    evidenceSnippet: requireString(record.evidenceSnippet, "finding.evidenceSnippet"),
  };
  if (record.id !== undefined) {
    throw new Error("finding.id is not supported in the MVP");
  }
  if (record.suggestedFix !== undefined) {
    finding.suggestedFix = requireString(record.suggestedFix, "finding.suggestedFix");
  }
  if (record.semanticAnchor !== undefined) {
    finding.semanticAnchor = requireString(record.semanticAnchor, "finding.semanticAnchor");
  }
  if (record.fingerprintHint !== undefined) {
    finding.fingerprintHint = requireString(record.fingerprintHint, "finding.fingerprintHint");
  }
  return finding;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireConfidence(value: unknown, label: string): number {
  if (typeof value !== "number" || value < 0 || value > 1) {
    throw new Error(`${label} must be a number from 0 to 1`);
  }
  return value;
}

function requireEnum<const T extends readonly [string, ...string[]]>(
  value: unknown,
  label: string,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function renderPromptTemplate(strings: TemplateStringsArray, values: PromptValue[]): string {
  let text = "";
  for (let index = 0; index < strings.length; index += 1) {
    text += strings[index] ?? "";
    if (index < values.length) {
      text += renderPromptValue(values[index]);
    }
  }
  return stripCommonIndent(text).trim();
}

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
  if (isPromptText(value)) {
    return value.value;
  }
  return JSON.stringify(value, null, 2);
}

function joinPromptSources(left: PromptSource, right: PromptSource): PromptText {
  return {
    kind: "pipr.prompt",
    value: `${renderPromptValue(left)}\n\n${renderPromptValue(right)}`.trim(),
  };
}

function isPromptText(value: unknown): value is PromptText {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, "kind") === "pipr.prompt"
  );
}

function stripCommonIndent(value: string): string {
  const lines = value.replaceAll("\t", "  ").split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const indent = Math.min(...nonEmpty.map((line) => line.match(/^ */)?.[0].length ?? 0));
  return lines.map((line) => line.slice(indent)).join("\n");
}

function compactManifest(manifest: DiffManifest): object {
  return {
    baseSha: manifest.baseSha,
    headSha: manifest.headSha,
    mergeBaseSha: manifest.mergeBaseSha,
    files: manifest.files.map((file) => ({
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      ranges: file.commentableRanges ?? file.ranges ?? [],
      preview: file.preview,
    })),
  };
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

function assertCommandPattern(pattern: string): void {
  const tokens = pattern.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("Command pattern must not be empty");
  }
  if (tokens[0] !== "@pipr") {
    throw new Error(`Command pattern '${pattern}' must start with @pipr`);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "then") === "function"
  );
}
