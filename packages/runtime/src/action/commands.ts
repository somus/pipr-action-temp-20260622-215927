import type { RuntimePlan, Task } from "@pipr/sdk";
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
import { selectLocalTask, selectRuntimeTasks } from "../config/task-selection.js";
import { buildDiffManifest } from "../diff/diff.js";
import { runGit as runGitCommand } from "../diff/git.js";
import { createGitHubHostAdapter } from "../hosts/github/adapter.js";
import type { GitHubCommandClient } from "../hosts/github/command.js";
import type { GitHubPublicationClient } from "../hosts/github/publication.js";
import { createLocalChangeRequestEvent, createLocalHostAdapter } from "../hosts/local/adapter.js";
import type {
  CodeHostAdapter,
  CodeHostCheckConclusion,
  CodeHostCheckRun,
  CommandCommentEvent,
  ReviewCommentReplyEvent,
} from "../hosts/types.js";
import { isPiprThreadActionReplyBody } from "../review/prior-state.js";
import type { PublicationResult } from "../review/publication-result.js";
import { resolveProvider } from "../review/review-run.js";
import {
  type ReviewRuntimeResult,
  type RuntimeCheckSink,
  type RuntimeTaskCheckResult,
  runTaskRuntime,
} from "../review/task-runtime.js";
import { runInternalVerifier } from "../review/verifier.js";
import type { ChangeRequestEventContext, PiprConfig, RuntimeSettings } from "../types.js";
import { parseChangeRequestEventContext } from "../types.js";
import {
  hasRequiredRepositoryPermission,
  type PlanCommandResolution,
  parsePlanCommandInputs,
  permissionDeniedHelp,
  resolvePlanCommand,
} from "./command-router.js";
import { loadRuntimeProjectFromGitCommit } from "./git-project.js";

