import { type ZodType, z } from "zod";
import { commandPatternInputIds } from "../commands/grammar.js";
import { piProviderIdSchema, piProviderProfileSchema } from "../pi/contract.js";
import { prReviewSchemaId } from "../review/contract.js";
import { isRecord } from "../shared/record.js";
import { workflowCommandSchema, workflowInputsSchema } from "../types.js";
import { validateWorkflowExpressions } from "../workflow/expression.js";

export const piprApiVersion = "pipr.dev/v1";

const componentKindValues = ["Workflow", "Block", "Agent", "CommentTemplate", "Schema"] as const;

const componentIdPattern = "^[a-z0-9-]+/[a-z0-9-]+$";
const commandIdPattern = "^[a-z0-9-]+$";
const rawSecretPattern = /(sk-|api[_-]?key|secret|token)[a-z0-9_-]{8,}/i;
const componentIdRegex = new RegExp(componentIdPattern);
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
const providerIdSchema = piProviderIdSchema;
const commandIdSchema = z.string().regex(commandIdRegex);
const failurePolicySchema = z.enum(["fail", "continue", "skip-output"]);

const providerProfileSchema = piProviderProfileSchema;

const limitsSchema = z.strictObject({
  timeoutSeconds: z.number().int().positive().max(3600),
});

const stepSchema = z.strictObject({
  id: commandIdSchema,
  uses: componentIdSchema,
  with: z.unknown().optional(),
  failurePolicy: failurePolicySchema.optional(),
});

const workflowComponentSchema = z.strictObject({
  apiVersion: z.literal(piprApiVersion),
  kind: z.literal("Workflow"),
  id: componentIdSchema,
  description: z.string().optional(),
  inputs: workflowInputsSchema.optional(),
  failurePolicy: failurePolicySchema.optional(),
  on: z
    .strictObject({
      events: z.array(z.string().min(1)).optional(),
      commands: z.array(workflowCommandSchema).optional(),
    })
    .optional(),
  steps: z.array(stepSchema),
});

const configWorkflowRefSchema = z.union([componentIdSchema, workflowComponentSchema]);

const configDocumentSchema = z.strictObject({
  apiVersion: z.literal(piprApiVersion),
  kind: z.literal("Config"),
  providers: z.array(providerProfileSchema).min(1),
  workflows: z.array(configWorkflowRefSchema).optional(),
  publication: z
    .strictObject({
      maxInlineComments: z.number().int().min(0).max(50).optional(),
    })
    .optional(),
  limits: limitsSchema.optional(),
});

const blockComponentSchema = z.strictObject({
  apiVersion: z.literal(piprApiVersion),
  kind: z.literal("Block"),
  id: componentIdSchema,
  description: z.string().optional(),
  inputs: stringMapSchema.optional(),
  outputs: stringMapSchema.optional(),
  steps: z.array(stepSchema).optional(),
  output: stringMapSchema.optional(),
  failurePolicy: failurePolicySchema.optional(),
});

const agentComponentSchema = z.strictObject({
  apiVersion: z.literal(piprApiVersion),
  kind: z.literal("Agent"),
  id: componentIdSchema,
  provider: providerIdSchema,
  tools: z.array(componentIdSchema).optional(),
  output: z.strictObject({
    schema: componentIdSchema,
  }),
});

const commentTemplateComponentSchema = z.strictObject({
  apiVersion: z.literal(piprApiVersion),
  kind: z.literal("CommentTemplate"),
  id: componentIdSchema,
  marker: z.string().min(1),
  heading: z.string().min(1),
  sections: z.array(
    z.strictObject({
      id: z.enum(["summary", "findings", "metadata"]),
      title: z.string().min(1),
      order: z.number().int(),
      empty: z.string().optional(),
      collapsed: z.boolean().optional(),
    }),
  ),
});

const schemaComponentSchema = z.strictObject({
  apiVersion: z.literal(piprApiVersion),
  kind: z.literal("Schema"),
  id: componentIdSchema,
  schema: stringMapSchema,
});

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
  Schema: schemaComponentSchema,
} as const satisfies Record<PiprComponentKind, ZodType<PiprComponent>>;

