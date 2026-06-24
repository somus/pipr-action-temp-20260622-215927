import { afterEach, describe, expect, it } from "bun:test";
import { loadGitHubPriorReviewState } from "../../hosts/github/publication.js";
import type { ChangeRequestEventContext, DiffManifest, ValidatedReview } from "../../types.js";
import { buildPublicationPlan, prepareInlinePublicationItems, runtimeVersion } from "../comment.js";
import {
  type PriorReviewState,
  renderInlineFindingMarker,
  renderResolvedFindingMarker,
} from "../prior-state.js";
import {
  createGitHubPublicationClient,
  type GitHubPublicationClient,
  PublicationError,
  publishPublicationPlan,
} from "../publish.js";

const event: ChangeRequestEventContext = {
  eventName: "pull_request",
  action: "opened",
  platform: { id: "github" },
  repository: { slug: "local/pipr" },
  change: {
    number: 1,
    title: "Review",
    description: "",
    base: { sha: "base" },
    head: { sha: "head" },
  },
  workspace: process.cwd(),
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
    const first = await publishPublicationPlan({ client, change: event, plan: plan() });
    const second = await publishPublicationPlan({ client, change: event, plan: plan() });

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
        change: event,
        plan: plan(),
      }),
    ).rejects.toThrow("Change request head changed");
  });

  it("dedupes existing inline markers before posting", async () => {
    const client = new FakePublicationClient("head");
    const publicationPlan = plan({ maxInlineComments: 1 });
    addExistingInlineComment(client, publicationPlan, client.ownerLogin);

    const result = await publishPublicationPlan({ client, change: event, plan: publicationPlan });

    expect(result.inlineComments).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(client.reviewCommentPayloads).toHaveLength(0);
  });

  it("dedupes same-head inline comments by location when finding wording changes", async () => {
    const client = new FakePublicationClient("head");
    await publishPublicationPlan({ client, change: event, plan: plan({ maxInlineComments: 1 }) });

    const changedFinding = {
      ...validated.validFindings[0],
      body: "Different wording for the same issue.",
    };
    const result = await publishPublicationPlan({
      client,
      change: event,
      plan: plan({
        maxInlineComments: 1,
        validated: { ...validated, validFindings: [changedFinding] },
      }),
    });

    expect(result.inlineComments).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(client.reviewCommentPayloads).toHaveLength(1);
  });

  it("does not dedupe same-head location comments without a pipr marker", async () => {
    const client = new FakePublicationClient("head");
    client.reviewComments.push(
      fakeReviewComment({
        id: 10,
        body: "Other automation commented here.",
        authorLogin: client.ownerLogin,
        path: "src/a.ts",
        commitId: "head",
        line: 12,
        startLine: 10,
        side: "RIGHT",
        startSide: "RIGHT",
      }),
    );

    const result = await publishPublicationPlan({
      client,
      change: event,
      plan: plan({ maxInlineComments: 1 }),
    });

    expect(result.inlineComments).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(client.reviewCommentPayloads).toHaveLength(1);
  });

  it("loads prior review state from the main marker and inline markers", async () => {
    const client = new FakePublicationClient("head");
    await publishPublicationPlan({ client, change: event, plan: plan({ maxInlineComments: 1 }) });

    const state = await loadGitHubPriorReviewState({ client, change: event });

    expect(state?.findings[0]).toMatchObject({
      status: "open",
      lastCommentedHeadSha: "head",
    });
  });

  it("replies to and resolves stale inline threads for resolved findings", async () => {
    const { client, finding, publicationPlan } = staleResolutionFixture({ resolved: false });

    const result = await publishPublicationPlan({ client, change: event, plan: publicationPlan });

    expect(result.inlineComments).toEqual({ posted: 0, skipped: 0, failed: 0 });
    expect(client.reviewReplies).toHaveLength(1);
    expect(client.reviewReplies[0]).toMatchObject({ commentId: 10 });
    expect(client.reviewReplies[0]?.body).toContain(
      renderResolvedFindingMarker(finding.id, "old-head"),
    );
    expect(client.reviewReplies[0]?.body).toContain(
      "Resolved in https://github.com/local/pipr/commit/head.",
    );
    expect(client.resolvedThreadIds).toEqual(["thread-1"]);
    expect(client.reviewThreads[0]?.isResolved).toBe(true);
  });

  it("does not duplicate stale inline resolution replies", async () => {
    const { client, publicationPlan } = staleResolutionFixture({
      resolved: true,
      withResolutionReply: true,
    });

    await publishPublicationPlan({ client, change: event, plan: publicationPlan });

    expect(client.reviewReplies).toHaveLength(0);
    expect(client.resolvedThreadIds).toHaveLength(0);
  });

  it("does not add a new resolution reply for each rerun head", async () => {
    const { client, publicationPlan } = staleResolutionFixture({
      resolved: false,
      withResolutionReply: true,
    });

    await publishPublicationPlan({ client, change: event, plan: publicationPlan });

    expect(client.reviewReplies).toHaveLength(0);
    expect(client.resolvedThreadIds).toEqual(["thread-1"]);
  });

  it("replies again when the same finding is reintroduced on a new inline thread", async () => {
    const { client, finding, publicationPlan } = staleResolutionFixture({
      resolved: false,
      withResolutionReply: true,
    });
    client.reviewComments.push(
      fakeReviewComment({
        id: 12,
        body: `${renderInlineFindingMarker(finding.id, "new-head")}\n\nThis can fail again.`,
        authorLogin: client.ownerLogin,
      }),
    );
    client.reviewThreads.push({ id: "thread-2", isResolved: false, commentIds: [12] });
    publicationPlan.reviewState.findings[0] = {
      ...finding,
      lastCommentedHeadSha: "new-head",
    };

    await publishPublicationPlan({ client, change: event, plan: publicationPlan });

    expect(client.reviewReplies).toHaveLength(1);
    expect(client.reviewReplies[0]?.commentId).toBe(12);
    expect(client.reviewReplies[0]?.body).toContain(
      renderResolvedFindingMarker(finding.id, "new-head"),
    );
    expect(client.resolvedThreadIds).toEqual(["thread-2"]);
  });

  for (const testCase of [
    {
      name: "keeps review publication successful when stale inline reply cleanup fails",
      fail: (client: FakePublicationClient) => {
        client.failReply = true;
      },
      errors: ["reply to resolved finding 'fnd_existing': reply failed"],
      replyCount: 0,
      resolvedThreadIds: ["thread-1"],
    },
    {
      name: "keeps review publication successful when stale inline thread resolve fails",
      fail: (client: FakePublicationClient) => {
        client.failResolve = true;
      },
      errors: ["resolve thread 'thread-1' for finding 'fnd_existing': resolve failed"],
      replyCount: 1,
      resolvedThreadIds: [],
    },
  ]) {
    it(testCase.name, async () => {
      const { client, publicationPlan } = staleResolutionFixture({ resolved: false });
      testCase.fail(client);

      const result = await publishPublicationPlan({ client, change: event, plan: publicationPlan });

      expect(result.inlineComments).toEqual({ posted: 0, skipped: 0, failed: 0 });
      expect(result.metadata.inlineResolutionErrors).toEqual(testCase.errors);
      expect(client.reviewReplies).toHaveLength(testCase.replyCount);
      expect(client.resolvedThreadIds).toEqual(testCase.resolvedThreadIds);
    });
  }

  it("ignores main comment markers from other authors", async () => {
    const client = new FakePublicationClient("head");
    client.issueComments.push({
      id: 10,
      body: plan().mainComment,
      authorLogin: "attacker",
    });

    const result = await publishPublicationPlan({ client, change: event, plan: plan() });

    expect(result.mainComment.action).toBe("created");
    expect(client.issueComments).toHaveLength(2);
  });

  it("updates the main comment when state decoding fails but marker identity matches", async () => {
    const client = new FakePublicationClient("head");
    client.issueComments.push({
      id: 10,
      body: "<!-- pipr:main-comment change=1 version=1 state=bad-state -->\n\nold",
      authorLogin: client.ownerLogin,
    });

    const result = await publishPublicationPlan({ client, change: event, plan: plan() });

    expect(result.mainComment).toEqual({ action: "updated", id: 10 });
    expect(client.issueComments).toHaveLength(1);
    expect(client.issueComments[0]?.body).toContain("# pipr Review");
  });

  it("ignores inline markers from other authors", async () => {
    const client = new FakePublicationClient("head");
    const publicationPlan = plan({ maxInlineComments: 1 });
    addExistingInlineComment(client, publicationPlan, "attacker");

    const result = await publishPublicationPlan({ client, change: event, plan: publicationPlan });

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
      publishPublicationPlan({ client, change: event, plan: plan({ maxInlineComments: 1 }) }),
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

    await expect(
      publishPublicationPlan({ client, change: event, plan: publicationPlan }),
    ).rejects.toThrow("GitHub inline comment publication failed");
    expect(client.reviewCommentPayloads).toHaveLength(0);
  });
});

