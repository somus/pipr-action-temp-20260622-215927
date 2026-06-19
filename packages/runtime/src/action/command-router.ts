import { z } from "zod";
import {
  commandLabels,
  commandPatternPrefixMatches,
  isPiprCommandLine,
  parseCommandPattern,
  piprHelpCommandLine,
} from "../commands/grammar.js";
import type {
  CommandPermissionLevel,
  RegistryEntry,
  RuntimeRegistry,
  WorkflowCommand,
  WorkflowCommandInvocation,
  WorkflowInput,
  WorkflowRegistryEntry,
} from "../types.js";
import { workflowCommandInvocationSchema } from "../types.js";

const permissionOrder: CommandPermissionLevel[] = ["read", "triage", "write", "maintain", "admin"];

const knownPermissions = new Set<CommandPermissionLevel>(permissionOrder);
const noRepositoryPermission: RepositoryPermissionResponse = { permission: "none" };

const pullRequestDetailsSchema = z.looseObject({
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

export type WorkflowCommandResolution =
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
      invocation: WorkflowCommandInvocation;
    };

export function createGitHubCommandClient(
  env: NodeJS.ProcessEnv = process.env,
): GitHubCommandClient {
  return {
    async getPullRequest(options) {
      const json = pullRequestDetailsSchema.parse(
        await getJson(env, `/repos/${options.repo}/pulls/${options.pullRequestNumber}`),
      );
      return {
        repo: json.base.repo?.full_name ?? options.repo,
        baseSha: json.base.sha,
        headSha: json.head.sha,
      };
    },
    async getRepositoryPermission(options) {
      try {
        return repositoryPermissionResponseSchema.parse(
          await getJson(env, `/repos/${options.repo}/collaborators/${options.username}/permission`),
        );
      } catch (error) {
        if (isGitHubApiStatus(error, 404)) {
          return noRepositoryPermission;
        }
        throw error;
      }
    },
  };
}

export function resolveWorkflowCommand(
  registry: RuntimeRegistry,
  line: string | undefined,
): WorkflowCommandResolution {
  if (!line) {
    return { kind: "ignored", reason: "comment did not contain a command line" };
  }
  if (!isPiprCommandLine(line)) {
    return { kind: "ignored", reason: "comment did not target pipr" };
  }
  if (line === piprHelpCommandLine) {
    return {
      kind: "help",
      reason: "built-in help requested",
      requiredPermission: "read",
      body: renderCommandHelp(registry),
    };
  }

  const invalid = findInvalidCommandCandidate(registry, line);
  const matched = findMatchedCommand(registry, line);
  if (matched) {
    return matched;
  }
  if (invalid) {
    return invalid;
  }
  return {
    kind: "help",
    reason: `unknown pipr command '${line}'`,
    requiredPermission: "read",
    body: renderCommandHelp(registry, `Unknown command: ${line}`),
  };
}

export function listWorkflowCommandEntries(registry: RuntimeRegistry): RegistryEntry[] {
  return [
    { id: piprHelpCommandLine, description: "Built-in pipr command help.", source: "runtime:core" },
    ...registry.workflows.flatMap((workflow) =>
      (workflow.commands ?? []).flatMap((command) =>
        commandLabels(command).map((label) => ({
          id: label,
          description: `${workflow.id} command '${command.name}' (${command.requiredPermission ?? "write"})`,
          source: workflow.source,
        })),
      ),
    ),
  ];
}

function renderCommandHelp(registry: RuntimeRegistry, reason?: string): string {
  const lines = ["# pipr commands", ""];
  if (reason) {
    lines.push(reason, "");
  }
  lines.push(`- ${piprHelpCommandLine} (read)`);
  for (const workflow of registry.workflows) {
    for (const command of workflow.commands ?? []) {
      for (const label of commandLabels(command)) {
        lines.push(`- ${label} (${command.requiredPermission ?? "write"})`);
      }
    }
  }
  return lines.join("\n");
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

export function permissionDeniedHelp(
  registry: RuntimeRegistry,
  required: CommandPermissionLevel,
): string {
  return renderCommandHelp(registry, `Permission denied: requires ${required}.`);
}

function findMatchedCommand(
  registry: RuntimeRegistry,
  line: string,
): WorkflowCommandResolution | undefined {
  for (const workflow of registry.workflows) {
    for (const command of workflow.commands ?? []) {
      const aliasMatch = matchAliasCommand(workflow, command, line);
      if (aliasMatch) {
        return aliasMatch;
      }
      const patternMatch = matchPatternCommand(workflow, command, line);
      if (patternMatch.kind === "matched") {
        return patternMatch;
      }
    }
  }
  return undefined;
}

function findInvalidCommandCandidate(
  registry: RuntimeRegistry,
  line: string,
): WorkflowCommandResolution | undefined {
  for (const workflow of registry.workflows) {
    for (const command of workflow.commands ?? []) {
      if (!command.pattern || !commandPatternPrefixMatches(command.pattern, line)) {
        continue;
      }
      const patternMatch = matchPatternCommand(workflow, command, line);
      if (patternMatch.kind === "invalid") {
        return patternMatch;
      }
    }
  }
  return undefined;
}

function matchAliasCommand(
  workflow: WorkflowRegistryEntry,
  command: WorkflowCommand,
  line: string,
): WorkflowCommandResolution | undefined {
  if (!command.aliases?.includes(line)) {
    return undefined;
  }
  const inputs = applyWorkflowInputs(workflow.inputs ?? {}, {});
  if (!inputs.ok) {
    return invalidCommand(workflow, command, inputs.error);
  }
  return matchedCommand(workflow, command, line, inputs.value);
}

function matchPatternCommand(
  workflow: WorkflowRegistryEntry,
  command: WorkflowCommand,
  line: string,
): WorkflowCommandResolution {
  if (!command.pattern) {
    return { kind: "ignored", reason: "command has no pattern" };
  }
  const parsed = parseCommandPattern(command.pattern, line);
  if (!parsed.ok) {
    return invalidCommand(workflow, command, parsed.error);
  }
  const inputs = applyWorkflowInputs(workflow.inputs ?? {}, parsed.value);
  if (!inputs.ok) {
    return invalidCommand(workflow, command, inputs.error);
  }
  return matchedCommand(workflow, command, line, inputs.value);
}

function matchedCommand(
  workflow: WorkflowRegistryEntry,
  command: WorkflowCommand,
  line: string,
  inputs: Record<string, string>,
): WorkflowCommandResolution {
  return {
    kind: "matched",
    invocation: workflowCommandInvocationSchema.parse({
      workflowId: workflow.id,
      commandName: command.name,
      requiredPermission: command.requiredPermission ?? "write",
      line,
      inputs,
    }),
  };
}

function invalidCommand(
  workflow: WorkflowRegistryEntry,
  command: WorkflowCommand,
  reason: string,
): WorkflowCommandResolution {
  return {
    kind: "invalid",
    reason,
    requiredPermission: command.requiredPermission ?? "write",
    body: renderCommandHelp(
      {
        presets: [],
        workflows: [workflow],
        blocks: [],
        agents: [],
        schemas: [],
        comments: [],
        tools: [],
      },
      reason,
    ),
  };
}

function applyWorkflowInputs(
  schema: Record<string, WorkflowInput>,
  values: Record<string, string>,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  const unexpectedInput = firstUnexpectedInput(schema, values);
  if (unexpectedInput) {
    return { ok: false, error: `Unexpected input '${unexpectedInput}'` };
  }

  const result: Record<string, string> = {};
  for (const [key, input] of Object.entries(schema)) {
    const applied = applyWorkflowInput(key, input, values[key]);
    if (!applied.ok) {
      return applied;
    }
    if (applied.value !== undefined) {
      result[key] = applied.value;
    }
  }
  return { ok: true, value: result };
}

function firstUnexpectedInput(
  schema: Record<string, WorkflowInput>,
  values: Record<string, string>,
): string | undefined {
  const expected = new Set(Object.keys(schema));
  for (const key of Object.keys(values)) {
    if (!expected.has(key)) {
      return key;
    }
  }
  return undefined;
}

function applyWorkflowInput(
  key: string,
  input: WorkflowInput,
  rawValue: string | undefined,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  const value = rawValue ?? input.default;
  if (value === undefined && input.required) {
    return { ok: false, error: `Missing required input '${key}'` };
  }
  if (value !== undefined && input.enum && !input.enum.includes(value)) {
    return { ok: false, error: `Input '${key}' must be one of: ${input.enum.join(", ")}` };
  }
  return { ok: true, value };
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

async function getJson(env: NodeJS.ProcessEnv, path: string): Promise<unknown> {
  const apiUrl = env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(`${apiUrl}${path}`, {
    headers: githubHeaders(env),
  });
  if (!response.ok) {
    throw new GitHubApiError(response.status, path);
  }
  return await response.json();
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`GitHub API request failed (${status}) for ${path}`);
  }
}

function isGitHubApiStatus(error: unknown, status: number): boolean {
  return error instanceof GitHubApiError && error.status === status;
}

function githubHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  const token = env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}
