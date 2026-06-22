import { afterEach, describe, expect, it } from "bun:test";
import type { DiffManifest, ValidatedReview } from "../../types.js";
import {
  buildPublicationPlan,
  prepareInlinePublicationItems,
  reviewToMainSectionContributions,
} from "../comment.js";
import {
  createGitHubPublicationClient,
  type GitHubPublicationClient,
  PublicationError,
  publishPublicationPlan,
} from "../publish.js";

const event = {
  repo: "local/pipr",
  pullRequestNumber: 1,
  headSha: "head",
};

const manifest: DiffManifest = {
  baseSha: "base",
  headSha: "head",
  mergeBaseSha: "base",
  files: [
    {
      path: "src/a.ts",
      status: "modified",
      additions: 2,
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
          preview: "fail()\nrecover()",
        },
        {
          id: "range-2",
          path: "src/a.ts",
          side: "RIGHT",
          startLine: 20,
          endLine: 20,
          kind: "added",
          hunkIndex: 1,
          hunkHeader: "@@ -9,1 +10,3 @@",
          hunkContentHash: "deadbeefcafe",
          preview: "break()",
        },
      ],
    },
  ],
};

const validated: ValidatedReview = {
  review: {
    summary: { title: "Review", body: "Found issues." },
    inlineFindings: [],
  },
  validFindings: [
    {
      body: "This can fail.",
      path: "src/a.ts",
      rangeId: "range-1",
      side: "RIGHT",
      startLine: 10,
      endLine: 12,
    },
    {
      body: "This can break.",
      path: "src/a.ts",
      rangeId: "range-2",
      side: "RIGHT",
      startLine: 20,
      endLine: 20,
    },
  ],
  droppedFindings: [],
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("publishPublicationPlan", () => {
  it("upserts the main comment and publishes inline comments", async () => {
    const client = new FakePublicationClient("head");
    const first = await publishPublicationPlan({ client, event, plan: plan() });
    const second = await publishPublicationPlan({ client, event, plan: plan() });

    expect(first.mainComment.action).toBe("created");
    expect(second.mainComment.action).toBe("updated");
    expect(client.issueComments).toHaveLength(1);
    expect(client.reviewCommentPayloads).toHaveLength(2);
    expect(client.reviewCommentPayloads[0]).toMatchObject({
      path: "src/a.ts",
      commit_id: "head",
      line: 12,
      side: "RIGHT",
      start_line: 10,
      start_side: "RIGHT",
    });
    expect(client.reviewCommentPayloads[1]).toMatchObject({
      path: "src/a.ts",
      commit_id: "head",
      line: 20,
      side: "RIGHT",
    });
  });

  it("blocks publication when the PR head changed", async () => {
    await expect(
      publishPublicationPlan({
        client: new FakePublicationClient("new-head"),
        event,
        plan: plan(),
      }),
    ).rejects.toThrow("PR head changed");
  });

  it("dedupes existing inline markers before posting", async () => {
    const client = new FakePublicationClient("head");
    const publicationPlan = plan({ maxInlineComments: 1 });
    client.reviewComments.push({
      id: 10,
      body: publicationPlan.inlineItems[0]?.body ?? "",
      authorLogin: client.ownerLogin,
    });

    const result = await publishPublicationPlan({ client, event, plan: publicationPlan });

    expect(result.inlineComments).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(client.reviewCommentPayloads).toHaveLength(0);
  });

  it("ignores main comment markers from other authors", async () => {
    const client = new FakePublicationClient("head");
    client.issueComments.push({
      id: 10,
      body: plan().mainComment,
      authorLogin: "attacker",
    });

    const result = await publishPublicationPlan({ client, event, plan: plan() });

    expect(result.mainComment.action).toBe("created");
    expect(client.issueComments).toHaveLength(2);
  });

  it("ignores inline markers from other authors", async () => {
    const client = new FakePublicationClient("head");
    const publicationPlan = plan({ maxInlineComments: 1 });
    client.reviewComments.push({
      id: 10,
      body: publicationPlan.inlineItems[0]?.body ?? "",
      authorLogin: "attacker",
    });

    const result = await publishPublicationPlan({ client, event, plan: publicationPlan });

    expect(result.inlineComments).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(client.reviewCommentPayloads).toHaveLength(1);
  });

  it("enforces maxInlineComments only when configured", () => {
    expect(plan().inlineItems).toHaveLength(2);
    expect(plan({ maxInlineComments: 1 }).inlineItems).toHaveLength(1);
  });

  it("reports inline API failures in publication metadata", async () => {
    const client = new FakePublicationClient("head");
    client.failInline = true;

    await expect(
      publishPublicationPlan({ client, event, plan: plan({ maxInlineComments: 1 }) }),
    ).rejects.toMatchObject({
      result: {
        inlineComments: { posted: 0, skipped: 0, failed: 1 },
        metadata: {
          inlinePublicationErrors: ["inline failed"],
        },
      },
    });
  });

  it("rejects invalid GitHub mappings before posting", async () => {
    const client = new FakePublicationClient("head");
    const publicationPlan = plan({ maxInlineComments: 1 });
    const item = publicationPlan.inlineItems[0];
    if (!item) {
      throw new Error("test fixture missing inline item");
    }
    publicationPlan.inlineItems = [
      {
        ...item,
        finding: { ...item.finding, endLine: 13 },
      },
    ];

    await expect(publishPublicationPlan({ client, event, plan: publicationPlan })).rejects.toThrow(
      "GitHub inline comment publication failed",
    );
    expect(client.reviewCommentPayloads).toHaveLength(0);
  });
});

describe("createGitHubPublicationClient", () => {
  it("lists all issue and review comment pages before marker checks", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input && typeof input === "object" && "url" in input
            ? String(input.url)
            : String(input);
      requestedUrls.push(url);
      const requestUrl = new URL(url);
      const page = requestUrl.searchParams.get("page") ?? "1";
      const headers =
        page === "1"
          ? {
              "Content-Type": "application/json",
              Link: `<${requestUrl.origin}${requestUrl.pathname}?per_page=100&page=2>; rel="next"`,
            }
          : { "Content-Type": "application/json" };
      const comments = [{ id: Number(page), body: `page ${page}` }];
      return new Response(JSON.stringify(comments), { status: 200, headers });
    }) as typeof fetch;

    const client = createGitHubPublicationClient({
      GITHUB_API_URL: "https://api.github.test",
    });

    await expect(
      client.listIssueComments({ repo: "local/pipr", issueNumber: 1 }),
    ).resolves.toHaveLength(2);
    await expect(
      client.listReviewComments({ repo: "local/pipr", pullRequestNumber: 1 }),
    ).resolves.toHaveLength(2);
    expect(requestedUrls).toHaveLength(4);
    expect(requestedUrls[0]).toContain("/repos/local/pipr/issues/1/comments");
    expect(requestedUrls[1]).toBe(
      "https://api.github.test/repos/local/pipr/issues/1/comments?per_page=100&page=2",
    );
    expect(requestedUrls[2]).toContain("/repos/local/pipr/pulls/1/comments");
    expect(requestedUrls[3]).toBe(
      "https://api.github.test/repos/local/pipr/pulls/1/comments?per_page=100&page=2",
    );
  });
});