export type PiprComponentKind = z.infer<typeof componentKindSchema>;
export type ProviderProfile = z.infer<typeof providerProfileSchema>;
type RawPiprV1Config = z.infer<typeof configDocumentSchema>;
export type PiprV1Config = Omit<RawPiprV1Config, "workflows"> & { workflows?: string[] };
export type WorkflowComponent = z.infer<typeof workflowComponentSchema>;
export type BlockComponent = z.infer<typeof blockComponentSchema>;
export type AgentComponent = z.infer<typeof agentComponentSchema>;
export type CommentTemplateComponent = z.infer<typeof commentTemplateComponentSchema>;
export type SchemaComponent = z.infer<typeof schemaComponentSchema>;
export type PiprComponent =
  | WorkflowComponent
  | BlockComponent
  | AgentComponent
  | CommentTemplateComponent
  | SchemaComponent;

export type ValidateMaterializedProjectOptions = {
  config: PiprV1Config;
  components: PiprComponent[];
  pluginToolIds?: string[];
};

export function validatePiprConfigDocument(filePath: string, value: unknown): PiprV1Config {
  assertNoRawSecret(filePath, value);
  const config = normalizeConfigDocument(assertSchemaValid(filePath, configDocumentSchema, value));
  assertUniqueProviders(config);
  return config;
}

