import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initOfficialMinimalProject } from "../../config/init.js";
import { type LoadedRuntimeProject, loadRuntimeProject } from "../../config/project.js";
import { createRuntimeRegistry } from "../../registry/registry.js";
import type { BlockRegistryEntry, PullRequestEventContext, WorkflowStep } from "../../types.js";
import { type PiRunner, type RunReviewRuntimeOptions, runReviewRuntime } from "../runtime.js";
import { reviewTestManifest } from "./fixtures.js";

const event: PullRequestEventContext = {
  eventName: "pull_request",
  action: "opened",
  repo: "local/pipr",
  pullRequestNumber: 1,
  baseSha: "base",
  headSha: "head",
  workspace: "/tmp/pipr",
};

const manifest = reviewTestManifest();

const noFindingsReview = JSON.stringify({
  summary: { body: "No findings." },
  inlineFindings: [],
});

describe("runReviewRuntime", () => {
  it("runs Pi, validates findings, and renders comment drafts", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = fakePiRunner([
      JSON.stringify({
        summary: { body: "Found one issue." },
        inlineFindings: [
          {
            title: "Bug",
            body: "This can fail.",
            path: "src/a.ts",
            rangeId: "range-1",
            side: "RIGHT",
            startLine: 10,
            endLine: 11,
            severity: "high",
            category: "correctness",
            confidence: 0.9,
            evidenceSnippet: "const x = fail();",
          },
        ],
      }),
    ]);

    const result = await runReviewRuntime({
      workspace: runtime.project.sources.config,
      config: runtime.resolved.config,
      event,
      project: runtime.project,
      registry: runtime.registry,
      piRunner: pi.run,
      diffManifestBuilder: () => manifest,
    });

    expect(pi.prompts).toHaveLength(1);
    expect(pi.prompts[0]).toContain("Diff Manifest:");
    expect(pi.timeoutSeconds).toEqual([300]);
    expect(result.validated.validFindings).toHaveLength(1);
    expect(result.inlineCommentDrafts).toHaveLength(1);
    expect(result.mainComment).toContain("# pipr Review");
  });

  it("runs the default pull request workflow when the event action is omitted", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = noFindingsPiRunner();
    const eventWithoutAction: PullRequestEventContext = {
      eventName: "pull_request",
      repo: "local/pipr",
      pullRequestNumber: 1,
      baseSha: "base",
      headSha: "head",
      workspace: "/tmp/pipr",
    };

    const result = await runReviewRuntime(
      reviewRuntimeOptions(runtime, pi, { event: eventWithoutAction }),
    );

    expect(pi.prompts).toHaveLength(1);
    expect(result.validated.validFindings).toHaveLength(0);
  });

  it("executes the resolved registry workflow", async () => {
    let manifestBuilds = 0;
    const pi = fakePiRunner([reviewSummary("Warmup."), noFindingsReview]);
    const registry = createRuntimeRegistry({
      modules: {
        workflows: [
          {
            id: "pipr/review",
            description: "Custom review workflow",
            source: "test",
            events: ["pull_request.opened"],
            steps: [
              { id: "warmup", block: "core/run-agent" },
              { id: "review", block: "core/run-agent" },
              {
                id: "main-comment",
                block: "core/main-comment",
                with: { review: expr("steps.review.outputs.result") },
              },
              {
                id: "inline-comments",
                block: "core/inline-comments",
                with: { review: expr("steps.review.outputs.result") },
              },
            ],
          },
        ],
      },
    });

    const result = await runReviewRuntime({
      workspace: "/tmp/pipr",
      config: (await loadOfficialRuntimeProject()).resolved.config,
      event,
      registry,
      piRunner: pi.run,
      diffManifestBuilder: () => {
        manifestBuilds += 1;
        return manifest;
      },
    });

    expect(manifestBuilds).toBe(2);
    expect(pi.prompts).toHaveLength(2);
    expect(result.validated.validFindings).toHaveLength(0);
  });

  it("rejects review workflows that do not expose reserved runtime step ids", async () => {
    const registry = createReviewRegistry([
      { id: "custom-review", block: "core/run-agent" },
      { id: "main-comment", block: "core/main-comment" },
      { id: "inline-comments", block: "core/inline-comments" },
    ]);

    await expectRuntimeRejection(registry, "must include reserved step id(s): review");
  });

  it("rejects review workflows that bind reserved step ids to other blocks", async () => {
    const registry = createReviewRegistry(
      [
        { id: "review", block: "test/pass" },
        { id: "main-comment", block: "core/main-comment" },
        { id: "inline-comments", block: "core/inline-comments" },
      ],
      [{ id: "test/pass", description: "Pass-through", source: "test" }],
    );

    await expectRuntimeRejection(
      registry,
      "reserved step(s) must use runtime block(s): review -> core/run-agent",
    );
  });

  it("runs the materialized Official Minimal Distribution Review Workflow", async () => {
    const { rootDir, runtime } = await createOfficialRuntimeProject();
    const pi = noFindingsPiRunner();

    const result = await runReviewRuntime(
      reviewRuntimeOptions(runtime, pi, { workspace: rootDir }),
    );

    expect(result.validated.validFindings).toHaveLength(0);
    expect(result.mainComment).toContain("# pipr Review");
    expect(result.inlineCommentDrafts).toEqual([]);
  });

  it("includes the materialized reviewer Agent instructions in the Pi prompt", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = noFindingsPiRunner();

    await runReviewRuntime(reviewRuntimeOptions(runtime, pi));

    expect(pi.prompts[0]).toContain(
      "Review the pull request diff for correctness, security, maintainability, and test risk.",
    );
    expect(pi.prompts[0]).toContain("Available Pi tools: read, grep, find, ls.");
    expect(pi.prompts[0]).toContain(
      "Do not use bash, write, edit, GitHub APIs, or comment publishing tools.",
    );
    expect(pi.prompts[0]).toContain("Output Schema ID: core/pr-review");
  });

  it("marks full Diff Manifest prompts without attaching runtime tools", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = noFindingsPiRunner();

    await runReviewRuntime(reviewRuntimeOptions(runtime, pi));

    expect(pi.prompts[0]).toContain('"mode": "full"');
    expect(pi.prompts[0]).toContain(
      "Runtime-owned pipr read tools are not attached because the full Diff Manifest is available.",
    );
    expect(promptManifest(pi.prompts[0] ?? "")).toEqual(manifest);
    expect(pi.runtimeTools).toEqual([undefined]);
  });

  it("sends condensed Diff Manifest prompts with runtime read tools", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = noFindingsPiRunner();
    const largeManifest = {
      ...manifest,
      files: manifest.files.map((file) => ({
        ...file,
        signals: ["large signal"],
        changedSymbols: ["changedSymbol"],
        commentableRanges: file.commentableRanges.map((range) => ({
          ...range,
          preview: (range.preview ?? "").repeat(300),
        })),
      })),
    };

    await runReviewRuntime(
      reviewRuntimeOptions(runtime, pi, {
        config: {
          ...runtime.resolved.config,
          limits: {
            ...runtime.resolved.config.limits,
            diffManifest: {
              fullMaxBytes: 128,
              fullMaxEstimatedTokens: 100_000,
              condensedMaxBytes: 100_000,
              condensedMaxEstimatedTokens: 100_000,
              toolResponseMaxBytes: 4096,
            },
          },
        },
        diffManifestBuilder: () => largeManifest,
      }),
    );

    const prompt = pi.prompts[0] ?? "";
    expect(prompt).toContain('"mode": "condensed"');
    expect(prompt).toContain("pipr_read_diff(path?, rangeId?)");
    expect(prompt).toContain(
      "Available Pi tools: read, grep, find, ls, pipr_read_diff, pipr_read_at_ref.",
    );
    expect(promptManifest(prompt).files[0]?.commentableRanges[0]).not.toHaveProperty("preview");
    expect(promptManifest(prompt).files[0]).not.toHaveProperty("signals");
    expect(pi.runtimeTools[0]).toMatchObject({
      manifest: largeManifest,
      toolResponseMaxBytes: 4096,
    });
  });

  it("fails before Pi when the condensed manifest exceeds configured limits", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = noFindingsPiRunner();

    await expect(
      runReviewRuntime(
        reviewRuntimeOptions(runtime, pi, {
          config: {
            ...runtime.resolved.config,
            limits: {
              ...runtime.resolved.config.limits,
              diffManifest: {
                fullMaxBytes: 1,
                fullMaxEstimatedTokens: 1,
                condensedMaxBytes: 1,
                condensedMaxEstimatedTokens: 1,
              },
            },
          },
        }),
      ),
    ).rejects.toThrow("exceeds condensed limit before Pi execution");
    expect(pi.prompts).toEqual([]);
  });

  it("uses the materialized CommentTemplate for the Main Review Comment", async () => {
    const { rootDir } = await createOfficialRuntimeProject();
    await writeCommentTemplate(rootDir, "main.yaml", "pipr/main", "Custom Review");
    const result = await runProjectReview(rootDir);

    expect(result.mainComment).toContain("<!-- pipr:custom-main pr=1 -->");
    expect(result.mainComment).toContain("# Custom Review");
    expect(result.mainComment).toContain("## Digest");
  });

  it("uses the workflow template input for the Main Review Comment", async () => {
    const { rootDir } = await createOfficialRuntimeProject();
    await writeFile(
      path.join(rootDir, ".pipr", "workflows", "review.yaml"),
      templatedReviewWorkflowYaml({ mainTemplate: "custom/main" }),
    );
    await writeCommentTemplate(rootDir, "custom.yaml", "custom/main", "Configured Review");
    const result = await runProjectReview(rootDir);

    expect(result.mainComment).toContain("<!-- pipr:custom-main pr=1 -->");
    expect(result.mainComment).toContain("# Configured Review");
  });

  it("keeps template selection on the reserved main-comment step", async () => {
    const { rootDir } = await createOfficialRuntimeProject();
    await writeFile(
      path.join(rootDir, ".pipr", "workflows", "review.yaml"),
      templatedReviewWorkflowYaml({
        mainTemplate: "custom/main",
        laterTemplate: "custom/later",
      }),
    );
    await writeCommentTemplate(rootDir, "custom.yaml", "custom/main", "Configured Review");
    await writeCommentTemplate(rootDir, "later.yaml", "custom/later", "Later Review");
    const result = await runProjectReview(rootDir);

    expect(result.mainComment).toContain("# Configured Review");
    expect(result.mainComment).not.toContain("# Later Review");
  });

  it("uses the materialized Agent provider for Pi and review metadata", async () => {
    const { rootDir } = await createOfficialRuntimeProject();
    await writeFile(
      path.join(rootDir, ".pipr", "config.yaml"),
      [
        "apiVersion: pipr.dev/v1",
        "kind: Config",
        "providers:",
        "  - id: primary",
        "    provider: deepseek",
        "    model: primary-model",
        "    apiKeyEnv: PRIMARY_API_KEY",
        "  - id: backup",
        "    provider: deepseek",
        "    model: backup-model",
        "    apiKeyEnv: BACKUP_API_KEY",
        "workflows:",
        "  - pipr/review",
        "publication:",
        "  maxInlineComments: 5",
      ].join("\n"),
    );
    await writeFile(
      path.join(rootDir, ".pipr", "agents", "reviewer.md"),
      [
        "---",
        "apiVersion: pipr.dev/v1",
        "kind: Agent",
        "id: pipr/reviewer",
        "provider: backup",
        "output:",
        "  schema: core/pr-review",
        "---",
        "",
        "Use backup provider.",
      ].join("\n"),
    );
    const runtime = await loadRuntimeProject({ rootDir });
    const pi = noFindingsPiRunner();

    const result = await runReviewRuntime(
      reviewRuntimeOptions(runtime, pi, { workspace: rootDir }),
    );

    expect(result.provider.id).toBe("backup");
    expect(pi.providerIds).toEqual(["backup"]);
    expect(result.mainComment).toContain("Model: `backup-model`");
  });

  it("passes the runtime source env through to Pi", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = noFindingsPiRunner();

    await runReviewRuntime(
      reviewRuntimeOptions(runtime, pi, { env: { DEEPSEEK_API_KEY: "provided-key" } }),
    );

    expect(pi.envs[0]?.DEEPSEEK_API_KEY).toBe("provided-key");
  });

  it("repairs invalid reviewer JSON once", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = fakePiRunner([reviewSummary(""), noFindingsReview]);

    const result = await runReviewRuntime(reviewRuntimeOptions(runtime, pi));

    expect(result.repairAttempted).toBe(true);
    expect(pi.prompts).toHaveLength(2);
    expect(pi.prompts[1]).toContain("Repair the previous reviewer output");
    expect(result.validated.validFindings).toHaveLength(0);
  });

  it("keeps runtime read tools attached during condensed repair attempts", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = fakePiRunner([reviewSummary(""), noFindingsReview]);

    const result = await runReviewRuntime(
      reviewRuntimeOptions(runtime, pi, {
        config: {
          ...runtime.resolved.config,
          limits: {
            ...runtime.resolved.config.limits,
            diffManifest: {
              fullMaxBytes: 1,
              fullMaxEstimatedTokens: 1,
              condensedMaxBytes: 100_000,
              condensedMaxEstimatedTokens: 100_000,
              toolResponseMaxBytes: 4096,
            },
          },
        },
      }),
    );

    expect(result.repairAttempted).toBe(true);
    expect(pi.prompts).toHaveLength(2);
    expect(pi.prompts[0]).toContain('"mode": "condensed"');
    expect(pi.prompts[1]).toContain('"mode": "condensed"');
    expect(pi.runtimeTools).toHaveLength(2);
    expect(pi.runtimeTools[0]).toMatchObject({ toolResponseMaxBytes: 4096 });
    expect(pi.runtimeTools[1]).toMatchObject({ toolResponseMaxBytes: 4096 });
  });

  it("fails when repair output is still invalid", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = fakePiRunner(["not json", "also not json"]);

    await expect(
      runReviewRuntime({
        workspace: runtime.project.sources.config,
        config: runtime.resolved.config,
        event,
        project: runtime.project,
        registry: runtime.registry,
        piRunner: pi.run,
        diffManifestBuilder: () => manifest,
      }),
    ).rejects.toThrow("failed schema validation after repair attempt");
  });
});

