import { setTimeout as delay } from "node:timers/promises";
import { type Agent, buildPiprPlan, definePipr, type ReviewResult } from "@pipr/sdk";
import { describe, expect, it } from "vitest";
import type { DiffManifest, PiprConfig, ProviderConfig, ReviewFinding } from "../../types.js";
import { type PiRunner, type RunTaskRuntimeOptions, runTaskRuntime } from "../task-runtime.js";
import { reviewTestManifest } from "./fixtures.js";

const provider: ProviderConfig = {
  id: "deepseek",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  thinking: "high",
};

const fallbackProvider: ProviderConfig = {
  id: "fallback",
  provider: "deepseek",
  model: "fallback-model",
  apiKeyEnv: "DEEPSEEK_API_KEY",
};

const overrideProvider: ProviderConfig = {
  id: "override",
  provider: "deepseek",
  model: "override-model",
  apiKeyEnv: "DEEPSEEK_API_KEY",
};

const config: PiprConfig = {
  defaultProvider: "deepseek",
  providers: [provider],
  publication: {
    maxInlineComments: 5,
    minConfidence: 0.75,
  },
};

const fallbackConfig: PiprConfig = {
  ...config,
  providers: [provider, fallbackProvider],
};

describe("runTaskRuntime", () => {
  it("skips cleanly when no task matches the change request action", async () => {
    const plan = testPlan((pipr) => {
      const task = pipr.task("review", () => {});
      pipr.on.changeRequest(["reopened"], task);
    });

    const result = await runRuntime({
      plan,
      event: eventContext({ action: "opened" }),
    });

    expect(result).toMatchObject({
      kind: "skipped",
      skipReason: "No tasks matched the change request event",
    });
  });

  it("maps GitHub pull request actions to change request actions", async () => {
    const seen: string[] = [];
    const plan = testPlan((pipr) => {
      const updated = pipr.task("updated", () => {
        seen.push("updated");
      });
      const ready = pipr.task("ready", () => {
        seen.push("ready");
      });
      pipr.on.changeRequest(["updated"], updated);
      pipr.on.changeRequest(["ready"], ready);
    });

    await runRuntime({
      plan,
      event: eventContext({ action: "synchronize" }),
    });
    await runRuntime({
      plan,
      event: eventContext({ action: "edited" }),
    });
    await runRuntime({
      plan,
      event: eventContext({ action: "ready_for_review" }),
    });

    expect(seen).toEqual(["updated", "ready"]);
  });

  it("passes local or command task input to the selected task", async () => {
    let observedInput: unknown;
    const plan = testPlan((pipr) => {
      const task = pipr.task("explain", (_ctx, input) => {
        observedInput = input;
      });
      pipr.local("explain", task);
    });

    await runRuntime({
      plan,
      taskName: "explain",
      taskInput: { finding: "FND-123" },
    });

    expect(observedInput).toEqual({ finding: "FND-123" });
  });

  it("merges parallel task outputs in selected task order", async () => {
    const plan = testPlan((pipr) => {
      const slow = pipr.task("slow", async (ctx) => {
        await delay(25);
        ctx.output.findings([finding("slow", "range-1", 10)]);
      });
      const fast = pipr.task("fast", (ctx) => {
        ctx.output.findings([finding("fast", "range-2", 20)]);
      });
      pipr.on.changeRequest(["opened"], slow);
      pipr.on.changeRequest(["opened"], fast);
    });

    const result = await runRuntime({
      config: { ...config, publication: { ...config.publication, maxInlineComments: 1 } },
      plan,
    });

    expect(result.publicationPlan.metadata.selectedTasks).toEqual(["slow", "fast"]);
    expect(result.inlineCommentDrafts.map((item) => item.finding.title)).toEqual(["slow"]);
  });

  it("applies Diff Manifest options exposed on task context", async () => {
    const manifest = reviewTestManifestWithContext();
    const plan = testPlan((pipr) => {
      const task = pipr.task("review", async (ctx) => {
        const scoped = await ctx.change.diffManifest({
          compressed: true,
          maxPreviewLines: 1,
        });
        const file = scoped.files[0] as DiffManifest["files"][number];
        ctx.output.metadata({
          preview: file.commentableRanges[0]?.preview,
          hasSignals: "signals" in file,
          hasChangedSymbols: "changedSymbols" in file,
        });
      });
      pipr.on.changeRequest(["opened"], task);
    });

    const result = await runRuntime({
      plan,
      diffManifestBuilder: manifestBuilder(manifest),
    });

    expect(result.publicationPlan.metadata.taskMetadata).toEqual({
      preview: "const x = fail();",
      hasSignals: false,
      hasChangedSymbols: false,
    });
  });

  it("keeps the internal Diff Manifest immutable from task handlers", async () => {
    const plan = testPlan((pipr) => {
      const task = pipr.task("review", async (ctx) => {
        const manifest = await ctx.change.diffManifest();
        const file = manifest.files[0] as DiffManifest["files"][number];
        const range = file.commentableRanges[0] as { startLine: number };
        range.startLine = 999;
        ctx.output.findings([finding("uses original range", "range-1", 10)]);
      });
      pipr.on.changeRequest(["opened"], task);
    });

    const result = await runRuntime({
      plan,
    });

    expect(result.validated.validFindings).toHaveLength(1);
    expect(result.inlineCommentDrafts[0].startLine).toBe(10);
  });

  it("passes PR title and description to task and agent prompt contexts", async () => {
    const seen: string[] = [];
    const plan = testPlan((pipr) => {
      const agent = defaultReviewAgent(pipr, {
        prompt(_input, context) {
          seen.push(`${context.change.title}:${context.change.description}`);
          return "Review.";
        },
      });
      const task = pipr.task("review", async (ctx) => {
        ctx.output.metadata({
          taskContext: `${ctx.change.title}:${ctx.change.description}`,
        });
        await ctx.pi.run(agent, { manifest: await ctx.change.diffManifest() });
      });
      pipr.on.changeRequest(["opened"], task);
    });

    const result = await runRuntime({
      event: eventContext({ title: "Useful title", description: "Useful body" }),
      plan,
      piRunner: noFindingsPiRunner(),
    });

    expect(seen).toEqual(["Useful title:Useful body"]);
    expect(result.publicationPlan.metadata.taskMetadata).toEqual({
      taskContext: "Useful title:Useful body",
    });
  });

  it("does not treat arbitrary agent input manifest fields as Diff Manifests", async () => {
    let observedPrompt = "";
    const plan = testPlan((pipr) => {
      const model = deepseekModel(pipr);
      const agent = pipr.agent<{ manifest: string }, { ok: boolean }>({
        name: "release-notes",
        model,
        instructions: "Summarize release notes.",
        output: {
          kind: "pipr.schema",
          id: "test/release-notes",
          parse(value) {
            return value as { ok: boolean };
          },
          safeParse(value) {
            return { success: true, data: value as { ok: boolean } };
          },
        },
        prompt: () => "Summarize.",
      });
      const task = pipr.task("notes", async (ctx) => {
        await ctx.pi.run(agent, { manifest: "release-notes" });
      });
      pipr.on.changeRequest(["opened"], task);
    });

    await runRuntime({
      plan,
      piRunner: async (options) => {
        observedPrompt = options.prompt;
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "", durationMs: 1 };
      },
    });

    expect(observedPrompt).not.toContain("Diff Manifest Payload:");
  });

  it("uses agent timeout when running Pi", async () => {
    let observedTimeout: number | undefined;
    const plan = testPlan((pipr) => {
      const agent = defaultReviewAgent(pipr, { timeout: "5m" });
      registerPiReviewTask(pipr, agent);
    });

    await runRuntime({
      plan,
      piRunner: async (options) => {
        observedTimeout = options.timeoutSeconds;
        return noFindingsPiResult();
      },
    });

    expect(observedTimeout).toBe(300);
  });

  it("retries once when Pi returns invalid review JSON", async () => {
    let calls = 0;
    const plan = testPlan((pipr) => {
      registerPiReviewTask(pipr, defaultReviewAgent(pipr));
    });

    const result = await runRuntime({
      plan,
      piRunner: async () => {
        calls += 1;
        return calls === 1
          ? { exitCode: 0, stdout: "{", stderr: "", durationMs: 1 }
          : noFindingsPiResult();
      },
    });

    expect(calls).toBe(2);
    expect(result.repairAttempted).toBe(true);
  });

  it("rejects unsupported core review fields returned by Pi", async () => {
    let calls = 0;
    const plan = testPlan((pipr) => {
      registerPiReviewTask(pipr, defaultReviewAgent(pipr));
    });

    await expect(
      runRuntime({
        plan,
        piRunner: async () => {
          calls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              summary: { body: "Review." },
              inlineFindings: [{ ...finding("unsupported id", "range-1", 10), id: "finding-1" }],
            }),
            stderr: "",
            durationMs: 1,
          };
        },
      }),
    ).rejects.toThrow("Pi output failed schema validation");
    expect(calls).toBe(2);
  });

  it("uses run model and fallbacks in order", async () => {
    const calls: string[] = [];
    const plan = fallbackReviewPlan({ agentModel: "fallback", runOverridesModel: true });

    await runRuntime({
      config: fallbackConfig,
      plan,
      piRunner: providerFailurePiRunner(calls),
    });

    expect(calls).toEqual(["deepseek-v4-pro", "fallback-model"]);
  });

  it("uses provider override without model fallback selection", async () => {
    const calls: string[] = [];
    const plan = fallbackReviewPlan();

    await runRuntime({
      config: fallbackConfig,
      plan,
      providerOverride: overrideProvider,
      piRunner: async (options) => {
        calls.push(options.provider.model);
        return noFindingsPiResult();
      },
    });

    expect(calls).toEqual(["override-model"]);
  });

  it("runs invalid-output repair attempts per model before falling back", async () => {
    const calls: string[] = [];
    const plan = fallbackReviewPlan();

    const result = await runRuntime({
      config: fallbackConfig,
      plan,
      piRunner: async (options) => {
        calls.push(options.provider.model);
        return options.provider.id === "deepseek"
          ? { exitCode: 0, stdout: "{", stderr: "", durationMs: 1 }
          : noFindingsPiResult();
      },
    });

    expect(calls).toEqual(["deepseek-v4-pro", "deepseek-v4-pro", "fallback-model"]);
    expect(result.repairAttempted).toBe(true);
  });

  it("retries transient failures per model before falling back", async () => {
    const calls: string[] = [];
    const plan = fallbackReviewPlan({ agentPatch: { retry: { transientFailure: 1 } } });

    await runRuntime({
      config: fallbackConfig,
      plan,
      piRunner: providerFailurePiRunner(calls),
    });

    expect(calls).toEqual(["deepseek-v4-pro", "deepseek-v4-pro", "fallback-model"]);
  });

  it("does not fall back when the primary model returns a valid empty review", async () => {
    const calls: string[] = [];
    const plan = fallbackReviewPlan();

    await runRuntime({
      config: fallbackConfig,
      plan,
      piRunner: async (options) => {
        calls.push(options.provider.model);
        if (options.provider.id === "fallback") {
          throw new Error("fallback should not run");
        }
        return noFindingsPiResult();
      },
    });

    expect(calls).toEqual(["deepseek-v4-pro"]);
  });

  it("fails closed when an agent declares custom Pi tools", async () => {
    const plan = testPlan((pipr) => {
      const customTool = memoryTool(pipr);
      registerPiReviewTask(
        pipr,
        defaultReviewAgent(pipr, { tools: [...pipr.tools.readOnly, customTool] }),
      );
    });

    await expectCustomToolRejected(plan, "custom_tool");
  });

  it("fails closed when a custom tool forges the readOnly name", async () => {
    const plan = testPlan((pipr) => {
      registerPiReviewTask(
        pipr,
        defaultReviewAgent(pipr, { tools: [{ kind: "pipr.tool", name: "readOnly" }] }),
      );
    });

    await expectCustomToolRejected(plan, "readOnly");
  });

  it("fails closed when an agent copies a registered custom tool handle", async () => {
    const plan = testPlan((pipr) => {
      const customTool = memoryTool(pipr);
      const copiedTool = { ...customTool };
      registerPiReviewTask(pipr, defaultReviewAgent(pipr, { tools: [copiedTool] }));
    });

    await expectCustomToolRejected(plan, "custom_tool");
  });

  it("renders plain object output sections instead of rejecting them", async () => {
    const plan = testPlan((pipr) => {
      const task = pipr.task("metadata", (ctx) => {
        ctx.output.section("details", { status: "ok" }, { title: "Details" });
      });
      pipr.on.changeRequest(["opened"], task);
    });

    const result = await runRuntime({
      plan,
    });

    expect(result.mainComment).toContain('"status": "ok"');
  });

  it("allows multiple review recipes to append summaries deterministically", async () => {
    const plan = testPlan((pipr) => {
      const model = deepseekModel(pipr);
      pipr.review({
        name: "correctness",
        model,
        instructions: "Review correctness.",
        command: false,
        localName: false,
      });
      pipr.review({
        name: "security",
        model,
        instructions: "Review security.",
        command: false,
        localName: false,
      });
    });

    const result = await runRuntime({
      plan,
      piRunner: noFindingsPiRunner(),
    });

    expect(result.mainComment).toContain("No findings.");
    expect(result.publicationPlan.metadata.selectedTasks).toEqual(["correctness", "security"]);
  });
});

