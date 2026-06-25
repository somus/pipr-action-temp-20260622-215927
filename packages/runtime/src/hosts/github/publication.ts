import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { firstNonEmptyLine } from "../../commands/grammar.js";
import type { PublicationPlan } from "../../review/comment.js";
import {
  applyInlineFindingMarkers,
  applyResolvedFindingMarkers,
  extractInlineFindingMarkerRecords,
  extractPriorReviewState,
  extractResolvedFindingMarkerRecords,
  extractVerifierResponseMarkers,
  mainCommentMarker,
  type PriorReviewState,
  parseMainCommentIdentity,
  renderResolvedFindingMarker,
  renderVerifierResponseMarker,
} from "../../review/prior-state.js";
import { PublicationError, type PublicationResult } from "../../review/publication-result.js";
import { githubApiVersion, parseRepoSlug } from "../../shared/github.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type { InlineThreadContext } from "../types.js";
import { mapFindingToGithubReviewCommentLocation } from "./inline.js";

const commandResponseMarker = "pipr:command-response";

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

const githubCheckRunSchema = z.looseObject({
  id: z.number().int().positive(),
  name: z.string().min(1),
});

export type GitHubIssueComment = z.infer<typeof githubIssueCommentSchema>;
export type GitHubReviewComment = z.infer<typeof githubReviewCommentSchema>;
export type GitHubReviewThread = z.infer<typeof githubReviewThreadSchema>;
export type GitHubCheckRun = z.infer<typeof githubCheckRunSchema>;

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
  createCheckRun(options: {
    repo: string;
    name: string;
    headSha: string;
    summary?: string;
  }): Promise<GitHubCheckRun>;
  updateCheckRun(options: {
    repo: string;
    checkRunId: number;
    name: string;
    conclusion: "success" | "failure" | "neutral";
    summary?: string;
  }): Promise<void>;
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
    async createCheckRun(options) {
      const repo = parseRepoSlug(options.repo);
      const { data } = await octokit.rest.checks.create({
        ...repo,
        name: options.name,
        head_sha: options.headSha,
        status: "in_progress",
        output: {
          title: options.name,
          summary: options.summary ?? "pipr is running.",
        },
      });
      return githubCheckRunSchema.parse(data);
    },
    async updateCheckRun(options) {
      const repo = parseRepoSlug(options.repo);
      await octokit.rest.checks.update({
        ...repo,
        check_run_id: options.checkRunId,
        name: options.name,
        status: "completed",
        conclusion: options.conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: options.name,
          summary: options.summary ?? checkRunSummary(options.conclusion),
        },
      });
    },
  };
}

function checkRunSummary(conclusion: "success" | "failure" | "neutral"): string {
  switch (conclusion) {
    case "success":
      return "pipr completed successfully.";
    case "failure":
      return "pipr failed.";
    case "neutral":
      return "pipr skipped this check.";
  }
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
  const mainComment = await loadGitHubPriorMainComment({ ...options, ownerLogin });
  const state = extractPriorReviewState(mainComment, options.change.change.number);
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
  return applyResolvedFindingMarkers(applyInlineFindingMarkers(state, inlineBodies), inlineBodies);
}

export async function loadGitHubInlineThreadContexts(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
}): Promise<InlineThreadContext[]> {
  const ownerLogin = await options.client.getAuthenticatedUserLogin();
  const comments = await options.client.listReviewComments({
    repo: options.change.repository.slug,
    pullRequestNumber: options.change.change.number,
  });
  const ownerComments = comments.filter((comment) => comment.authorLogin === ownerLogin);
  const threads = await options.client.listReviewThreads({
    repo: options.change.repository.slug,
    pullRequestNumber: options.change.change.number,
  });
  const threadByCommentId = reviewThreadByCommentId(threads);
  const commentById = new Map(comments.map((comment) => [comment.id, comment]));

  return ownerComments.flatMap((comment) => {
    const marker = extractInlineFindingMarkerRecords([comment.body ?? ""])[0];
    if (!marker) {
      return [];
    }
    const thread = threadByCommentId.get(comment.id);
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: comment.id,
        parentBody: comment.body ?? "",
        threadId: thread?.id,
        threadResolved: thread?.isResolved ?? false,
        comments:
          thread?.commentIds.flatMap((id) => {
            const item = commentById.get(id);
            return item
              ? [
                  {
                    id: item.id,
                    body: item.body ?? "",
                    authorLogin: item.authorLogin,
                  },
                ]
              : [];
          }) ?? [],
      },
    ];
  });
}

