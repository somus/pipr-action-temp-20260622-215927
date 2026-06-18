import { type ZodType, z } from "zod";
import { isRefValue, validateWorkflowPath } from "./workflow.js";

export const piprApiVersion = "pipr.dev/v1";

const componentKindValues = [
  "Workflow",
  "Block",
  "Agent",
  "CommentTemplate",
  "CommandSet",
  "Schema",
] as const;

const componentIdPattern = "^[a-z0-9-]+/[a-z0-9-]+$";
const providerIdPattern = "^[a-z][a-z0-9_-]*$";
const envNamePattern = "^[A-Z_][A-Z0-9_]*$";
const commandIdPattern = "^[a-z0-9-]+$";
const rawSecretPattern = /(sk-|api[_-]?key|secret|token)[a-z0-9_-]{8,}/i;
const componentIdRegex = new RegExp(componentIdPattern);
const providerIdRegex = new RegExp(providerIdPattern);
const envNameRegex = new RegExp(envNamePattern);
const commandIdRegex = new RegExp(commandIdPattern);
const componentKinds = new Set<string>(componentKindValues);
const jsonSchemaTypeNames = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string",
]);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const stringMapSchema = z.record(z.string(), z.unknown());
const componentKindSchema = z.enum(componentKindValues);
const componentIdSchema = z.string().regex(componentIdRegex);
const providerIdSchema = z.string().regex(providerIdRegex);
const envNameSchema = z.string().regex(envNameRegex);
const commandIdSchema = z.string().regex(commandIdRegex);
const failurePolicySchema = z.enum(["fail", "continue", "skip-output"]);

const enabledListSchema = z
  .object({
    enabled: z.array(componentIdSchema),
  })
  .strict();

const providerProfileSchema = z
  .object({
    id: providerIdSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    apiKeyEnv: envNameSchema,
    options: stringMapSchema.optional(),
  })
  .strict();