async function loadOfficialRuntimeProject() {
  return (await createOfficialRuntimeProject()).runtime;
}

function createReviewRegistry(steps: WorkflowStep[], blocks: BlockRegistryEntry[] = []) {
  return createRuntimeRegistry({
    modules: {
      blocks,
      workflows: [
        {
          id: "pipr/review",
          description: "Custom review workflow",
          source: "test",
          events: ["pull_request.opened"],
          steps,
        },
      ],
    },
  });
}

async function expectRuntimeRejection(
  registry: RunReviewRuntimeOptions["registry"],
  message: string,
) {
  await expect(
    runReviewRuntime({
      workspace: "/tmp/pipr",
      config: (await loadOfficialRuntimeProject()).resolved.config,
      event,
      registry,
      piRunner: fakePiRunner([]).run,
      diffManifestBuilder: () => manifest,
    }),
  ).rejects.toThrow(message);
}

async function createOfficialRuntimeProject() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-review-runtime-"));
  await initOfficialMinimalProject({ rootDir });
  return { rootDir, runtime: await loadRuntimeProject({ rootDir }) };
}

async function runProjectReview(rootDir: string) {
  const runtime = await loadRuntimeProject({ rootDir });
  return await runReviewRuntime(
    reviewRuntimeOptions(runtime, noFindingsPiRunner(), { workspace: rootDir }),
  );
}