export async function loadGitHubPriorMainComment(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  ownerLogin?: string;
}): Promise<string | undefined> {
  const ownerLogin = options.ownerLogin ?? (await options.client.getAuthenticatedUserLogin());
  const mainComment = findMainComment(
    await options.client.listIssueComments({
      repo: options.change.repository.slug,
      issueNumber: options.change.change.number,
    }),
    mainCommentMarker,
    options.change.change.number,
    ownerLogin,
  );
  return mainComment?.body ?? undefined;
}

export async function publishGitHubPublicationPlan(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  plan: PublicationPlan;
}): Promise<PublicationResult> {
  await assertCurrentHeadSha(options.client, options.change, options.plan.metadata.reviewedHeadSha);

  const ownerLogin = await options.client.getAuthenticatedUserLogin();
  const mainComment = await upsertMainComment({ ...options, ownerLogin });
  const existingReviewComments = await listOwnedReviewComments({ ...options, ownerLogin });
  const inline = await publishInlineComments({ ...options, ownerLogin, existingReviewComments });
  const threadActions = await publishThreadActions({
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
      inlineResolutionErrors: threadActions.errors,
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

export async function publishGitHubCommandResponse(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  sourceCommentId: number;
  commandName: string;
  body: string;
}): Promise<{ action: "created" | "updated"; id: number }> {
  await assertCurrentHeadSha(options.client, options.change, options.change.change.head.sha);

  const ownerLogin = await options.client.getAuthenticatedUserLogin();
  const marker = renderCommandResponseMarker({
    changeNumber: options.change.change.number,
    sourceCommentId: options.sourceCommentId,
    commandName: options.commandName,
  });
  const body = [marker, "", options.body, ""].join("\n");
  const existing = findCommandResponseComment(
    await options.client.listIssueComments({
      repo: options.change.repository.slug,
      issueNumber: options.change.change.number,
    }),
    marker,
    ownerLogin,
  );
  if (existing) {
    const updated = await options.client.updateIssueComment({
      repo: options.change.repository.slug,
      commentId: existing.id,
      body,
    });
    return { action: "updated", id: updated.id };
  }
  const created = await options.client.createIssueComment({
    repo: options.change.repository.slug,
    issueNumber: options.change.change.number,
    body,
  });
  return { action: "created", id: created.id };
}

export async function publishGitHubThreadActions(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  actions: PublicationPlan["threadActions"];
  reviewedHeadSha: string;
}): Promise<{ errors: string[] }> {
  if (options.actions.length === 0) {
    return { errors: [] };
  }
  const headMismatch = await currentHeadShaMismatch(
    options.client,
    options.change,
    options.reviewedHeadSha,
  );
  if (headMismatch) {
    return { errors: [headMismatch] };
  }
  const ownerLogin = await options.client.getAuthenticatedUserLogin();
  const existingReviewComments = await listOwnedReviewComments({ ...options, ownerLogin });
  return await publishThreadActions({ ...options, existingReviewComments });
}

async function assertCurrentHeadSha(
  client: GitHubPublicationClient,
  change: ChangeRequestEventContext,
  reviewedHeadSha: string,
): Promise<void> {
  const headMismatch = await currentHeadShaMismatch(client, change, reviewedHeadSha);
  if (headMismatch) {
    throw new PublicationError(headMismatch, undefined);
  }
}

async function currentHeadShaMismatch(
  client: GitHubPublicationClient,
  change: ChangeRequestEventContext,
  reviewedHeadSha: string,
): Promise<string | undefined> {
  const currentHeadSha = await client.getPullRequestHeadSha({
    repo: change.repository.slug,
    pullRequestNumber: change.change.number,
  });
  return currentHeadSha === reviewedHeadSha
    ? undefined
    : `Change request head changed from '${reviewedHeadSha}' to '${currentHeadSha}' before publication`;
}

async function listOwnedReviewComments(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  ownerLogin: string;
}): Promise<GitHubReviewComment[]> {
  return (
    await options.client.listReviewComments({
      repo: options.change.repository.slug,
      pullRequestNumber: options.change.change.number,
    })
  ).filter((comment) => comment.authorLogin === options.ownerLogin);
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

async function publishThreadActions(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  actions?: PublicationPlan["threadActions"];
  plan?: PublicationPlan;
  reviewedHeadSha?: string;
  existingReviewComments: GitHubReviewComment[];
}): Promise<{ errors: string[] }> {
  const actions = options.actions ?? options.plan?.threadActions ?? [];
  if (actions.length === 0) {
    return { errors: [] };
  }
  const context: ThreadActionContext = {
    client: options.client,
    change: options.change,
    reviewedHeadSha: threadActionHeadSha(options),
    commitUrl: commitUrlFor(options.change, threadActionHeadSha(options)),
    resolvedKeys: new Set(
      extractResolvedFindingMarkerRecords(
        options.existingReviewComments.map((comment) => comment.body ?? ""),
      ).map((record) => `${record.id}:${record.head}`),
    ),
    responseMarkers: extractVerifierResponseMarkers(
      options.existingReviewComments.map((comment) => comment.body ?? ""),
    ),
    threadById: new Map<string, GitHubReviewThread>(),
    threadByCommentId: new Map<number, GitHubReviewThread>(),
  };
  const errors: string[] = [];
  const threadLoad = await loadThreadActionThreads(context, actions);
  context.threadById = threadLoad.threads;
  context.threadByCommentId = threadLoad.threadsByCommentId;
  if (threadLoad.error) {
    errors.push(threadLoad.error);
  }
  for (const action of actions) {
    errors.push(...(await publishThreadAction(context, action)));
  }
  return { errors };
}

