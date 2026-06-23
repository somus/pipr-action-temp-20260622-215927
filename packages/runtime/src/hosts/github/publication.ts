import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { firstNonEmptyLine } from "../../commands/grammar.js";
import type { PublicationPlan } from "../../review/comment.js";
import {
  applyInlineFindingMarkers,
  extractInlineFindingMarkerRecords,
  extractPriorReviewState,
  extractResolvedFindingMarkerRecords,
  mainCommentMarker,
  type PriorFindingRecord,
  type PriorReviewState,
  parseMainCommentIdentity,
  renderResolvedFindingMarker,
} from "../../review/prior-state.js";
import { PublicationError, type PublicationResult } from "../../review/publication-result.js";
import { githubApiVersion, parseRepoSlug } from "../../shared/github.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { mapFindingToGithubReviewCommentLocation } from "./inline.js";

const githubCommentFields = {
  id: z.number().int().positive(),
  body: z.string().nullable().optional(),
  user: z
    .looseObject({
      login: z.string().min(1),
    })
    .optional(),
};

const githubIssueCommentSchema = z.looseObject(githubCommentFields).transform((comment) => ({
  id: comment.id,
  body: comment.body,
  authorLogin: comment.user?.login,
}));

const githubReviewCommentSchema = z
  .looseObject({
    ...githubCommentFields,
    path: z.string().min(1).optional(),
    commit_id: z.string().min(1).optional(),
    line: z.number().int().positive().nullable().optional(),
    start_line: z.number().int().positive().nullable().optional(),
    side: z.enum(["RIGHT", "LEFT"]).optional(),
    start_side: z.enum(["RIGHT", "LEFT"]).nullable().optional(),
    user: z
      .looseObject({
        login: z.string().min(1),
      })
      .optional(),
  })
  .transform((comment) => ({
    id: comment.id,
    body: comment.body,
    authorLogin: comment.user?.login,
    path: comment.path,
    commitId: comment.commit_id,
    line: comment.line ?? undefined,
    startLine: comment.start_line ?? undefined,
    side: comment.side,
    startSide: comment.start_side ?? undefined,
  }));

const githubReviewThreadSchema = z.strictObject({
  id: z.string().min(1),
  isResolved: z.boolean(),
  commentIds: z.array(z.number().int().positive()),
});

const githubReviewThreadsPageSchema = z
  .looseObject({
    repository: z
      .looseObject({
        pullRequest: z
          .looseObject({
            reviewThreads: z.looseObject({
              pageInfo: z.looseObject({
                hasNextPage: z.boolean(),
                endCursor: z.string().nullable().optional(),
              }),
              nodes: z.array(
                z.looseObject({
                  id: z.string().min(1),
                  isResolved: z.boolean().optional(),
                  comments: z.looseObject({
                    nodes: z.array(
                      z.looseObject({
                        databaseId: z.number().int().positive().nullable().optional(),
                      }),
                    ),
                  }),
                }),
              ),
            }),
          })
          .nullable()
          .optional(),
      })
      .optional(),
  })
  .transform((page) => {
    const reviewThreads = page.repository?.pullRequest?.reviewThreads;
    if (!reviewThreads) {
      throw new Error("GitHub pull request review threads were not found");
    }
    return {
      pageInfo: {
        hasNextPage: reviewThreads.pageInfo.hasNextPage,
        endCursor: reviewThreads.pageInfo.endCursor ?? undefined,
      },
      threads: reviewThreads.nodes.map((thread) =>
        githubReviewThreadSchema.parse({
          id: thread.id,
          isResolved: thread.isResolved ?? false,
          commentIds: thread.comments.nodes.flatMap((comment) =>
            comment.databaseId === undefined || comment.databaseId === null
              ? []
              : [comment.databaseId],
          ),
        }),
      ),
    };
  });

const githubAuthenticatedUserSchema = z.looseObject({
  login: z.string().min(1),
});
const githubActionsBotLogin = "github-actions[bot]";

const pullRequestHeadSchema = z.looseObject({
  head: z.looseObject({
    sha: z.string().min(1),
  }),
});

export type GitHubIssueComment = z.infer<typeof githubIssueCommentSchema>;
export type GitHubReviewComment = z.infer<typeof githubReviewCommentSchema>;
export type GitHubReviewThread = z.infer<typeof githubReviewThreadSchema>;