export function extractPiprConfigComponents(filePath: string, value: unknown): PiprComponent[] {
  assertNoRawSecret(filePath, value);
  const config = assertSchemaValid(filePath, configDocumentSchema, value);
  return (config.workflows ?? []).filter(isInlineWorkflow);
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
  assertNoReservedMaterializedComponentIds(options.components);
  assertConfigComponentRefs(options.config, options.components);
  assertComponentGraphRefs(options.config, options.components);
  assertAgentProviderRefs(options.config, options.components);
  assertAgentToolRefs(options);
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

function normalizeConfigDocument(config: RawPiprV1Config): PiprV1Config {
  return {
    ...config,
    workflows: config.workflows?.map((workflow) =>
      typeof workflow === "string" ? workflow : workflow.id,
    ),
  };
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

function assertNoReservedMaterializedComponentIds(components: PiprComponent[]): void {
  for (const component of components) {
    if (isExternalComponentRef(component.id)) {
      throw new Error(`Component id '${component.id}' uses reserved namespace 'core/'`);
    }
  }
}

function assertConfigComponentRefs(config: PiprV1Config, components: PiprComponent[]): void {
  const componentById = new Map(components.map((component) => [component.id, component]));
  for (const workflowId of config.workflows ?? []) {
    assertComponentRef(componentById, workflowId, "Workflow", "Config workflows");
  }
}

function assertComponentGraphRefs(config: PiprV1Config, components: PiprComponent[]): void {
  const componentById = new Map(components.map((component) => [component.id, component]));
  const enabledWorkflowIds = new Set(config.workflows ?? []);
  for (const component of components) {
    assertAgentSchemaRef(componentById, component);
    assertStepContainerRefs(componentById, component);
  }
  assertEnabledWorkflowCommands(componentById, enabledWorkflowIds);
}

function assertAgentSchemaRef(
  componentById: Map<string, PiprComponent>,
  component: PiprComponent,
): void {
  if (!isAgentComponent(component)) {
    return;
  }
  if (component.output.schema === prReviewSchemaId) {
    return;
  }
  assertComponentRef(
    componentById,
    component.output.schema,
    "Schema",
    `Agent '${component.id}' output.schema`,
  );
}

function assertStepContainerRefs(
  componentById: Map<string, PiprComponent>,
  component: PiprComponent,
): void {
  if (!isStepContainerComponent(component)) {
    return;
  }
  assertUniqueStepIds(component);
  if (component.kind === "Block") {
    assertSafeMaterializedExpressions(
      `${component.kind} '${component.id}' output`,
      component.output,
    );
  }
  for (const step of component.steps ?? []) {
    assertSafeMaterializedStep(component, step);
    assertCoreStepInputRefs(componentById, component, step);
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

function assertUniqueStepIds(component: StepContainerComponent): void {
  const seen = new Set<string>();
  for (const step of component.steps ?? []) {
    if (seen.has(step.id)) {
      throw new Error(`${component.kind} '${component.id}' has duplicate step id '${step.id}'`);
    }
    seen.add(step.id);
  }
}

function assertCoreStepInputRefs(
  componentById: Map<string, PiprComponent>,
  component: StepContainerComponent,
  step: { id: string; uses: string; with?: unknown },
): void {
  if (step.uses !== "core/main-comment" || !isRecord(step.with) || !hasOwn(step.with, "template")) {
    return;
  }
  const template = step.with.template;
  if (typeof template !== "string") {
    throw new Error(
      `${component.kind} '${component.id}' step '${step.id}' template must be a CommentTemplate id string`,
    );
  }
  assertComponentRef(
    componentById,
    template,
    "CommentTemplate",
    `${component.kind} '${component.id}' step '${step.id}' template`,
  );
}

function assertSafeMaterializedStep(
  component: StepContainerComponent,
  step: { id: string; uses: string; with?: unknown },
): void {
  assertSafeMaterializedExpressions(
    `${component.kind} '${component.id}' step '${step.id}' input`,
    step.with,
  );
}

function assertSafeMaterializedExpressions(label: string, value: unknown): void {
  try {
    validateWorkflowExpressions(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} has invalid expression: ${message}`);
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
  }
}

function assertAgentToolRefs(options: ValidateMaterializedProjectOptions): void {
  const pluginToolIds = new Set(options.pluginToolIds ?? []);
  for (const agent of options.components.filter(isAgentComponent)) {
    for (const toolId of agent.tools ?? []) {
      if (isExternalComponentRef(toolId)) {
        throw new Error(
          `Agent '${agent.id}' tool '${toolId}' references a runtime built-in; Pi built-in tools are attached by pipr, not Agent tools`,
        );
      }
      if (!pluginToolIds.has(toolId)) {
        throw new Error(`Agent '${agent.id}' references unknown tool '${toolId}'`);
      }
    }
  }
}

function assertEnabledWorkflowCommands(
  componentById: Map<string, PiprComponent>,
  enabledWorkflowIds: Set<string>,
): void {
  const commandNames = new Map<string, string>();
  const commandAliases = new Map<string, string>();
  for (const workflowId of enabledWorkflowIds) {
    const workflow = enabledWorkflow(componentById, workflowId);
    if (workflow) {
      assertWorkflowCommands(workflow, { commandNames, commandAliases });
    }
  }
}

function enabledWorkflow(
  componentById: Map<string, PiprComponent>,
  workflowId: string,
): WorkflowComponent | undefined {
  const workflow = componentById.get(workflowId);
  return workflow?.kind === "Workflow" ? workflow : undefined;
}

function assertWorkflowCommands(
  workflow: WorkflowComponent,
  seen: { commandNames: Map<string, string>; commandAliases: Map<string, string> },
): void {
  for (const command of workflow.on?.commands ?? []) {
    assertUniqueWorkflowCommand(command.name, workflow.id, seen.commandNames, "command name");
    assertWorkflowCommandAliases(workflow, command, seen.commandAliases);
  }
}

function assertWorkflowCommandAliases(
  workflow: WorkflowComponent,
  command: NonNullable<NonNullable<WorkflowComponent["on"]>["commands"]>[number],
  commandAliases: Map<string, string>,
): void {
  for (const alias of command.aliases ?? []) {
    assertUniqueWorkflowCommand(alias, workflow.id, commandAliases, "command alias");
  }
  if (!command.pattern) {
    return;
  }
  assertUniqueWorkflowCommand(command.pattern, workflow.id, commandAliases, "command pattern");
  assertCommandPatternInputs(workflow, command.pattern, command.name);
}

function assertUniqueWorkflowCommand(
  value: string,
  workflowId: string,
  seen: Map<string, string>,
  label: string,
): void {
  const existing = seen.get(value);
  if (existing) {
    throw new Error(`Duplicate workflow ${label} '${value}' in '${existing}' and '${workflowId}'`);
  }
  seen.set(value, workflowId);
}

function assertCommandPatternInputs(
  workflow: WorkflowComponent,
  pattern: string,
  commandName: string,
): void {
  const inputIds = new Set(Object.keys(workflow.inputs ?? {}));
  for (const inputId of commandPatternInputIds(pattern)) {
    if (!inputIds.has(inputId)) {
      throw new Error(
        `Workflow '${workflow.id}' command '${commandName}' pattern references missing input '${inputId}'`,
      );
    }
  }
}

function isAgentComponent(component: PiprComponent): component is AgentComponent {
  return component.kind === "Agent";
}

type StepContainerComponent = WorkflowComponent | BlockComponent;

function isStepContainerComponent(component: PiprComponent): component is StepContainerComponent {
  return component.kind === "Workflow" || component.kind === "Block";
}

function isSchemaComponent(component: PiprComponent): component is SchemaComponent {
  return component.kind === "Schema";
}

function isInlineWorkflow(value: string | WorkflowComponent): value is WorkflowComponent {
  return typeof value !== "string";
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
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
  return key === "apiKeyEnv";
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