function threadActionHeadSha(options: {
  plan?: PublicationPlan;
  reviewedHeadSha?: string;
  change: ChangeRequestEventContext;
}): string {
  return (
    options.reviewedHeadSha ??
    options.plan?.metadata.reviewedHeadSha ??
    options.change.change.head.sha
  );
}

type ThreadActionContext = {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  reviewedHeadSha: string;
  commitUrl: string;
  resolvedKeys: Set<string>;
  responseMarkers: Set<string>;
  threadById: Map<string, GitHubReviewThread>;
  threadByCommentId: Map<number, GitHubReviewThread>;
};

async function publishThreadAction(
  context: ThreadActionContext,
  action: PublicationPlan["threadActions"][number],
): Promise<string[]> {
  const errors: string[] = [];
  if (action.kind === "resolve" && threadActionAlreadyResolved(context, action)) {
    return errors;
  }
  const replyError = await postThreadActionReplyIfNeeded(context, action);
  if (replyError) {
    errors.push(replyError);
  }
  if (action.kind === "resolve") {
    const resolveError = await resolveReviewThread(context, action);
    if (resolveError) {
      errors.push(resolveError);
    }
  }
  return errors;
}

function threadActionAlreadyResolved(
  context: ThreadActionContext,
  action: PublicationPlan["threadActions"][number],
): boolean {
  return action.kind === "resolve" && Boolean(threadForAction(context, action)?.isResolved);
}

async function postThreadActionReplyIfNeeded(
  context: ThreadActionContext,
  action: PublicationPlan["threadActions"][number],
): Promise<string | undefined> {
  const marker = threadActionReplyMarker(action);
  if (threadActionReplyExists(context, action, marker.key)) {
    return undefined;
  }
  try {
    await context.client.createReviewCommentReply({
      repo: context.change.repository.slug,
      pullRequestNumber: context.change.change.number,
      commentId: action.commentId,
      body: [marker.body, "", escapeGeneratedThreadReply(action.body)].join("\n"),
    });
    recordThreadActionReply(context, action, marker.key);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `reply to verifier action '${action.findingId}': ${message}`;
  }
}

function escapeGeneratedThreadReply(body: string): string {
  return body.replaceAll("<!--", "&lt;!--");
}