function eventContext(options: { action?: string; title?: string; description?: string } = {}) {
  return {
    eventName: "pull_request",
    action: options.action ?? "opened",
    repo: "local/pipr",
    pullRequestNumber: 1,
    title: options.title ?? "PR title",
    description: options.description ?? "PR body",
    baseSha: "base",
    headSha: "head",
    workspace: process.cwd(),
  };
}

type PiprApi = Parameters<Parameters<typeof definePipr>[0]>[0];
type ReviewAgent = Agent<{ manifest: unknown }, ReviewResult>;
type RunRuntimeOptions = Omit<
  RunTaskRuntimeOptions,
  "workspace" | "config" | "event" | "diffManifestBuilder"
> & {
  config?: PiprConfig;
  event?: RunTaskRuntimeOptions["event"];
  diffManifestBuilder?: RunTaskRuntimeOptions["diffManifestBuilder"];
};

function testPlan(configure: (pipr: PiprApi) => void) {
  return buildPiprPlan(definePipr(configure));
}

function deepseekModel(pipr: PiprApi, name = "deepseek", model = "deepseek-v4-pro") {
  return pipr.model(`deepseek/${model}`, {
    name,
    apiKey: pipr.secret("DEEPSEEK_API_KEY"),
  });
}

function defaultReviewAgent(pipr: PiprApi, options: Partial<Parameters<PiprApi["agent"]>[0]> = {}) {
  return pipr.agent({
    name: "reviewer",
    model: deepseekModel(pipr),
    instructions: "Review.",
    output: pipr.schemas.review,
    prompt: () => "Review.",
    ...options,
  }) as ReviewAgent;
}