const configDocumentSchema = z
  .object({
    apiVersion: z.literal(piprApiVersion),
    kind: z.literal("Config"),
    providers: z.array(providerProfileSchema).min(1),
    workflows: enabledListSchema.optional(),
    commands: enabledListSchema.optional(),
    publication: z
      .object({
        mainCommentTemplate: componentIdSchema.optional(),
        maxInlineComments: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    limits: stringMapSchema.optional(),
    artifacts: stringMapSchema.optional(),
    plugins: z.array(stringMapSchema).optional(),
    missingCredentialPolicy: z.enum(["fail", "skip"]).optional(),
  })
  .strict();

const stepSchema = z
  .object({
    id: commandIdSchema,
    uses: componentIdSchema,
    with: stringMapSchema.optional(),
    output: z.string().min(1).optional(),
    failurePolicy: failurePolicySchema.optional(),
  })
  .strict();

const workflowComponentSchema = z
  .object({
    apiVersion: z.literal(piprApiVersion),
    kind: z.literal("Workflow"),
    id: componentIdSchema,
    description: z.string().optional(),
    priority: z.number().int().optional(),
    failurePolicy: failurePolicySchema.optional(),
    on: z.array(z.string().min(1)).optional(),
    steps: z.array(stepSchema),
  })
  .strict();

const blockComponentSchema = z
  .object({
    apiVersion: z.literal(piprApiVersion),
    kind: z.literal("Block"),
    id: componentIdSchema,
    description: z.string().optional(),
    inputs: stringMapSchema.optional(),
    outputs: stringMapSchema.optional(),
    steps: z.array(stepSchema).optional(),
    output: stringMapSchema.optional(),
    failurePolicy: failurePolicySchema.optional(),
  })
  .strict();

const agentComponentSchema = z
  .object({
    apiVersion: z.literal(piprApiVersion),
    kind: z.literal("Agent"),
    id: componentIdSchema,
    provider: providerIdSchema,
    fallbacks: z.array(providerIdSchema).optional(),
    tools: z.array(componentIdSchema).optional(),
    output: z
      .object({
        schema: componentIdSchema,
      })
      .strict(),
  })
  .strict();

const commentTemplateComponentSchema = z
  .object({
    apiVersion: z.literal(piprApiVersion),
    kind: z.literal("CommentTemplate"),
    id: componentIdSchema,
    marker: z.string().min(1),
    heading: z.string().min(1),
    sections: z.array(
      z
        .object({
          id: commandIdSchema,
          title: z.string().min(1),
          order: z.number().int(),
          empty: z.string().optional(),
          collapsed: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const commandSetComponentSchema = z
  .object({
    apiVersion: z.literal(piprApiVersion),
    kind: z.literal("CommandSet"),
    id: componentIdSchema,
    commands: z.array(
      z
        .object({
          id: commandIdSchema,
          aliases: z.array(z.string().min(1)),
          run: z
            .object({
              workflows: z.array(componentIdSchema).optional(),
              block: componentIdSchema.optional(),
            })
            .strict()
            .refine((run) => Boolean(run.workflows ?? run.block), {
              message: "expected workflows or block",
            }),
        })
        .strict(),
    ),
  })
  .strict();

const schemaComponentSchema = z
  .object({
    apiVersion: z.literal(piprApiVersion),
    kind: z.literal("Schema"),
    id: componentIdSchema,
    schema: stringMapSchema,
  })
  .strict();

const jsonSchemaDocumentSchema = z
  .record(z.string(), jsonValueSchema)
  .superRefine((schema, context) => {
    validateJsonSchemaShape(schema, context, []);
  });

const componentValidators = {
  Workflow: workflowComponentSchema,
  Block: blockComponentSchema,
  Agent: agentComponentSchema,
  CommentTemplate: commentTemplateComponentSchema,
  CommandSet: commandSetComponentSchema,
  Schema: schemaComponentSchema,
} as const satisfies Record<PiprComponentKind, ZodType<PiprComponent>>;

export type PiprComponentKind = z.infer<typeof componentKindSchema>;
export type ProviderProfile = z.infer<typeof providerProfileSchema>;
export type PiprV1Config = z.infer<typeof configDocumentSchema>;
export type WorkflowComponent = z.infer<typeof workflowComponentSchema>;
export type BlockComponent = z.infer<typeof blockComponentSchema>;
export type AgentComponent = z.infer<typeof agentComponentSchema>;
export type CommentTemplateComponent = z.infer<typeof commentTemplateComponentSchema>;
export type CommandSetComponent = z.infer<typeof commandSetComponentSchema>;
export type SchemaComponent = z.infer<typeof schemaComponentSchema>;
export type PiprComponent =
  | WorkflowComponent
  | BlockComponent
  | AgentComponent
  | CommentTemplateComponent
  | CommandSetComponent
  | SchemaComponent;

export type ValidateMaterializedProjectOptions = {
  config: PiprV1Config;
  components: PiprComponent[];
};

export function validatePiprConfigDocument(filePath: string, value: unknown): PiprV1Config {
  assertNoRawSecret(filePath, value);
  const config = assertSchemaValid(filePath, configDocumentSchema, value);
  assertUniqueProviders(config);
  return config;
}

export function validateComponentDocument(filePath: string, value: unknown): PiprComponent {
  assertNoRawSecret(filePath, value);
  const kind = readComponentKind(filePath, value);
  const validator = componentValidators[kind] as ZodType<PiprComponent>;
  const component = assertSchemaValid(filePath, validator, value);
  if (isSchemaComponent(component)) {
    assertJsonSchema(filePath, component.schema);
  }
  return component;
}

export function validateMaterializedProject(options: ValidateMaterializedProjectOptions): void {
  assertUniqueComponentIds(options.components);
  assertConfigComponentRefs(options.config, options.components);
  assertComponentGraphRefs(options.components);
  assertAgentProviderRefs(options.config, options.components);
}

export function isComponentId(value: string): boolean {
  return componentIdRegex.test(value);
}

function readComponentKind(filePath: string, value: unknown): PiprComponentKind {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${filePath}: expected a component object`);
  }
  const kind = (value as { kind?: unknown }).kind;
  if (isPiprComponentKind(kind)) {
    return kind;
  }
  throw new Error(`${filePath}: unknown component kind '${String(kind)}'`);
}

function isPiprComponentKind(value: unknown): value is PiprComponentKind {
  return typeof value === "string" && componentKinds.has(value);
}

function assertSchemaValid<T>(filePath: string, validator: ZodType<T>, value: unknown): T {
  const parsed = validator.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(formatZodErrors(filePath, parsed.error));
}

function formatZodErrors(filePath: string, error: z.ZodError): string {
  return error.issues.map((issue) => formatZodIssue(filePath, issue)).join("\n");
}

function formatZodIssue(filePath: string, issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? `/${issue.path.join("/")}` : "/";
  return `${filePath}${path}: ${issue.message}`;
}

function assertUniqueProviders(config: PiprV1Config): void {
  const seen = new Set<string>();
  for (const provider of config.providers) {
    if (seen.has(provider.id)) {
      throw new Error(`Duplicate provider id '${provider.id}'`);
    }
    seen.add(provider.id);
  }
}

function assertUniqueComponentIds(components: PiprComponent[]): void {
  const seen = new Map<string, PiprComponent>();
  for (const component of components) {
    const existing = seen.get(component.id);
    if (existing) {
      throw new Error(`Duplicate component id '${component.id}'`);
    }
    seen.set(component.id, component);
  }
}

function assertConfigComponentRefs(config: PiprV1Config, components: PiprComponent[]): void {
  const componentById = new Map(components.map((component) => [component.id, component]));
  for (const workflowId of config.workflows?.enabled ?? []) {
    assertComponentRef(componentById, workflowId, "Workflow", "Config workflows.enabled");
  }
  for (const commandSetId of config.commands?.enabled ?? []) {
    assertComponentRef(componentById, commandSetId, "CommandSet", "Config commands.enabled");
  }
  if (config.publication?.mainCommentTemplate) {
    assertComponentRef(
      componentById,
      config.publication.mainCommentTemplate,
      "CommentTemplate",
      "Config publication.mainCommentTemplate",
    );
  }
}

function assertComponentGraphRefs(components: PiprComponent[]): void {
  const componentById = new Map(components.map((component) => [component.id, component]));
  for (const component of components) {
    assertAgentSchemaRef(componentById, component);
    assertCommandSetRefs(componentById, component);
    assertStepContainerRefs(componentById, component);
  }
}

function assertAgentSchemaRef(
  componentById: Map<string, PiprComponent>,
  component: PiprComponent,
): void {
  if (!isAgentComponent(component)) {
    return;
  }
  assertComponentRef(
    componentById,
    component.output.schema,
    "Schema",
    `Agent '${component.id}' output.schema`,
  );
}

function assertCommandSetRefs(
  componentById: Map<string, PiprComponent>,
  component: PiprComponent,
): void {
  if (!isCommandSetComponent(component)) {
    return;
  }
  for (const command of component.commands) {
    for (const workflowId of command.run.workflows ?? []) {
      assertComponentRef(
        componentById,
        workflowId,
        "Workflow",
        `CommandSet '${component.id}' command '${command.id}' workflows`,
      );
    }
    if (command.run.block && !isExternalComponentRef(command.run.block)) {
      assertComponentRef(
        componentById,
        command.run.block,
        "Block",
        `CommandSet '${component.id}' command '${command.id}' block`,
      );
    }
  }
}

function assertStepContainerRefs(
  componentById: Map<string, PiprComponent>,
  component: PiprComponent,
): void {
  if (!isStepContainerComponent(component)) {
    return;
  }
  for (const step of component.steps ?? []) {
    assertSafeMaterializedStep(component, step);
    if (isExternalComponentRef(step.uses)) {
      continue;
    }
    assertComponentRef(
      componentById,
      step.uses,
      "Block",
      `${component.kind} '${component.id}' step '${step.id}' uses`,
    );
  }
}

function assertSafeMaterializedStep(
  component: StepContainerComponent,
  step: { id: string; uses: string; with?: unknown; output?: string },
): void {
  assertSafeMaterializedWorkflowPath(component, step, "output", step.output);
  assertSafeMaterializedRefs(component, step, step.with);
}

function assertSafeMaterializedRefs(
  component: StepContainerComponent,
  step: { id: string; uses: string },
  value: unknown,
): void {
  if (isRefValue(value)) {
    assertSafeMaterializedWorkflowPath(component, step, "ref", value.from);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      assertSafeMaterializedRefs(component, step, item);
    }
    return;
  }

  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      assertSafeMaterializedRefs(component, step, item);
    }
  }
}

function assertSafeMaterializedWorkflowPath(
  component: StepContainerComponent,
  step: { id: string; uses: string },
  kind: "output" | "ref",
  value: string | undefined,
): void {
  if (!value) {
    return;
  }
  try {
    validateWorkflowPath(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${component.kind} '${component.id}' step '${step.id}' has invalid ${kind} '${value}': ${message}`,
    );
  }
}

function assertComponentRef(
  componentById: Map<string, PiprComponent>,
  componentId: string,
  expectedKind: PiprComponentKind,
  label: string,
): void {
  const component = componentById.get(componentId);
  if (!component) {
    throw new Error(`${label} references missing ${expectedKind} '${componentId}'`);
  }
  if (component.kind !== expectedKind) {
    throw new Error(
      `${label} references ${component.kind} '${componentId}', expected ${expectedKind}`,
    );
  }
}

function isExternalComponentRef(componentId: string): boolean {
  return componentId.startsWith("core/");
}

function assertAgentProviderRefs(config: PiprV1Config, components: PiprComponent[]): void {
  const providerIds = new Set(config.providers.map((provider) => provider.id));
  for (const agent of components.filter(isAgentComponent)) {
    assertKnownProvider(agent.id, agent.provider, providerIds);
    for (const fallback of agent.fallbacks ?? []) {
      assertKnownProvider(agent.id, fallback, providerIds);
    }
  }
}

function isAgentComponent(component: PiprComponent): component is AgentComponent {
  return component.kind === "Agent";
}

function isCommandSetComponent(component: PiprComponent): component is CommandSetComponent {
  return component.kind === "CommandSet";
}

type StepContainerComponent = WorkflowComponent | BlockComponent;

function isStepContainerComponent(component: PiprComponent): component is StepContainerComponent {
  return component.kind === "Workflow" || component.kind === "Block";
}

function isSchemaComponent(component: PiprComponent): component is SchemaComponent {
  return component.kind === "Schema";
}

function assertJsonSchema(filePath: string, schema: Record<string, unknown>): void {
  const parsed = jsonSchemaDocumentSchema.safeParse(schema);
  if (parsed.success) {
    return;
  }
  throw new Error(
    `Invalid JSON Schema in ${filePath}:\n${formatZodErrors(filePath, parsed.error)}`,
  );
}

function validateJsonSchemaShape(
  schema: Record<string, JsonValue>,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  validateJsonSchemaType(schema.type, context, [...path, "type"]);
  validateStringArray(schema.required, context, [...path, "required"]);
  validateSchemaMap(schema.properties, context, [...path, "properties"]);
  validateSchemaMap(schema.patternProperties, context, [...path, "patternProperties"]);
  validateNestedSchema(schema.items, context, [...path, "items"]);
  validateNestedSchema(schema.additionalProperties, context, [...path, "additionalProperties"]);
}

function validateJsonSchemaType(
  value: JsonValue | undefined,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === "string") {
    if (!jsonSchemaTypeNames.has(value)) {
      addJsonSchemaIssue(context, path, `unknown JSON Schema type '${value}'`);
    }
    return;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    for (const item of value) {
      if (!jsonSchemaTypeNames.has(item)) {
        addJsonSchemaIssue(context, path, `unknown JSON Schema type '${item}'`);
      }
    }
    return;
  }
  addJsonSchemaIssue(context, path, "type must be a JSON Schema type name or array");
}

function validateStringArray(
  value: JsonValue | undefined,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    addJsonSchemaIssue(context, path, "must be an array of strings");
  }
}

function validateSchemaMap(
  value: JsonValue | undefined,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (value === undefined) {
    return;
  }
  if (!isJsonObject(value)) {
    addJsonSchemaIssue(context, path, "must be an object of JSON Schemas");
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    validateNestedSchema(nested, context, [...path, key]);
  }
}

function validateNestedSchema(
  value: JsonValue | undefined,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (value === undefined || typeof value === "boolean") {
    return;
  }
  if (isJsonObject(value)) {
    validateJsonSchemaShape(value, context, path);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateNestedSchema(item, context, [...path, index]);
    }
    return;
  }
  addJsonSchemaIssue(context, path, "must be a JSON Schema object or boolean");
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addJsonSchemaIssue(
  context: z.RefinementCtx,
  path: Array<string | number>,
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function assertKnownProvider(
  agentId: string,
  providerId: string,
  knownProviders: Set<string>,
): void {
  if (!knownProviders.has(providerId)) {
    throw new Error(`Agent '${agentId}' references unknown provider '${providerId}'`);
  }
}

function assertNoRawSecret(filePath: string, value: unknown): void {
  const secretPath = findRawSecretPath(value);
  if (secretPath) {
    throw new Error(
      `${filePath}: Raw secret-looking value found at ${secretPath}; use env var names instead`,
    );
  }
}

export function assertNoRawSecrets(filePath: string, value: unknown): void {
  assertNoRawSecret(filePath, value);
}

function findRawSecretPath(value: unknown): string | undefined {
  const stack: Array<{ value: unknown; pathParts: string[] }> = [{ value, pathParts: [] }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (
      typeof current.value === "string" &&
      !isSecretEnvPath(current.pathParts) &&
      rawSecretPattern.test(current.value)
    ) {
      return formatPath(current.pathParts);
    }
    for (const [key, item] of childEntries(current.value)) {
      stack.push({ value: item, pathParts: [...current.pathParts, key] });
    }
  }
  return undefined;
}

function isSecretEnvPath(pathParts: string[]): boolean {
  const key = pathParts.at(-1) ?? "";
  return key === "apiKeyEnv" || key === "api_key_env";
}

function childEntries(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) {
    return value.map((item, index) => [String(index), item]);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value);
  }
  return [];
}

function formatPath(parts: string[]): string {
  return parts.length === 0 ? "$" : `$.${parts.join(".")}`;
}
