import { describe, expect, it } from "vitest";
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
      expect("text" in pipr).toBe(false);
    });

    const plan = buildPiprPlan(factory);

    expect(plan.models.map((model) => model.name)).toEqual(["deepseek"]);
    expect(plan.agents.map((agent) => agent.name)).toEqual(["reviewer"]);
    expect(plan.tasks.map((task) => task.name)).toEqual(["review"]);
    expect(plan.changeRequestTriggers[0]).toMatchObject({ actions: ["opened"] });
    expect(plan.commands[0]).toMatchObject({ pattern: "@pipr review", permission: "write" });
    expect(plan.locals[0]).toMatchObject({ name: "review" });
    expect(plan.tools[0]?.name).toBe("custom_tool");
    expect("baseUrl" in plan.models[0]).toBe(false);
    expect("headers" in plan.models[0]).toBe(false);
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

  it("allows user-defined help commands without built-in help behavior", () => {
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        const task = pipr.task("help", () => {});
        pipr.command("@pipr help", {}, task);
      }),
    );

    expect(plan.commands[0]).toMatchObject({ pattern: "@pipr help" });
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
    expect(() => schemas.summary.parse({ body: 123 })).toThrow("summary.body");
    expect(() => schemas.summary.parse({ body: "Looks good.", risk: "low" })).toThrow(
      "ReviewSummary.risk is not supported",
    );
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [{ title: "Old title", ...validReviewFinding() }],
      }),
    ).toThrow("ReviewFinding.title is not supported");
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [],
        nonInlineFindings: [],
      }),
    ).toThrow("nonInlineFindings is not supported");
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [validReviewFinding({ id: "finding-1" })],
      }),
    ).toThrow("ReviewFinding.id is not supported");
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
    ).toThrow("finding.data must be JSON");
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [validReviewFinding({ data: { values: new Map([["key", "value"]]) } })],
      }),
    ).toThrow("finding.data must be JSON");
  });
});

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
