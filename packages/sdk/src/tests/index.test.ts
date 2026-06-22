import { describe, expect, it } from "vitest";
import type { ModelProfile, PiprBuilder, Reviewer } from "../index.js";
import { buildPiprPlan, definePipr, definePlugin, schemas } from "../index.js";

describe("definePipr", () => {
  it("registers models, agents, tasks, events, commands, locals, and tools", () => {
    const factory = definePipr((pipr) => {
      const model = pipr.model("deepseek/deepseek-v4-pro", {
        name: "deepseek",
        apiKey: pipr.secret("DEEPSEEK_API_KEY"),
      });
      const tool = pipr.tool({
        name: "custom_tool",
        description: "Custom tool.",
        input: pipr.schemas.summary,
        output: pipr.schemas.summary,
        async execute(_context, input) {
          return input;
        },
      });
      const agent = pipr.agent({
        name: "reviewer",
        model,
        instructions: "Review.",
        output: pipr.schemas.review,
        tools: [tool],
        prompt: () => "Prompt.",
      });
      const task = pipr.task("review", async (context) => {
        const manifest = await context.change.diffManifest();
        const result = await context.pi.run(agent, { manifest });
        context.output.summary(result.summary);
      });
      expect(pipr.on.changeRequest(["opened"], task)).toBeUndefined();
      expect(pipr.command("@pipr review", { permission: "write" }, task)).toBeUndefined();
      expect(pipr.local("review", task)).toBeUndefined();
    });

    const plan = buildPiprPlan(factory);

    expect(plan.models.map((model) => model.name)).toEqual(["deepseek"]);
    expect(plan.agents.map((agent) => agent.name)).toEqual(["reviewer"]);
    expect(plan.tasks.map((task) => task.name)).toEqual(["review"]);
    expect(plan.changeRequestTriggers[0]).toMatchObject({ actions: ["opened"] });
    expect(plan.commands[0]).toMatchObject({ pattern: "@pipr review", permission: "write" });
    expect(plan.locals[0]).toMatchObject({ name: "review" });
    expect(plan.tools[0]?.name).toBe("custom_tool");
  });

  it("rejects async config callbacks", () => {
    const factory = definePipr(async () => {});

    expect(() => buildPiprPlan(factory)).toThrow(
      "definePipr configuration callback must be synchronous",
    );
  });

  it("rejects duplicate task, command, and local names", () => {
    const factory = definePipr((pipr) => {
      const first = pipr.task("review", () => {});
      const second = pipr.task("review", () => {});
      pipr.command("@pipr review", {}, first);
      pipr.command("@pipr review", {}, second);
      pipr.local("review", first);
      pipr.local("review", second);
    });

    expect(() => buildPiprPlan(factory)).toThrow("Duplicate task 'review'");
  });

  it("rejects command patterns outside the pipr command grammar", () => {
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          const task = pipr.task("review", () => {});
          pipr.command("review", {}, task);
        }),
      ),
    ).toThrow("must start with @pipr");
  });

  it("rejects custom tools that collide with built-in read-only tools", () => {
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.tool({
            name: "readOnly",
            description: "collision",
            input: pipr.schemas.summary,
            output: pipr.schemas.summary,
            async execute(_context, input) {
              return input;
            },
          });
        }),
      ),
    ).toThrow("reserved");
  });

  it("expands the review recipe into one runnable review plan", () => {
    const factory = definePipr((pipr) => {
      const model = pipr.model("deepseek/deepseek-v4-pro", {
        name: "deepseek",
        apiKey: pipr.secret("DEEPSEEK_API_KEY"),
      });
      pipr.review({ model, instructions: "Review.", inlineComments: { max: 3 } });
    });

    const plan = buildPiprPlan(factory);

    expect(plan.models).toHaveLength(1);
    expect(plan.agents.map((agent) => agent.name)).toEqual(["review"]);
    expect(plan.tasks.map((task) => task.name)).toEqual(["review"]);
    expect(plan.changeRequestTriggers[0]?.actions).toEqual([
      "opened",
      "updated",
      "reopened",
      "ready",
    ]);
    expect(plan.commands[0]).toMatchObject({ pattern: "@pipr review", permission: "write" });
    expect(plan.locals[0]).toMatchObject({ name: "review" });
    expect(plan.publication.maxInlineComments).toBe(3);
  });

  it("reuses explicit reviewers and registers provider-neutral entrypoints", () => {
    const factory = definePipr((pipr) => {
      const model = pipr.model("deepseek/deepseek-v4-pro", {
        name: "deepseek",
        apiKey: pipr.secret("DEEPSEEK_API_KEY"),
      });
      const reviewer = pipr.reviewer({
        name: "correctness-reviewer",
        model,
        instructions: "Review correctness.",
      });
      pipr.review({
        name: "correctness",
        reviewer,
        entrypoints: {
          changeRequest: false,
          command: {
            pattern: "@pipr correctness",
            permission: "triage",
            description: "Run correctness review.",
          },
          local: "correctness",
        },
        inlineComments: false,
      });
    });

    const plan = buildPiprPlan(factory);

    expect(plan.agents.map((agent) => agent.name)).toEqual(["correctness-reviewer"]);
    expect(plan.tasks.map((task) => task.name)).toEqual(["correctness"]);
    expect(plan.changeRequestTriggers).toHaveLength(0);
    expect(plan.commands[0]).toMatchObject({
      pattern: "@pipr correctness",
      permission: "triage",
      description: "Run correctness review.",
    });
    expect(plan.locals[0]).toMatchObject({ name: "correctness" });
    expect(plan.publication.maxInlineComments).toBe(0);
  });

  it("passes review-level timeout when reusing an explicit reviewer", async () => {
    let runTimeout: unknown;
    const factory = definePipr((pipr) => {
      const model = pipr.model("deepseek/deepseek-v4-pro", {
        name: "deepseek",
        apiKey: pipr.secret("DEEPSEEK_API_KEY"),
      });
      const reviewer = pipr.reviewer({
        model,
        instructions: "Review.",
      });
      pipr.review({
        reviewer,
        timeout: "5m",
        entrypoints: {
          changeRequest: false,
          command: false,
          local: false,
        },
      });
    });

    const plan = buildPiprPlan(factory);
    const task = plan.tasks[0];
    expect(task).toBeDefined();
    await task?.handler(
      {
        run: { id: "test-run" },
        repository: { root: "/tmp/repo", name: "repo" },
        platform: { id: "local" },
        change: {
          title: "Local change",
          description: "",
          base: { sha: "base" },
          head: { sha: "head" },
          async diffManifest() {
            return { baseSha: "base", headSha: "head", mergeBaseSha: "base", files: [] };
          },
          async changedFiles() {
            return [];
          },
          async currentHeadSha() {
            return "head";
          },
        },
        pi: {
          async run(_agent, _input, options) {
            runTimeout = options?.timeout;
            return { summary: { body: "Done." }, inlineFindings: [] } as Awaited<
              ReturnType<typeof _agent.definition.output.parse>
            >;
          },
        },
        output: {
          summary() {},
          findings() {},
          section() {},
          metadata() {},
        },
        log: {
          info() {},
          warn() {},
          error() {},
        },
      },
      undefined,
    );

    expect(runTimeout).toBe("5m");
  });

  it("normalizes plugin tools to Eve-style run inputs", async () => {
    const factory = definePipr((pipr) => {
      pipr.tool({
        name: "summarize",
        description: "Summarize input.",
        input: pipr.schemas.summary,
        output: pipr.schemas.summary,
        async run({ input }) {
          return input;
        },
        toModelOutput(output) {
          return output.body;
        },
      });
    });

    const plan = buildPiprPlan(factory);
    const tool = plan.tools[0];

    await expect(
      tool?.run?.({ input: { body: "Looks good." }, ctx: {}, signal: undefined }),
    ).resolves.toEqual({ body: "Looks good." });
    expect(tool?.toModelOutput?.({ body: "Looks good." })).toBe("Looks good.");
  });

  it("rejects conflicting global inline publication settings across review recipes", () => {
    expect(() => buildPiprPlan(reviewRecipeFactory({ max: 3 }, { max: 5 }))).toThrow(
      "inlineComments settings must match",
    );
  });

  it("allows matching global inline publication settings across review recipes", () => {
    const plan = buildPiprPlan(reviewRecipeFactory({ max: 3 }, { max: 3 }));

    expect(plan.publication).toEqual({ maxInlineComments: 3 });
  });

  it("lets explicit plugins install typed helpers without adding plan modules", () => {
    const factory = definePipr((pipr) => {
      const helper = pipr.use(
        definePlugin((pluginPipr) => ({
          createTask() {
            return pluginPipr.task("plugin-task", () => {});
          },
        })),
      );
      helper.createTask();
    });

    const plan = buildPiprPlan(factory);

    expect(plan.tasks.map((task) => task.name)).toEqual(["plugin-task"]);
    expect("modules" in plan).toBe(false);
  });

  it("validates builtin schema values", () => {
    expect("jsonSchema" in schemas.review).toBe(false);
    expect(() => schemas.summary.parse({ body: "Looks good." })).not.toThrow();
    expect(() => schemas.summary.parse({ body: 123 })).toThrow("expected string");
    expect(() => schemas.summary.parse({ body: "Looks good.", risk: "low" })).toThrow("risk");
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [{ title: "Old title", ...validReviewFinding() }],
      }),
    ).toThrow("title");
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [],
        nonInlineFindings: [],
      }),
    ).toThrow("nonInlineFindings");
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [validReviewFinding({ id: "finding-1" })],
      }),
    ).toThrow("id");
    expect(
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [validReviewFinding({ data: { category: "correctness" } })],
        metadata: { source: "test" },
      }),
    ).toMatchObject({
      inlineFindings: [{ data: { category: "correctness" } }],
      metadata: { source: "test" },
    });
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [validReviewFinding({ data: { when: new Date() } })],
      }),
    ).toThrow("Invalid input");
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [validReviewFinding({ data: { values: new Map([["key", "value"]]) } })],
      }),
    ).toThrow("Invalid input");
  });
});

function expectExplicitReviewerRejectsConstructionFields(
  pipr: PiprBuilder,
  reviewer: Reviewer,
  model: ModelProfile,
): void {
  // @ts-expect-error explicit reviewer recipes do not accept reviewer construction fields
  pipr.review({ reviewer, model, instructions: "Ignored." });
}

void expectExplicitReviewerRejectsConstructionFields;

type InlineComments = false | { max?: number };

function reviewRecipeFactory(firstInline: InlineComments, secondInline: InlineComments) {
  return definePipr((pipr) => {
    const model = pipr.model("deepseek/deepseek-v4-pro", {
      name: "deepseek",
      apiKey: pipr.secret("DEEPSEEK_API_KEY"),
    });
    pipr.review({
      name: "correctness",
      model,
      instructions: "Review correctness.",
      inlineComments: firstInline,
      command: false,
      localName: false,
    });
    pipr.review({
      name: "security",
      model,
      instructions: "Review security.",
      inlineComments: secondInline,
      command: false,
      localName: false,
    });
  });
}

function validReviewFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    body: "Finding body.",
    path: "src/example.ts",
    rangeId: "rng_example",
    side: "RIGHT",
    startLine: 1,
    endLine: 1,
    ...overrides,
  };
}
