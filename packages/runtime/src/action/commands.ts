import { firstNonEmptyLine, isPiprCommandLine } from "../commands/grammar.js";
import {
  type InitOfficialMinimalProjectResult,
  initOfficialMinimalProject,
} from "../config/init.js";
import {
  inspectRuntimePlan,
  type LoadedRuntimeProject,
  loadRuntimeProject,
  validateProject,
} from "../config/project.js";
import { selectLocalTask } from "../config/task-selection.js";
import { runGit as runGitCommand } from "../diff/git.js";
import { createGitHubHostAdapter } from "../hosts/github/adapter.js";
import type { GitHubCommandClient } from "../hosts/github/command.js";
import type { GitHubPublicationClient } from "../hosts/github/publication.js";
import { createLocalChangeRequestEvent, createLocalHostAdapter } from "../hosts/local/adapter.js";
import type { CodeHostAdapter, CommandCommentEvent } from "../hosts/types.js";
import type { PublicationResult } from "../review/publication-result.js";
import { type ReviewRuntimeResult, runTaskRuntime } from "../review/task-runtime.js";
import type {
  ChangeRequestEventContext,
  PiprConfig,
  ProviderConfig,
  RuntimeSettings,
} from "../types.js";
import { parseChangeRequestEventContext, parsePiprConfig, parseProviderConfig } from "../types.js";
import {
  hasRequiredRepositoryPermission,
  type PlanCommandResolution,
  parsePlanCommandInputs,
  permissionDeniedHelp,
  resolvePlanCommand,
} from "./command-router.js";
import { loadRuntimeProjectFromGitCommit } from "./git-project.js";

const defaultActionProvider: ProviderConfig = {
  id: "deepseek",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  thinking: "high",
};

export type RuntimeCommandOptions = {
  rootDir: string;
  configDir: string;
  env?: NodeJS.ProcessEnv;
  requireProviderEnv?: boolean;
};

export type InitCommandOptions = RuntimeCommandOptions & {
  force: boolean;
};

export type DryRunCommandOptions = RuntimeCommandOptions & {
  eventPath: string;
};

export type ActionCommandOptions = RuntimeCommandOptions & {
  eventPath: string;
  dryRun: boolean;
  trustedProvider?: {
    providerId?: string;
    provider?: string;
    model?: string;
    apiKeyEnv?: string;
  };
};

export type ActionCommandDependencyOptions = ActionCommandOptions & {
  piExecutable?: string;
  hostAdapter?: CodeHostAdapter;
  githubClient?: GitHubCommandClient;
  githubPublicationClient?: GitHubPublicationClient;
};

export type LocalTaskCommandOptions = RuntimeCommandOptions & {
  localName: string;
  baseSha: string;
  headSha?: string;
  piExecutable?: string;
};

export type DryRunCommandResult = {
  configSource: string;
  event: ChangeRequestEventContext;
};

export type InspectCommandResult = import("../config/project.js").InspectRuntimePlan;

export type LocalTaskCommandResult = ReviewRuntimeResult;

export type ActionCommandResult =
  | {
      kind: "ignored";
      reason: string;
    }
  | {
      kind: "dry-run";
      event: ChangeRequestEventContext;
      configSource: string;
    }
  | {
      kind: "command-help";
      event: ChangeRequestEventContext;
      configSource: string;
      body: string;
      reason: string;
    }
  | {
      kind: "review";
      event: ChangeRequestEventContext;
      configSource: string;
      command?: string;
      review: ReviewRuntimeResult;
      publication: PublicationResult;
    };

type TrustedRuntimeProject = LoadedRuntimeProject & {
  trustedConfigSha: string;
  trustedConfigHash: string;
};

/** Initializes the official minimal `.pipr` project files. */
export async function runInitCommand(
  options: InitCommandOptions,
): Promise<InitOfficialMinimalProjectResult> {
  return await initOfficialMinimalProject({
    rootDir: options.rootDir,
    configDir: options.configDir,
    force: options.force,
  });
}

/** Loads and validates the runtime project configuration. */
export async function runValidateCommand(options: RuntimeCommandOptions): Promise<RuntimeSettings> {
  return (
    await validateProject({
      ...options,
      requireProviderEnv: options.requireProviderEnv ?? false,
    })
  ).settings;
}

