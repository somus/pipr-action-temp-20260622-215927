import { describe, expect, it } from "vitest";
import { createRuntimeRegistry } from "../src/registry.js";
import type { RuntimeRegistry } from "../src/types.js";
import {
  executeWorkflow,
  resolveWorkflowValue,
  selectWorkflowForEvent,
  setWorkflowValue,
} from "../src/workflow.js";

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

  it("rejects unsafe workflow paths and inherited refs", () => {
    const context = {};
    const inherited = Object.create({ polluted: "yes" });

    expect(() => setWorkflowValue(context, "__proto__.polluted", "yes")).toThrow(
      "Unsafe workflow path segment '__proto__'",
    );
    expect(() => resolveWorkflowValue({ from: "constructor.prototype" }, context)).toThrow(
      "Unsafe workflow path segment 'constructor'",
    );
    expect(() => resolveWorkflowValue({ from: "polluted" }, inherited)).toThrow(
      "Unknown workflow ref 'polluted'",
    );
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});

describe("workflow runner", () => {
  it("selects the built-in review workflow for pull_request events", () => {
    const workflow = selectWorkflowForEvent(createRuntimeRegistry(), {
      eventName: "pull_request",
      action: "opened",
    });

    expect(workflow?.id).toBe("review");
  });

  it("runs the built-in review workflow composition", async () => {
    const calls: string[] = [];
    const diffManifest = { files: [] };
    const review = { summary: { body: "ok" }, inlineFindings: [] };
    const validated = { review, validFindings: [], droppedFindings: [] };

    const result = await executeWorkflow({
      registry: createRuntimeRegistry(),
      event: { eventName: "pull_request", action: "opened" },
      blocks: {
        "context.diff_manifest": () => {
          calls.push("diff");
          return diffManifest;
        },
        "agent.run": {
          validate: (input) => {
            expect(input).toEqual({ input: diffManifest });
          },
          run: () => {
            calls.push("agent");
            return review;
          },
        },
        "validate.pr_review": {
          validate: (input) => {
            expect(input).toEqual({ review, manifest: diffManifest });
          },
          run: () => {
            calls.push("validate");
            return validated;
          },
        },
        "publish.main_comment": {
          validate: (input) => {
            expect(input).toEqual({ review: validated });
          },
          run: () => {
            calls.push("main");
            return "main-comment";
          },
        },
        "publish.inline_comments": {
          validate: (input) => {
            expect(input).toEqual({ review: validated });
          },
          run: () => {
            calls.push("inline");
            return [];
          },
        },
      },
    });

    expect(calls).toEqual(["diff", "agent", "validate", "main", "inline"]);
    expect(result.context.validated_review).toBe(validated);
    expect(result.context.main_comment).toBe("main-comment");
    expect(result.context.inline_comments).toEqual([]);
  });

  it("runs declarative blocks and resolves explicit from refs", async () => {
    const calls: string[] = [];
    const result = await executeWorkflow({
      registry: testRegistry(),
      workflowId: "review",
      event: { eventName: "pull_request", action: "opened" },
      context: { seed: "input" },
      blocks: {
        "source.block": {
          run: (input) => {
            calls.push(`source:${String(input)}`);
            return "source-output";
          },
        },
        "consumer.block": {
          validate: (input) => {
            if (typeof input !== "string") {
              throw new Error("consumer.block expected string input");
            }
          },
          run: (input) => {
            calls.push(`consumer:${input}`);
            return `${input}:done`;
          },
        },
      },
    });

    expect(calls).toEqual(["source:input", "consumer:source-output"]);
    expect(result.context.final).toBe("source-output:done");
  });

  it("fails unknown refs and invalid inputs before running a block", async () => {
    const calls: string[] = [];

    await expect(
      executeWorkflow({
        registry: testRegistry({ badRef: true }),
        workflowId: "review",
        event: { eventName: "pull_request", action: "opened" },
        context: {},
        blocks: {
          "source.block": {
            run: () => {
              calls.push("source");
              return "source-output";
            },
          },
          "consumer.block": {
            run: () => {
              calls.push("consumer");
            },
          },
        },
      }),
    ).rejects.toThrow("Unknown workflow ref 'missing.value'");
    expect(calls).toEqual([]);
  });

  it("validates block inputs before run", async () => {
    const calls: string[] = [];

    await expect(
      executeWorkflow({
        registry: testRegistry(),
        workflowId: "review",
        event: { eventName: "pull_request", action: "opened" },
        context: { seed: 123 },
        blocks: {
          "source.block": {
            run: (input) => input,
          },
          "consumer.block": {
            validate: () => {
              throw new Error("consumer.block expected string input");
            },
            run: () => {
              calls.push("consumer");
            },
          },
        },
      }),
    ).rejects.toThrow("consumer.block expected string input");
    expect(calls).toEqual([]);
  });

  it("does not resolve handlers from Object prototype", async () => {
    await expect(
      executeWorkflow({
        registry: {
          ...testRegistry(),
          workflows: [
            {
              id: "review",
              description: "Prototype handler workflow",
              source: "test",
              events: ["pull_request.opened"],
              steps: [{ block: "toString", output: "result" }],
            },
          ],
          blocks: [{ id: "toString", description: "Prototype block", source: "test" }],
        },
        workflowId: "review",
        event: { eventName: "pull_request", action: "opened" },
        blocks: {},
      }),
    ).rejects.toThrow("No handler registered for block 'toString'");
  });
});

function testRegistry(options: { badRef?: boolean } = {}): RuntimeRegistry {
  return {
    presets: [{ id: "builtin:minimal", description: "Test preset", source: "test" }],
    workflows: [
      {
        id: "review",
        description: "Test workflow",
        source: "test",
        events: ["pull_request.opened"],
        steps: [
          {
            block: "composed.block",
            with: { from: options.badRef ? "missing.value" : "seed" },
            output: "final",
          },
        ],
      },
    ],
    blocks: [
      {
        id: "composed.block",
        description: "Composed block",
        source: "test",
        steps: [
          { block: "source.block", with: { from: "input" }, output: "source" },
          { block: "consumer.block", with: { from: "source" }, output: "result" },
        ],
      },
      { id: "source.block", description: "Source", source: "test" },
      { id: "consumer.block", description: "Consumer", source: "test" },
    ],
    agents: [],
    schemas: [],
    comments: [],
    tools: [],
  };
}
