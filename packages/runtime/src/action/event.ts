import { readFile } from "node:fs/promises";
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
  pull_request: z
    .looseObject({
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
    })
    .optional(),
});

type GitHubPullRequestPayload = z.infer<typeof githubPullRequestPayloadSchema>;

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
  const payload = await readEventPayload(eventPath);
  const pullRequest = requirePullRequest(payload);

  return parsePullRequestEventContext({
    eventName: readEventName(env),
    action: payload.action,
    repo: readRepo(payload, pullRequest, env),
    pullRequestNumber: readPullRequestNumber(payload, pullRequest),
    title: pullRequest.title ?? "",
    description: pullRequest.body ?? "",
    baseSha: readBaseSha(pullRequest),
    headSha: readHeadSha(pullRequest),
    workspace: readWorkspace(env),
  });
}

export async function loadIssueCommentEventContext(
  eventPath: string,
  env: NodeJS.ProcessEnv,
): Promise<IssueCommentEventContext> {
  const payload = githubIssueCommentPayloadSchema.parse(
    JSON.parse(await readFile(eventPath, "utf8")),
  );
  return {
    eventName: "issue_comment",
    action: payload.action,
    repo: firstString(payload.repository?.full_name, env.GITHUB_REPOSITORY) ?? missingField("repo"),
    issueNumber: payload.issue?.number ?? missingField("issue number"),
    isPullRequest: payload.issue?.pull_request !== undefined,
    commentBody: payload.comment?.body ?? "",
    commenter: payload.comment?.user?.login ?? missingField("comment user"),
    workspace: readWorkspace(env),
  };
}

async function readEventPayload(eventPath: string): Promise<GitHubPullRequestPayload> {
  return githubPullRequestPayloadSchema.parse(JSON.parse(await readFile(eventPath, "utf8")));
}

function requirePullRequest(
  payload: GitHubPullRequestPayload,
): NonNullable<GitHubPullRequestPayload["pull_request"]> {
  if (payload.pull_request) {
    return payload.pull_request;
  }
  throw new Error("GitHub event payload does not contain pull_request");
}

function readRepo(
  payload: GitHubPullRequestPayload,
  pullRequest: NonNullable<GitHubPullRequestPayload["pull_request"]>,
  env: NodeJS.ProcessEnv,
): string {
  return (
    firstString(
      payload.repository?.full_name,
      pullRequest.base?.repo?.full_name,
      env.GITHUB_REPOSITORY,
    ) ?? missingField("repo")
  );
}

function readPullRequestNumber(
  payload: GitHubPullRequestPayload,
  pullRequest: NonNullable<GitHubPullRequestPayload["pull_request"]>,
): number {
  return firstNumber(pullRequest.number, payload.number) ?? missingField("PR number");
}

function readBaseSha(pullRequest: NonNullable<GitHubPullRequestPayload["pull_request"]>): string {
  return pullRequest.base?.sha ?? missingField("base SHA");
}

function readHeadSha(pullRequest: NonNullable<GitHubPullRequestPayload["pull_request"]>): string {
  return pullRequest.head?.sha ?? missingField("head SHA");
}

function readWorkspace(env: NodeJS.ProcessEnv): string {
  return env.GITHUB_WORKSPACE ?? process.cwd();
}

function readEventName(env: NodeJS.ProcessEnv): string {
  return env.GITHUB_EVENT_NAME ?? "pull_request";
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => value !== undefined);
}

function missingField(field: string): never {
  throw new Error(`GitHub pull request event is missing ${field}`);
}
