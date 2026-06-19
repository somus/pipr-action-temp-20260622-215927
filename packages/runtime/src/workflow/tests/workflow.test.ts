import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initOfficialMinimalProject } from "../../config/init.js";
import { loadRuntimeProject } from "../../config/project.js";
import type { RuntimeRegistry } from "../../types.js";
import { collectWorkflowStepDependencies, renderWorkflowTemplateString } from "../expression.js";
import { executeWorkflow, resolveWorkflowValue, selectWorkflowForEvent } from "../workflow.js";

describe("workflow expressions", () => {
  it("resolves whole expressions without treating literal strings as refs", () => {
    const roots = {
      inputs: {
        agent: "pipr/reviewer",
      },
      steps: {
        review: {
          outputs: {
            result: {
              inlineFindings: [{ title: "finding" }],
            },
          },
        },
      },
      context: { enabled: true },
      config: { maxInlineComments: 5 },
      event: { action: "opened" },
    };

    const resolved = resolveWorkflowValue(
      {
        agent: expr("inputs.agent"),
        findings: expr("steps.review.outputs.result.inlineFindings"),
        literal: "steps.review.outputs.result.inlineFindings",
        condition: expr("context.enabled && event.action == 'opened'"),
      },
      roots,
    );

    expect(resolved).toEqual({
      agent: "pipr/reviewer",
      findings: [{ title: "finding" }],
      literal: "steps.review.outputs.result.inlineFindings",
      condition: true,
    });
  });

  it("rejects embedded expressions, unsafe paths, inherited refs, and calls", () => {
    const roots = { inputs: {}, steps: {}, context: {}, config: {}, event: {} };
    const inherited = Object.create({ polluted: "yes" }) as Record<string, unknown>;

    expect(() => resolveWorkflowValue(`hello ${expr("inputs.name")}`, roots)).toThrow(
      "Embedded workflow expressions are not supported",
    );
    expect(() => resolveWorkflowValue(expr("steps.__proto__.outputs.result"), roots)).toThrow(
      "Unsafe workflow path segment '__proto__'",
    );
    expect(() =>
      resolveWorkflowValue(expr("context.loadSecret()"), {
        ...roots,
        context: { loadSecret: () => "secret" },
      }),
    ).toThrow("Unsupported workflow expression token '('");
    expect(() =>
      resolveWorkflowValue(expr("context.polluted"), { ...roots, context: inherited }),
    ).toThrow("Unknown workflow ref 'context.polluted'");
  });

  it("supports array indexing and boolean operators", () => {
    const roots = {
      inputs: { files: [{ path: "a.ts" }, { path: "b.ts" }] },
      steps: {},
      context: {},
      config: {},
      event: {},
    };

    expect(resolveWorkflowValue(expr("inputs.files[1].path == 'b.ts' && !false"), roots)).toBe(
      true,
    );
    expect(resolveWorkflowValue(expr("inputs.files[0].path != 'b.ts' || false"), roots)).toBe(true);
  });

  it("renders embedded template expressions with caller-owned value formatting", () => {
    const literalExpressionText = ["Keep ", expr("github.sha"), " and }} as data."].join("");
    const roots = {
      inputs: {
        name: "review",
        payload: { ok: true },
        literal: literalExpressionText,
      },
      steps: {},
      context: {},
      config: {},
      event: {},
    };

    const rendered = renderWorkflowTemplateString(
      [
        "Run ",
        expr("inputs.name"),
        "\nPayload: ",
        expr("inputs.payload"),
        "\nLiteral: ",
        expr("inputs.literal"),
      ].join(""),
      roots,
      {
        renderValue: (value) =>
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
        invalidMessage: "invalid template",
      },
    );

    expect(rendered).toBe(
      ['Run review\nPayload: {\n  "ok": true\n}\nLiteral: ', literalExpressionText].join(""),
    );
  });

  it("rejects malformed template markers in template source", () => {
    const roots = { inputs: { name: "review" }, steps: {}, context: {}, config: {}, event: {} };

    expect(() =>
      renderWorkflowTemplateString("Run ${{ inputs.name", roots, {
        renderValue: String,
        invalidMessage: "invalid template",
      }),
    ).toThrow("invalid template");
  });

  it("collects step dependencies from expression trees", () => {
    expect([
      ...collectWorkflowStepDependencies({ value: expr("steps.review.outputs.result") }),
    ]).toEqual(["review"]);
    expect([...collectWorkflowStepDependencies(expr('steps["review"].outputs.result'))]).toEqual([
      "review",
    ]);
    expect([
      ...collectWorkflowStepDependencies(expr('steps["first.agent"].outputs.result')),
    ]).toEqual(["first.agent"]);
    expect([...collectWorkflowStepDependencies(expr("inputs.value == 'steps.fake'"))]).toEqual([]);
    expect(collectWorkflowStepDependencies("steps.review.outputs.result")).toEqual(new Set());
  });

  it("short-circuits boolean operators while still validating skipped expression syntax", () => {
    const roots = {
      inputs: { enabled: false, ready: true },
      steps: {},
      context: {},
      config: {},
      event: {},
    };

    expect(resolveWorkflowValue(expr("inputs.enabled && inputs.missing.value"), roots)).toBe(false);
    expect(resolveWorkflowValue(expr("inputs.ready || inputs.missing.value"), roots)).toBe(true);
    expect(() =>
      resolveWorkflowValue(expr("inputs.enabled && inputs.__proto__.value"), roots),
    ).toThrow("Unsafe workflow path segment '__proto__'");
  });
});

