import { readFile } from "node:fs/promises";
import type { PullRequestEventContext } from "./types.js";

type GitHubPullRequestPayload = {
  action?: string;
  number?: number;
  repository?: {
    full_name?: string;
  };
  pull_request?: {
    number?: number;
    base?: {
      sha?: string;
      repo?: {
        full_name?: string;
      };
    };
    head?: {
      sha?: string;
    };
  };
};

export async function loadPullRequestEventContext(
  eventPath: string,
  env: NodeJS.ProcessEnv,
): Promise<PullRequestEventContext> {
  const payload = await readEventPayload(eventPath);
  const pullRequest = requirePullRequest(payload);

  return {
    eventName: readEventName(env),
    action: payload.action,
    repo: readRepo(payload, pullRequest, env),
    pullRequestNumber: readPullRequestNumber(payload, pullRequest),
    baseSha: readBaseSha(pullRequest),
    headSha: readHeadSha(pullRequest),
    workspace: readWorkspace(env),
  };
}

async function readEventPayload(eventPath: string): Promise<GitHubPullRequestPayload> {
  return JSON.parse(await readFile(eventPath, "utf8")) as GitHubPullRequestPayload;
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
