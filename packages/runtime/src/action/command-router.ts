import { Octokit } from "@octokit/rest";
import type { RuntimePlan } from "@pipr/sdk";
import { z } from "zod";
import { isPiprCommandLine } from "../commands/grammar.js";
import {
  parsePlanCommandInput as parseSelectedPlanCommandInput,
  selectCommandForInvocation,
  selectPlanCommand,
} from "../config/task-selection.js";
import { githubApiVersion, parseRepoSlug } from "../shared/github.js";
import type { CommandPermissionLevel } from "../types.js";

const permissionOrder: CommandPermissionLevel[] = ["read", "triage", "write", "maintain", "admin"];

const knownPermissions = new Set<CommandPermissionLevel>(permissionOrder);
const noRepositoryPermission: RepositoryPermissionResponse = { permission: "none" };

const pullRequestDetailsSchema = z.looseObject({
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  base: z.looseObject({
    sha: z.string().min(1),
    repo: z
      .looseObject({
        full_name: z.string().min(1).optional(),
      })
      .optional(),
  }),
  head: z.looseObject({
    sha: z.string().min(1),
  }),
});

const repositoryPermissionResponseSchema = z.looseObject({
  permission: z.string().min(1),
  role_name: z.string().min(1).optional(),
});

export type GitHubPullRequestDetails = {
  repo: string;
  baseSha: string;
  headSha: string;
  title: string;
  description: string;
};

export type RepositoryPermissionResponse = z.infer<typeof repositoryPermissionResponseSchema>;

export type GitHubCommandClient = {
  getPullRequest(options: {
    repo: string;
    pullRequestNumber: number;
  }): Promise<GitHubPullRequestDetails>;
  getRepositoryPermission(options: {
    repo: string;
    username: string;
  }): Promise<RepositoryPermissionResponse>;
};

export type PlanCommandResolution =
  | { kind: "ignored"; reason: string }
  | {
      kind: "help";
      reason: string;
      requiredPermission: CommandPermissionLevel;
      body: string;
    }
  | {
      kind: "invalid";
      reason: string;
      requiredPermission: CommandPermissionLevel;
      body: string;
    }
  | {
      kind: "matched";
      invocation: {
        taskName: string;
        commandName: string;
        requiredPermission: CommandPermissionLevel;
        line: string;
        pattern: string;
        arguments: Record<string, string>;
        inputs?: unknown;
      };
    };

export function createGitHubCommandClient(
  env: NodeJS.ProcessEnv = process.env,
): GitHubCommandClient {
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
    async getPullRequest(options) {
      const repo = parseRepoSlug(options.repo);
      const { data } = await octokit.rest.pulls.get({
        ...repo,
        pull_number: options.pullRequestNumber,
      });
      const json = pullRequestDetailsSchema.parse(data);
      return {
        repo: json.base.repo?.full_name ?? options.repo,
        baseSha: json.base.sha,
        headSha: json.head.sha,
        title: json.title ?? "",
        description: json.body ?? "",
      };
    },
    async getRepositoryPermission(options) {
      try {
        const repo = parseRepoSlug(options.repo);
        const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
          ...repo,
          username: options.username,
        });
        return repositoryPermissionResponseSchema.parse(data);
      } catch (error) {
        if (isOctokitStatus(error, 404)) {
          return noRepositoryPermission;
        }
        throw error;
      }
    },
  };
}

export function resolvePlanCommand(
  plan: RuntimePlan,
  line: string | undefined,
): PlanCommandResolution {
  if (!line) {
    return { kind: "ignored", reason: "comment did not contain a command line" };
  }
  if (!isPiprCommandLine(line)) {
    return { kind: "ignored", reason: "comment did not target pipr" };
  }
  const selected = selectPlanCommand(plan, line);
  if (selected?.kind === "matched") {
    return {
      kind: "matched",
      invocation: {
        taskName: selected.command.task.name,
        commandName: selected.commandName,
        requiredPermission: selected.command.permission,
        line: selected.line,
        pattern: selected.command.pattern,
        arguments: selected.arguments,
      },
    };
  }
  if (selected?.kind === "invalid") {
    return {
      kind: "invalid",
      reason: selected.error,
      requiredPermission: selected.command.permission,
      body: renderPlanCommandHelp(plan, selected.error),
    };
  }
  return {
    kind: "help",
    reason: `unknown pipr command '${line}'`,
    requiredPermission: "read",
    body: renderPlanCommandHelp(plan, `Unknown command: ${line}`),
  };
}

function renderPlanCommandHelp(plan: RuntimePlan, reason?: string): string {
  const lines = ["# pipr commands", ""];
  if (reason) {
    lines.push(reason, "");
  }
  for (const command of plan.commands) {
    lines.push(`- ${command.pattern} (${command.permission})`);
  }
  return lines.join("\n");
}

export function parsePlanCommandInputs(
  plan: RuntimePlan,
  invocation: Extract<PlanCommandResolution, { kind: "matched" }>["invocation"],
): PlanCommandResolution {
  const matchingCommand = selectCommandForInvocation(plan, invocation);
  if (!matchingCommand) {
    return {
      kind: "invalid",
      reason: `No command registered for task '${invocation.taskName}'`,
      requiredPermission: invocation.requiredPermission,
      body: renderPlanCommandHelp(plan),
    };
  }
  try {
    return {
      kind: "matched",
      invocation: {
        ...invocation,
        inputs: parseSelectedPlanCommandInput(matchingCommand, invocation.arguments),
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: "invalid",
      reason,
      requiredPermission: invocation.requiredPermission,
      body: renderPlanCommandHelp(plan, reason),
    };
  }
}

export function hasRequiredRepositoryPermission(
  actual: RepositoryPermissionResponse,
  required: CommandPermissionLevel,
): boolean {
  const effective = effectiveRepositoryPermission(actual, required);
  if (!effective) {
    return false;
  }
  return permissionOrder.indexOf(effective) >= permissionOrder.indexOf(required);
}

export function permissionDeniedHelp(plan: RuntimePlan, required: CommandPermissionLevel): string {
  return renderPlanCommandHelp(plan, `Permission denied: requires ${required}.`);
}

function effectiveRepositoryPermission(
  actual: RepositoryPermissionResponse,
  required: CommandPermissionLevel,
): CommandPermissionLevel | undefined {
  if (isKnownPermission(actual.role_name)) {
    return actual.role_name;
  }
  if (required === "triage" || required === "maintain") {
    return undefined;
  }
  if (
    actual.permission === "admin" ||
    actual.permission === "write" ||
    actual.permission === "read"
  ) {
    return actual.permission;
  }
  return undefined;
}

function isKnownPermission(value: string | undefined): value is CommandPermissionLevel {
  return value !== undefined && knownPermissions.has(value as CommandPermissionLevel);
}

function isOctokitStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "status") === status;
}
