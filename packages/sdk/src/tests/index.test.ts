import { describe, expect, it } from "vitest";
import type { ModelProfile, PiprBuilder, Reviewer } from "../index.js";
import {
  buildPiprPlan,
  definePipr,
  definePlugin,
  jsonSchema,
  schema,
  schemas,
  z,
} from "../index.js";

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
      const paths = { include: ["src/**"], exclude: ["**/*.test.ts"] };
      const task = pipr.task("review", async (context) => {
        const manifest = await context.change.diffManifest({ paths });
        const result = await context.pi.run(agent, { manifest }, { paths });
        context.output.summary(result.summary);
        context.output.findings(result.inlineFindings, { paths });
      });
      expect(pipr.on.changeRequest(["opened"], task)).toBeUndefined();
      expect(pipr.command("@pipr review", { permission: "write" }, task)).toBeUndefined();
      expect(pipr.local("review", task)).toBeUndefined();
      pipr.review({
        name: "scoped",
        model,
        instructions: "Review scoped files.",
        paths: { include: ["docs/**"] },
        entrypoints: { changeRequest: false, command: false, local: false },
      });
    });

    const plan = buildPiprPlan(factory);

    expect(plan.models.map((model) => model.name)).toEqual(["deepseek"]);
    expect(plan.agents.map((agent) => agent.name)).toEqual(["reviewer", "scoped"]);
    expect(plan.tasks.map((task) => task.name)).toEqual(["review", "scoped"]);
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

  it("exports Zod and creates typed custom Zod schemas", () => {
    const resultSchema = schema(
      "custom/security-review",
      z.strictObject({
        verdict: z.enum(["pass", "fail"]),
        findings: z.array(z.string()),
      }),
    );

    const parsed = resultSchema.parse({ verdict: "pass", findings: ["ok"] });
    const typed: { verdict: "pass" | "fail"; findings: string[] } = parsed;

    expect(typed).toEqual({ verdict: "pass", findings: ["ok"] });
    expect(resultSchema.jsonSchema).toMatchObject({
      type: "object",
      required: ["verdict", "findings"],
    });
    expect(() => resultSchema.parse({ verdict: "skip", findings: [] })).toThrow();
  });

  it("rejects custom Zod schemas that cannot be rendered as JSON Schema", () => {
    expect(() =>
      schema(
        "custom/transformed",
        z.string().transform((value) => value.trim()),
      ),
    ).toThrow("could not be converted to JSON Schema");
  });

  it("reserves core schema IDs for built-ins", () => {
    expect(() => schema("core/pr-review", z.strictObject({ ok: z.boolean() }))).toThrow(
      "reserved core/ namespace",
    );
    expect(() => jsonSchema("core/custom", true)).toThrow("reserved core/ namespace");
    expect(schemas.review.id).toBe("core/pr-review");
    expect(schemas.summary.id).toBe("core/summary");
  });

  it("creates typed custom JSON Schemas with caller-supplied output types", () => {
    type SummaryRating = { summary: string; rating: "low" | "high" };
    const resultSchema = jsonSchema<SummaryRating>("custom/summary-rating", {
      type: "object",
      additionalProperties: false,
      required: ["summary", "rating"],
      properties: {
        summary: { type: "string" },
        rating: { enum: ["low", "high"] },
      },
    });

    const parsed = resultSchema.parse({ summary: "Looks good.", rating: "low" });
    const typed: SummaryRating = parsed;

    expect(typed.rating).toBe("low");
    expect(resultSchema.safeParse({ summary: "Looks good.", rating: "medium" }).success).toBe(
      false,
    );
    expect(resultSchema.jsonSchema).toMatchObject({ type: "object" });
  });

  it("uses custom schemas as agent outputs", async () => {
    const factory = definePipr((pipr) => {
      const model = pipr.model("deepseek/deepseek-v4-pro", {
        name: "deepseek",
        apiKey: pipr.secret("DEEPSEEK_API_KEY"),
      });
      const output = pipr.schema(
        "custom/security-summary",
        z.strictObject({
          summary: z.string(),
          findings: z.array(z.string()),
        }),
      );
      const agent = pipr.agent({
        name: "security",
        model,
        instructions: "Review security.",
        output,
        prompt: () => "Review.",
      });
      const task = pipr.task("security", async (context) => {
        const result = await context.pi.run(agent, {});
        context.output.section("security", result, { title: "Security" });
      });
      pipr.on.changeRequest(["opened"], task);
    });

    const plan = buildPiprPlan(factory);
    const task = plan.tasks[0];
    let sectionValue: unknown;

    await task?.handler(
      {
        run: { id: "test-run" },
        repository: { root: "/tmp/repo", name: "repo" },
        platform: { id: "local" },
        change: fakeChange(),
        pi: {
          async run(agent) {
            return agent.definition.output.parse({ summary: "Done.", findings: ["A"] }) as never;
          },
        },
        output: {
          summary() {},
          findings() {},
          section(_id, value) {
            sectionValue = value;
          },
          metadata() {},
        },
        log: fakeLog(),
      },
      undefined,
    );

    expect(sectionValue).toEqual({ summary: "Done.", findings: ["A"] });
  });

  it("validates builtin schema values", () => {
    expect(schemas.review.jsonSchema).toMatchObject({
      type: "object",
      required: ["summary", "inlineFindings"],
    });
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

function expectRemovedPublicApis(pipr: PiprBuilder): void {
  // @ts-expect-error compactManifest is not part of the TS-first SDK.
  pipr.compactManifest({ baseSha: "base", headSha: "head", mergeBaseSha: "base", files: [] });
  // @ts-expect-error reviewCandidates is not part of the MVP schema catalog.
  pipr.schemas.reviewCandidates;
  // @ts-expect-error consolidatedReview is not part of the MVP schema catalog.
  pipr.schemas.consolidatedReview;
}

void expectRemovedPublicApis;

function expectSchemaRequiresZod(pipr: PiprBuilder): void {
  // @ts-expect-error schema() requires real Zod, not a parse-only validator.
  pipr.schema("custom/parse-only", { parse: (value: unknown) => String(value) });
}

void expectSchemaRequiresZod;

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

function fakeChange() {
  return {
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
  };
}

function fakeLog() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}
