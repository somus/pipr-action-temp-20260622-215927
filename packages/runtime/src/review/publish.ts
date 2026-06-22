import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { firstNonEmptyLine } from "../commands/grammar.js";
import { githubApiVersion, parseRepoSlug } from "../shared/github.js";
import type { PullRequestEventContext } from "../types.js";
import {
  extractFindingMarkers,
  type InlinePublicationItem,
  type PublicationMetadata,
  type PublicationPlan,
} from "./comment.js";
import { mapFindingToGithubReviewCommentLocation } from "./github.js";

const githubIssueCommentSchema = z
  .looseObject({
    id: z.number().int().positive(),
    body: z.string().nullable().optional(),
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
  }));

const githubReviewCommentSchema = z
  .looseObject({
    id: z.number().int().positive(),
    body: z.string().nullable().optional(),
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
  }));

const githubAuthenticatedUserSchema = z.looseObject({
  login: z.string().min(1),
});

const pullRequestHeadSchema = z.looseObject({
  head: z.looseObject({
    sha: z.string().min(1),
  }),
});

export type GitHubIssueComment = z.infer<typeof githubIssueCommentSchema>;
export type GitHubReviewComment = z.infer<typeof githubReviewCommentSchema>;

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
};

export type PublicationResult = {
  mainComment: {
    action: "created" | "updated";
    id: number;
  };
  inlineComments: {
    posted: number;
    skipped: number;
    failed: number;
  };
  metadata: PublicationMetadata & {
    inlinePublicationErrors: string[];
  };
};

/** Error thrown when GitHub publication fails after producing partial result metadata. */
export class PublicationError extends Error {
  constructor(
    message: string,
    readonly result: Omit<PublicationResult, "mainComment"> | undefined,
  ) {
    super(message);
  }
}

export function createGitHubPublicationClient(
  env: NodeJS.ProcessEnv = process.env,
): GitHubPublicationClient {
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
  };
}

export async function publishPublicationPlan(options: {
  client: GitHubPublicationClient;
  event: Pick<PullRequestEventContext, "repo" | "pullRequestNumber" | "headSha">;
  plan: PublicationPlan;
}): Promise<PublicationResult> {
  const currentHeadSha = await options.client.getPullRequestHeadSha({
    repo: options.event.repo,
    pullRequestNumber: options.event.pullRequestNumber,
  });
  if (currentHeadSha !== options.plan.metadata.reviewedHeadSha) {
    throw new PublicationError(
      `PR head changed from '${options.plan.metadata.reviewedHeadSha}' to '${currentHeadSha}' before publication`,
      undefined,
    );
  }

  const ownerLogin = await options.client.getAuthenticatedUserLogin();
  const mainComment = await upsertMainComment({ ...options, ownerLogin });
  const inline = await publishInlineComments({ ...options, ownerLogin });
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
  event: Pick<PullRequestEventContext, "repo" | "pullRequestNumber">;
  plan: PublicationPlan;
  ownerLogin: string;
}): Promise<PublicationResult["mainComment"]> {
  const existing = findMainComment(
    await options.client.listIssueComments({
      repo: options.event.repo,
      issueNumber: options.event.pullRequestNumber,
    }),
    options.plan.mainMarker,
    options.event.pullRequestNumber,
    options.ownerLogin,
  );
  if (existing) {
    const updated = await options.client.updateIssueComment({
      repo: options.event.repo,
      commentId: existing.id,
      body: options.plan.mainComment,
    });
    return { action: "updated", id: updated.id };
  }
  const created = await options.client.createIssueComment({
    repo: options.event.repo,
    issueNumber: options.event.pullRequestNumber,
    body: options.plan.mainComment,
  });
  return { action: "created", id: created.id };
}

async function publishInlineComments(options: {
  client: GitHubPublicationClient;
  event: Pick<PullRequestEventContext, "repo" | "pullRequestNumber">;
  plan: PublicationPlan;
  ownerLogin: string;
}): Promise<{ posted: number; skipped: number; errors: string[] }> {
  const existingMarkers = extractFindingMarkers(
    (
      await options.client.listReviewComments({
        repo: options.event.repo,
        pullRequestNumber: options.event.pullRequestNumber,
      })
    )
      .filter((comment) => comment.authorLogin === options.ownerLogin)
      .map((comment) => comment.body ?? ""),
  );
  let posted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of options.plan.inlineItems) {
    if (existingMarkers.has(item.marker)) {
      skipped += 1;
      continue;
    }
    try {
      await options.client.createReviewComment({
        repo: options.event.repo,
        pullRequestNumber: options.event.pullRequestNumber,
        body: item.body,
        ...reviewCommentLocation(item),
      });
      existingMarkers.add(item.marker);
      posted += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { posted, skipped, errors };
}

function reviewCommentLocation(item: InlinePublicationItem): {
  path: string;
  commit_id: string;
  line: number;
  side: "RIGHT" | "LEFT";
  start_line?: number;
  start_side?: "RIGHT" | "LEFT";
} {
  return mapFindingToGithubReviewCommentLocation({
    finding: item.finding,
    range: item.range,
    headSha: item.reviewedHeadSha,
  });
}

function findMainComment(
  comments: GitHubIssueComment[],
  marker: string,
  pullRequestNumber: number,
  ownerLogin: string,
): GitHubIssueComment | undefined {
  const token = `<!-- ${marker} pr=${pullRequestNumber} -->`;
  return comments.find(
    (comment) =>
      comment.authorLogin === ownerLogin &&
      (comment.body === null || comment.body === undefined
        ? undefined
        : firstNonEmptyLine(comment.body)) === token,
  );
}
