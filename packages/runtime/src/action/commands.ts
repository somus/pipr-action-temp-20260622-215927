import { execFileSync } from "node:child_process";
import { firstNonEmptyLine, isPiprCommandLine } from "../commands/grammar.js";
import {
  type InitOfficialMinimalProjectResult,
  initOfficialMinimalProject,
} from "../config/init.js";
import {
  type LoadedRuntimeProject,
  loadRuntimeConfig,
  loadRuntimeProject,
  validateProject,
} from "../config/project.js";
import { renderRegistryGraph } from "../registry/registry.js";
import {
  createGitHubPublicationClient,
  type GitHubPublicationClient,
  type PublicationResult,
  publishPublicationPlan,
} from "../review/publish.js";
import { type ReviewRuntimeResult, runReviewRuntime } from "../review/runtime.js";
import type {
  PiprConfig,
  ProviderConfig,
  PullRequestEventContext,
  RegistryCollectionName,
  RegistryEntry,
  ResolvedConfig,
  RuntimeRegistry,
} from "../types.js";
import { parsePiprConfig, parseProviderConfig, parsePullRequestEventContext } from "../types.js";
import {
  createGitHubCommandClient,
  type GitHubCommandClient,
  hasRequiredRepositoryPermission,
  listWorkflowCommandEntries,
  permissionDeniedHelp,
  resolveWorkflowCommand,
  type WorkflowCommandResolution,
} from "./command-router.js";
import {
  type IssueCommentEventContext,
  loadIssueCommentEventContext,
  loadPullRequestEventContext,
} from "./event.js";
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

export type DryRunCommandResult = {
  configSource: string;
  event: PullRequestEventContext;
  registry: RuntimeRegistry;
};

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

export async function runValidateCommand(options: RuntimeCommandOptions): Promise<ResolvedConfig> {
  return (
    await validateProject({
      ...options,
      requireProviderEnv: options.requireProviderEnv ?? false,
    })
  ).resolved;
}

export async function runExplainConfigCommand(
  options: RuntimeCommandOptions,
): Promise<ResolvedConfig> {
  return await loadRuntimeConfig({
    ...options,
    requireProviderEnv: options.requireProviderEnv ?? false,
  });
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
    configSource: runtime.resolved.source,
    event,
    registry: runtime.registry,
  };
}

export async function runGraphCommand(options: RuntimeCommandOptions): Promise<string> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  return renderRegistryGraph(runtime.registry);
}

export async function runListCommand(
  options: RuntimeCommandOptions,
  collection: Extract<RegistryCollectionName, "blocks" | "tools" | "agents" | "presets">,
): Promise<RegistryEntry[]> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  return runtime.registry[collection];
}

export async function runListCommandsCommand(
  options: RuntimeCommandOptions,
): Promise<RegistryEntry[]> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  return listWorkflowCommandEntries(runtime.registry);
}

export async function runActionCommand(
  options: ActionCommandOptions,
): Promise<ActionCommandResult> {
  if (actionEventName(options) === "issue_comment") {
    return await runIssueCommentActionCommand(options);
  }
  const event = await loadPullRequestEventContext(options.eventPath, options.env ?? process.env);
  if (options.dryRun) {
    const runtime = await loadRuntimeProject({
      rootDir: options.rootDir,
      configDir: options.configDir,
      env: options.env,
      requireProviderEnv: false,
    });
    return {
      kind: "dry-run",
      event,
      configSource: runtime.resolved.source,
    };
  }
  const trustedRuntime = await loadRuntimeProjectFromGitCommit({
    rootDir: options.rootDir,
    configDir: options.configDir,
    commitSha: event.baseSha,
    env: options.env,
  });
  const provider = trustedActionProvider(options, trustedRuntime.resolved.config);
  ensurePullRequestHeadCheckout(options.rootDir, event);
  const completed = await runTrustedReviewAndPublish({ options, trustedRuntime, provider, event });
  if (completed.kind === "skipped") {
    return { kind: "ignored", reason: completed.reason };
  }

  return {
    kind: "review",
    event,
    configSource: trustedRuntime.resolved.source,
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
      resolution: Exclude<WorkflowCommandResolution, { kind: "ignored" }>;
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
  const resolution = resolveWorkflowCommand(trustedRuntime.registry, line);
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
      configSource: prepared.trustedRuntime.resolved.source,
      body: permissionDeniedHelp(prepared.trustedRuntime.registry, requiredPermission),
      reason: `permission denied for '${prepared.line}'`,
    };
  }
  if (prepared.resolution.kind === "help" || prepared.resolution.kind === "invalid") {
    return {
      kind: "command-help",
      event: prepared.event,
      configSource: prepared.trustedRuntime.resolved.source,
      body: prepared.resolution.body,
      reason: prepared.resolution.reason,
    };
  }

  const provider = trustedActionProvider(options, prepared.trustedRuntime.resolved.config);
  ensurePullRequestHeadCheckout(options.rootDir, prepared.event);
  const completed = await runTrustedReviewAndPublish({
    options,
    trustedRuntime: prepared.trustedRuntime,
    provider,
    event: prepared.event,
    workflowId: prepared.resolution.invocation.workflowId,
    workflowInputs: prepared.resolution.invocation.inputs,
  });
  if (completed.kind === "skipped") {
    return { kind: "ignored", reason: completed.reason };
  }
  return {
    kind: "review",
    event: prepared.event,
    command: prepared.resolution.invocation.commandName,
    configSource: prepared.trustedRuntime.resolved.source,
    review: completed.review,
    publication: completed.publication,
  };
}

async function runTrustedReviewAndPublish(options: {
  options: ActionCommandOptions;
  trustedRuntime: LoadedRuntimeProject;
  provider: ProviderConfig;
  event: PullRequestEventContext;
  workflowId?: string;
  workflowInputs?: unknown;
}): Promise<
  | { kind: "skipped"; reason: string }
  | { kind: "completed"; review: ReviewRuntimeResult; publication: PublicationResult }
> {
  const review = await runReviewRuntime({
    workspace: options.options.rootDir,
    config: trustedActionConfig(
      options.trustedRuntime.resolved.config,
      options.options,
      options.provider,
    ),
    event: options.event,
    env: options.options.env,
    project: options.trustedRuntime.project,
    registry: options.trustedRuntime.registry,
    providerOverride: options.provider,
    workflowId: options.workflowId,
    workflowInputs: options.workflowInputs,
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
  return firstNonEmptyString([
    trustedProviderOptions(options)[optionKey],
    readActionInput(actionEnv(options), inputName),
    fallback,
  ]);
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

function firstNonEmptyString(values: Array<string | undefined>): string {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return "";
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
