import { execFileSync } from "node:child_process";
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
import {
  createGitHubPublicationClient,
  type GitHubPublicationClient,
  type PublicationResult,
  publishPublicationPlan,
} from "../review/publish.js";
import { type ReviewRuntimeResult, runTaskRuntime } from "../review/task-runtime.js";
import type {
  PiprConfig,
  ProviderConfig,
  PullRequestEventContext,
  RuntimeSettings,
} from "../types.js";
import { parsePiprConfig, parseProviderConfig, parsePullRequestEventContext } from "../types.js";
import {
  createGitHubCommandClient,
  type GitHubCommandClient,
  hasRequiredRepositoryPermission,
  type PlanCommandResolution,
  parsePlanCommandInputs,
  permissionDeniedHelp,
  resolvePlanCommand,
} from "./command-router.js";
import {
  type IssueCommentEventContext,
  loadIssueCommentEventContext,
  loadPullRequestEventContext,
} from "./event.js";
import { loadRuntimeProjectFromGitCommit } from "./git-project.js";
import { ensureGitHubWorkspaceSafeDirectory } from "./git-safe-directory.js";

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
  piExecutable?: string;
  trustedProvider?: {
    providerId?: string;
    provider?: string;
    model?: string;
    apiKeyEnv?: string;
  };
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
  event: PullRequestEventContext;
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
      event: PullRequestEventContext;
      configSource: string;
    }
  | {
      kind: "command-help";
      event: PullRequestEventContext;
      configSource: string;
      body: string;
      reason: string;
    }
  | {
      kind: "review";
      event: PullRequestEventContext;
      configSource: string;
      command?: string;
      review: ReviewRuntimeResult;
      publication: PublicationResult;
    };

export async function runInitCommand(
  options: InitCommandOptions,
): Promise<InitOfficialMinimalProjectResult> {
  return await initOfficialMinimalProject({
    rootDir: options.rootDir,
    configDir: options.configDir,
    force: options.force,
  });
}

export async function runValidateCommand(options: RuntimeCommandOptions): Promise<RuntimeSettings> {
  return (
    await validateProject({
      ...options,
      requireProviderEnv: options.requireProviderEnv ?? false,
    })
  ).settings;
}

export async function runInspectCommand(
  options: RuntimeCommandOptions,
): Promise<InspectCommandResult> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  return inspectRuntimePlan(runtime.plan, runtime.settings.source);
}

export async function runDryRunCommand(
  options: DryRunCommandOptions,
): Promise<DryRunCommandResult> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  const event = await loadPullRequestEventContext(options.eventPath, {
    ...options.env,
    GITHUB_WORKSPACE: options.rootDir,
    GITHUB_EVENT_NAME: "pull_request",
  });
  return {
    configSource: runtime.settings.source,
    event,
  };
}

export async function runLocalTaskCommand(
  options: LocalTaskCommandOptions,
): Promise<LocalTaskCommandResult> {
  const runtime = await loadRuntimeProject({
    ...options,
    requireProviderEnv: true,
  });
  const local = runtime.plan.locals.find((entry) => entry.name === options.localName);
  if (!local) {
    throw new Error(`Local entry '${options.localName}' was not registered`);
  }
  const headSha = options.headSha ?? runGit(options.rootDir, ["rev-parse", "HEAD"]).trim();
  return await runTaskRuntime({
    workspace: options.rootDir,
    config: runtime.settings.config,
    event: parsePullRequestEventContext({
      eventName: "local",
      action: "updated",
      repo: "local/repository",
      pullRequestNumber: 1,
      baseSha: options.baseSha,
      headSha,
      workspace: options.rootDir,
    }),
    env: options.env,
    plan: runtime.plan,
    taskName: local.task.name,
    piExecutable: options.piExecutable,
  });
}

