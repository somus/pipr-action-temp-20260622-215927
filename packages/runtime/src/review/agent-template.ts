import { type JSONType, z } from "zod";
import type { AgentComponent } from "../config/schema.js";
import { requireRecord } from "../shared/record.js";
import {
  renderWorkflowTemplateString,
  resolveWorkflowValue,
  validateWorkflowExpressions,
  type WorkflowExpressionRoots,
} from "../workflow/expression.js";

type AgentInputDefinitions = NonNullable<AgentComponent["inputs"]>;

export function bindAgentInputs(
  agent: Pick<AgentComponent, "id" | "inputs">,
  rawInputs: unknown,
): Record<string, JSONType> {
  const definitions = agent.inputs ?? {};
  const inputRecord =
    rawInputs === undefined ? {} : requireRecord(rawInputs, `Agent '${agent.id}' inputs`);
  const bound: Record<string, JSONType> = {};
  const definitionKeys = new Set(Object.keys(definitions));

  for (const key of Object.keys(inputRecord)) {
    if (!definitionKeys.has(key)) {
      throw new Error(`Agent '${agent.id}' input '${key}' is not declared`);
    }
  }

  for (const [key, definition] of Object.entries(definitions)) {
    const hasValue = Object.hasOwn(inputRecord, key);
    const value = hasValue ? inputRecord[key] : definition.default;
    if (value === undefined) {
      if (definition.required) {
        throw new Error(`Agent '${agent.id}' input '${key}' is required`);
      }
      continue;
    }
    bound[key] = validateAgentInputValue(agent.id, key, definition, value);
  }

  return bound;
}

export function resolveAgentProviderTemplate(
  provider: unknown,
  inputs: Record<string, JSONType>,
): unknown {
  validateWorkflowExpressions(provider, { allowedRoots: ["inputs"] });
  return resolveWorkflowValue(provider, expressionRoots(inputs));
}

export function renderAgentBodyTemplate(
  agentId: string,
  body: string | undefined,
  inputs: Record<string, JSONType>,
): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  return renderWorkflowTemplateString(body, expressionRoots(inputs), {
    renderValue: renderTemplateValue,
    invalidMessage: `Agent '${agentId}' body has invalid embedded expression`,
    allowedRoots: ["inputs"],
  });
}

function validateAgentInputValue(
  agentId: string,
  key: string,
  definition: AgentInputDefinitions[string],
  value: unknown,
): JSONType {
  if (definition.type === "string") {
    if (typeof value !== "string") {
      throw new Error(`Agent '${agentId}' input '${key}' must be string`);
    }
    if (definition.enum && !definition.enum.includes(value)) {
      throw new Error(
        `Agent '${agentId}' input '${key}' must be one of ${definition.enum.join(", ")}`,
      );
    }
    return value;
  }
  const parsed = z.json().safeParse(value);
  if (!parsed.success) {
    throw new Error(`Agent '${agentId}' input '${key}' must be JSON value`);
  }
  return parsed.data;
}

function renderTemplateValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const parsed = z.json().safeParse(value);
  if (!parsed.success) {
    throw new Error("Agent template expression must resolve to a JSON value");
  }
  return JSON.stringify(parsed.data, null, 2);
}

function expressionRoots(inputs: Record<string, JSONType>): WorkflowExpressionRoots {
  return {
    inputs,
    steps: {},
    context: {},
    config: {},
    event: {},
  };
}