const genericCheckFailureSummary = "pipr failed; see Action logs for details.";

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
    }
  | {
      kind: "verifier";
      event: ChangeRequestEventContext;
      configSource: string;
      errors: string[];
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
  const eventName = actionEnv(options).GITHUB_EVENT_NAME ?? "pull_request";
  if (eventName === "issue_comment") {
    return await runIssueCommentActionCommand(options, adapter);
  }
  if (eventName === "pull_request_review_comment") {
    return await runReviewCommentReplyActionCommand(options, adapter);
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
  assertTrustedActionProviderEnv(options, trustedRuntime.settings.config);
  adapter.ensureHeadCheckout({ rootDir: options.rootDir, change: event });
  const completed = await runTrustedReviewAndPublish({
    options,
    adapter,
    trustedRuntime,
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

async function runReviewCommentReplyActionCommand(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
): Promise<ActionCommandResult> {
  if (!adapter.resolveReviewCommentReply) {
    return { kind: "ignored", reason: "host adapter does not support review comment replies" };
  }
  if (!adapter.publishThreadActions) {
    return { kind: "ignored", reason: "host adapter does not support verifier thread actions" };
  }
  if (options.dryRun) {
    return { kind: "ignored", reason: "PIPR_DRY_RUN=1; verifier dispatch skipped" };
  }
  const reply = await adapter.resolveReviewCommentReply({
    eventPath: options.eventPath,
    env: actionEnv(options),
    workspace: options.rootDir,
  });
  const runnable = runnableReviewCommentReply(reply);
  if (runnable.kind === "ignored") {
    return runnable;
  }
  const prepared = await prepareReviewCommentVerifier(options, adapter, reply);
  if (prepared.kind === "ignored") {
    return prepared;
  }
  const result = await runReviewCommentVerifier(options, adapter, prepared);
  const publication = await adapter.publishThreadActions({
    change: prepared.event,
    actions: result.threadActions,
    reviewedHeadSha: prepared.event.change.head.sha,
  });
  return {
    kind: "verifier",
    event: prepared.event,
    configSource: prepared.trustedRuntime.settings.source,
    errors: publication?.errors ?? [],
  };
}

type PreparedReviewCommentVerifier =
  | { kind: "ignored"; reason: string }
  | {
      kind: "prepared";
      reply: ReviewCommentReplyEvent & { parentCommentId: number };
      event: ChangeRequestEventContext;
      trustedRuntime: TrustedRuntimeProject;
    };

async function prepareReviewCommentVerifier(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
  reply: ReviewCommentReplyEvent,
): Promise<PreparedReviewCommentVerifier> {
  if (!reply.parentCommentId) {
    return { kind: "ignored", reason: "review comment was not a reply" };
  }
  const loaded = await adapter.loadChangeRequest({
    repository: reply.repository,
    changeNumber: reply.changeNumber,
    workspace: reply.workspace,
    eventName: reply.eventName,
    action: reply.action,
    rawAction: reply.rawAction,
  });
  const event = parseChangeRequestEventContext({
    eventName: loaded.eventName ?? reply.eventName,
    action: loaded.action ?? reply.action,
    rawAction: loaded.rawAction ?? reply.rawAction,
    platform: { id: adapter.id },
    repository: loaded.repository,
    change: loaded.change,
    workspace: loaded.workspace ?? reply.workspace,
  });
  const trustedRuntime = await loadRuntimeProjectFromGitCommit({
    rootDir: options.rootDir,
    configDir: options.configDir,
    commitSha: event.change.base.sha,
    env: options.env,
  });
  const config = trustedRuntime.settings.config;
  if (!config.publication.autoResolve.enabled) {
    return { kind: "ignored", reason: "publication.autoResolve is disabled" };
  }
  if (!config.publication.autoResolve.userReplies.enabled) {
    return { kind: "ignored", reason: "publication.autoResolve.userReplies is disabled" };
  }
  if (!(await verifierActorAllowed(adapter, event, reply, config))) {
    return { kind: "ignored", reason: "review comment reply actor is not allowed" };
  }
  assertTrustedActionProviderEnv(options, trustedRuntime.settings.config);
  adapter.ensureHeadCheckout({ rootDir: options.rootDir, change: event });
  return {
    kind: "prepared",
    reply: { ...reply, parentCommentId: reply.parentCommentId },
    event,
    trustedRuntime,
  };
}

async function runReviewCommentVerifier(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
  prepared: Exclude<PreparedReviewCommentVerifier, { kind: "ignored" }>,
) {
  const { event, reply, trustedRuntime } = prepared;
  const config = trustedRuntime.settings.config;
  const provider = resolveProvider(config, config.defaultProvider);
  const verifierProvider = resolveProvider(
    config,
    config.publication.autoResolve.model ?? config.defaultProvider,
  );
  const result = await runInternalVerifier({
    workspace: options.rootDir,
    config,
    event,
    provider,
    verifierProvider,
    plan: trustedRuntime.plan,
    env: options.env,
    piExecutable: options.piExecutable,
    diffManifest: buildDiffManifest({
      cwd: options.rootDir,
      baseSha: event.change.base.sha,
      headSha: event.change.head.sha,
    }),
    priorReviewState: await adapter.loadPriorReviewState?.({ change: event }),
    threadContexts: (await adapter.loadInlineThreadContexts?.({ change: event })) ?? [],
    mode: {
      kind: "user-reply",
      reply: {
        commentId: reply.commentId,
        parentCommentId: reply.parentCommentId,
        body: reply.body,
        actor: reply.actor,
      },
      respondWhenStillValid: config.publication.autoResolve.userReplies.respondWhenStillValid,
    },
  });
  return result;
}

function runnableReviewCommentReply(
  reply: ReviewCommentReplyEvent,
): { kind: "runnable" } | { kind: "ignored"; reason: string } {
  if (reply.action !== "created") {
    return { kind: "ignored", reason: `review comment action '${reply.action}' is not supported` };
  }
  if (!reply.parentCommentId) {
    return { kind: "ignored", reason: "review comment was not a reply" };
  }
  if (reply.actor === "github-actions[bot]") {
    return { kind: "ignored", reason: "review comment reply was authored by pipr" };
  }
  if (isPiprThreadActionReplyBody(reply.body)) {
    return { kind: "ignored", reason: "review comment reply was authored by pipr" };
  }
  return { kind: "runnable" };
}

async function verifierActorAllowed(
  adapter: CodeHostAdapter,
  event: ChangeRequestEventContext,
  reply: ReviewCommentReplyEvent,
  config: PiprConfig,
): Promise<boolean> {
  const allowed = config.publication.autoResolve.userReplies.allowedActors;
  if (allowed === "any") {
    return true;
  }
  if (allowed === "author-or-write" && event.change.author?.login === reply.actor) {
    return true;
  }
  const permission = await adapter.getRepositoryPermission({
    repository: event.repository,
    actor: reply.actor,
  });
  return hasRequiredRepositoryPermission(permission, "write");
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

  assertTrustedActionProviderEnv(options, prepared.trustedRuntime.settings.config);
  adapter.ensureHeadCheckout({ rootDir: options.rootDir, change: prepared.event });
  const completed = await runTrustedReviewAndPublish({
    options,
    adapter,
    trustedRuntime: prepared.trustedRuntime,
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
  event: ChangeRequestEventContext;
  taskName?: string;
  taskInput?: unknown;
}): Promise<
  | { kind: "skipped"; reason: string }
  | { kind: "completed"; review: ReviewRuntimeResult; publication: PublicationResult }
> {
  const checks = await startRuntimeChecks({
    adapter: options.adapter,
    event: options.event,
    plan: options.trustedRuntime.plan,
    taskName: options.taskName,
  });
  try {
    const review = await runTaskRuntime({
      workspace: options.options.rootDir,
      config: options.trustedRuntime.settings.config,
      event: options.event,
      env: options.options.env,
      plan: options.trustedRuntime.plan,
      taskName: options.taskName,
      taskInput: options.taskInput,
      trustedConfigSha: options.trustedRuntime.trustedConfigSha,
      trustedConfigHash: options.trustedRuntime.trustedConfigHash,
      piExecutable: options.options.piExecutable,
      checkSink: checks?.sink,
      loadPriorReviewState: () =>
        options.adapter.loadPriorReviewState?.({ change: options.event }) ??
        Promise.resolve(undefined),
      loadPriorMainComment: () =>
        options.adapter.loadPriorMainComment?.({ change: options.event }) ??
        Promise.resolve(undefined),
      loadInlineThreadContexts: () =>
        options.adapter.loadInlineThreadContexts?.({ change: options.event }) ??
        Promise.resolve([]),
    });
    if (review.kind === "skipped") {
      await finalizeRuntimeChecks(checks, { skipped: true });
      return { kind: "skipped", reason: review.skipReason ?? "review skipped" };
    }
    const publication = await options.adapter.publish({
      change: options.event,
      plan: review.publicationPlan,
    });
    await finalizeRuntimeChecks(checks, {});
    return { kind: "completed", review, publication };
  } catch (error) {
    await finalizeRuntimeChecks(checks, {
      forceFailureSummary: genericCheckFailureSummary,
      preserveTaskOutcomes: hasTaskFailureOutcome(checks),
    }).catch((finalizeError: unknown) => {
      console.warn(
        `Unable to finalize GitHub check runs after failure: ${errorMessage(finalizeError)}`,
      );
    });
    throw error;
  }
}

type StartedRuntimeChecks = {
  event: ChangeRequestEventContext;
  adapter: CodeHostAdapter;
  tasks: Task<unknown>[];
  outcomes: Map<string, RuntimeTaskCheckResult>;
  taskRuns: Map<string, CodeHostCheckRun>;
  aggregate?: CodeHostCheckRun;
  sink: RuntimeCheckSink;
};

type FinalizeRuntimeCheckOptions = {
  skipped?: boolean;
  forceFailureSummary?: string;
  preserveTaskOutcomes?: boolean;
};

async function startRuntimeChecks(options: {
  adapter: CodeHostAdapter;
  event: ChangeRequestEventContext;
  plan: RuntimePlan;
  taskName?: string;
}): Promise<StartedRuntimeChecks | undefined> {
  if (!canStartRuntimeChecks(options)) {
    return undefined;
  }
  const tasks = selectRuntimeTasks({
    plan: options.plan,
    event: options.event,
    taskName: options.taskName,
  });
  const aggregate = aggregateCheckOptions(options.plan);
  const taskRuns = new Map<string, CodeHostCheckRun>();
  if (!aggregate && !tasks.some((task) => taskCheckSettings(task).individual)) {
    return undefined;
  }
  const outcomes = new Map<string, RuntimeTaskCheckResult>();
  const started: StartedRuntimeChecks = {
    event: options.event,
    adapter: options.adapter,
    tasks,
    outcomes,
    taskRuns,
    sink: {
      setTaskResult(result) {
        outcomes.set(result.taskName, result);
      },
    },
  };
  try {
    await startTaskCheckRuns(started);
    if (aggregate) {
      started.aggregate = await createCheckRunOrThrow(
        started,
        aggregate.name,
        "pipr review is running.",
      );
    }
  } catch (error) {
    await finalizeRuntimeChecks(started, {
      forceFailureSummary: genericCheckFailureSummary,
    }).catch(() => undefined);
    throw error;
  }
  return started;
}

function canStartRuntimeChecks(options: {
  adapter: CodeHostAdapter;
  event: ChangeRequestEventContext;
  taskName?: string;
}): boolean {
  return (
    options.event.eventName === "pull_request" &&
    options.taskName === undefined &&
    Boolean(options.adapter.createCheckRun) &&
    Boolean(options.adapter.updateCheckRun)
  );
}

async function startTaskCheckRuns(started: StartedRuntimeChecks): Promise<void> {
  for (const task of started.tasks) {
    const settings = taskCheckSettings(task);
    if (!settings.individual) {
      continue;
    }
    started.taskRuns.set(
      task.name,
      await createCheckRunOrThrow(started, settings.name, "pipr task is running."),
    );
  }
}

async function createCheckRunOrThrow(
  checks: StartedRuntimeChecks,
  name: string,
  summary: string,
): Promise<CodeHostCheckRun> {
  try {
    const createCheckRun = checks.adapter.createCheckRun;
    if (!createCheckRun) {
      throw new Error("check run creation is not available");
    }
    return await createCheckRun({ change: checks.event, name, summary });
  } catch (error) {
    throw checkRunPermissionError(error);
  }
}

function checkRunPermissionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `Unable to create GitHub check run. Ensure the workflow grants 'checks: write'. ${message}`,
  );
}

async function finalizeRuntimeChecks(
  checks: StartedRuntimeChecks | undefined,
  options: FinalizeRuntimeCheckOptions,
): Promise<void> {
  if (!checks?.adapter.updateCheckRun) {
    return;
  }
  const taskResults = checks.tasks.map((task) =>
    taskCheckResultForFinalization(task, checks.outcomes.get(task.name), options),
  );
  const taskError = await updateTaskCheckRuns(checks, taskResults);
  const aggregateError = await updateAggregateCheckRun(checks, taskResults, options);
  const firstError = taskError ?? aggregateError;
  if (firstError !== undefined) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }
}

async function updateTaskCheckRuns(
  checks: StartedRuntimeChecks,
  taskResults: RuntimeTaskCheckResult[],
): Promise<unknown> {
  let firstError: unknown;
  for (const task of checks.tasks) {
    const run = checks.taskRuns.get(task.name);
    if (!run) {
      continue;
    }
    const result = taskResults.find((item) => item.taskName === task.name);
    if (!result) {
      continue;
    }
    firstError ??= await updateCheckRunOrError(checks, run, result);
  }
  return firstError;
}

async function updateAggregateCheckRun(
  checks: StartedRuntimeChecks,
  taskResults: RuntimeTaskCheckResult[],
  options: FinalizeRuntimeCheckOptions,
): Promise<unknown> {
  if (checks.aggregate) {
    return await updateCheckRunOrError(
      checks,
      checks.aggregate,
      aggregateCheckConclusion(checks.tasks, taskResults, options),
    );
  }
  return undefined;
}

async function updateCheckRunOrError(
  checks: StartedRuntimeChecks,
  checkRun: CodeHostCheckRun,
  result: { conclusion: CodeHostCheckConclusion; summary?: string },
): Promise<unknown> {
  try {
    await checks.adapter.updateCheckRun?.({
      change: checks.event,
      checkRun,
      conclusion: result.conclusion,
      summary: result.summary,
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

function taskCheckResultForFinalization(
  task: Task<unknown>,
  result: RuntimeTaskCheckResult | undefined,
  options: FinalizeRuntimeCheckOptions,
): RuntimeTaskCheckResult {
  if (options.skipped) {
    return { taskName: task.name, conclusion: "neutral", summary: "No task matched this run." };
  }
  if (options.forceFailureSummary && options.preserveTaskOutcomes && result) {
    return result;
  }
  if (options.forceFailureSummary) {
    return { taskName: task.name, conclusion: "failure", summary: options.forceFailureSummary };
  }
  return result ?? { taskName: task.name, conclusion: "success" };
}

function aggregateCheckConclusion(
  tasks: Task<unknown>[],
  results: RuntimeTaskCheckResult[],
  options: { skipped?: boolean; forceFailureSummary?: string },
): { conclusion: CodeHostCheckConclusion; summary: string } {
  if (options.skipped || tasks.length === 0) {
    return { conclusion: "neutral", summary: "No pipr tasks matched this run." };
  }
  if (options.forceFailureSummary) {
    return { conclusion: "failure", summary: options.forceFailureSummary };
  }
  const participating = tasks.filter((task) => taskCheckSettings(task).aggregate);
  if (participating.length === 0) {
    return { conclusion: "neutral", summary: "No pipr task checks participated." };
  }
  const failedRequired = participating.some((task) => {
    const settings = taskCheckSettings(task);
    const result = results.find((item) => item.taskName === task.name);
    return settings.required && result?.conclusion === "failure";
  });
  return failedRequired
    ? { conclusion: "failure", summary: "One or more required pipr tasks failed." }
    : { conclusion: "success", summary: "All required pipr tasks completed." };
}

function hasTaskFailureOutcome(checks: StartedRuntimeChecks | undefined): boolean {
  return Array.from(checks?.outcomes.values() ?? []).some(
    (result) => result.conclusion === "failure",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function aggregateCheckOptions(plan: RuntimePlan): { name: string } | undefined {
  const aggregate = plan.checks?.aggregate;
  if (aggregate === undefined || aggregate === false || aggregate.enabled === false) {
    return undefined;
  }
  return { name: aggregate.name ?? "all" };
}

function taskCheckSettings(task: Task<unknown>): {
  individual: boolean;
  aggregate: boolean;
  name: string;
  required: boolean;
} {
  const check = task.check;
  if (check === false) {
    return { individual: false, aggregate: false, name: task.name, required: false };
  }
  const options = typeof check === "object" ? check : undefined;
  return {
    individual: options !== undefined && options.enabled !== false,
    aggregate: true,
    name: options?.name ?? task.name,
    required: options?.required ?? true,
  };
}

function assertTrustedActionProviderEnv(
  options: ActionCommandDependencyOptions,
  trustedConfig: PiprConfig,
): void {
  const env = actionEnv(options);
  const missing: string[] = [];
  for (const provider of trustedConfig.providers) {
    if (!env[provider.apiKeyEnv]) {
      missing.push(provider.apiKeyEnv);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing provider env vars: ${missing.join(", ")}`);
  }
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
