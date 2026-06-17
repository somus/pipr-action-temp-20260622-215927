import { describe, expect, it } from "vitest";
import { builtinMinimalConfig } from "../src/config.js";
import { createRuntimeRegistry } from "../src/registry.js";
import { type PiRunner, runReviewRuntime } from "../src/review-runtime.js";
import type { DiffManifest, PullRequestEventContext } from "../src/types.js";

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
      commentableRanges: [
        {
          id: "range-1",
          path: "src/a.ts",
          side: "RIGHT",
          startLine: 10,
          endLine: 12,
          kind: "added",
          hunkHeader: "@@ -9,1 +10,3 @@",
        },
      ],
    },
  ],
};

describe("runReviewRuntime", () => {
  it("runs Pi, validates findings, and renders comment drafts", async () => {
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
      workspace: "/tmp/pipr",
      config: builtinMinimalConfig,
      event,
      piRunner: pi.run,
      diffManifestBuilder: () => manifest,
    });

    expect(pi.prompts).toHaveLength(1);
    expect(pi.prompts[0]).toContain("Diff Manifest:");
    expect(result.validated.validFindings).toHaveLength(1);
    expect(result.inlineCommentDrafts).toHaveLength(1);
    expect(result.mainComment).toContain("# pipr Review");
  });

  it("runs the default pull request workflow when the event action is omitted", async () => {
    const pi = fakePiRunner([
      JSON.stringify({ summary: { body: "No findings." }, inlineFindings: [] }),
    ]);
    const eventWithoutAction: PullRequestEventContext = {
      eventName: "pull_request",
      repo: "local/pipr",
      pullRequestNumber: 1,
      baseSha: "base",
      headSha: "head",
      workspace: "/tmp/pipr",
    };

    const result = await runReviewRuntime({
      workspace: "/tmp/pipr",
      config: builtinMinimalConfig,
      event: eventWithoutAction,
      piRunner: pi.run,
      diffManifestBuilder: () => manifest,
    });

    expect(pi.prompts).toHaveLength(1);
    expect(result.validated.validFindings).toHaveLength(0);
  });

  it("executes the resolved registry workflow", async () => {
    let manifestBuilds = 0;
    const pi = fakePiRunner([
      JSON.stringify({ summary: { body: "No findings." }, inlineFindings: [] }),
    ]);
    const registry = createRuntimeRegistry({
      modules: {
        blocks: [
          {
            id: "review.default",
            description: "Custom review composition",
            source: "test",
            steps: [
              { block: "context.diff_manifest", output: "warmup_manifest" },
              { block: "context.diff_manifest", output: "diff_manifest" },
              {
                block: "agent.run",
                with: { input: { from: "diff_manifest" } },
                output: "review_result",
              },
              {
                block: "validate.pr_review",
                with: {
                  review: { from: "review_result" },
                  manifest: { from: "diff_manifest" },
                },
                output: "validated_review",
              },
            ],
          },
        ],
      },
    });

    const result = await runReviewRuntime({
      workspace: "/tmp/pipr",
      config: builtinMinimalConfig,
      event,
      registry,
      piRunner: pi.run,
      diffManifestBuilder: () => {
        manifestBuilds += 1;
        return manifest;
      },
    });

    expect(manifestBuilds).toBe(2);
    expect(result.validated.validFindings).toHaveLength(0);
  });

  it("repairs invalid reviewer JSON once", async () => {
    const pi = fakePiRunner([
      JSON.stringify({ summary: { body: "" }, inlineFindings: [] }),
      JSON.stringify({ summary: { body: "No findings." }, inlineFindings: [] }),
    ]);

    const result = await runReviewRuntime({
      workspace: "/tmp/pipr",
      config: builtinMinimalConfig,
      event,
      piRunner: pi.run,
      diffManifestBuilder: () => manifest,
    });

    expect(result.repairAttempted).toBe(true);
    expect(pi.prompts).toHaveLength(2);
    expect(pi.prompts[1]).toContain("Repair the previous reviewer output");
    expect(result.validated.validFindings).toHaveLength(0);
  });

  it("fails when repair output is still invalid", async () => {
    const pi = fakePiRunner(["not json", "also not json"]);

    await expect(
      runReviewRuntime({
        workspace: "/tmp/pipr",
        config: builtinMinimalConfig,
        event,
        piRunner: pi.run,
        diffManifestBuilder: () => manifest,
      }),
    ).rejects.toThrow("failed schema validation after repair attempt");
  });
});

function fakePiRunner(outputs: string[]): { run: PiRunner; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    run: async (options) => {
      prompts.push(options.prompt);
      return {
        stdout: outputs.shift() ?? "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  };
}