/** Returns an inspectable summary of the configured runtime plan. */
export async function runInspectCommand(
  options: RuntimeCommandOptions,
): Promise<InspectCommandResult> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  return inspectRuntimePlan(runtime.plan, runtime.settings.source);
}

/** Loads the runtime config and pull request event without running review publication. */
export async function runDryRunCommand(
  options: DryRunCommandOptions,
): Promise<DryRunCommandResult> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  const adapter = createActionHostAdapter(options);
  const event = await adapter.parseEvent({
    eventPath: options.eventPath,
    env: {
      ...options.env,
      GITHUB_WORKSPACE: options.rootDir,
      GITHUB_EVENT_NAME: "pull_request",
    },
    workspace: options.rootDir,
  });
  return {
    configSource: runtime.settings.source,
    event,
  };
}

/** Runs a named local task against the configured Git base and head revisions. */
export async function runLocalTaskCommand(
  options: LocalTaskCommandOptions,
): Promise<LocalTaskCommandResult> {
  const runtime = await loadRuntimeProject({
    ...options,
    requireProviderEnv: true,
  });
  const local = selectLocalTask(runtime.plan, options.localName);
  if (!local) {
    throw new Error(`Local entry '${options.localName}' was not registered`);
  }
  const headSha = options.headSha ?? runGitCommand(["rev-parse", "HEAD"], options.rootDir).trim();
  const localAdapter = createLocalHostAdapter();
  const event = parseChangeRequestEventContext({
    ...createLocalChangeRequestEvent({
      rootDir: options.rootDir,
      baseSha: options.baseSha,
      headSha,
    }),
  });
  localAdapter.ensureHeadCheckout({ rootDir: options.rootDir, change: event });
  return await runTaskRuntime({
    workspace: options.rootDir,
    config: runtime.settings.config,
    event,
    env: options.env,
    plan: runtime.plan,
    taskName: local.task.name,
    piExecutable: options.piExecutable,
  });
}

/** Runs the GitHub Action workflow for pull request and issue-comment events. */
export async function runActionCommand(
  options: ActionCommandOptions,
): Promise<ActionCommandResult> {
  return await runActionCommandWithDependencies(options);
}

export async function runActionCommandWithDependencies(
  options: ActionCommandDependencyOptions,
): Promise<ActionCommandResult> {
  const adapter = createActionHostAdapter(options);
  adapter.ensureWorkspaceSafeDirectory?.({ rootDir: options.rootDir, env: options.env });
  if ((actionEnv(options).GITHUB_EVENT_NAME ?? "pull_request") === "issue_comment") {
    return await runIssueCommentActionCommand(options, adapter);
  }
  const event = await adapter.parseEvent({
    eventPath: options.eventPath,
    env: options.env ?? process.env,
    workspace: options.rootDir,
  });
  if (options.dryRun) {
    const trustedRuntime = await loadRuntimeProjectFromGitCommit({
      rootDir: options.rootDir,
      configDir: options.configDir,
      commitSha: event.change.base.sha,
      env: options.env,
    });
    return {
      kind: "dry-run",
      event,
      configSource: trustedRuntime.settings.source,
    };
  }
  const trustedRuntime = await loadRuntimeProjectFromGitCommit({
    rootDir: options.rootDir,
    configDir: options.configDir,
    commitSha: event.change.base.sha,
    env: options.env,
  });
  const provider = trustedActionProvider(options, trustedRuntime.settings.config);
  adapter.ensureHeadCheckout({ rootDir: options.rootDir, change: event });
  const completed = await runTrustedReviewAndPublish({
    options,
    adapter,
    trustedRuntime,
    provider,
    event,
  });
  if (completed.kind === "skipped") {
    return { kind: "ignored", reason: completed.reason };
  }

  return {
    kind: "review",
    event,
    configSource: trustedRuntime.settings.source,
    review: completed.review,
    publication: completed.publication,
  };
}

async function runIssueCommentActionCommand(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
): Promise<ActionCommandResult> {
  const prepared = await prepareIssueCommentCommand(options, adapter);
  if (prepared.kind === "ignored") {
    return prepared;
  }
  return await dispatchIssueCommentCommand(options, adapter, prepared);
}

type PreparedIssueCommentCommand =
  | { kind: "ignored"; reason: string }
  | {
      kind: "prepared";
      comment: CommandCommentEvent;
      line: string;
      event: ChangeRequestEventContext;
      trustedRuntime: TrustedRuntimeProject;
      resolution: Exclude<PlanCommandResolution, { kind: "ignored" }>;
    };

