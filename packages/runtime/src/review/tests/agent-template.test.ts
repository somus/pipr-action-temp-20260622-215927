import { describe, expect, it } from "vitest";
import {
  bindAgentInputs,
  renderAgentBodyTemplate,
  resolveAgentProviderTemplate,
} from "../agent-template.js";

describe("Agent template rendering", () => {
  it("binds string inputs and renders them into body prompts", () => {
    const inputs = bindAgentInputs(
      {
        id: "pipr/reviewer",
        inputs: { focus: { type: "string", required: true } },
      },
      { focus: "security" },
    );

    expect(
      renderAgentBodyTemplate("pipr/reviewer", ["Focus: ", expr("inputs.focus")].join(""), inputs),
    ).toBe("Focus: security");
  });

  it("renders object inputs as stable pretty JSON", () => {
    const inputs = bindAgentInputs(
      {
        id: "pipr/orchestrator",
        inputs: { reviews: { type: "json", required: true } },
      },
      { reviews: { correctness: { summary: { body: "ok" }, inlineFindings: [] } } },
    );

    expect(renderAgentBodyTemplate("pipr/orchestrator", expr("inputs.reviews"), inputs)).toBe(
      JSON.stringify(inputs.reviews, null, 2),
    );
  });

  it("does not treat template markers inside input values as Agent expressions", () => {
    const literalExpressionText = ["Keep ", expr("github.sha"), " and }} as data."].join("");
    const inputs = bindAgentInputs(
      {
        id: "pipr/reviewer",
        inputs: { payload: { type: "json", required: true } },
      },
      { payload: { expressionText: literalExpressionText } },
    );

    expect(renderAgentBodyTemplate("pipr/reviewer", expr("inputs.payload"), inputs)).toContain(
      ['"expressionText": "', literalExpressionText, '"'].join(""),
    );
  });

  it("applies defaults and string enums", () => {
    const inputs = bindAgentInputs(
      {
        id: "pipr/reviewer",
        inputs: {
          focus: {
            type: "string",
            default: "correctness",
            enum: ["correctness", "security"],
          },
        },
      },
      {},
    );

    expect(inputs.focus).toBe("correctness");
  });

  it("rejects missing, undeclared, and non-json inputs", () => {
    expect(() =>
      bindAgentInputs(
        { id: "pipr/reviewer", inputs: { focus: { type: "string", required: true } } },
        {},
      ),
    ).toThrow("input 'focus' is required");
    expect(() => bindAgentInputs({ id: "pipr/reviewer", inputs: {} }, { extra: "value" })).toThrow(
      "input 'extra' is not declared",
    );
    expect(() =>
      bindAgentInputs(
        { id: "pipr/reviewer", inputs: { payload: { type: "json", required: true } } },
        { payload: () => "not json" },
      ),
    ).toThrow("must be JSON value");
  });

  it("rejects unsafe and function-call template expressions", () => {
    const inputs = bindAgentInputs({ id: "pipr/reviewer", inputs: {} }, {});

    expect(() =>
      renderAgentBodyTemplate("pipr/reviewer", expr("inputs.__proto__.value"), inputs),
    ).toThrow("Unsafe workflow path segment '__proto__'");
    expect(() =>
      renderAgentBodyTemplate("pipr/reviewer", expr("inputs.loadSecret()"), inputs),
    ).toThrow("Unsupported workflow expression token '('");
    expect(() =>
      renderAgentBodyTemplate("pipr/reviewer", expr("steps.review.outputs.result"), inputs),
    ).toThrow("Unknown workflow expression root 'steps'");
  });

  it("resolves provider templates from Agent inputs", () => {
    const inputs = bindAgentInputs(
      {
        id: "pipr/reviewer",
        inputs: { provider: { type: "string", default: "deepseek" } },
      },
      {},
    );

    expect(resolveAgentProviderTemplate(expr("inputs.provider"), inputs)).toBe("deepseek");
  });
});

function expr(source: string): string {
  return ["$", "{{ ", source, " }}"].join("");
}
