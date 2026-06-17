import type {
  BlockRegistryEntry,
  PullRequestEventContext,
  RuntimeRegistry,
  WorkflowRegistryEntry,
  WorkflowStep,
} from "./types.js";

export type WorkflowContext = Record<string, unknown>;

export type RefValue = {
  from: string;
};

const unsafePathSegments = new Set(["__proto__", "prototype", "constructor"]);

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
  blocks: WorkflowBlockHandlers;
};

export type ExecuteWorkflowResult = {
  workflow: WorkflowRegistryEntry;
  context: WorkflowContext;
};

export function isRefValue(value: unknown): value is RefValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "from" in value &&
    typeof (value as { from: unknown }).from === "string" &&
    Object.keys(value).length === 1
  );
}

export function resolveWorkflowValue(value: unknown, context: WorkflowContext): unknown {
  if (isRefValue(value)) {
    return getPath(context, value.from);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveWorkflowValue(item, context));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveWorkflowValue(item, context)]),
    );
  }

  return value;
}

export function setWorkflowValue(context: WorkflowContext, path: string, value: unknown): void {
  const parts = validateWorkflowPath(path);
  let cursor: WorkflowContext = context;
  for (const part of parts.slice(0, -1)) {
    const next = hasOwn(cursor, part) ? cursor[part] : undefined;
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as WorkflowContext;
  }
  cursor[parts.at(-1) ?? path] = value;
}

export function validateWorkflowPath(path: string): string[] {
  const parts = path.split(".");
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid workflow path '${path}'`);
  }

  const unsafe = parts.find((part) => unsafePathSegments.has(part));
  if (unsafe) {
    throw new Error(`Unsafe workflow path segment '${unsafe}' in '${path}'`);
  }

  return parts;
}

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
  const context = { ...(options.context ?? {}) };
  for (const step of workflow.steps) {
    await executeStep(step, {
      registry: options.registry,
      context,
      blocks: options.blocks,
    });
  }
  return { workflow, context };
}

async function executeStep(
  step: WorkflowStep,
  options: {
    registry: RuntimeRegistry;
    context: WorkflowContext;
    blocks: WorkflowBlockHandlers;
  },
): Promise<unknown> {
  const block = findBlock(options.registry, step.block);
  const input = resolveWorkflowValue(step.with ?? {}, options.context);
  const output =
    block.steps && block.steps.length > 0
      ? await executeDeclarativeBlock(input, block, options)
      : await executeHandlerBlock(input, block, options);

  if (step.output) {
    setWorkflowValue(options.context, step.output, output);
  }
  return output;
}

async function executeDeclarativeBlock(
  input: unknown,
  block: BlockRegistryEntry,
  options: {
    registry: RuntimeRegistry;
    context: WorkflowContext;
    blocks: WorkflowBlockHandlers;
  },
): Promise<unknown> {
  const localContext = { ...options.context, input };
  let output: unknown;
  for (const step of block.steps ?? []) {
    output = await executeStep(step, {
      registry: options.registry,
      context: localContext,
      blocks: options.blocks,
    });
  }
  return output;
}

async function executeHandlerBlock(
  input: unknown,
  block: BlockRegistryEntry,
  options: { context: WorkflowContext; blocks: WorkflowBlockHandlers },
): Promise<unknown> {
  const handler = hasOwn(options.blocks, block.id) ? options.blocks[block.id] : undefined;
  if (!handler) {
    throw new Error(`No handler registered for block '${block.id}'`);
  }

  const normalized = normalizeHandler(handler);
  normalized.validate?.(input, options.context);
  return await normalized.run(input, options.context);
}

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

function getPath(context: WorkflowContext, path: string): unknown {
  const parts = validateWorkflowPath(path);
  let cursor: unknown = context;
  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || !hasOwn(cursor, part)) {
      throw new Error(`Unknown workflow ref '${path}'`);
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
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

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}