async function loadThreadActionThreads(
  context: ThreadActionContext,
  actions: PublicationPlan["threadActions"],
): Promise<{
  threads: Map<string, GitHubReviewThread>;
  threadsByCommentId: Map<number, GitHubReviewThread>;
  error?: string;
}> {
  if (!actions.some((action) => action.kind === "resolve")) {
    return { threads: new Map(), threadsByCommentId: new Map() };
  }
  try {
    const threads = await context.client.listReviewThreads({
      repo: context.change.repository.slug,
      pullRequestNumber: context.change.change.number,
    });
    return {
      threads: new Map(threads.map((thread) => [thread.id, thread])),
      threadsByCommentId: reviewThreadByCommentId(threads),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      threads: new Map(),
      threadsByCommentId: new Map(),
      error: `list review threads for verifier actions: ${message}`,
    };
  }
}

function threadActionReplyMarker(action: PublicationPlan["threadActions"][number]): {
  body: string;
  key: string;
} {
  if (action.kind === "resolve") {
    return {
      body: renderResolvedFindingMarker(action.findingId, action.findingHeadSha),
      key: `${action.findingId}:${action.findingHeadSha}`,
    };
  }
  return {
    body: renderVerifierResponseMarker(action.findingId, action.responseKey),
    key: `pipr:verifier-response:${action.findingId}:${action.responseKey}`,
  };
}

function threadActionReplyExists(
  context: ThreadActionContext,
  action: PublicationPlan["threadActions"][number],
  markerKey: string,
): boolean {
  return action.kind === "resolve"
    ? context.resolvedKeys.has(markerKey)
    : context.responseMarkers.has(markerKey);
}

function recordThreadActionReply(
  context: ThreadActionContext,
  action: PublicationPlan["threadActions"][number],
  markerKey: string,
): void {
  if (action.kind === "resolve") {
    context.resolvedKeys.add(markerKey);
    return;
  }
  context.responseMarkers.add(markerKey);
}

async function resolveReviewThread(
  context: ThreadActionContext,
  action: PublicationPlan["threadActions"][number],
): Promise<string | undefined> {
  const thread = threadForAction(context, action);
  const threadId = action.threadId ?? thread?.id;
  if (!threadId) {
    return `GitHub review thread not found for pipr finding '${action.findingId}'`;
  }
  try {
    if (thread?.isResolved) {
      return undefined;
    }
    await context.client.resolveReviewThread({ threadId });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `resolve thread '${threadId}' for finding '${action.findingId}': ${message}`;
  }
}

function threadForAction(
  context: ThreadActionContext,
  action: PublicationPlan["threadActions"][number],
): GitHubReviewThread | undefined {
  if (action.kind !== "resolve") {
    return undefined;
  }
  return (
    (action.threadId ? context.threadById.get(action.threadId) : undefined) ??
    context.threadByCommentId.get(action.commentId)
  );
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
  return findOwnedIssueComment(comments, ownerLogin, (firstLine) => {
    const parsed = parseMainCommentIdentity(firstLine);
    return parsed?.marker === marker && parsed.changeNumber === changeNumber;
  });
}

function findCommandResponseComment(
  comments: GitHubIssueComment[],
  marker: string,
  ownerLogin: string,
): GitHubIssueComment | undefined {
  return findOwnedIssueComment(comments, ownerLogin, (firstLine) => firstLine === marker);
}

function findOwnedIssueComment(
  comments: GitHubIssueComment[],
  ownerLogin: string,
  matchesFirstLine: (firstLine: string | undefined) => boolean,
): GitHubIssueComment | undefined {
  return comments.find((comment) => {
    if (comment.authorLogin !== ownerLogin) {
      return false;
    }
    const firstLine =
      comment.body === null || comment.body === undefined
        ? undefined
        : firstNonEmptyLine(comment.body);
    return matchesFirstLine(firstLine);
  });
}

function renderCommandResponseMarker(options: {
  changeNumber: number;
  sourceCommentId: number;
  commandName: string;
}): string {
  return `<!-- ${commandResponseMarker} change=${options.changeNumber} source=${options.sourceCommentId} command=${options.commandName} -->`;
}