export type GitHubPublicationClient = {
  getAuthenticatedUserLogin(): Promise<string>;
  getPullRequestHeadSha(options: { repo: string; pullRequestNumber: number }): Promise<string>;
  listIssueComments(options: { repo: string; issueNumber: number }): Promise<GitHubIssueComment[]>;
  createIssueComment(options: {
    repo: string;
    issueNumber: number;
    body: string;
  }): Promise<{ id: number }>;
  updateIssueComment(options: {
    repo: string;
    commentId: number;
    body: string;
  }): Promise<{ id: number }>;
  listReviewComments(options: {
    repo: string;
    pullRequestNumber: number;
  }): Promise<GitHubReviewComment[]>;
  listReviewThreads(options: {
    repo: string;
    pullRequestNumber: number;
  }): Promise<GitHubReviewThread[]>;
  createReviewComment(options: {
    repo: string;
    pullRequestNumber: number;
    body: string;
    path: string;
    commit_id: string;
    line: number;
    side: "RIGHT" | "LEFT";
    start_line?: number;
    start_side?: "RIGHT" | "LEFT";
  }): Promise<{ id: number }>;
  createReviewCommentReply(options: {
    repo: string;
    pullRequestNumber: number;
    commentId: number;
    body: string;
  }): Promise<{ id: number }>;
  resolveReviewThread(options: { threadId: string }): Promise<void>;
};

export function createGitHubPublicationClient(
  env: NodeJS.ProcessEnv = process.env,
): GitHubPublicationClient {
  const authenticatedUserLogin = env.GITHUB_ACTIONS === "true" ? githubActionsBotLogin : undefined;
  const octokit = new Octokit({
    auth: env.GITHUB_TOKEN,
    baseUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    request: {
      headers: {
        "X-GitHub-Api-Version": githubApiVersion,
      },
    },
  });
  return {
    async getAuthenticatedUserLogin() {
      if (authenticatedUserLogin) {
        return authenticatedUserLogin;
      }
      const { data } = await octokit.rest.users.getAuthenticated();
      return githubAuthenticatedUserSchema.parse(data).login;
    },
    async getPullRequestHeadSha(options) {
      const repo = parseRepoSlug(options.repo);
      const { data } = await octokit.rest.pulls.get({
        ...repo,
        pull_number: options.pullRequestNumber,
      });
      const value = pullRequestHeadSchema.parse(data);
      return value.head.sha;
    },
    async listIssueComments(options) {
      const repo = parseRepoSlug(options.repo);
      return z.array(githubIssueCommentSchema).parse(
        await octokit.paginate(octokit.rest.issues.listComments, {
          ...repo,
          issue_number: options.issueNumber,
          per_page: 100,
        }),
      );
    },
    async createIssueComment(options) {
      const repo = parseRepoSlug(options.repo);
      const { data } = await octokit.rest.issues.createComment({
        ...repo,
        issue_number: options.issueNumber,
        body: options.body,
      });
      return githubIssueCommentSchema.parse(data);
    },
    async updateIssueComment(options) {
      const repo = parseRepoSlug(options.repo);
      const { data } = await octokit.rest.issues.updateComment({
        ...repo,
        comment_id: options.commentId,
        body: options.body,
      });
      return githubIssueCommentSchema.parse(data);
    },
    async listReviewComments(options) {
      const repo = parseRepoSlug(options.repo);
      return z.array(githubReviewCommentSchema).parse(
        await octokit.paginate(octokit.rest.pulls.listReviewComments, {
          ...repo,
          pull_number: options.pullRequestNumber,
          per_page: 100,
        }),
      );
    },
    async createReviewComment(options) {
      const { repo: repoSlug, pullRequestNumber, ...body } = options;
      const repo = parseRepoSlug(repoSlug);
      const { data } = await octokit.rest.pulls.createReviewComment({
        ...repo,
        pull_number: pullRequestNumber,
        ...body,
      });
      return githubReviewCommentSchema.parse(data);
    },
    async listReviewThreads(options) {
      const repo = parseRepoSlug(options.repo);
      const threads: GitHubReviewThread[] = [];
      let after: string | undefined;
      for (;;) {
        const page = githubReviewThreadsPageSchema.parse(
          await octokit.graphql(githubReviewThreadsQuery, {
            owner: repo.owner,
            name: repo.repo,
            number: options.pullRequestNumber,
            after: after ?? null,
          }),
        );
        threads.push(...page.threads);
        if (!page.pageInfo.hasNextPage) {
          return threads;
        }
        after = page.pageInfo.endCursor;
      }
    },
    async createReviewCommentReply(options) {
      const repo = parseRepoSlug(options.repo);
      const { data } = await octokit.rest.pulls.createReplyForReviewComment({
        ...repo,
        pull_number: options.pullRequestNumber,
        comment_id: options.commentId,
        body: options.body,
      });
      return githubReviewCommentSchema.parse(data);
    },
    async resolveReviewThread(options) {
      await octokit.graphql(githubResolveReviewThreadMutation, {
        threadId: options.threadId,
      });
    },
  };
}

