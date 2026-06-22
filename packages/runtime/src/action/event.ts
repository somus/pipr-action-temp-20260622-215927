import { z } from "zod";
import type { PullRequestEventContext } from "../types.js";
import { parsePullRequestEventContext } from "../types.js";

const githubPullRequestPayloadSchema = z.looseObject({
  action: z.string().optional(),
  number: z.number().optional(),
  repository: z
    .looseObject({
      full_name: z.string().optional(),
    })
    .optional(),
  pull_request: z.looseObject(
    {
      number: z.number().optional(),
      title: z.string().optional(),
      body: z.string().nullable().optional(),
      base: z
        .looseObject({
          sha: z.string().optional(),
          repo: z
            .looseObject({
              full_name: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
      head: z
        .looseObject({
          sha: z.string().optional(),
        })
        .optional(),
    },
    { error: "GitHub event payload does not contain pull_request" },
  ),
});

const githubIssueCommentPayloadSchema = z.looseObject({
  action: z.string().optional(),
  repository: z
    .looseObject({
      full_name: z.string().optional(),
    })
    .optional(),
  issue: z
    .looseObject({
      number: z.number().optional(),
      pull_request: z.unknown().optional(),
    })
    .optional(),
  comment: z
    .looseObject({
      body: z.string().optional(),
      user: z
        .looseObject({
          login: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

const pullRequestEventInputSchema = z.strictObject({
  eventName: z.string().min(1),
  action: z.string().optional(),
  repo: z.string({ error: "GitHub pull request event is missing repo" }).min(1),
  pullRequestNumber: z
    .number({ error: "GitHub pull request event is missing PR number" })
    .int()
    .positive(),
  title: z.string(),
  description: z.string(),
  baseSha: z.string({ error: "GitHub pull request event is missing base SHA" }).min(1),
  headSha: z.string({ error: "GitHub pull request event is missing head SHA" }).min(1),
  workspace: z.string().min(1),
});

const issueCommentEventContextSchema = z.strictObject({
  eventName: z.literal("issue_comment"),
  action: z.string().optional(),
  repo: z.string({ error: "GitHub issue comment event is missing repo" }).min(1),
  issueNumber: z
    .number({ error: "GitHub issue comment event is missing issue number" })
    .int()
    .positive(),
  isPullRequest: z.boolean(),
  commentBody: z.string(),
  commenter: z.string({ error: "GitHub issue comment event is missing comment user" }).min(1),
  workspace: z.string().min(1),
});

export type IssueCommentEventContext = {
  eventName: "issue_comment";
  action?: string;
  repo: string;
  issueNumber: number;
  isPullRequest: boolean;
  commentBody: string;
  commenter: string;
  workspace: string;
};

export async function loadPullRequestEventContext(
  eventPath: string,
  env: NodeJS.ProcessEnv,
): Promise<PullRequestEventContext> {
  const payload = githubPullRequestPayloadSchema.parse(await Bun.file(eventPath).json());
  const pullRequest = payload.pull_request;

  return parsePullRequestEventContext(
    pullRequestEventInputSchema.parse({
      eventName: env.GITHUB_EVENT_NAME ?? "pull_request",
      action: payload.action,
      repo: [
        payload.repository?.full_name,
        pullRequest.base?.repo?.full_name,
        env.GITHUB_REPOSITORY,
      ].find((value) => value !== undefined && value.length > 0),
      pullRequestNumber: [pullRequest.number, payload.number].find((value) => value !== undefined),
      title: pullRequest.title ?? "",
      description: pullRequest.body ?? "",
      baseSha: pullRequest.base?.sha,
      headSha: pullRequest.head?.sha,
      workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
    }),
  );
}

export async function loadIssueCommentEventContext(
  eventPath: string,
  env: NodeJS.ProcessEnv,
): Promise<IssueCommentEventContext> {
  const payload = githubIssueCommentPayloadSchema.parse(await Bun.file(eventPath).json());
  return issueCommentEventContextSchema.parse({
    eventName: "issue_comment",
    action: payload.action,
    repo: [payload.repository?.full_name, env.GITHUB_REPOSITORY].find(
      (value) => value !== undefined && value.length > 0,
    ),
    issueNumber: payload.issue?.number,
    isPullRequest: payload.issue?.pull_request !== undefined,
    commentBody: payload.comment?.body ?? "",
    commenter: payload.comment?.user?.login,
    workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
  });
}