describe("createGitHubPublicationClient", () => {
  it("uses the GitHub Actions bot login without calling the user endpoint", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;

    const client = createGitHubPublicationClient({
      GITHUB_ACTIONS: "true",
      GITHUB_API_URL: "https://api.github.test",
      GITHUB_TOKEN: "actions-token",
    });

    await expect(client.getAuthenticatedUserLogin()).resolves.toBe("github-actions[bot]");
    expect(called).toBe(false);
  });

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

  it("uses GitHub review reply and review thread APIs", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    globalThis.fetch = mockGitHubReviewThreadApi(requests);

    const client = createGitHubPublicationClient({
      GITHUB_API_URL: "https://api.github.test",
      GITHUB_TOKEN: "actions-token",
    });

    await expect(
      client.createReviewCommentReply({
        repo: "local/pipr",
        pullRequestNumber: 1,
        commentId: 10,
        body: "Resolved.",
      }),
    ).resolves.toMatchObject({ id: 42, body: "resolved" });
    await expect(
      client.listReviewThreads({ repo: "local/pipr", pullRequestNumber: 1 }),
    ).resolves.toEqual([{ id: "thread-1", isResolved: false, commentIds: [10, 42] }]);
    await expect(client.resolveReviewThread({ threadId: "thread-1" })).resolves.toBeUndefined();
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.github.test/repos/local/pipr/pulls/1/comments/10/replies",
      "https://api.github.test/graphql",
      "https://api.github.test/graphql",
    ]);
  });
});

