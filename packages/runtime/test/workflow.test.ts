import { describe, expect, it } from "vitest";
import { resolveWorkflowValue, setWorkflowValue } from "../src/workflow.js";

describe("workflow refs", () => {
  it("resolves explicit from refs without treating literal strings as refs", () => {
    const context = {
      review_result: {
        inlineFindings: [{ title: "finding" }],
      },
    };

    const resolved = resolveWorkflowValue(
      {
        findings: { from: "review_result.inlineFindings" },
        literal: "review_result.inlineFindings",
      },
      context,
    );

    expect(resolved).toEqual({
      findings: [{ title: "finding" }],
      literal: "review_result.inlineFindings",
    });
  });

  it("sets nested output values", () => {
    const context = {};

    setWorkflowValue(context, "review_result.summary.body", "ok");

    expect(context).toEqual({ review_result: { summary: { body: "ok" } } });
  });
});