async function prepareIssueCommentCommand(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
): Promise<PreparedIssueCommentCommand> {
  const comment = await adapter.resolveCommandComment({
    eventPath: options.eventPath,
    env: actionEnv(options),
    workspace: options.rootDir,
  });
  const runnable = runnableIssueCommentCommand(comment, options.dryRun);
  if (runnable.kind === "ignored") {
    return runnable;
  }
  const loaded = await adapter.loadChangeRequest({
    repository: comment.repository,
    changeNumber: comment.changeNumber,
    workspace: comment.workspace,
    eventName: comment.eventName,
    action: comment.action,
    rawAction: comment.rawAction,
  });
  const event = parseChangeRequestEventContext({
    eventName: loaded.eventName ?? comment.eventName,
    action: loaded.action ?? comment.action,
    rawAction: loaded.rawAction ?? comment.rawAction,
    platform: { id: adapter.id },
    repository: loaded.repository,
    change: loaded.change,
    workspace: loaded.workspace ?? comment.workspace,
  });
  const trustedRuntime = await loadRuntimeProjectFromGitCommit({
    rootDir: options.rootDir,
    configDir: options.configDir,
    commitSha: event.change.base.sha,
    env: options.env,
  });
  const resolution = resolvePlanCommand(trustedRuntime.plan, runnable.line);
  if (resolution.kind === "ignored") {
    return { kind: "ignored", reason: resolution.reason };
  }
  return { kind: "prepared", comment, line: runnable.line, event, trustedRuntime, resolution };
}

function runnableIssueCommentCommand(
  comment: CommandCommentEvent,
  dryRun: boolean,
): { kind: "runnable"; line: string } | { kind: "ignored"; reason: string } {
  if (!comment.isChangeRequest) {
    return { kind: "ignored", reason: "issue_comment did not target a pull request" };
  }
  if (comment.action !== "created") {
    return { kind: "ignored", reason: `issue_comment action '${comment.action}' is not supported` };
  }
  const line = firstNonEmptyLine(comment.body);
  if (!line || !isPiprCommandLine(line)) {
    return { kind: "ignored", reason: "issue_comment did not target pipr" };
  }
  return dryRun
    ? { kind: "ignored", reason: "PIPR_DRY_RUN=1; command dispatch skipped" }
    : { kind: "runnable", line };
}

async function dispatchIssueCommentCommand(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
  prepared: Extract<PreparedIssueCommentCommand, { kind: "prepared" }>,
): Promise<ActionCommandResult> {
  const requiredPermission =
    prepared.resolution.kind === "matched"
      ? prepared.resolution.invocation.requiredPermission
      : prepared.resolution.requiredPermission;
  const permission = await adapter.getRepositoryPermission({
    repository: prepared.comment.repository,
    actor: prepared.comment.actor,
  });
  if (!hasRequiredRepositoryPermission(permission, requiredPermission)) {
    return {
      kind: "command-help",
      event: prepared.event,
      configSource: prepared.trustedRuntime.settings.source,
      body: permissionDeniedHelp(prepared.trustedRuntime.plan, requiredPermission),
      reason: `permission denied for '${prepared.line}'`,
    };
  }
  if (prepared.resolution.kind === "help" || prepared.resolution.kind === "invalid") {
    return {
      kind: "command-help",
      event: prepared.event,
      configSource: prepared.trustedRuntime.settings.source,
      body: prepared.resolution.body,
      reason: prepared.resolution.reason,
    };
  }

  const parsedResolution = parsePlanCommandInputs(
    prepared.trustedRuntime.plan,
    prepared.resolution.invocation,
  );
  if (parsedResolution.kind === "invalid") {
    return {
      kind: "command-help",
      event: prepared.event,
      configSource: prepared.trustedRuntime.settings.source,
      body: parsedResolution.body,
      reason: parsedResolution.reason,
    };
  }
  if (parsedResolution.kind !== "matched") {
    return { kind: "ignored", reason: "command dispatch did not resolve to a runnable task" };
  }

  const provider = trustedActionProvider(options, prepared.trustedRuntime.settings.config);
  adapter.ensureHeadCheckout({ rootDir: options.rootDir, change: prepared.event });
  const completed = await runTrustedReviewAndPublish({
    options,
    adapter,
    trustedRuntime: prepared.trustedRuntime,
    provider,
    event: prepared.event,
    taskName: parsedResolution.invocation.taskName,
    taskInput: parsedResolution.invocation.inputs,
  });
  if (completed.kind === "skipped") {
    return { kind: "ignored", reason: completed.reason };
  }
  return {
    kind: "review",
    event: prepared.event,
    command: parsedResolution.invocation.commandName,
    configSource: prepared.trustedRuntime.settings.source,
    review: completed.review,
    publication: completed.publication,
  };
}