function addExistingInlineComment(
  client: FakePublicationClient,
  publicationPlan: ReturnType<typeof plan>,
  authorLogin: string,
): void {
  client.reviewComments.push(
    fakeReviewComment({
      id: 10,
      body: firstInlineBody(publicationPlan),
      authorLogin,
    }),
  );
}

function addStaleInlineThread(
  client: FakePublicationClient,
  finding: PriorReviewState["findings"][number],
  options: { resolved: boolean; withResolutionReply?: boolean },
): void {
  client.reviewComments.push(
    fakeReviewComment({
      id: 10,
      body: `${renderInlineFindingMarker(finding.id, "old-head")}\n\nThis can fail.`,
      authorLogin: client.ownerLogin,
    }),
  );
  const commentIds = [10];
  if (options.withResolutionReply) {
    client.reviewComments.push(
      fakeReviewComment({
        id: 11,
        body: renderResolvedFindingMarker(finding.id, "old-head"),
        authorLogin: client.ownerLogin,
      }),
    );
    commentIds.push(11);
  }
  client.reviewThreads.push({ id: "thread-1", isResolved: options.resolved, commentIds });
}

function staleResolutionFixture(options: { resolved: boolean; withResolutionReply?: boolean }): {
  client: FakePublicationClient;
  finding: PriorReviewState["findings"][number];
  publicationPlan: ReturnType<typeof resolvedPriorPlan>;
} {
  const client = new FakePublicationClient("head");
  const publicationPlan = resolvedPriorPlan();
  const finding = resolvedFindingFrom(publicationPlan);
  addStaleInlineThread(client, finding, options);
  return { client, finding, publicationPlan };
}

function firstInlineBody(publicationPlan: ReturnType<typeof plan>): string {
  const body = publicationPlan.inlineItems[0]?.body;
  if (!body) {
    throw new Error("test fixture missing inline item");
  }
  return body;
}

function resolvedFindingFrom(
  publicationPlan: ReturnType<typeof resolvedPriorPlan>,
): PriorReviewState["findings"][number] {
  const finding = publicationPlan.reviewState.findings[0];
  if (!finding) {
    throw new Error("test fixture missing resolved finding");
  }
  return finding;
}

function mockGitHubReviewThreadApi(requests: Array<{ url: string; body: string }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = {
      url: input instanceof Request ? input.url : String(input),
      body: await gitHubRequestBody(input, init),
    };
    requests.push(request);
    return gitHubReviewThreadApiResponse(request);
  }) as typeof fetch;
}

async function gitHubRequestBody(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<string> {
  if (input instanceof Request) {
    return input.clone().text();
  }
  return typeof init?.body === "string" ? init.body : "";
}

function gitHubReviewThreadApiResponse(request: { url: string; body: string }): Response {
  if (request.url.endsWith("/repos/local/pipr/pulls/1/comments/10/replies")) {
    return jsonResponse({ id: 42, body: "resolved" });
  }
  if (request.body.includes("PiprReviewThreads")) {
    return jsonResponse(reviewThreadsGraphqlResponse());
  }
  if (request.body.includes("PiprResolveReviewThread")) {
    return jsonResponse(resolveReviewThreadGraphqlResponse());
  }
  throw new Error(`unexpected request ${request.url}`);
}

function reviewThreadsGraphqlResponse() {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "thread-1",
                isResolved: false,
                comments: {
                  nodes: [{ databaseId: 10 }, { databaseId: 42 }],
                },
              },
            ],
          },
        },
      },
    },
  };
}

