import { firstNonEmptyLine, isPiprCommandLine } from "../commands/grammar.js";
import {
  type InitOfficialMinimalProjectResult,
  initOfficialMinimalProject,
} from "../config/init.js";
import { inspectRuntimePlan, loadRuntimeProject, validateProject } from "../config/project.js";
import { buildDiffManifest } from "../diff/diff.js";
import { runGit as runGitCommand } from "../diff/git.js";
import { createLocalChangeRequestEvent } from "../hosts/local/adapter.js";
import type {
  CodeHostAdapter,
  CommandCommentEvent,
  ReviewCommentReplyEvent,
} from "../hosts/types.js";
import { resolveProvider } from "../review/agent/review-run.js";
import { isPiprThreadActionReplyBody } from "../review/prior-state.js";
import { runTaskRuntime } from "../review/task/task-runtime.js";
import { runInternalVerifier } from "../review/verifier.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";
import { parseChangeRequestEventContext } from "../types.js";
import { assertTrustedActionProviderEnv, createActionHostAdapter } from "./action-host.js";
import {
  dispatchRuntimeEntry,
  hasRequiredRepositoryPermission,
  type PlanCommandResolution,
  parsePlanCommandInputs,
  permissionDeniedHelp,
  resolvePlanCommand,
} from "./entry-dispatch.js";
import { loadRuntimeProjectFromGitCommit } from "./git-project.js";
import { runTrustedReviewAndPublish } from "./review-publishing.js";
import type {
  ActionCommandDependencyOptions,
  ActionCommandOptions,
  ActionCommandResult,
  DryRunCommandOptions,
  DryRunCommandResult,
  InitCommandOptions,
  InspectCommandResult,
  LocalTaskCommandOptions,
  LocalTaskCommandResult,
  RuntimeCommandOptions,
  TrustedReviewAndPublishResult,
  TrustedRuntimeProject,
  ValidateCommandResult,
} from "./types.js";