async function runTrustedReviewAndPublish(options: {
  options: ActionCommandDependencyOptions;
  adapter: CodeHostAdapter;
  trustedRuntime: TrustedRuntimeProject;
  provider: ProviderConfig;
  event: ChangeRequestEventContext;
  taskName?: string;
  taskInput?: unknown;
}): Promise<
  | { kind: "skipped"; reason: string }
  | { kind: "completed"; review: ReviewRuntimeResult; publication: PublicationResult }
> {
  const review = await runTaskRuntime({
    workspace: options.options.rootDir,
    config: trustedActionConfig(
      options.trustedRuntime.settings.config,
      options.options,
      options.provider,
    ),
    event: options.event,
    env: options.options.env,
    providerOverride: options.provider,
    plan: options.trustedRuntime.plan,
    taskName: options.taskName,
    taskInput: options.taskInput,
    trustedConfigSha: options.trustedRuntime.trustedConfigSha,
    trustedConfigHash: options.trustedRuntime.trustedConfigHash,
    piExecutable: options.options.piExecutable,
  });
  if (review.kind === "skipped") {
    return { kind: "skipped", reason: review.skipReason ?? "review skipped" };
  }
  const publication = await options.adapter.publish({
    change: options.event,
    plan: review.publicationPlan,
  });
  return { kind: "completed", review, publication };
}

function trustedActionConfig(
  trustedConfig: PiprConfig,
  options: ActionCommandDependencyOptions,
  provider: ProviderConfig,
): PiprConfig {
  const env = actionEnv(options);
  if (!env[provider.apiKeyEnv]) {
    throw new Error(`Missing provider env vars: ${provider.apiKeyEnv}`);
  }
  return parsePiprConfig({
    ...trustedConfig,
    defaultProvider: provider.id,
    providers: [provider],
  });
}

function trustedActionProvider(
  options: ActionCommandDependencyOptions,
  trustedConfig: PiprConfig,
): ProviderConfig {
  const providerId = readTrustedProviderOption(
    options,
    "providerId",
    "provider-id",
    defaultActionProvider.id,
  );
  return parseProviderConfig({
    id: providerId,
    provider: readTrustedProviderOption(
      options,
      "provider",
      "provider",
      defaultActionProvider.provider,
    ),
    model: readTrustedProviderOption(options, "model", "model", defaultActionProvider.model),
    apiKeyEnv: readTrustedProviderOption(
      options,
      "apiKeyEnv",
      "api-key-env",
      defaultActionProvider.apiKeyEnv,
    ),
    thinking: trustedConfig.providers.find((provider) => provider.id === providerId)?.thinking,
  });
}

function readTrustedProviderOption(
  options: ActionCommandDependencyOptions,
  optionKey: keyof NonNullable<ActionCommandDependencyOptions["trustedProvider"]>,
  inputName: string,
  fallback: string,
): string {
  return (
    [
      options.trustedProvider?.[optionKey],
      readActionInput(actionEnv(options), inputName),
      fallback,
    ].find((value) => value !== undefined && value.length > 0) ?? ""
  );
}

function actionEnv(options: ActionCommandDependencyOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function createActionHostAdapter(options: {
  env?: NodeJS.ProcessEnv;
  hostAdapter?: CodeHostAdapter;
  githubClient?: GitHubCommandClient;
  githubPublicationClient?: GitHubPublicationClient;
}): CodeHostAdapter {
  return (
    options.hostAdapter ??
    createGitHubHostAdapter({
      env: options.env,
      commandClient: options.githubClient,
      publicationClient: options.githubPublicationClient,
    })
  );
}

function readActionInput(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const key of [
    `INPUT_${name}`,
    `INPUT_${name.toUpperCase()}`,
    `INPUT_${name.replaceAll("-", "_").toUpperCase()}`,
  ]) {
    const value = env[key];
    if (value) {
      return value;
    }
  }
  return undefined;
}