function noFindingsPiRunner() {
  return fakePiRunner([noFindingsReview]);
}

function reviewRuntimeOptions(
  runtime: LoadedRuntimeProject,
  pi: { run: PiRunner },
  overrides: Partial<RunReviewRuntimeOptions> = {},
): RunReviewRuntimeOptions {
  return {
    workspace: runtime.project.sources.config,
    config: runtime.resolved.config,
    event,
    project: runtime.project,
    registry: runtime.registry,
    piRunner: pi.run,
    diffManifestBuilder: () => manifest,
    ...overrides,
  };
}

async function writeCommentTemplate(
  rootDir: string,
  fileName: string,
  id: string,
  heading: string,
): Promise<void> {
  await writeFile(
    path.join(rootDir, ".pipr", "comments", fileName),
    [
      "apiVersion: pipr.dev/v1",
      "kind: CommentTemplate",
      `id: ${id}`,
      "marker: pipr:custom-main",
      `heading: ${heading}`,
      "sections:",
      "  - id: summary",
      "    title: Digest",
      "    order: 10",
    ].join("\n"),
  );
}

function reviewSummary(body: string): string {
  return JSON.stringify({ summary: { body }, inlineFindings: [] });
}

function templatedReviewWorkflowYaml(options: {
  mainTemplate: string;
  laterTemplate?: string;
}): string {
  const lines = [
    "apiVersion: pipr.dev/v1",
    "kind: Workflow",
    "id: pipr/review",
    "on:",
    "  events:",
    "    - pull_request.opened",
    "steps:",
    "  - id: review",
    "    uses: core/run-agent",
    "    with:",
    "      agent: pipr/reviewer",
    "  - id: main-comment",
    "    uses: core/main-comment",
    "    with:",
    `      review: ${expr("steps.review.outputs.result")}`,
    `      template: ${options.mainTemplate}`,
    "  - id: inline-comments",
    "    uses: core/inline-comments",
    "    with:",
    `      review: ${expr("steps.review.outputs.result")}`,
  ];
  if (options.laterTemplate !== undefined) {
    lines.push(
      "  - id: later-main-comment",
      "    uses: core/main-comment",
      "    with:",
      `      review: ${expr("steps.review.outputs.result")}`,
      `      template: ${options.laterTemplate}`,
    );
  }
  return lines.join("\n");
}

function fakePiRunner(outputs: string[]): {
  run: PiRunner;
  envs: Array<NodeJS.ProcessEnv | undefined>;
  prompts: string[];
  providerIds: string[];
  runtimeTools: Array<Parameters<PiRunner>[0]["runtimeTools"]>;
  timeoutSeconds: Array<number | undefined>;
} {
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  const prompts: string[] = [];
  const providerIds: string[] = [];
  const runtimeTools: Array<Parameters<PiRunner>[0]["runtimeTools"]> = [];
  const timeoutSeconds: Array<number | undefined> = [];
  return {
    envs,
    prompts,
    providerIds,
    runtimeTools,
    timeoutSeconds,
    run: async (options) => {
      envs.push(options.env);
      prompts.push(options.prompt);
      providerIds.push(options.provider.id);
      runtimeTools.push(options.runtimeTools);
      timeoutSeconds.push(options.timeoutSeconds);
      return {
        stdout: outputs.shift() ?? "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  };
}

function expr(source: string): string {
  return ["$", "{{ ", source, " }}"].join("");
}

function promptManifest(prompt: string) {
  return JSON.parse(prompt.split("Diff Manifest:\n\n").at(-1) ?? "{}");
}
