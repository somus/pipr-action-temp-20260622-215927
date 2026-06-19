import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initOfficialMinimalProject } from "../../config/init.js";
import { type LoadedRuntimeProject, loadRuntimeProject } from "../../config/project.js";
import { createRuntimeRegistry } from "../../registry/registry.js";
import type { DiffManifest, PullRequestEventContext } from "../../types.js";
import { type PiRunner, type RunReviewRuntimeOptions, runReviewRuntime } from "../runtime.js";

const event: PullRequestEventContext = {
  eventName: "pull_request",
  action: "opened",
  repo: "local/pipr",
  pullRequestNumber: 1,
  baseSha: "base",
  headSha: "head",
  workspace: "/tmp/pipr",
};

const manifest: DiffManifest = {
  baseSha: "base",
  headSha: "head",
  mergeBaseSha: "base",
  files: [
    {
      path: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      hunks: [
        {
          hunkIndex: 1,
          header: "@@ -9,1 +10,3 @@",
          oldStart: 9,
          oldLines: 1,
          newStart: 10,
          newLines: 3,
          contentHash: "deadbeefcafe",
        },
      ],
      commentableRanges: [
        {
          id: "range-1",
          path: "src/a.ts",
          side: "RIGHT",
          startLine: 10,
          endLine: 12,
          kind: "added",
          hunkIndex: 1,
          hunkHeader: "@@ -9,1 +10,3 @@",
          hunkContentHash: "deadbeefcafe",
        },
      ],
    },
  ],
};

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
    const registry = createRuntimeRegistry({
      modules: {
        workflows: [
          {
            id: "pipr/review",
            description: "Custom review workflow",
            source: "test",
            events: ["pull_request.opened"],
            steps: [
              { id: "custom-review", block: "core/run-agent" },
              { id: "main-comment", block: "core/main-comment" },
              { id: "inline-comments", block: "core/inline-comments" },
            ],
          },
        ],
      },
    });

    await expect(
      runReviewRuntime({
        workspace: "/tmp/pipr",
        config: (await loadOfficialRuntimeProject()).resolved.config,
        event,
        registry,
        piRunner: fakePiRunner([]).run,
        diffManifestBuilder: () => manifest,
      }),
    ).rejects.toThrow("must include reserved step id(s): review");
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
      [
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
        "      template: custom/main",
        "  - id: inline-comments",
        "    uses: core/inline-comments",
        "    with:",
        `      review: ${expr("steps.review.outputs.result")}`,
      ].join("\n"),
    );
    await writeCommentTemplate(rootDir, "custom.yaml", "custom/main", "Configured Review");
    const result = await runProjectReview(rootDir);

    expect(result.mainComment).toContain("<!-- pipr:custom-main pr=1 -->");
    expect(result.mainComment).toContain("# Configured Review");
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

function fakePiRunner(outputs: string[]): {
  run: PiRunner;
  envs: Array<NodeJS.ProcessEnv | undefined>;
  prompts: string[];
  providerIds: string[];
  timeoutSeconds: Array<number | undefined>;
} {
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  const prompts: string[] = [];
  const providerIds: string[] = [];
  const timeoutSeconds: Array<number | undefined> = [];
  return {
    envs,
    prompts,
    providerIds,
    timeoutSeconds,
    run: async (options) => {
      envs.push(options.env);
      prompts.push(options.prompt);
      providerIds.push(options.provider.id);
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
