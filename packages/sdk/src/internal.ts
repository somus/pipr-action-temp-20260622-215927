import type { AgentTool, PromptText, PromptValue } from "./index.js";

export type { RuntimePlan } from "./runtime-contract.js";

import type { RuntimePlan } from "./runtime-contract.js";

/** Stable identifier for pipr's built-in pull request review output schema. */
export const reviewOutputSchemaId = "core/pr-review";

const configFactoryBrand = Symbol.for("pipr.config.factory");
const builtinReadOnlyToolBrand = Symbol.for("pipr.builtin.readOnlyTool");

type ConfigFactoryValue = {
  readonly kind: "pipr.config-factory";
};

type InternalPiprConfigFactory = ConfigFactoryValue & {
  readonly [configFactoryBrand]: true;
  build(): RuntimePlan;
};

/** Returns whether a tool is one of pipr's built-in read-only tools. */
export function isBuiltinReadOnlyTool(tool: AgentTool): boolean {
  return Reflect.get(tool, builtinReadOnlyToolBrand) === true;
}

/** Checks that an unknown value is a pipr configuration factory. */
export function isPiprConfigFactory(value: unknown): value is ConfigFactoryValue {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "pipr.config-factory" &&
    Reflect.get(value, configFactoryBrand) === true
  );
}

/** Builds a runtime plan from a pipr configuration factory. */
export function buildPiprPlan(factory: unknown): RuntimePlan {
  if (!isInternalPiprConfigFactory(factory)) {
    throw new Error("Expected a pipr configuration factory");
  }
  return factory.build();
}

function isInternalPiprConfigFactory(value: unknown): value is InternalPiprConfigFactory {
  return isPiprConfigFactory(value) && typeof Reflect.get(value, "build") === "function";
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
