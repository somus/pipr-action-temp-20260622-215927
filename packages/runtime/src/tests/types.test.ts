import { describe, expect, it } from "vitest";
import type { PrReview, ReviewFinding, RuntimeRegistry } from "../types.js";
import {
  parseDiffManifest,
  parsePiprConfig,
  parsePullRequestEventContext,
  parseRuntimeRegistry,
  parseValidatedReview,
} from "../types.js";

const finding: ReviewFinding = {
  title: "Bug",
  body: "This can fail.",
  path: "src/a.ts",
  rangeId: "range-1",
  side: "RIGHT",
  startLine: 10,
  endLine: 10,
  severity: "high",
  category: "correctness",
  confidence: 0.9,
  evidenceSnippet: "fail()",
};

const review: PrReview = {
  summary: { body: "Looks fine." },
  inlineFindings: [finding],
};

const registry: RuntimeRegistry = {
  presets: [],
  workflows: [
    {
      id: "pipr/review",
      description: "Review",
      source: "test",
      events: ["pull_request.opened"],
      steps: [{ id: "review", block: "core/run-agent" }],
    },
  ],
  blocks: [
    {
      id: "core/run-agent",
      description: "Run review",
      source: "test",
    },
  ],
  agents: [],
  schemas: [],
  comments: [],
  tools: [],
};

describe("runtime boundary schemas", () => {
  it("validates Pi provider config from zod-derived types", () => {
    const config = parsePiprConfig({
      defaultProvider: "deepseek",
      providers: [
        {
          id: "deepseek",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          thinking: "minimal",
        },
      ],
      publication: {
        maxInlineComments: 5,
        minConfidence: 0.75,
      },
    });

    expect(config.providers[0]?.thinking).toBe("minimal");
  });

  it("rejects invalid pipr config values", () => {
    expect(() =>
      parsePiprConfig({
        defaultProvider: "deepseek",
        providers: [
          {
            id: "deepseek",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            apiKeyEnv: "DEEPSEEK_API_KEY",
          },
        ],
        publication: {
          maxInlineComments: 51,
          minConfidence: 0.75,
        },
      }),
    ).toThrow();
  });

  it("rejects invalid pull request event context", () => {
    expect(() =>
      parsePullRequestEventContext({
        eventName: "pull_request",
        repo: "owner/repo",
        pullRequestNumber: 0,
        baseSha: "base",
        headSha: "head",
        workspace: "/tmp/repo",
      }),
    ).toThrow();
  });

  it("rejects invalid diff manifest ranges", () => {
    expect(() =>
      parseDiffManifest({
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
                startLine: 0,
                endLine: 1,
                kind: "added",
                hunkHeader: "@@ -1,0 +1,1 @@",
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects invalid validated reviews", () => {
    expect(() =>
      parseValidatedReview({
        review,
        validFindings: [],
        droppedFindings: [{ finding, reason: "" }],
      }),
    ).toThrow();
  });

  it("rejects malformed runtime registries", () => {
    expect(() =>
      parseRuntimeRegistry({
        ...registry,
        blocks: [{ id: "core/run-agent", description: "Run review" }],
      }),
    ).toThrow();
  });
});
