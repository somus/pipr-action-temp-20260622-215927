import { isRecord } from "../shared/record.js";
import type {
  BlockRegistryEntry,
  FailurePolicy,
  PullRequestEventContext,
  RuntimeRegistry,
  WorkflowRegistryEntry,
  WorkflowStep,
} from "../types.js";
import { resolveWorkflowValue, type WorkflowExpressionRoots } from "./expression.js";

export { resolveWorkflowValue } from "./expression.js";

export type WorkflowContext = Record<string, unknown>;

export type WorkflowFailure = {
  stepId: string;
  block: string;
  policy: Exclude<FailurePolicy, "fail">;
  message: string;
};

export type WorkflowState = WorkflowExpressionRoots & {
  failures: WorkflowFailure[];
};

export type WorkflowBlockHandler = {
  validate?: (input: unknown, context: WorkflowContext) => void;
  run: (input: unknown, context: WorkflowContext) => unknown | Promise<unknown>;
};

export type WorkflowBlockHandlers = Record<
  string,
  WorkflowBlockHandler | WorkflowBlockHandler["run"]
>;

export type ExecuteWorkflowOptions = {
  registry: RuntimeRegistry;
  workflowId?: string;
  event: Pick<PullRequestEventContext, "eventName" | "action">;
  context?: WorkflowContext;
  inputs?: unknown;
  config?: unknown;
  blocks: WorkflowBlockHandlers;
};

export type ExecuteWorkflowResult = {
  workflow: WorkflowRegistryEntry;
  context: WorkflowContext;
  state: WorkflowState;
  failures: WorkflowFailure[];
};

type ExecuteStepOptions = {
  registry: RuntimeRegistry;
  state: WorkflowState;
  blocks: WorkflowBlockHandlers;
  failurePolicy: FailurePolicy;
};

export function selectWorkflowForEvent(
  registry: RuntimeRegistry,
  event: Pick<PullRequestEventContext, "eventName" | "action">,
): WorkflowRegistryEntry | undefined {
  const eventNames = new Set(workflowEventCandidates(event));
  return registry.workflows.find((workflow) =>
    workflow.events.some((workflowEvent) => eventNames.has(workflowEvent)),
  );
}

export async function executeWorkflow(
  options: ExecuteWorkflowOptions,
): Promise<ExecuteWorkflowResult> {
  const workflow = resolveWorkflow(options);
  const state: WorkflowState = {
    inputs: options.inputs ?? {},
    steps: {},
    context: { ...(options.context ?? {}), workflowId: workflow.id },
    config: options.config ?? {},
    event: options.event,
    failures: [],
  };
  await executeSteps(workflow.steps, {
    registry: options.registry,
    state,
    blocks: options.blocks,
    failurePolicy: workflow.failurePolicy ?? "fail",
  });
  return { workflow, context: state.context, state, failures: state.failures };
}

async function executeSteps(steps: WorkflowStep[], options: ExecuteStepOptions): Promise<void> {
  for (const step of steps) {
    await executeStep(step, options);
  }
}

async function executeStep(
  step: WorkflowStep,
  options: ExecuteStepOptions,
): Promise<Record<string, unknown> | undefined> {
  let block: BlockRegistryEntry | undefined;
  try {
    block = findBlock(options.registry, step.block);
    const outputs = freezeWorkflowValue(await executeResolvedStep(step, block, options));
    options.state.steps[step.id] = { outputs };
    return outputs;
  } catch (error) {
    return handleStepFailure(step, block, options, error);
  }
}

async function executeResolvedStep(
  step: WorkflowStep,
  block: BlockRegistryEntry,
  options: ExecuteStepOptions,
): Promise<Record<string, unknown>> {
  const input = resolveWorkflowValue(step.with ?? {}, options.state);
  return isDeclarativeBlock(block)
    ? await executeDeclarativeBlock(input, block, options)
    : await executeHandlerBlock(input, block, options);
}

function handleStepFailure(
  step: WorkflowStep,
  block: BlockRegistryEntry | undefined,
  options: ExecuteStepOptions,
  error: unknown,
): undefined {
  const policy = step.failurePolicy ?? block?.failurePolicy ?? options.failurePolicy;
  if (policy === "fail") {
    throw error;
  }
  options.state.failures.push({
    stepId: step.id,
    block: step.block,
    policy,
    message: error instanceof Error ? error.message : String(error),
  });
  return undefined;
}

function isDeclarativeBlock(block: BlockRegistryEntry): boolean {
  return Boolean(block.steps?.length);
}