function registerPiReviewTask(
  pipr: PiprApi,
  agent: ReviewAgent,
  runOptions?: Parameters<
    RunTaskRuntimeOptions["plan"]["tasks"][number]["handler"]
  >[0]["pi"]["run"] extends (...args: infer Args) => unknown
    ? Args[2]
    : never,
): void {
  const task = pipr.task("review", async (ctx) => {
    await ctx.pi.run(agent, { manifest: await ctx.change.diffManifest() }, runOptions);
  });
  pipr.on.changeRequest(["opened"], task);
}

function fallbackReviewPlan(
  options: {
    agentModel?: "primary" | "fallback";
    agentPatch?: Partial<Parameters<PiprApi["agent"]>[0]>;
    runOverridesModel?: boolean;
  } = {},
) {
  return testPlan((pipr) => {
    const primary = deepseekModel(pipr);
    const fallback = deepseekModel(pipr, "fallback", "fallback-model");
    const agentModel = options.agentModel === "fallback" ? fallback : primary;
    const agent = defaultReviewAgent(pipr, {
      model: agentModel,
      fallbacks: [fallback],
      ...options.agentPatch,
    });
    registerPiReviewTask(
      pipr,
      agent,
      options.runOverridesModel ? { model: primary, fallbacks: [fallback] } : undefined,
    );
  });
}

