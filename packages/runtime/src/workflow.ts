export type WorkflowContext = Record<string, unknown>;

export type RefValue = {
  from: string;
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
  const parts = path.split(".");
  let cursor: WorkflowContext = context;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as WorkflowContext;
  }
  cursor[parts.at(-1) ?? path] = value;
}

function getPath(context: WorkflowContext, path: string): unknown {
  let cursor: unknown = context;
  for (const part of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null || !(part in cursor)) {
      throw new Error(`Unknown workflow ref '${path}'`);
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}