const githubReviewThreadsQuery = /* GraphQL */ `
  query PiprReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
                databaseId
              }
            }
          }
        }
      }
    }
  }
`;

const githubResolveReviewThreadMutation = /* GraphQL */ `
  mutation PiprResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

export async function loadGitHubPriorReviewState(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
}): Promise<PriorReviewState | undefined> {
  const ownerLogin = await options.client.getAuthenticatedUserLogin();
  const mainComment = findMainComment(
    await options.client.listIssueComments({
      repo: options.change.repository.slug,
      issueNumber: options.change.change.number,
    }),
    mainCommentMarker,
    options.change.change.number,
    ownerLogin,
  );
  const state = extractPriorReviewState(mainComment?.body, options.change.change.number);
  if (!state) {
    return undefined;
  }
  const inlineBodies = (
    await options.client.listReviewComments({
      repo: options.change.repository.slug,
      pullRequestNumber: options.change.change.number,
    })
  )
    .filter((comment) => comment.authorLogin === ownerLogin)
    .map((comment) => comment.body ?? "");
  return applyInlineFindingMarkers(state, inlineBodies);
}

export async function publishGitHubPublicationPlan(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  plan: PublicationPlan;
}): Promise<PublicationResult> {
  const currentHeadSha = await options.client.getPullRequestHeadSha({
    repo: options.change.repository.slug,
    pullRequestNumber: options.change.change.number,
  });
  if (currentHeadSha !== options.plan.metadata.reviewedHeadSha) {
    throw new PublicationError(
      `Change request head changed from '${options.plan.metadata.reviewedHeadSha}' to '${currentHeadSha}' before publication`,
      undefined,
    );
  }

  const ownerLogin = await options.client.getAuthenticatedUserLogin();
  const mainComment = await upsertMainComment({ ...options, ownerLogin });
  const existingReviewComments = (
    await options.client.listReviewComments({
      repo: options.change.repository.slug,
      pullRequestNumber: options.change.change.number,
    })
  ).filter((comment) => comment.authorLogin === ownerLogin);
  const inline = await publishInlineComments({ ...options, ownerLogin, existingReviewComments });
  const resolvedInline = await resolveStaleInlineThreads({
    ...options,
    existingReviewComments,
  });
  const result: PublicationResult = {
    mainComment,
    inlineComments: {
      posted: inline.posted,
      skipped: inline.skipped,
      failed: inline.errors.length,
    },
    metadata: {
      ...options.plan.metadata,
      inlinePublicationErrors: inline.errors,
      inlineResolutionErrors: resolvedInline.errors,
    },
  };
  if (inline.errors.length > 0) {
    throw new PublicationError("GitHub inline comment publication failed", {
      inlineComments: result.inlineComments,
      metadata: result.metadata,
    });
  }
  return result;
}

async function upsertMainComment(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  plan: PublicationPlan;
  ownerLogin: string;
}): Promise<PublicationResult["mainComment"]> {
  const existing = findMainComment(
    await options.client.listIssueComments({
      repo: options.change.repository.slug,
      issueNumber: options.change.change.number,
    }),
    options.plan.mainMarker,
    options.change.change.number,
    options.ownerLogin,
  );
  if (existing) {
    const updated = await options.client.updateIssueComment({
      repo: options.change.repository.slug,
      commentId: existing.id,
      body: options.plan.mainComment,
    });
    return { action: "updated", id: updated.id };
  }
  const created = await options.client.createIssueComment({
    repo: options.change.repository.slug,
    issueNumber: options.change.change.number,
    body: options.plan.mainComment,
  });
  return { action: "created", id: created.id };
}

async function publishInlineComments(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  plan: PublicationPlan;
  ownerLogin: string;
  existingReviewComments: GitHubReviewComment[];
}): Promise<{ posted: number; skipped: number; errors: string[] }> {
  const existing = existingInlineCommentState(options.existingReviewComments);
  let posted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of options.plan.inlineItems) {
    const result = await publishInlineCommentItem({ ...options, existing, item });
    switch (result.status) {
      case "posted":
        posted += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
      case "failed":
        errors.push(result.error);
        break;
    }
  }

  return { posted, skipped, errors };
}

type ExistingInlineCommentState = {
  markers: Set<string>;
  comments: GitHubReviewComment[];
};

function existingInlineCommentState(comments: GitHubReviewComment[]): ExistingInlineCommentState {
  const state: ExistingInlineCommentState = { markers: new Set(), comments: [] };
  for (const comment of comments) {
    const markers = extractInlineFindingMarkerRecords([comment.body ?? ""]);
    if (markers.length === 0) {
      continue;
    }
    state.comments.push(comment);
    for (const marker of markers) {
      state.markers.add(marker.marker);
    }
  }
  return state;
}

async function publishInlineCommentItem(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  existing: ExistingInlineCommentState;
  item: PublicationPlan["inlineItems"][number];
}): Promise<{ status: "posted" | "skipped" } | { status: "failed"; error: string }> {
  let location: GitHubReviewCommentLocation;
  try {
    location = mapFindingToGithubReviewCommentLocation({
      finding: options.item.finding,
      range: options.item.range,
      headSha: options.item.reviewedHeadSha,
    });
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  if (
    options.existing.markers.has(options.item.marker) ||
    hasExistingLocation(options.existing.comments, location)
  ) {
    return { status: "skipped" };
  }
  try {
    await options.client.createReviewComment({
      repo: options.change.repository.slug,
      pullRequestNumber: options.change.change.number,
      body: options.item.body,
      ...location,
    });
    options.existing.markers.add(options.item.marker);
    return { status: "posted" };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

async function resolveStaleInlineThreads(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  plan: PublicationPlan;
  existingReviewComments: GitHubReviewComment[];
}): Promise<{ errors: string[] }> {
  const candidates = staleInlineResolutionCandidates({
    findings: options.plan.reviewState.findings,
    comments: options.existingReviewComments,
  });
  if (candidates.length === 0) {
    return { errors: [] };
  }

  const context = {
    client: options.client,
    change: options.change,
    reviewedHeadSha: options.plan.metadata.reviewedHeadSha,
    commitUrl: commitUrlFor(options.change, options.plan.metadata.reviewedHeadSha),
    resolvedFindingKeys: new Set(
      extractResolvedFindingMarkerRecords(
        options.existingReviewComments.map((comment) => comment.body ?? ""),
      ).map((record) => `${record.id}:${record.head}`),
    ),
    threadByCommentId: new Map<number, GitHubReviewThread>(),
  };
  const errors: string[] = [];
  try {
    context.threadByCommentId = reviewThreadByCommentId(
      await options.client.listReviewThreads({
        repo: options.change.repository.slug,
        pullRequestNumber: options.change.change.number,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`list review threads for resolved findings: ${message}`);
  }

  for (const candidate of candidates) {
    errors.push(...(await resolveStaleInlineCandidate(context, candidate)));
  }

  return { errors };
}

type StaleInlineResolutionCandidate = {
  finding: PriorFindingRecord;
  comment: GitHubReviewComment;
};

type StaleInlineResolutionContext = {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  reviewedHeadSha: string;
  commitUrl: string;
  resolvedFindingKeys: Set<string>;
  threadByCommentId: Map<number, GitHubReviewThread>;
};

function staleInlineResolutionCandidates(options: {
  findings: PriorFindingRecord[];
  comments: GitHubReviewComment[];
}): StaleInlineResolutionCandidate[] {
  return options.findings
    .filter(
      (finding) => finding.status === "resolved" && finding.lastCommentedHeadSha !== undefined,
    )
    .flatMap((finding) => {
      const comment = findInlineCommentForFinding(options.comments, finding);
      return comment ? [{ finding, comment }] : [];
    });
}

async function resolveStaleInlineCandidate(
  context: StaleInlineResolutionContext,
  candidate: StaleInlineResolutionCandidate,
): Promise<string[]> {
  const thread = context.threadByCommentId.get(candidate.comment.id);
  if (thread?.isResolved) {
    return [];
  }
  const errors: string[] = [];
  const replyError = await postResolutionReplyIfNeeded(context, candidate);
  if (replyError) {
    errors.push(replyError);
  }
  if (!thread) {
    errors.push(`GitHub review thread not found for pipr finding '${candidate.finding.id}'`);
    return errors;
  }
  const resolveError = await resolveReviewThreadIfOpen(context, candidate.finding, thread);
  if (resolveError) {
    errors.push(resolveError);
  }
  return errors;
}

async function postResolutionReplyIfNeeded(
  context: StaleInlineResolutionContext,
  candidate: StaleInlineResolutionCandidate,
): Promise<string | undefined> {
  const commentedHeadSha = candidate.finding.lastCommentedHeadSha;
  if (!commentedHeadSha) {
    return undefined;
  }
  const resolutionKey = `${candidate.finding.id}:${commentedHeadSha}`;
  if (context.resolvedFindingKeys.has(resolutionKey)) {
    return undefined;
  }
  try {
    await context.client.createReviewCommentReply({
      repo: context.change.repository.slug,
      pullRequestNumber: context.change.change.number,
      commentId: candidate.comment.id,
      body: [
        renderResolvedFindingMarker(candidate.finding.id, commentedHeadSha),
        "",
        `Resolved in ${context.commitUrl}.`,
      ].join("\n"),
    });
    context.resolvedFindingKeys.add(resolutionKey);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `reply to resolved finding '${candidate.finding.id}': ${message}`;
  }
}

async function resolveReviewThreadIfOpen(
  context: StaleInlineResolutionContext,
  finding: PriorFindingRecord,
  thread: GitHubReviewThread,
): Promise<string | undefined> {
  if (thread.isResolved) {
    return undefined;
  }
  try {
    await context.client.resolveReviewThread({ threadId: thread.id });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `resolve thread '${thread.id}' for finding '${finding.id}': ${message}`;
  }
}

function findInlineCommentForFinding(
  comments: GitHubReviewComment[],
  finding: PriorFindingRecord,
): GitHubReviewComment | undefined {
  const candidates = comments.flatMap((comment) =>
    extractInlineFindingMarkerRecords([comment.body ?? ""])
      .filter((marker) => marker.id === finding.id)
      .map((marker) => ({ marker, comment })),
  );
  const sameHead = candidates.find(
    (candidate) => candidate.marker.head === finding.lastCommentedHeadSha,
  );
  return sameHead?.comment ?? candidates.at(-1)?.comment;
}

function reviewThreadByCommentId(threads: GitHubReviewThread[]): Map<number, GitHubReviewThread> {
  const index = new Map<number, GitHubReviewThread>();
  for (const thread of threads) {
    for (const commentId of thread.commentIds) {
      index.set(commentId, thread);
    }
  }
  return index;
}

function commitUrlFor(change: ChangeRequestEventContext, sha: string): string {
  const repoUrl = change.repository.url ?? `https://github.com/${change.repository.slug}`;
  return `${repoUrl.replace(/\/$/, "")}/commit/${sha}`;
}