function memoryTool(pipr: PiprApi) {
  return pipr.tool({
    name: "custom_tool",
    description: "Store reviewer memory.",
    input: pipr.schemas.summary,
    output: pipr.schemas.summary,
    async execute(_context, input) {
      return input;
    },
  });
}

async function expectCustomToolRejected(
  plan: RunTaskRuntimeOptions["plan"],
  toolName: string,
): Promise<void> {
  await expect(runRuntime({ plan, piRunner: noFindingsPiRunner() })).rejects.toThrow(
    `custom Pi tools that are not executable in the MVP: ${toolName}`,
  );
}

async function runRuntime(options: RunRuntimeOptions) {
  const { config: runtimeConfig, event, diffManifestBuilder, ...rest } = options;
  return await runTaskRuntime({
    workspace: process.cwd(),
    config: runtimeConfig ?? config,
    event: event ?? eventContext(),
    diffManifestBuilder: diffManifestBuilder ?? manifestBuilder(),
    ...rest,
  });
}

function manifestBuilder(manifest: DiffManifest = reviewTestManifest()) {
  return () => manifest;
}

function reviewTestManifestWithContext(): DiffManifest {
  const manifest = reviewTestManifest();
  return {
    ...manifest,
    files: manifest.files.map((file) => ({
      ...file,
      signals: ["tests"],
      changedSymbols: ["value"],
      commentableRanges: file.commentableRanges.map((range) => ({
        ...range,
        summary: "summary",
      })),
    })),
  };
}

function finding(title: string, rangeId: string, startLine: number): ReviewFinding {
  return {
    title,
    body: `${title} body`,
    path: "src/a.ts",
    rangeId,
    side: "RIGHT",
    startLine,
    endLine: startLine,
    severity: "high",
    category: "correctness",
    confidence: 0.9,
    evidenceSnippet: "fail()",
  };
}

function noFindingsPiRunner(): PiRunner {
  return async () => noFindingsPiResult();
}

function providerFailurePiRunner(calls: string[]): PiRunner {
  return async (options) => {
    calls.push(options.provider.model);
    return options.provider.id === "deepseek"
      ? { exitCode: 1, stdout: "", stderr: "temporary failure", durationMs: 1 }
      : noFindingsPiResult();
  };
}

function noFindingsPiResult() {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ summary: { body: "No findings." }, inlineFindings: [] }),
    stderr: "",
    durationMs: 1,
  };
}