describe("workflow runner", () => {
  it("selects the materialized Review Workflow for pull_request events", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const workflow = selectWorkflowForEvent(runtime.registry, {
      eventName: "pull_request",
      action: "opened",
    });

    expect(workflow?.id).toBe("pipr/review");
  });

  it("runs the materialized Review Workflow composition", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const calls: string[] = [];
    const validated = {
      review: { summary: { body: "ok" }, inlineFindings: [] },
      validFindings: [],
      droppedFindings: [],
    };

    const result = await executeWorkflow({
      registry: runtime.registry,
      event: { eventName: "pull_request", action: "opened" },
      config: runtime.resolved.config,
      blocks: {
        "core/run-agent": {
          validate: (input) => {
            expect(input).toEqual({ agent: "pipr/reviewer" });
          },
          run: () => {
            calls.push("agent");
            return validated;
          },
        },
        "core/main-comment": {
          validate: (input) => {
            expect(input).toEqual({ review: validated, template: "pipr/main" });
          },
          run: () => {
            calls.push("main");
            return "main-comment";
          },
        },
        "core/inline-comments": {
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

    expect(calls).toEqual(["agent", "main", "inline"]);
    expect(result.state.steps.review?.outputs.result).toBe(validated);
    expect(result.state.steps["main-comment"]?.outputs.result).toBe("main-comment");
    expect(result.state.steps["inline-comments"]?.outputs.result).toEqual([]);
  });

  it("runs independent parallel-dag steps in parallel before dependent steps", async () => {
    const blockId = "pipr/parallel-agent";
    const calls: string[] = [];
    const releases = new Map<string, () => void>();
    const started = new Promise<void>((resolve) => {
      const maybeResolve = () => {
        if (
          calls.includes("start:correctness") &&
          calls.includes("start:security") &&
          calls.includes("start:tests")
        ) {
          resolve();
        }
      };
      releases.set("maybeResolve", maybeResolve);
    });

    const workflow = executeWorkflow({
      registry: {
        ...testRegistry(),
        workflows: [
          {
            id: "review",
            description: "Parallel agent workflow",
            source: "test",
            events: ["pull_request.opened"],
            steps: [
              { id: "correctness", block: blockId },
              { id: "security", block: blockId },
              { id: "tests", block: blockId },
              {
                id: "review",
                block: blockId,
                with: {
                  reviews: {
                    correctness: expr("steps.correctness.outputs.result"),
                    security: expr("steps.security.outputs.result"),
                    tests: expr("steps.tests.outputs.result"),
                  },
                },
              },
            ],
          },
        ],
        blocks: [parallelAgentBlock(blockId)],
      },
      workflowId: "review",
      event: { eventName: "pull_request", action: "opened" },
      blocks: {
        [blockId]: async (_input, _context, meta) => {
          calls.push(`start:${meta.stepId}`);
          releases.get("maybeResolve")?.();
          if (meta.stepId !== "review") {
            await new Promise<void>((resolve) => {
              releases.set(meta.stepId, resolve);
            });
          }
          calls.push(`finish:${meta.stepId}`);
          return `${meta.stepId}-result`;
        },
      },
    });

    await started;
    expect(calls).toEqual(["start:correctness", "start:security", "start:tests"]);
    releases.get("security")?.();
    await Promise.resolve();
    expect(calls).not.toContain("start:review");
    releases.get("correctness")?.();
    releases.get("tests")?.();
    const result = await workflow;

    expect(result.state.steps.review?.outputs.result).toBe("review-result");
    expect(calls.at(-2)).toBe("start:review");
    expect(calls.at(-1)).toBe("finish:review");
  });

  it("supports bracket step dependencies with dotted step ids", async () => {
    const calls: string[] = [];
    const result = await executeWorkflow({
      registry: {
        ...testRegistry(),
        workflows: [
          {
            id: "review",
            description: "Dotted step id workflow",
            source: "test",
            events: ["pull_request.opened"],
            steps: [
              { id: "first.agent", block: "core/run-agent" },
              {
                id: "review",
                block: "core/run-agent",
                with: { previous: expr('steps["first.agent"].outputs.result') },
              },
            ],
          },
        ],
        blocks: [parallelAgentBlock("core/run-agent")],
      },
      workflowId: "review",
      event: { eventName: "pull_request", action: "opened" },
      blocks: {
        "core/run-agent": (input, _context, meta) => {
          calls.push(meta.stepId);
          return meta.stepId === "review" ? { input } : `${meta.stepId}-result`;
        },
      },
    });

    expect(calls).toEqual(["first.agent", "review"]);
    expect(result.state.steps.review?.outputs.result).toEqual({
      input: { previous: "first.agent-result" },
    });
  });

  it("does not stall dependent agent steps after a non-fatal agent failure", async () => {
    const calls: string[] = [];
    const result = await executeWorkflow({
      registry: {
        ...testRegistry(),
        workflows: [
          {
            id: "review",
            description: "Non-fatal dependency workflow",
            source: "test",
            events: ["pull_request.opened"],
            steps: [
              { id: "optional", block: "core/run-agent", failurePolicy: "continue" },
              {
                id: "dependent",
                block: "core/run-agent",
                failurePolicy: "continue",
                with: { previous: expr("steps.optional.outputs.result") },
              },
            ],
          },
        ],
        blocks: [parallelAgentBlock("core/run-agent")],
      },
      workflowId: "review",
      event: { eventName: "pull_request", action: "opened" },
      blocks: {
        "core/run-agent": (_input, _context, meta) => {
          calls.push(meta.stepId);
          if (meta.stepId === "optional") {
            throw new Error("planned failure");
          }
          return `${meta.stepId}-result`;
        },
      },
    });

    expect(calls).toEqual(["optional"]);
    expect(result.failures.map((failure) => failure.stepId)).toEqual(["optional", "dependent"]);
    expect(result.failures[1]?.message).toContain("Unknown workflow ref 'steps.optional'");
    expect(result.state.steps.optional).toBeUndefined();
    expect(result.state.steps.dependent).toBeUndefined();
  });

  it("runs declarative blocks and resolves expressions into immutable step outputs", async () => {
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
    expect(result.state.steps.review?.outputs.result).toBe("source-output:done");
    expect(Object.isFrozen(result.state.steps.review?.outputs)).toBe(true);
  });

  it("freezes previous step outputs before expression inputs expose them", async () => {
    const result = await executeWorkflow({
      registry: {
        ...testRegistry(),
        workflows: [
          {
            id: "review",
            description: "Immutable output workflow",
            source: "test",
            events: ["pull_request.opened"],
            steps: [
              { id: "source", block: "source.block" },
              {
                id: "consumer",
                block: "consumer.block",
                with: expr("steps.source.outputs.result"),
              },
            ],
          },
        ],
      },
      workflowId: "review",
      event: { eventName: "pull_request", action: "opened" },
      blocks: {
        "source.block": () => ({ nested: { count: 1 } }),
        "consumer.block": (input) => {
          const value = input as { nested: { count: number } };
          expect(Object.isFrozen(value)).toBe(true);
          expect(Object.isFrozen(value.nested)).toBe(true);
          return value.nested.count;
        },
      },
    });

    expect(result.state.steps.consumer?.outputs.result).toBe(1);
  });

  it("fails unknown expressions before running a block", async () => {
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
    ).rejects.toThrow("Unknown workflow ref 'context.missing'");
    expect(calls).toEqual([]);
  });

  it("validates block inputs and outputs around execution", async () => {
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
    ).rejects.toThrow("composed.block input.value must be string");
    expect(calls).toEqual([]);
  });

  it("records continue and skip-output failures without producing step output", async () => {
    const result = await executeWorkflow({
      registry: failureRegistry(),
      workflowId: "review",
      event: { eventName: "pull_request", action: "opened" },
      blocks: {
        "fail.block": () => {
          throw new Error("planned failure");
        },
        "ok.block": () => "ok",
      },
    });

    expect(result.failures.map((failure) => failure.stepId)).toEqual(["optional", "skipped"]);
    expect(result.state.steps.optional).toBeUndefined();
    expect(result.state.steps.skipped).toBeUndefined();
    expect(result.state.steps.final?.outputs.result).toBe("ok");
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
              steps: [{ id: "bad", block: "toString" }],
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

async function loadOfficialRuntimeProject() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-workflow-"));
  await initOfficialMinimalProject({ rootDir });
  return await loadRuntimeProject({ rootDir });
}

function testRegistry(options: { badRef?: boolean } = {}): RuntimeRegistry {
  return {
    presets: [{ id: "core/default", description: "Test preset", source: "test" }],
    workflows: [
      {
        id: "review",
        description: "Test workflow",
        source: "test",
        events: ["pull_request.opened"],
        steps: [
          {
            id: "review",
            block: "composed.block",
            with: options.badRef ? expr("context.missing.value") : { value: expr("context.seed") },
          },
        ],
      },
    ],
    blocks: [
      {
        id: "composed.block",
        description: "Composed block",
        source: "test",
        inputs: { value: { type: "string" } },
        outputs: { result: { type: "string" } },
        steps: [
          { id: "source", block: "source.block", with: expr("inputs.value") },
          { id: "consumer", block: "consumer.block", with: expr("steps.source.outputs.result") },
        ],
        output: { result: expr("steps.consumer.outputs.result") },
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

function failureRegistry(): RuntimeRegistry {
  return {
    presets: [{ id: "core/default", description: "Test preset", source: "test" }],
    workflows: [
      {
        id: "review",
        description: "Failure workflow",
        source: "test",
        events: ["pull_request.opened"],
        steps: [
          { id: "optional", block: "fail.block", failurePolicy: "continue" },
          { id: "skipped", block: "fail.block", failurePolicy: "skip-output" },
          { id: "final", block: "ok.block" },
        ],
      },
    ],
    blocks: [
      { id: "fail.block", description: "Fails", source: "test" },
      { id: "ok.block", description: "Succeeds", source: "test" },
    ],
    agents: [],
    schemas: [],
    comments: [],
    tools: [],
  };
}

function parallelAgentBlock(id: string) {
  return {
    id,
    description: "Agent",
    source: "test",
    execution: { mode: "parallel-dag" as const },
  };
}

function expr(source: string): string {
  return ["$", "{{ ", source, " }}"].join("");
}