type GitHubReviewCommentLocation = {
  path: string;
  commit_id: string;
  line: number;
  side: "RIGHT" | "LEFT";
  start_line?: number;
  start_side?: "RIGHT" | "LEFT";
};

function hasExistingLocation(
  comments: GitHubReviewComment[],
  location: GitHubReviewCommentLocation,
): boolean {
  const targetStart = location.start_line ?? location.line;
  const targetEnd = location.line;
  return comments.some((comment) => {
    if (
      comment.path !== location.path ||
      comment.commitId !== location.commit_id ||
      comment.side !== location.side ||
      comment.line === undefined
    ) {
      return false;
    }
    const existingStart = comment.startLine ?? comment.line;
    const existingEnd = comment.line;
    return existingStart <= targetEnd && targetStart <= existingEnd;
  });
}

function findMainComment(
  comments: GitHubIssueComment[],
  marker: string,
  changeNumber: number,
  ownerLogin: string,
): GitHubIssueComment | undefined {
  return comments.find((comment) => {
    if (comment.authorLogin !== ownerLogin) {
      return false;
    }
    const firstLine =
      comment.body === null || comment.body === undefined
        ? undefined
        : firstNonEmptyLine(comment.body);
    const parsed = parseMainCommentIdentity(firstLine);
    return parsed?.marker === marker && parsed.changeNumber === changeNumber;
  });
}