async function executeDeclarativeBlock(
  input: unknown,
  block: BlockRegistryEntry,
  options: ExecuteStepOptions,
): Promise<Record<string, unknown>> {
  validateSchemaMap(input, block.inputs, `${block.id} input`);
  const localState: WorkflowState = {
    inputs: input,
    steps: {},
    context: options.state.context,
    config: options.state.config,
    event: options.state.event,
    failures: options.state.failures,
  };
  await executeSteps(block.steps ?? [], {
    registry: options.registry,
    state: localState,
    blocks: options.blocks,
    failurePolicy: block.failurePolicy ?? options.failurePolicy,
  });
  const outputs = resolveBlockOutputs(block, localState);
  validateSchemaMap(outputs, block.outputs, `${block.id} output`);
  return outputs;
}

async function executeHandlerBlock(
  input: unknown,
  block: BlockRegistryEntry,
  options: ExecuteStepOptions,
): Promise<Record<string, unknown>> {
  validateSchemaMap(input, block.inputs, `${block.id} input`);
  const handler = hasOwn(options.blocks, block.id) ? options.blocks[block.id] : undefined;
  if (!handler) {
    throw new Error(`No handler registered for block '${block.id}'`);
  }

  const normalized = normalizeHandler(handler);
  normalized.validate?.(input, options.state.context);
  const result = await normalized.run(input, options.state.context);
  const outputs = { result };
  validateSchemaMap(outputs, block.outputs, `${block.id} output`);
  return outputs;
}

function resolveBlockOutputs(
  block: BlockRegistryEntry,
  state: WorkflowState,
): Record<string, unknown> {
  if (block.output) {
    const value = resolveWorkflowValue(block.output, state);
    return requireRecord(value, `${block.id} output`);
  }

  const lastStep = (block.steps ?? []).at(-1);
  if (!lastStep) {
    return { result: undefined };
  }
  const lastOutputs = state.steps[lastStep.id]?.outputs;
  if (!lastOutputs) {
    return { result: undefined };
  }
  return { result: lastOutputs.result };
}

function validateSchemaMap(
  value: unknown,
  schemaMap: Record<string, unknown> | undefined,
  label: string,
): void {
  if (!schemaMap) {
    return;
  }
  const record = requireRecord(value, label);
  const expectedKeys = new Set(Object.keys(schemaMap));
  for (const key of expectedKeys) {
    if (!hasOwn(record, key)) {
      throw new Error(`${label}.${key} is required`);
    }
    validateJsonSchemaValue(record[key], schemaMap[key], `${label}.${key}`);
  }
  for (const key of Object.keys(record)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`${label}.${key} is not allowed`);
    }
  }
}

function validateJsonSchemaValue(value: unknown, schema: unknown, label: string): void {
  if (!isRecord(schema)) {
    return;
  }
  if (typeof schema.type !== "string") {
    return;
  }
  const validator = jsonTypeValidators[schema.type];
  if (validator && !validator(value)) {
    throw new Error(`${label} must be ${schema.type}`);
  }
}

const jsonTypeValidators: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  object: isRecord,
  array: Array.isArray,
  boolean: (value) => typeof value === "boolean",
  number: (value) => typeof value === "number",
  integer: (value) => typeof value === "number" && Number.isInteger(value),
  null: (value) => value === null,
};

function normalizeHandler(handler: WorkflowBlockHandlers[string]): WorkflowBlockHandler {
  if (typeof handler === "function") {
    return { run: handler };
  }
  return handler;
}

function resolveWorkflow(options: ExecuteWorkflowOptions): WorkflowRegistryEntry {
  if (options.workflowId) {
    const workflow = options.registry.workflows.find((entry) => entry.id === options.workflowId);
    if (!workflow) {
      throw new Error(`Unknown workflow '${options.workflowId}'`);
    }
    return workflow;
  }

  const selected = selectWorkflowForEvent(options.registry, options.event);
  if (!selected) {
    throw new Error(`No workflow registered for event '${formatWorkflowEvent(options.event)}'`);
  }
  return selected;
}

function findBlock(registry: RuntimeRegistry, blockId: string): BlockRegistryEntry {
  const block = registry.blocks.find((entry) => entry.id === blockId);
  if (!block) {
    throw new Error(`Unknown workflow block '${blockId}'`);
  }
  return block;
}

function formatWorkflowEvent(event: Pick<PullRequestEventContext, "eventName" | "action">): string {
  return event.action ? `${event.eventName}.${event.action}` : event.eventName;
}

function workflowEventCandidates(
  event: Pick<PullRequestEventContext, "eventName" | "action">,
): string[] {
  if (event.action) {
    return [`${event.eventName}.${event.action}`, event.eventName];
  }

  if (event.eventName === "pull_request") {
    return [
      "pull_request",
      "pull_request.opened",
      "pull_request.synchronize",
      "pull_request.reopened",
    ];
  }

  return [event.eventName];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function freezeWorkflowValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (!isFreezable(value)) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    freezeWorkflowValue(child, seen);
  }
  return Object.freeze(value);
}

function isFreezable(value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || isRecord(value);
}
