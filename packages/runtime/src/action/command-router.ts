import { Octokit } from "@octokit/rest";
import type { RuntimePlan } from "@pipr/sdk";
import { z } from "zod";
import {
  commandPatternPrefixMatches,
  isPiprCommandLine,
  parseCommandPattern,
} from "../commands/grammar.js";
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
  let matched: PlanCommandResolution | undefined;
  matched = findMatchedPlanCommand(plan, line);
  if (matched) {
    return matched;
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

function findMatchedPlanCommand(
  plan: RuntimePlan,
  line: string,
): PlanCommandResolution | undefined {
  let firstInvalid: PlanCommandResolution | undefined;
  for (const command of plan.commands) {
    const parsed = parseCommandPattern(command.pattern, line);
    if (!parsed.ok) {
      if (commandPatternPrefixMatches(command.pattern, line) && !firstInvalid) {
        firstInvalid = {
          kind: "invalid",
          reason: parsed.error,
          requiredPermission: command.permission,
          body: renderPlanCommandHelp(plan, parsed.error),
        };
      }
      continue;
    }
    return {
      kind: "matched",
      invocation: {
        taskName: command.task.name,
        commandName: planCommandName(command.pattern),
        requiredPermission: command.permission,
        line,
        pattern: command.pattern,
        arguments: parsed.value,
      },
    };
  }
  return firstInvalid;
}

export function parsePlanCommandInputs(
  plan: RuntimePlan,
  invocation: Extract<PlanCommandResolution, { kind: "matched" }>["invocation"],
): PlanCommandResolution {
  const command = plan.commands.find(
    (candidate) =>
      candidate.task.name === invocation.taskName && candidate.pattern === invocation.pattern,
  );
  const matchingCommand =
    command ?? plan.commands.find((candidate) => candidate.task.name === invocation.taskName);
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
        inputs: parsePlanCommandInput(matchingCommand, invocation.arguments),
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

function parsePlanCommandInput(
  command: RuntimePlan["commands"][number],
  values: Record<string, string>,
): unknown {
  return command.parse ? command.parse(values) : values;
}

function planCommandName(pattern: string): string {
  return pattern.replace(/^@pipr\s+/, "").split(/\s+/)[0] ?? pattern;
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