function plan(options: { maxInlineComments?: number } = {}) {
  return buildPublicationPlan({
    event,
    mainContributions: reviewToMainSectionContributions({
      sourceId: "pipr/review",
      validated,
    }),
    inlineItems: prepareInlinePublicationItems({
      validated,
      manifest,
      reviewedHeadSha: "head",
    }),
    maxInlineComments: options.maxInlineComments,
    metadata: {
      runtimeVersion: "0.0.0",
      trustedConfigSha: "base",
      trustedConfigHash: "hash",
      reviewedHeadSha: "head",
      selectedTasks: ["review"],
      failedTasks: [],
      validFindings: 2,
      droppedFindings: 0,
    },
  });
}

class FakePublicationClient implements GitHubPublicationClient {
  readonly ownerLogin = "github-actions[bot]";
  issueComments: Array<{ id: number; body: string; authorLogin: string | undefined }> = [];
  reviewComments: Array<{ id: number; body: string; authorLogin: string | undefined }> = [];
  reviewCommentPayloads: unknown[] = [];
  failInline = false;

  constructor(private readonly headSha: string) {}

  async getAuthenticatedUserLogin() {
    return this.ownerLogin;
  }

  async getPullRequestHeadSha() {
    return this.headSha;
  }

  async listIssueComments() {
    return this.issueComments;
  }

  async createIssueComment(options: { body: string }) {
    const comment = {
      id: this.issueComments.length + 1,
      body: options.body,
      authorLogin: this.ownerLogin,
    };
    this.issueComments.push(comment);
    return { id: comment.id };
  }

  async updateIssueComment(options: { commentId: number; body: string }) {
    const existing = this.issueComments.find((comment) => comment.id === options.commentId);
    if (!existing) {
      throw new PublicationError("missing main comment", undefined);
    }
    existing.body = options.body;
    return { id: existing.id };
  }

  async listReviewComments() {
    return this.reviewComments;
  }

  async createReviewComment(options: unknown) {
    if (this.failInline) {
      throw new Error("inline failed");
    }
    this.reviewCommentPayloads.push(options);
    this.reviewComments.push({
      id: this.reviewCommentPayloads.length,
      body: typeof options === "object" && options && "body" in options ? String(options.body) : "",
      authorLogin: this.ownerLogin,
    });
    return { id: this.reviewCommentPayloads.length };
  }
}