function resolveReviewThreadGraphqlResponse() {
  return {
    data: {
      resolveReviewThread: {
        thread: { id: "thread-1", isResolved: true },
      },
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function plan(options: { maxInlineComments?: number; validated?: ValidatedReview } = {}) {
  const review = options.validated ?? validated;
  return buildPublicationPlan({
    event,
    main: review.review.summary.body,
    inlineItems: prepareInlinePublicationItems({
      validated: review,
      manifest,
      reviewedHeadSha: "head",
    }),
    maxInlineComments: options.maxInlineComments,
    metadata: {
      runtimeVersion,
      trustedConfigSha: "base",
      trustedConfigHash: "hash",
      reviewedHeadSha: "head",
      selectedTasks: ["review"],
      failedTasks: [],
      validFindings: review.validFindings.length,
      droppedFindings: 0,
    },
  });
}

function resolvedPriorPlan() {
  const reviewState: PriorReviewState = {
    version: 1,
    reviewedHeadSha: "head",
    selectedTasks: ["review"],
    findings: [
      {
        id: "fnd_existing",
        status: "resolved",
        path: "src/a.ts",
        rangeId: "range-1",
        side: "RIGHT",
        startLine: 10,
        endLine: 12,
        firstSeenHeadSha: "old-head",
        lastSeenHeadSha: "old-head",
        lastCommentedHeadSha: "old-head",
      },
    ],
  };
  return buildPublicationPlan({
    event,
    main: "Review completed.",
    inlineItems: [],
    metadata: {
      runtimeVersion,
      trustedConfigSha: "base",
      trustedConfigHash: "hash",
      reviewedHeadSha: "head",
      selectedTasks: ["review"],
      failedTasks: [],
      validFindings: 0,
      droppedFindings: 0,
    },
    reviewState,
  });
}

type FakeReviewComment = Awaited<ReturnType<GitHubPublicationClient["listReviewComments"]>>[number];
type FakeReviewThread = Awaited<ReturnType<GitHubPublicationClient["listReviewThreads"]>>[number];

function fakeReviewComment(options: {
  id: number;
  body?: string | null;
  authorLogin?: string;
  path?: string;
  commitId?: string;
  line?: number;
  startLine?: number;
  side?: "RIGHT" | "LEFT";
  startSide?: "RIGHT" | "LEFT";
}): FakeReviewComment {
  return {
    id: options.id,
    body: options.body,
    authorLogin: options.authorLogin,
    path: options.path,
    commitId: options.commitId,
    line: options.line,
    startLine: options.startLine,
    side: options.side,
    startSide: options.startSide,
  };
}

class FakePublicationClient implements GitHubPublicationClient {
  readonly ownerLogin = "github-actions[bot]";
  issueComments: Array<{ id: number; body: string; authorLogin: string | undefined }> = [];
  reviewComments: FakeReviewComment[] = [];
  reviewThreads: FakeReviewThread[] = [];
  reviewCommentPayloads: unknown[] = [];
  reviewReplies: Array<{ commentId: number; body: string }> = [];
  resolvedThreadIds: string[] = [];
  failInline = false;
  failReply = false;
  failResolve = false;

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

  async listReviewThreads() {
    return this.reviewThreads;
  }

  async createReviewComment(options: unknown) {
    if (this.failInline) {
      throw new Error("inline failed");
    }
    const payload = options as {
      body?: unknown;
      path?: string;
      commit_id?: string;
      line?: number;
      start_line?: number;
      side?: "RIGHT" | "LEFT";
      start_side?: "RIGHT" | "LEFT";
    };
    this.reviewCommentPayloads.push(options);
    this.reviewComments.push(
      fakeReviewComment({
        id: this.reviewCommentPayloads.length,
        body: typeof payload.body === "string" ? payload.body : "",
        authorLogin: this.ownerLogin,
        path: payload.path,
        commitId: payload.commit_id,
        line: payload.line,
        startLine: payload.start_line,
        side: payload.side,
        startSide: payload.start_side,
      }),
    );
    return { id: this.reviewCommentPayloads.length };
  }

  async createReviewCommentReply(options: { commentId: number; body: string }) {
    if (this.failReply) {
      throw new Error("reply failed");
    }
    const id = this.reviewComments.length + 1;
    this.reviewReplies.push(options);
    this.reviewComments.push(
      fakeReviewComment({
        id,
        body: options.body,
        authorLogin: this.ownerLogin,
      }),
    );
    return { id };
  }

  async resolveReviewThread(options: { threadId: string }) {
    if (this.failResolve) {
      throw new Error("resolve failed");
    }
    const thread = this.reviewThreads.find((item) => item.id === options.threadId);
    if (!thread) {
      throw new Error(`missing thread ${options.threadId}`);
    }
    thread.isResolved = true;
    this.resolvedThreadIds.push(options.threadId);
  }
}
