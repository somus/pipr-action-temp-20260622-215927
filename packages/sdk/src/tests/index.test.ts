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
      const model = pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
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
      const task = pipr.task({
        name: "review",
        async run(context) {
          const manifest = await context.change.diffManifest({ paths });
          const result = await context.pi.run(agent, { manifest }, { paths });
          await context.comment({
            main: result.summary.body,
            inlineFindings: result.inlineFindings,
          });
        },
      });
      expect(pipr.on.changeRequest({ actions: ["opened"], task })).toBeUndefined();
      expect(pipr.command({ pattern: "@pipr review", permission: "write", task })).toBeUndefined();
      expect(pipr.local({ name: "review", task })).toBeUndefined();
      pipr.review({
        id: "scoped",
        model,
        instructions: "Review scoped files.",
        paths: { include: ["docs/**"] },
        entrypoints: { changeRequest: false, command: false, local: false },
      });
    });

    const plan = buildPiprPlan(factory);

    expect(plan.models.map((model) => model.id)).toEqual(["deepseek/deepseek-v4-pro"]);
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
      const first = pipr.task({ name: "review", run() {} });
      const second = pipr.task({ name: "review", run() {} });
      pipr.command({ pattern: "@pipr review", task: first });
      pipr.command({ pattern: "@pipr review", task: second });
      pipr.local({ name: "review", task: first });
      pipr.local({ name: "review", task: second });
    });

    expect(() => buildPiprPlan(factory)).toThrow("Duplicate task 'review'");
  });

  it("rejects command patterns outside the pipr command grammar", () => {
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          const task = pipr.task({ name: "review", run() {} });
          pipr.command({ pattern: "review", task });
        }),
      ),
    ).toThrow("must start with @pipr");
  });

  it("rejects old positional builder calls at runtime", () => {
    const factory = definePipr((pipr) => {
      expect(() =>
        // @ts-expect-error positional secret API was removed.
        pipr.secret("DEEPSEEK_API_KEY"),
      ).toThrow("pipr.secret requires { name }");
      expect(() =>
        // @ts-expect-error positional model API was removed.
        pipr.model("deepseek/deepseek-v4-pro", {}),
      ).toThrow("pipr.model requires { provider, model }");
      expect(() =>
        // @ts-expect-error positional task API was removed.
        pipr.task("review", () => {}),
      ).toThrow("pipr.task requires { name, run }");
      const task = pipr.task({ name: "review", run() {} });
      expect(() =>
        // @ts-expect-error positional event API was removed.
        pipr.on.changeRequest(["opened"], task),
      ).toThrow("pipr.on.changeRequest requires { actions, task }");
      expect(() =>
        // @ts-expect-error positional command API was removed.
        pipr.command("@pipr review", {}, task),
      ).toThrow("pipr.command requires { pattern, task }");
      expect(() =>
        // @ts-expect-error positional local API was removed.
        pipr.local("review", task),
      ).toThrow("pipr.local requires { name, task }");
      expect(() =>
        // @ts-expect-error positional schema API was removed.
        pipr.schema("custom/output", z.string()),
      ).toThrow("pipr.schema requires { id, schema }");
      expect(() =>
        // @ts-expect-error positional JSON schema API was removed.
        pipr.jsonSchema("custom/output", true),
      ).toThrow("pipr.jsonSchema requires { id, schema }");
    });

    expect(buildPiprPlan(factory).tasks.map((task) => task.name)).toEqual(["review"]);
  });

  it("rejects unsupported review option fields at runtime", () => {
    const factory = definePipr((pipr) => {
      const model = pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      expect(() =>
        pipr.review({
          id: "review",
          model,
          instructions: "Review.",
          command: false,
        } as never),
      ).toThrow("pipr.review received unsupported option fields: command");
    });

    buildPiprPlan(factory);
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
      const model = pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      pipr.review({ id: "review", model, instructions: "Review.", inlineComments: { max: 3 } });
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
      const model = pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      const reviewer = pipr.reviewer({
        name: "correctness-reviewer",
        model,
        instructions: "Review correctness.",
      });
      pipr.review({
        id: "correctness",
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
        comment: "Correctness review disabled.",
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
    expect(plan.publication.maxInlineComments).toBe(5);
  });

  it("passes review-level timeout when reusing an explicit reviewer", async () => {
    let runTimeout: unknown;
    const factory = definePipr((pipr) => {
      const model = pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      const reviewer = pipr.reviewer({
        model,
        instructions: "Review.",
      });
      pipr.review({
        id: "review",
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
        review: {
          async prior() {
            return { inlineFindings: [] };
          },
        },
        check: fakeCheck(),
        async comment() {},
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
            return pluginPipr.task({ name: "plugin-task", run() {} });
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
    const resultSchema = schema({
      id: "custom/security-review",
      schema: z.strictObject({
        verdict: z.enum(["pass", "fail"]),
        findings: z.array(z.string()),
      }),
    });

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
      schema({
        id: "custom/transformed",
        schema: z.string().transform((value) => value.trim()),
      }),
    ).toThrow("could not be converted to JSON Schema");
  });

  it("reserves core schema IDs for built-ins", () => {
    expect(() =>
      schema({ id: "core/pr-review", schema: z.strictObject({ ok: z.boolean() }) }),
    ).toThrow("reserved core/ namespace");
    expect(() => jsonSchema({ id: "core/custom", schema: true })).toThrow(
      "reserved core/ namespace",
    );
    expect(schemas.review.id).toBe("core/pr-review");
    expect(schemas.summary.id).toBe("core/summary");
  });

  it("creates typed custom JSON Schemas with caller-supplied output types", () => {
    type SummaryRating = { summary: string; rating: "low" | "high" };
    const resultSchema = jsonSchema<SummaryRating>({
      id: "custom/summary-rating",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "rating"],
        properties: {
          summary: { type: "string" },
          rating: { enum: ["low", "high"] },
        },
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
      const model = pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      const output = pipr.schema({
        id: "custom/security-summary",
        schema: z.strictObject({
          summary: z.string(),
          findings: z.array(z.string()),
        }),
      });
      const agent = pipr.agent({
        name: "security",
        model,
        instructions: "Review security.",
        output,
        prompt: () => "Review.",
      });
      const task = pipr.task({
        name: "security",
        async run(context) {
          const result = await context.pi.run(agent, {});
          await context.comment(JSON.stringify(result));
        },
      });
      pipr.on.changeRequest({ actions: ["opened"], task });
    });

    const plan = buildPiprPlan(factory);
    const task = plan.tasks[0];
    let commentValue: unknown;

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
        review: {
          async prior() {
            return { inlineFindings: [] };
          },
        },
        check: fakeCheck(),
        async comment(value) {
          commentValue = value;
        },
        log: fakeLog(),
      },
      undefined,
    );

    expect(commentValue).toEqual('{"summary":"Done.","findings":["A"]}');
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
        inlineFindings: [{ ...validReviewFinding(), title: 123 }],
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
        inlineFindings: [validReviewFinding()],
      }),
    ).toMatchObject({
      inlineFindings: [{ body: "Finding body." }],
    });
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [validReviewFinding({ data: { label: "correctness" } })],
      }),
    ).toThrow("data");
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [validReviewFinding()],
        metadata: { source: "test" },
      }),
    ).toThrow("metadata");
  });

  it("uses provider/model as the default model id", () => {
    const factory = definePipr((pipr) => {
      pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
    });

    expect(buildPiprPlan(factory).models[0]?.id).toBe("deepseek/deepseek-v4-pro");
  });

  it("rejects duplicate explicit model ids", () => {
    const factory = definePipr((pipr) => {
      pipr.model({
        id: "primary",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      pipr.model({
        id: "primary",
        provider: "openai",
        model: "gpt-4.1",
        apiKey: pipr.secret({ name: "OPENAI_API_KEY" }),
      });
    });

    expect(() => buildPiprPlan(factory)).toThrow("Duplicate model id 'primary'");
  });

  it("rejects duplicate effective model configs", () => {
    const factory = definePipr((pipr) => {
      const apiKey = pipr.secret({ name: "DEEPSEEK_API_KEY" });
      pipr.model({
        id: "primary",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey,
        options: { thinking: "high" },
      });
      pipr.model({
        id: "duplicate",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey,
        options: { thinking: "high" },
      });
    });

    expect(() => buildPiprPlan(factory)).toThrow("Duplicate model config");
  });

  it("requires explicit model ids for repeated provider/model with different config", () => {
    const missingIdFactory = definePipr((pipr) => {
      const apiKey = pipr.secret({ name: "DEEPSEEK_API_KEY" });
      pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey,
      });
      pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey,
        options: { thinking: "high" },
      });
    });
    const explicitIdFactory = definePipr((pipr) => {
      const apiKey = pipr.secret({ name: "DEEPSEEK_API_KEY" });
      pipr.model({
        id: "deepseek-default",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey,
      });
      pipr.model({
        id: "deepseek-thinking",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey,
        options: { thinking: "high" },
      });
    });

    expect(() => buildPiprPlan(missingIdFactory)).toThrow("Add an explicit id");
    expect(buildPiprPlan(explicitIdFactory).models.map((model) => model.id)).toEqual([
      "deepseek-default",
      "deepseek-thinking",
    ]);
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
  pipr.schema({ id: "custom/parse-only", schema: { parse: (value: unknown) => String(value) } });
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

type InlineComments = { max?: number };

function reviewRecipeFactory(firstInline: InlineComments, secondInline: InlineComments) {
  return definePipr((pipr) => {
    const model = pipr.model({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    });
    pipr.review({
      id: "correctness",
      model,
      instructions: "Review correctness.",
      inlineComments: firstInline,
      entrypoints: { command: false, local: false },
    });
    pipr.review({
      id: "security",
      model,
      instructions: "Review security.",
      inlineComments: secondInline,
      entrypoints: { command: false, local: false },
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

function fakeCheck() {
  return {
    pass() {},
    fail() {},
    neutral() {},
  };
}