export async function runActionCommand(
  options: ActionCommandOptions,
): Promise<ActionCommandResult> {
  ensureGitHubWorkspaceSafeDirectory({ rootDir: options.rootDir, env: options.env });
  if (actionEventName(options) === "issue_comment") {
    return await runIssueCommentActionCommand(options);
  }
  const event = await loadPullRequestEventContext(options.eventPath, options.env ?? process.env);
  if (options.dryRun) {
    const trustedRuntime = await loadRuntimeProjectFromGitCommit({
      rootDir: options.rootDir,
      configDir: options.configDir,
      commitSha: event.baseSha,
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
    commitSha: event.baseSha,
    env: options.env,
  });
  const provider = trustedActionProvider(options, trustedRuntime.settings.config);
  ensurePullRequestHeadCheckout(options.rootDir, event);
  const completed = await runTrustedReviewAndPublish({ options, trustedRuntime, provider, event });
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
  options: ActionCommandOptions,
): Promise<ActionCommandResult> {
  const prepared = await prepareIssueCommentCommand(options);
  if (prepared.kind === "ignored") {
    return prepared;
  }
  return await dispatchIssueCommentCommand(options, prepared);
}

type PreparedIssueCommentCommand =
  | { kind: "ignored"; reason: string }
  | {
      kind: "prepared";
      comment: IssueCommentEventContext;
      line: string;
      github: GitHubCommandClient;
      event: PullRequestEventContext;
      trustedRuntime: LoadedRuntimeProject;
      resolution: Exclude<PlanCommandResolution, { kind: "ignored" }>;
    };

async function prepareIssueCommentCommand(
  options: ActionCommandOptions,
): Promise<PreparedIssueCommentCommand> {
  const comment = await loadIssueCommentEventContext(options.eventPath, actionEnv(options));
  if (!comment.isPullRequest) {
    return { kind: "ignored", reason: "issue_comment did not target a pull request" };
  }
  if (comment.action !== "created") {
    return { kind: "ignored", reason: `issue_comment action '${comment.action}' is not supported` };
  }
  const line = firstNonEmptyLine(comment.commentBody);
  if (!line || !isPiprCommandLine(line)) {
    return { kind: "ignored", reason: "issue_comment did not target pipr" };
  }
  if (options.dryRun) {
    return { kind: "ignored", reason: "PIPR_DRY_RUN=1; command dispatch skipped" };
  }
  const github = options.githubClient ?? createGitHubCommandClient(actionEnv(options));
  const pullRequest = await github.getPullRequest({
    repo: comment.repo,
    pullRequestNumber: comment.issueNumber,
  });
  const event = parsePullRequestEventContext({
    eventName: comment.eventName,
    action: comment.action,
    repo: pullRequest.repo,
    pullRequestNumber: comment.issueNumber,
    title: pullRequest.title,
    description: pullRequest.description,
    baseSha: pullRequest.baseSha,
    headSha: pullRequest.headSha,
    workspace: comment.workspace,
  });
  const trustedRuntime = await loadRuntimeProjectFromGitCommit({
    rootDir: options.rootDir,
    configDir: options.configDir,
    commitSha: event.baseSha,
    env: options.env,
  });
  const resolution = resolvePlanCommand(trustedRuntime.plan, line);
  if (resolution.kind === "ignored") {
    return { kind: "ignored", reason: resolution.reason };
  }
  return { kind: "prepared", comment, line, github, event, trustedRuntime, resolution };
}

async function dispatchIssueCommentCommand(
  options: ActionCommandOptions,
  prepared: Extract<PreparedIssueCommentCommand, { kind: "prepared" }>,
): Promise<ActionCommandResult> {
  const requiredPermission =
    prepared.resolution.kind === "matched"
      ? prepared.resolution.invocation.requiredPermission
      : prepared.resolution.requiredPermission;
  const permission = await prepared.github.getRepositoryPermission({
    repo: prepared.comment.repo,
    username: prepared.comment.commenter,
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
  ensurePullRequestHeadCheckout(options.rootDir, prepared.event);
  const completed = await runTrustedReviewAndPublish({
    options,
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
  options: ActionCommandOptions;
  trustedRuntime: LoadedRuntimeProject;
  provider: ProviderConfig;
  event: PullRequestEventContext;
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
    trustedConfigSha: readTrustedRuntimeSha(options.trustedRuntime),
    trustedConfigHash: readTrustedRuntimeHash(options.trustedRuntime),
    piExecutable: options.options.piExecutable,
  });
  if (review.kind === "skipped") {
    return { kind: "skipped", reason: review.skipReason ?? "review skipped" };
  }
  const client =
    options.options.githubPublicationClient ??
    createGitHubPublicationClient(actionEnv(options.options));
  const publication = await publishPublicationPlan({
    client,
    event: options.event,
    plan: review.publicationPlan,
  });
  return { kind: "completed", review, publication };
}

function readTrustedRuntimeSha(runtime: LoadedRuntimeProject): string | undefined {
  const trusted = runtime as unknown as { trustedConfigSha?: unknown };
  return typeof trusted.trustedConfigSha === "string" ? trusted.trustedConfigSha : undefined;
}

function readTrustedRuntimeHash(runtime: LoadedRuntimeProject): string | undefined {
  const trusted = runtime as unknown as { trustedConfigHash?: unknown };
  return typeof trusted.trustedConfigHash === "string" ? trusted.trustedConfigHash : undefined;
}

function trustedActionConfig(
  trustedConfig: PiprConfig,
  options: ActionCommandOptions,
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
  options: ActionCommandOptions,
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
  options: ActionCommandOptions,
  optionKey: keyof NonNullable<ActionCommandOptions["trustedProvider"]>,
  inputName: string,
  fallback: string,
): string {
  return (
    [
      trustedProviderOptions(options)[optionKey],
      readActionInput(actionEnv(options), inputName),
      fallback,
    ].find((value) => value !== undefined && value.length > 0) ?? ""
  );
}

function trustedProviderOptions(
  options: ActionCommandOptions,
): NonNullable<ActionCommandOptions["trustedProvider"]> {
  return options.trustedProvider ?? {};
}

function actionEnv(options: ActionCommandOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function actionEventName(options: ActionCommandOptions): string {
  return actionEnv(options).GITHUB_EVENT_NAME ?? "pull_request";
}

function readActionInput(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const key of actionInputEnvKeys(name)) {
    const value = env[key];
    if (value) {
      return value;
    }
  }
  return undefined;
}

function actionInputEnvKeys(name: string): string[] {
  return [
    `INPUT_${name}`,
    `INPUT_${name.toUpperCase()}`,
    `INPUT_${name.replaceAll("-", "_").toUpperCase()}`,
  ];
}

function ensurePullRequestHeadCheckout(rootDir: string, event: PullRequestEventContext): void {
  if (!hasGitCommit(rootDir, event.headSha)) {
    runGit(rootDir, ["fetch", "--no-tags", "--depth=1", "origin", pullRequestHeadRef(event)]);
  }
  if (currentGitHead(rootDir) !== event.headSha) {
    runGit(rootDir, ["checkout", "--detach", event.headSha]);
  }
}

function hasGitCommit(rootDir: string, sha: string): boolean {
  try {
    runGit(rootDir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function currentGitHead(rootDir: string): string {
  return runGit(rootDir, ["rev-parse", "HEAD"]).trim();
}

function pullRequestHeadRef(event: PullRequestEventContext): string {
  return `refs/pull/${event.pullRequestNumber}/head`;
}

function runGit(rootDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: "pipe" });
}
