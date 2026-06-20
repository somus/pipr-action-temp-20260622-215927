import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initOfficialMinimalProject } from "../../config/init.js";
import { type LoadedRuntimeProject, loadRuntimeProject } from "../../config/project.js";
import { createRuntimeRegistry } from "../../registry/registry.js";
import type { BlockRegistryEntry, PullRequestEventContext, WorkflowStep } from "../../types.js";
import {
  type PiRunner,
  type ReviewRuntimeResult,
  type RunReviewRuntimeOptions,
  runReviewRuntime,
} from "../runtime.js";
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

type PiRunnerSpy = ReturnType<typeof fakePiRunner>;

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

    expect(manifestBuilds).toBe(1);
    expect(pi.prompts).toHaveLength(2);
    expect(result.validated.validFindings).toHaveLength(0);
  });

  it("skips event workflows when no changed files match workflow paths", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = noFindingsPiRunner();
    const registry = createRuntimeRegistry({
      modules: {
        workflows: [reviewWorkflow({ id: "pipr/docs", paths: { include: ["docs/**"] } })],
      },
    });

    const result = await runReviewRuntime({
      workspace: "/tmp/pipr",
      config: runtime.resolved.config,
      event,
      registry,
      piRunner: pi.run,
      diffManifestBuilder: () => manifest,
    });

    expect(result.kind).toBe("skipped");
    expect(result.skipReason).toContain("No enabled workflows matched");
    expect(pi.prompts).toEqual([]);
  });

  it("returns an empty review without Pi when Agent paths do not match", async () => {
    const { rootDir } = await createOfficialRuntimeProject();
    await writeDocsReviewerAgent(rootDir);
    const runtime = await loadRuntimeProject({ rootDir });
    const pi = noFindingsPiRunner();

    const result = await runReviewRuntime(
      reviewRuntimeOptions(runtime, pi, { workspace: rootDir }),
    );

    expect(result.kind).toBe("review");
    expect(result.validated.validFindings).toEqual([]);
    expect(result.review.summary.body).toContain("skipped because no changed files matched");
    expect(pi.prompts).toEqual([]);
  });

  it("passes a path-scoped Diff Manifest into Agent prompts", async () => {
    const { rootDir } = await createOfficialRuntimeProject();
    await writeDocsReviewerAgent(rootDir);
    const runtime = await loadRuntimeProject({ rootDir });
    const pi = noFindingsPiRunner();

    await runReviewRuntime(
      reviewRuntimeOptions(runtime, pi, {
        workspace: rootDir,
        diffManifestBuilder: () => manifestWithDocs(),
      }),
    );

    expect(
      promptManifest(pi.prompts[0] ?? "").files.map((file: { path: string }) => file.path),
    ).toEqual(["docs/readme.md"]);
  });

  it("executes all matching event workflows in config order with one Diff Manifest build", async () => {
    let manifestBuilds = 0;
    const runtime = await loadOfficialRuntimeProject();
    const pi = fakePiRunner([reviewSummary("Backend review."), reviewSummary("Docs review.")]);
    const registry = twoPathReviewRegistry("append");

    const result = await runRegistryReview({
      runtime,
      pi,
      registry,
      diffManifestBuilder: () => {
        manifestBuilds += 1;
        return manifestWithDocs();
      },
    });

    expect(manifestBuilds).toBe(1);
    expect(pi.prompts).toHaveLength(2);
    expectTwoWorkflowReview(result);
  });

  it("runs selected workflows in parallel while reducing results deterministically", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = concurrentPiRunner([
      reviewSummary("Backend review."),
      reviewSummary("Docs review."),
    ]);
    const registry = twoPathReviewRegistry("append");

    const result = await runRegistryReview({
      runtime,
      pi,
      registry,
      diffManifestBuilder: () => manifestWithDocs(),
    });

    expect(pi.maxActive()).toBeGreaterThan(1);
    expectTwoWorkflowReview(result);
  });

  it("fails when multiple workflows write the same main section without explicit merge", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = fakePiRunner([reviewSummary("Backend review."), reviewSummary("Docs review.")]);
    const registry = twoPathReviewRegistry();

    await expect(
      runRegistryReview({
        runtime,
        pi,
        registry,
        diffManifestBuilder: () => manifestWithDocs(),
      }),
    ).rejects.toThrow("multiple exclusive writers");
  });

  it("records provider models from every selected workflow Agent step", async () => {
    const { rootDir } = await createOfficialRuntimeProject();
    await writeFile(
      path.join(rootDir, ".pipr", "config.yaml"),
      [
        "apiVersion: pipr.dev/v1",
        "kind: Config",
        "providers:",
        "  - id: backend",
        "    provider: deepseek",
        "    model: backend-model",
        "    apiKeyEnv: BACKEND_API_KEY",
        "  - id: docs",
        "    provider: deepseek",
        "    model: docs-model",
        "    apiKeyEnv: DOCS_API_KEY",
        "workflows:",
        "  - pipr/backend",
        "  - pipr/docs",
      ].join("\n"),
    );
    await writeProviderAgent(rootDir, "reviewer.md", "pipr/reviewer", "backend");
    await writeProviderAgent(rootDir, "backend.md", "pipr/backend-reviewer", "backend");
    await writeProviderAgent(rootDir, "docs.md", "pipr/docs-reviewer", "docs");
    await writeFile(
      path.join(rootDir, ".pipr", "workflows", "backend.yaml"),
      providerWorkflowYaml("pipr/backend", "pipr/backend-reviewer", "src/**"),
    );
    await writeFile(
      path.join(rootDir, ".pipr", "workflows", "docs.yaml"),
      providerWorkflowYaml("pipr/docs", "pipr/docs-reviewer", "docs/**"),
    );
    const runtime = await loadRuntimeProject({ rootDir });
    const pi = fakePiRunner([reviewSummary("Backend review."), reviewSummary("Docs review.")]);

    const result = await runReviewRuntime(
      reviewRuntimeOptions(runtime, pi, {
        workspace: rootDir,
        diffManifestBuilder: () => manifestWithDocs(),
      }),
    );

    expect(pi.providerIds).toEqual(["backend", "docs"]);
    expect(result.publicationPlan.metadata.providerModels).toEqual(["backend-model", "docs-model"]);
    expect(result.mainComment).toContain("Models: `backend-model, docs-model`");
  });

  it("executes only the requested command workflow", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = fakePiRunner([reviewSummary("Docs review.")]);
    const registry = twoPathReviewRegistry("append");

    const result = await runRegistryReview({
      runtime,
      pi,
      registry,
      workflowId: "pipr/docs",
      diffManifestBuilder: () => manifestWithDocs(),
    });

    expect(pi.prompts).toHaveLength(1);
    expect(result.publicationPlan.metadata.selectedWorkflows).toEqual(["pipr/docs"]);
    expect(result.mainComment).toContain("Docs review.");
    expect(result.mainComment).not.toContain("Backend review.");
  });

  it("lets core/main-comment emit an explicit named section contribution", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = fakePiRunner([reviewSummary("Explicit section review.")]);
    const registry = createRuntimeRegistry({
      modules: {
        workflows: [
          {
            id: "pipr/review",
            description: "Explicit section review workflow",
            source: "test",
            events: ["pull_request.opened"],
            steps: [
              { id: "review", block: "core/run-agent" },
              {
                id: "main-comment",
                block: "core/main-comment",
                with: {
                  sectionId: "summary",
                  value: expr("steps.review.outputs.result.review.summary.body"),
                  merge: "exclusive",
                  priority: 100,
                },
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

    const result = await runRegistryReview({
      runtime,
      pi,
      registry,
      diffManifestBuilder: () => manifest,
    });

    expect(result.mainComment).toContain("Explicit section review.");
  });

  it("fails the run when a selected workflow records a step failure", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = fakePiRunnerWithExitCodes([
      { stdout: "", stderr: "warmup failed", exitCode: 1 },
      { stdout: noFindingsReview, stderr: "", exitCode: 0 },
    ]);
    const registry = createRuntimeRegistry({
      modules: {
        workflows: [
          {
            id: "pipr/review",
            description: "Review with fallible warmup",
            source: "test",
            events: ["pull_request.opened"],
            steps: [
              { id: "warmup", block: "core/run-agent", failurePolicy: "continue" },
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

    await expect(
      runRegistryReview({ runtime, pi, registry, diffManifestBuilder: () => manifest }),
    ).rejects.toThrow("Review workflow 'pipr/review' failed: warmup");
  });

  it("uses the built-in Main Review Comment template when selected workflows omit templates", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = noFindingsPiRunner();
    const registry = createRuntimeRegistry({
      modules: {
        workflows: [reviewWorkflow({ id: "pipr/review", omitTemplate: true })],
      },
    });

    const result = await runReviewRuntime({
      workspace: "/tmp/pipr",
      config: runtime.resolved.config,
      event,
      project: projectWithoutCommentTemplates(runtime),
      registry,
      piRunner: pi.run,
      diffManifestBuilder: () => manifest,
    });

    expect(result.mainComment).toContain("<!-- pipr:main-comment pr=1 -->");
    expect(result.mainComment).toContain("# pipr Review");
  });

  it("dedupes inline findings and applies the inline cap across workflows", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = fakePiRunner([
      findingReview("First", "range-1"),
      findingReview("Second", "range-2"),
    ]);
    const registry = createRuntimeRegistry({
      modules: {
        workflows: [
          reviewWorkflow({ id: "pipr/first", merge: "append" }),
          reviewWorkflow({ id: "pipr/second", merge: "append" }),
        ],
      },
    });

    const result = await runReviewRuntime({
      workspace: "/tmp/pipr",
      config: {
        ...runtime.resolved.config,
        publication: { ...runtime.resolved.config.publication, maxInlineComments: 1 },
      },
      event,
      registry,
      piRunner: pi.run,
      diffManifestBuilder: () => manifest,
    });

    expect(result.inlineCommentDrafts).toHaveLength(1);
    expect(result.publicationPlan.metadata.cappedInlineFindings).toBe(1);

    const duplicatePi = fakePiRunner([
      findingReview("Duplicate", "range-1"),
      findingReview("Duplicate", "range-1"),
    ]);
    const duplicateResult = await runReviewRuntime({
      workspace: "/tmp/pipr",
      config: runtime.resolved.config,
      event,
      registry,
      piRunner: duplicatePi.run,
      diffManifestBuilder: () => manifest,
    });

    expect(duplicateResult.inlineCommentDrafts).toHaveLength(1);
  });

  it("rejects selected workflows with mixed Main Review Comment templates", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = noFindingsPiRunner();
    const registry = createRuntimeRegistry({
      modules: {
        workflows: [
          reviewWorkflow({ id: "pipr/first", template: "pipr/main" }),
          reviewWorkflow({ id: "pipr/second", template: "custom/main" }),
        ],
      },
    });

    await expect(
      runReviewRuntime({
        workspace: "/tmp/pipr",
        config: runtime.resolved.config,
        event,
        registry,
        piRunner: pi.run,
        diffManifestBuilder: () => manifest,
      }),
    ).rejects.toThrow("mixed Main Review Comment templates");
  });

  it("fails before Pi when Diff Manifest build fails", async () => {
    const runtime = await loadOfficialRuntimeProject();
    const pi = noFindingsPiRunner();

    await expect(
      runReviewRuntime(
        reviewRuntimeOptions(runtime, pi, {
          diffManifestBuilder: () => {
            throw new Error("diff failed");
          },
        }),
      ),
    ).rejects.toThrow("diff failed");
    expect(pi.prompts).toEqual([]);
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

  it("renders Agent inputs into provider and prompt body", async () => {
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
      ].join("\n"),
    );
    await writeFile(
      path.join(rootDir, ".pipr", "agents", "reviewer.md"),
      [
        "---",
        "apiVersion: pipr.dev/v1",
        "kind: Agent",
        "id: pipr/reviewer",
        "inputs:",
        "  focus:",
        "    type: string",
        "    required: true",
        "    enum: [security, correctness]",
        "  provider:",
        "    type: string",
        "    default: backup",
        "  reviews:",
        "    type: json",
        "    required: true",
        `provider: ${expr("inputs.provider")}`,
        "output:",
        "  schema: core/pr-review",
        "---",
        "",
        ["Focus: ", expr("inputs.focus")].join(""),
        "Prior reviews:",
        expr("inputs.reviews"),
      ].join("\n"),
    );
    await writeFile(
      path.join(rootDir, ".pipr", "workflows", "review.yaml"),
      templatedReviewWorkflowYaml({
        agentInputLines: [
          "      inputs:",
          "        focus: security",
          "        reviews:",
          "          correctness:",
          "            summary:",
          "              body: ok",
          "            inlineFindings: []",
        ],
      }),
    );
    const { result, pi } = await runProjectReviewWithRunner(rootDir);

    expectBackupProviderUsed(result, pi);
    expect(pi.prompts[0]).toContain("Focus: security");
    expect(pi.prompts[0]).toContain('"correctness"');
    expect(pi.prompts[0]).toContain('"inlineFindings": []');
  });

  it("accepts dynamic inline Agent provider objects without id", async () => {
    const { rootDir } = await createOfficialRuntimeProject();
    await writeFile(
      path.join(rootDir, ".pipr", "agents", "reviewer.md"),
      [
        "---",
        "apiVersion: pipr.dev/v1",
        "kind: Agent",
        "id: pipr/reviewer",
        "inputs:",
        "  model:",
        "    type: string",
        "    required: true",
        "provider:",
        "  provider: deepseek",
        `  model: ${expr("inputs.model")}`,
        "  apiKeyEnv: DEEPSEEK_API_KEY",
        "output:",
        "  schema: core/pr-review",
        "---",
        "",
        "Use inline provider.",
      ].join("\n"),
    );
    await writeFile(
      path.join(rootDir, ".pipr", "workflows", "review.yaml"),
      templatedReviewWorkflowYaml({
        agentInputLines: ["      inputs:", "        model: dynamic-model"],
      }),
    );
    const { result, pi } = await runProjectReviewWithRunner(rootDir);

    expect(result.provider).toMatchObject({
      id: "inline_pipr_reviewer",
      model: "dynamic-model",
    });
    expect(pi.providerIds).toEqual(["inline_pipr_reviewer"]);
  });

  it("keeps provider override ahead of dynamic Agent provider", async () => {
    const { rootDir } = await createOfficialRuntimeProject();
    await writeFile(
      path.join(rootDir, ".pipr", "agents", "reviewer.md"),
      [
        "---",
        "apiVersion: pipr.dev/v1",
        "kind: Agent",
        "id: pipr/reviewer",
        "inputs:",
        "  provider:",
        "    type: string",
        "    default: deepseek",
        `provider: ${expr("inputs.provider")}`,
        "output:",
        "  schema: core/pr-review",
        "---",
        "",
        "Use configured provider unless overridden.",
      ].join("\n"),
    );
    const runtime = await loadRuntimeProject({ rootDir });
    const pi = noFindingsPiRunner();

    const result = await runReviewRuntime(
      reviewRuntimeOptions(runtime, pi, {
        workspace: rootDir,
        providerOverride: {
          id: "override",
          provider: "deepseek",
          model: "override-model",
          apiKeyEnv: "OVERRIDE_API_KEY",
        },
      }),
    );

    expect(result.provider.id).toBe("override");
    expect(pi.providerIds).toEqual(["override"]);
  });

  it("feeds specialist Agent outputs into the orchestrator Agent", async () => {
    const { rootDir } = await createOfficialRuntimeProject();
    await writeFile(
      path.join(rootDir, ".pipr", "agents", "specialist.md"),
      [
        "---",
        "apiVersion: pipr.dev/v1",
        "kind: Agent",
        "id: pipr/specialist-reviewer",
        "inputs:",
        "  focus:",
        "    type: string",
        "    required: true",
        "provider: deepseek",
        "output:",
        "  schema: core/pr-review",
        "---",
        "",
        ["Focus: ", expr("inputs.focus")].join(""),
      ].join("\n"),
    );
    await writeFile(
      path.join(rootDir, ".pipr", "agents", "orchestrator.md"),
      [
        "---",
        "apiVersion: pipr.dev/v1",
        "kind: Agent",
        "id: pipr/review-orchestrator",
        "inputs:",
        "  reviews:",
        "    type: json",
        "    required: true",
        "provider: deepseek",
        "output:",
        "  schema: core/pr-review",
        "---",
        "",
        "Specialist reviews:",
        expr("inputs.reviews"),
      ].join("\n"),
    );
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
        "  - id: correctness",
        "    uses: core/run-agent",
        "    with:",
        "      agent: pipr/specialist-reviewer",
        "      inputs:",
        "        focus: correctness",
        "  - id: security",
        "    uses: core/run-agent",
        "    with:",
        "      agent: pipr/specialist-reviewer",
        "      inputs:",
        "        focus: security",
        "  - id: tests",
        "    uses: core/run-agent",
        "    with:",
        "      agent: pipr/specialist-reviewer",
        "      inputs:",
        "        focus: tests",
        "  - id: review",
        "    uses: core/run-agent",
        "    with:",
        "      agent: pipr/review-orchestrator",
        "      inputs:",
        "        reviews:",
        `          correctness: ${expr("steps.correctness.outputs.result")}`,
        `          security: ${expr("steps.security.outputs.result")}`,
        `          tests: ${expr("steps.tests.outputs.result")}`,
        "  - id: main-comment",
        "    uses: core/main-comment",
        "    with:",
        `      review: ${expr("steps.review.outputs.result")}`,
        "      template: pipr/main",
        "  - id: inline-comments",
        "    uses: core/inline-comments",
        "    with:",
        `      review: ${expr("steps.review.outputs.result")}`,
      ].join("\n"),
    );
    const runtime = await loadRuntimeProject({ rootDir });
    const pi = fakePiRunner([
      reviewSummary("Correctness review."),
      reviewSummary("Security review."),
      reviewSummary("Test review."),
      noFindingsReview,
    ]);

    const result = await runReviewRuntime(
      reviewRuntimeOptions(runtime, pi, { workspace: rootDir }),
    );

    expect(pi.prompts).toHaveLength(4);
    expect(pi.prompts[0]).toContain("Focus: correctness");
    expect(pi.prompts[1]).toContain("Focus: security");
    expect(pi.prompts[2]).toContain("Focus: tests");
    expect(pi.prompts[3]).toContain('"body": "Correctness review."');
    expect(pi.prompts[3]).toContain('"body": "Security review."');
    expect(pi.prompts[3]).toContain('"body": "Test review."');
    expect(result.validated.validFindings).toEqual([]);
  });

  it("rejects missing Agent inputs before Pi", async () => {
    const { rootDir } = await createOfficialRuntimeProject();
    await writeFile(
      path.join(rootDir, ".pipr", "agents", "reviewer.md"),
      [
        "---",
        "apiVersion: pipr.dev/v1",
        "kind: Agent",
        "id: pipr/reviewer",
        "inputs:",
        "  focus:",
        "    type: string",
        "    required: true",
        "provider: deepseek",
        "output:",
        "  schema: core/pr-review",
        "---",
        "",
        ["Focus: ", expr("inputs.focus")].join(""),
      ].join("\n"),
    );
    const runtime = await loadRuntimeProject({ rootDir });
    const pi = noFindingsPiRunner();

    await expect(
      runReviewRuntime(reviewRuntimeOptions(runtime, pi, { workspace: rootDir })),
    ).rejects.toThrow("input 'focus' is required");
    expect(pi.prompts).toEqual([]);
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
    const { result, pi } = await runProjectReviewWithRunner(rootDir);

    expectBackupProviderUsed(result, pi);
    expect(result.mainComment).toContain("Models: `backup-model`");
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

function reviewWorkflow(options: {
  id: string;
  paths?: NonNullable<RunReviewRuntimeOptions["registry"]["workflows"][number]["paths"]>;
  template?: string;
  omitTemplate?: boolean;
  merge?: "exclusive" | "replace" | "append" | "list";
}) {
  const mainCommentInput = options.omitTemplate
    ? { review: expr("steps.review.outputs.result") }
    : {
        review: expr("steps.review.outputs.result"),
        template: options.template ?? "pipr/main",
        ...(options.merge ? { merge: options.merge } : {}),
      };
  return {
    id: options.id,
    description: options.id,
    source: "test",
    paths: options.paths,
    events: ["pull_request.opened"],
    steps: [
      { id: "review", block: "core/run-agent" },
      {
        id: "main-comment",
        block: "core/main-comment",
        with: mainCommentInput,
      },
      {
        id: "inline-comments",
        block: "core/inline-comments",
        with: { review: expr("steps.review.outputs.result") },
      },
    ],
  };
}

function twoPathReviewRegistry(merge?: "exclusive" | "replace" | "append" | "list") {
  return createRuntimeRegistry({
    modules: {
      workflows: [
        reviewWorkflow({
          id: "pipr/backend",
          paths: { include: ["src/**"] },
          ...(merge ? { merge } : {}),
        }),
        reviewWorkflow({
          id: "pipr/docs",
          paths: { include: ["docs/**"] },
          ...(merge ? { merge } : {}),
        }),
      ],
    },
  });
}

function expectTwoWorkflowReview(result: ReviewRuntimeResult): void {
  expect(result.publicationPlan.metadata.selectedWorkflows).toEqual(["pipr/backend", "pipr/docs"]);
  expect(result.mainComment).toContain("Backend review.");
  expect(result.mainComment).toContain("Docs review.");
}

function manifestWithDocs() {
  return {
    ...manifest,
    files: [
      ...manifest.files,
      {
        path: "docs/readme.md",
        status: "modified" as const,
        additions: 1,
        deletions: 0,
        hunks: [
          {
            hunkIndex: 1,
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            contentHash: "cafedeadbeef",
          },
        ],
        commentableRanges: [
          {
            id: "docs-range",
            path: "docs/readme.md",
            side: "RIGHT" as const,
            startLine: 1,
            endLine: 1,
            kind: "added" as const,
            hunkIndex: 1,
            hunkHeader: "@@ -1 +1 @@",
            hunkContentHash: "cafedeadbeef",
            preview: "updated docs",
          },
        ],
      },
    ],
  };
}

function findingReview(title: string, rangeId: "range-1" | "range-2"): string {
  const startLine = rangeId === "range-1" ? 10 : 20;
  const endLine = rangeId === "range-1" ? 12 : 22;
  return JSON.stringify({
    summary: { body: `${title} summary.` },
    inlineFindings: [
      {
        title,
        body: "This can fail.",
        path: "src/a.ts",
        rangeId,
        side: "RIGHT",
        startLine,
        endLine,
        severity: "high",
        category: "correctness",
        confidence: 0.9,
        evidenceSnippet: "const x = fail();",
      },
    ],
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
  return (await runProjectReviewWithRunner(rootDir)).result;
}

async function runProjectReviewWithRunner(rootDir: string, pi = noFindingsPiRunner()) {
  const runtime = await loadRuntimeProject({ rootDir });
  const result = await runReviewRuntime(reviewRuntimeOptions(runtime, pi, { workspace: rootDir }));
  return { result, pi };
}

async function runRegistryReview(options: {
  runtime: LoadedRuntimeProject;
  pi: PiRunnerSpy;
  registry: RunReviewRuntimeOptions["registry"];
  workflowId?: string;
  diffManifestBuilder: RunReviewRuntimeOptions["diffManifestBuilder"];
}) {
  return await runReviewRuntime({
    workspace: "/tmp/pipr",
    config: options.runtime.resolved.config,
    event,
    registry: options.registry,
    workflowId: options.workflowId,
    piRunner: options.pi.run,
    diffManifestBuilder: options.diffManifestBuilder,
  });
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

async function writeDocsReviewerAgent(rootDir: string): Promise<void> {
  await writeFile(
    path.join(rootDir, ".pipr", "agents", "reviewer.md"),
    [
      "---",
      "apiVersion: pipr.dev/v1",
      "kind: Agent",
      "id: pipr/reviewer",
      "paths:",
      "  include:",
      "    - docs/**",
      "provider: deepseek",
      "output:",
      "  schema: core/pr-review",
      "---",
      "",
      "Review docs.",
    ].join("\n"),
  );
}

async function writeProviderAgent(
  rootDir: string,
  fileName: string,
  id: string,
  provider: string,
): Promise<void> {
  await writeFile(
    path.join(rootDir, ".pipr", "agents", fileName),
    [
      "---",
      "apiVersion: pipr.dev/v1",
      "kind: Agent",
      `id: ${id}`,
      `provider: ${provider}`,
      "output:",
      "  schema: core/pr-review",
      "---",
      "",
      `Review with ${provider}.`,
    ].join("\n"),
  );
}

function providerWorkflowYaml(id: string, agentId: string, includePath: string): string {
  return [
    "apiVersion: pipr.dev/v1",
    "kind: Workflow",
    `id: ${id}`,
    "paths:",
    "  include:",
    `    - ${includePath}`,
    "on:",
    "  events:",
    "    - pull_request.opened",
    "steps:",
    "  - id: review",
    "    uses: core/run-agent",
    "    with:",
    `      agent: ${agentId}`,
    "  - id: main-comment",
    "    uses: core/main-comment",
    "    with:",
    `      review: ${expr("steps.review.outputs.result")}`,
    "      template: pipr/main",
    "      merge: append",
    "  - id: inline-comments",
    "    uses: core/inline-comments",
    "    with:",
    `      review: ${expr("steps.review.outputs.result")}`,
  ].join("\n");
}

function reviewSummary(body: string): string {
  return JSON.stringify({ summary: { body }, inlineFindings: [] });
}

function expectBackupProviderUsed(result: ReviewRuntimeResult, pi: PiRunnerSpy): void {
  expect(result.provider.id).toBe("backup");
  expect(pi.providerIds).toEqual(["backup"]);
}

function projectWithoutCommentTemplates(
  runtime: LoadedRuntimeProject,
): LoadedRuntimeProject["project"] {
  const componentFiles = Object.fromEntries(
    Object.entries(runtime.project.componentFiles).filter(
      ([, component]) => component.document.kind !== "CommentTemplate",
    ),
  );
  return {
    ...runtime.project,
    components: runtime.project.components.filter(
      (component) => component.kind !== "CommentTemplate",
    ),
    componentFiles,
    sources: {
      ...runtime.project.sources,
      components: Object.fromEntries(
        Object.entries(runtime.project.sources.components).filter(([id]) =>
          Object.hasOwn(componentFiles, id),
        ),
      ),
    },
  };
}

function templatedReviewWorkflowYaml(options: {
  mainTemplate?: string;
  laterTemplate?: string;
  agentInputLines?: string[];
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
    ...(options.agentInputLines ?? []),
    "  - id: main-comment",
    "    uses: core/main-comment",
    "    with:",
    `      review: ${expr("steps.review.outputs.result")}`,
    `      template: ${options.mainTemplate ?? "pipr/main"}`,
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
      recordPiRun({ envs, prompts, providerIds, runtimeTools, timeoutSeconds }, options);
      return {
        stdout: outputs.shift() ?? "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  };
}

function fakePiRunnerWithExitCodes(
  outputs: Array<{ stdout: string; stderr: string; exitCode: number }>,
): {
  run: PiRunner;
  envs: Array<NodeJS.ProcessEnv | undefined>;
  prompts: string[];
  providerIds: string[];
  runtimeTools: Array<Parameters<PiRunner>[0]["runtimeTools"]>;
  timeoutSeconds: Array<number | undefined>;
} {
  const runner = fakePiRunner([]);
  return {
    ...runner,
    run: async (options) => {
      recordPiRun(runner, options);
      const output = outputs.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
      return {
        ...output,
        durationMs: 1,
      };
    },
  };
}

function concurrentPiRunner(outputs: string[]): PiRunnerSpy & { maxActive: () => number } {
  const runner = fakePiRunner([]);
  let active = 0;
  let maxActive = 0;
  return {
    ...runner,
    maxActive: () => maxActive,
    run: async (options) => {
      recordPiRun(runner, options);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const stdout = outputs.shift() ?? "";
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return {
        stdout,
        stderr: "",
        exitCode: 0,
        durationMs: 20,
      };
    },
  };
}

function recordPiRun(
  runner: Pick<PiRunnerSpy, "envs" | "prompts" | "providerIds" | "runtimeTools" | "timeoutSeconds">,
  options: Parameters<PiRunner>[0],
): void {
  runner.envs.push(options.env);
  runner.prompts.push(options.prompt);
  runner.providerIds.push(options.provider.id);
  runner.runtimeTools.push(options.runtimeTools);
  runner.timeoutSeconds.push(options.timeoutSeconds);
}

function expr(source: string): string {
  return ["$", "{{ ", source, " }}"].join("");
}

function promptManifest(prompt: string) {
  return JSON.parse(prompt.split("Diff Manifest:\n\n").at(-1) ?? "{}");
}