export type {
  ActionCommandOptions,
  ActionCommandResult,
  DryRunCommandOptions,
  DryRunCommandResult,
  InitCommandOptions,
  InspectCommandResult,
  LocalTaskCommandOptions,
  LocalTaskCommandResult,
  RuntimeCommandOptions,
} from "./types.js";

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
export async function runValidateCommand(
  options: RuntimeCommandOptions,
): Promise<ValidateCommandResult> {
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
  const event = await adapter.events.parseEvent({
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
  const localDispatch = dispatchRuntimeEntry({
    kind: "local",
    plan: runtime.plan,
    localName: options.localName,
  });
  const local = localDispatch.kind === "local" ? localDispatch.local : undefined;
  if (!local) {
    throw new Error(`Local entry '${options.localName}' was not registered`);
  }
  const headSha = options.headSha ?? runGitCommand(["rev-parse", "HEAD"], options.rootDir).trim();
  const event = parseChangeRequestEventContext({
    ...createLocalChangeRequestEvent({
      rootDir: options.rootDir,
      baseSha: options.baseSha,
      headSha,
    }),
  });
  const result = await runTaskRuntime({
    workspace: options.rootDir,
    config: runtime.settings.config,
    event,
    env: options.env,
    plan: runtime.plan,
    taskName: local.task.name,
    piExecutable: options.piExecutable,
  });
  if (result.kind === "command-response") {
    throw new Error("command response result is only supported for issue_comment commands");
  }
  return result as LocalTaskCommandResult;
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
  adapter.workspace.ensureWorkspaceSafeDirectory?.({ rootDir: options.rootDir, env: options.env });
  const eventName = (options.env ?? process.env).GITHUB_EVENT_NAME ?? "pull_request";
  if (eventName === "issue_comment") {
    return await runIssueCommentActionCommand(options, adapter);
  }
  if (eventName === "pull_request_review_comment") {
    return await runReviewCommentReplyActionCommand(options, adapter);
  }
  const event = await adapter.events.parseEvent({
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
  adapter.workspace.ensureHeadCheckout({ rootDir: options.rootDir, change: event });
  const dispatch = dispatchRuntimeEntry({
    kind: "change-request",
    plan: trustedRuntime.plan,
    event,
  });
  const completed = await runTrustedReviewAndPublish({
    options,
    adapter,
    trustedRuntime,
    event,
    selectedTasks: dispatch.kind === "change-request" ? dispatch.tasks : [],
  });
  if (completed.kind === "skipped") {
    return { kind: "ignored", reason: completed.reason };
  }
  if (completed.kind === "command-response") {
    throw new Error("command response result is only supported for issue_comment commands");
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
  const capabilities = reviewCommentReplyDispatchCapabilities(options, adapter);
  if (capabilities.kind === "ignored") {
    return capabilities;
  }
  const reply = await capabilities.resolveReviewCommentReply({
    eventPath: options.eventPath,
    env: options.env ?? process.env,
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
  const publication = await capabilities.publishThreadActions({
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

function reviewCommentReplyDispatchCapabilities(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
):
  | { kind: "ignored"; reason: string }
  | {
      kind: "ready";
      resolveReviewCommentReply: NonNullable<
        CodeHostAdapter["events"]["resolveReviewCommentReply"]
      >;
      publishThreadActions: NonNullable<
        NonNullable<CodeHostAdapter["publication"]>["publishThreadActions"]
      >;
    } {
  if (!adapter.events.resolveReviewCommentReply) {
    return { kind: "ignored", reason: "host adapter does not support review comment replies" };
  }
  if (!adapter.publication?.publishThreadActions) {
    return { kind: "ignored", reason: "host adapter does not support verifier thread actions" };
  }
  if (options.dryRun) {
    return { kind: "ignored", reason: "PIPR_DRY_RUN=1; verifier dispatch skipped" };
  }
  return {
    kind: "ready",
    resolveReviewCommentReply: adapter.events.resolveReviewCommentReply,
    publishThreadActions: adapter.publication.publishThreadActions,
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
  const loaded = await adapter.events.loadChangeRequest({
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
  adapter.workspace.ensureHeadCheckout({ rootDir: options.rootDir, change: event });
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
    priorReviewState: await adapter.comments?.loadPriorReviewState?.({ change: event }),
    threadContexts: (await adapter.comments?.loadInlineThreadContexts?.({ change: event })) ?? [],
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
  const permission = await adapter.permissions.getRepositoryPermission({
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
  const comment = await adapter.events.resolveCommandComment({
    eventPath: options.eventPath,
    env: options.env ?? process.env,
    workspace: options.rootDir,
  });
  const runnable = runnableIssueCommentCommand(comment, options.dryRun);
  if (runnable.kind === "ignored") {
    return runnable;
  }
  const loaded = await adapter.events.loadChangeRequest({
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
  const permission = await adapter.permissions.getRepositoryPermission({
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
  adapter.workspace.ensureHeadCheckout({ rootDir: options.rootDir, change: prepared.event });
  const dispatch = dispatchRuntimeEntry({
    kind: "change-request",
    plan: prepared.trustedRuntime.plan,
    event: prepared.event,
    taskName: parsedResolution.invocation.taskName,
  });
  const completed = await runTrustedReviewAndPublish({
    options,
    adapter,
    trustedRuntime: prepared.trustedRuntime,
    event: prepared.event,
    taskName: parsedResolution.invocation.taskName,
    taskInput: parsedResolution.invocation.inputs,
    selectedTasks: dispatch.kind === "change-request" ? dispatch.tasks : [],
    commandInvocation: {
      name: parsedResolution.invocation.commandName,
      line: parsedResolution.invocation.line,
      arguments: parsedResolution.invocation.arguments,
    },
  });
  return await issueCommentCommandResult({
    adapter,
    completed,
    event: prepared.event,
    commandName: parsedResolution.invocation.commandName,
    sourceCommentId: prepared.comment.commentId,
    configSource: prepared.trustedRuntime.settings.source,
  });
}

async function issueCommentCommandResult(options: {
  adapter: CodeHostAdapter;
  completed: TrustedReviewAndPublishResult;
  event: ChangeRequestEventContext;
  commandName: string;
  sourceCommentId: number;
  configSource: string;
}): Promise<ActionCommandResult> {
  if (options.completed.kind === "skipped") {
    return { kind: "ignored", reason: options.completed.reason };
  }
  if (options.completed.kind === "command-response") {
    return await publishCommandResponseActionResult({
      adapter: options.adapter,
      completed: options.completed,
      event: options.event,
      sourceCommentId: options.sourceCommentId,
      configSource: options.configSource,
    });
  }
  return {
    kind: "review",
    event: options.event,
    command: options.commandName,
    configSource: options.configSource,
    review: options.completed.review,
    publication: options.completed.publication,
  };
}

async function publishCommandResponseActionResult(options: {
  adapter: CodeHostAdapter;
  completed: Extract<TrustedReviewAndPublishResult, { kind: "command-response" }>;
  event: ChangeRequestEventContext;
  sourceCommentId: number;
  configSource: string;
}): Promise<ActionCommandResult> {
  const publishCommandResponse = options.adapter.publication?.publishCommandResponse;
  if (!publishCommandResponse) {
    throw new Error("command response publication is not available for this code host");
  }
  const publication = await publishCommandResponse({
    change: options.event,
    sourceCommentId: options.sourceCommentId,
    commandName: options.completed.response.commandName,
    body: options.completed.response.body,
  });
  return {
    kind: "command-response",
    event: options.event,
    command: options.completed.response.commandName,
    configSource: options.configSource,
    response: { body: options.completed.response.body },
    publication,
  };
}
