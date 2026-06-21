#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { inspect, parseArgs } from "node:util";
import * as core from "@actions/core";
import type { GitHubPublicationClient } from "@pipr/runtime";
import {
  type ActionCommandResult,
  PublicationError,
  runActionCommand,
  runDryRunCommand,
  runInitCommand,
  runInspectCommand,
  runLocalTaskCommand,
  runValidateCommand,
} from "@pipr/runtime";

type CliOptions = {
  configDir: string;
  event?: string;
  force: boolean;
  trustedProvider?: {
    providerId?: string;
    provider?: string;
    model?: string;
    apiKeyEnv?: string;
  };
  requireEnv: boolean;
  base?: string;
  head?: string;
  piExecutable?: string;
};

type CommandHandler = (options: CliOptions) => Promise<void> | void;
type LoadedActionResult = Exclude<ActionCommandResult, { kind: "ignored" }>;

const help = `pipr

Commands:
  init [--config-dir .pipr] [--force]
                                   Create editable TypeScript config
  action [--config-dir .pipr] [--provider-id id] [--provider name] [--model model] [--api-key-env ENV]
                                   Run inside GitHub Docker Action
  check [--config-dir .pipr] [--require-env]
                                   Type-load config and validate the runtime plan
  dry-run --event event.json [--config-dir .pipr]
                                   Load config and event without publishing
  inspect [--config-dir .pipr]     Print models, agents, tasks, commands, locals, and tools
  review --base sha [--head sha] [--config-dir .pipr]
                                   Run local review entrypoint without publishing
  run name --base sha [--head sha] [--config-dir .pipr]
                                   Run a named local entrypoint without publishing
`;

const commandHandlers: Record<string, CommandHandler> = {
  init: runInit,
  action: runAction,
  check: runCheck,
  "dry-run": runDryRun,
  inspect: runInspect,
  review: runReview,
  help: printHelp,
  "--help": printHelp,
  "-h": printHelp,
};

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "run") {
    await runLocal(args);
    return;
  }
  const handler = getCommandHandler(command);
  if (!handler) {
    throw new Error(`Unknown pipr command '${command}'`);
  }
  if (args.some(isHelpOption)) {
    printHelp();
    return;
  }
  await handler(parseOptions(args));
}

async function runAction(options: CliOptions): Promise<void> {
  const result = await runActionCommand({
    rootDir: actionWorkspace(),
    configDir: actionConfigDir(options),
    env: process.env,
    eventPath: actionEventPath(),
    dryRun: isActionDryRun(),
    piExecutable: process.env.PIPR_PI_EXECUTABLE,
    trustedProvider: options.trustedProvider,
    githubPublicationClient: fixturePublicationClient({
      fixturePath: process.env.PIPR_GITHUB_FIXTURE_PATH,
      enabled: process.env.PIPR_ENABLE_TEST_FIXTURES === "1",
    }),
  });
  handleActionResult(result);
}

function handleActionResult(result: ActionCommandResult): void {
  if (result.kind === "ignored") {
    handleIgnoredActionResult(result);
    return;
  }
  handleLoadedActionResult(result);
}

function handleLoadedActionResult(result: LoadedActionResult): void {
  if (result.kind === "dry-run") {
    handleDryRunActionResult(result);
    return;
  }
  handleCompletedActionResult(result);
}

function handleCompletedActionResult(
  result: Exclude<LoadedActionResult, { kind: "dry-run" }>,
): void {
  if (result.kind === "command-help") {
    handleCommandHelpActionResult(result);
    return;
  }
  handleReviewActionResult(result);
}

function handleIgnoredActionResult(
  result: Extract<ActionCommandResult, { kind: "ignored" }>,
): void {
  core.info(`pipr ignored event: ${result.reason}`);
}

function handleDryRunActionResult(result: Extract<ActionCommandResult, { kind: "dry-run" }>): void {
  logActionContext(result);
  core.info("PIPR_DRY_RUN=1; stopping before review runtime, model, or GitHub publishing calls");
}

function handleCommandHelpActionResult(
  result: Extract<ActionCommandResult, { kind: "command-help" }>,
): void {
  logActionContext(result);
  core.info(`pipr command help: ${result.reason}`);
  core.setOutput("main-comment", result.body);
}

function handleReviewActionResult(result: Extract<ActionCommandResult, { kind: "review" }>): void {
  logActionContext(result);
  core.info(
    `pipr review produced ${result.review.validated.validFindings.length} valid inline finding(s), ` +
      `${result.review.validated.droppedFindings.length} dropped finding(s)`,
  );
  core.info(
    `pipr published main comment (${result.publication.mainComment.action}) and ` +
      `${result.publication.inlineComments.posted} inline comment(s); ` +
      `${result.publication.inlineComments.skipped} skipped`,
  );
  if (result.review.repairAttempted) {
    core.info("pipr repaired reviewer JSON once before validation");
  }
  core.setOutput("main-comment", result.review.mainComment);
  core.setOutput("inline-comments", JSON.stringify(result.review.inlineCommentDrafts));
  core.setOutput("dropped-findings", JSON.stringify(result.review.validated.droppedFindings));
  core.setOutput("publication", JSON.stringify(result.publication));
}

function logActionContext(result: LoadedActionResult): void {
  logActionEvent(result.event);
  core.info(`pipr config source: ${result.configSource}`);
}

async function runInit(options: CliOptions): Promise<void> {
  const result = await runInitCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    force: options.force,
  });
  console.log(
    `created ${result.created.length} file(s) in ${result.configDir}` +
      (result.overwritten.length > 0 ? `; overwrote ${result.overwritten.length}` : ""),
  );
}

async function runCheck(options: CliOptions): Promise<void> {
  const settings = await runValidateCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
    requireProviderEnv: options.requireEnv,
  });
  console.log(`valid: ${settings.source}`);
  for (const warning of settings.warnings) {
    console.log(`warning: ${warning}`);
  }
}

async function runInspect(options: CliOptions): Promise<void> {
  const result = await runInspectCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
  });
  console.log(inspect(result, { depth: 8, colors: false }));
}

async function runReview(options: CliOptions): Promise<void> {
  await runLocalEntrypoint("review", options);
}

async function runLocal(args: string[]): Promise<void> {
  const [localName, ...options] = args;
  if (!localName || isHelpOption(localName)) {
    printHelp();
    return;
  }
  await runLocalEntrypoint(localName, parseOptions(options));
}

async function runLocalEntrypoint(localName: string, options: CliOptions): Promise<void> {
  if (!options.base) {
    throw new Error(`pipr ${localName} requires --base <sha>`);
  }
  const result = await runLocalTaskCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
    localName,
    baseSha: options.base,
    headSha: options.head,
    piExecutable: options.piExecutable,
  });
  if (result.kind === "skipped") {
    console.log(`skipped: ${result.skipReason ?? "no task matched"}`);
    return;
  }
  console.log(result.mainComment);
}

async function runDryRun(options: CliOptions): Promise<void> {
  if (!options.event) {
    throw new Error("dry-run requires --event <path>");
  }
  const result = await runDryRunCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
    eventPath: options.event,
  });
  console.log(
    inspect(
      {
        configSource: result.configSource,
        event: result.event,
      },
      { depth: 6, colors: false },
    ),
  );
}

function parseOptions(args: string[]): CliOptions {
  const values = parseCliArgs(args);
  return {
    configDir: stringOption(values["config-dir"]) ?? ".pipr",
    event: stringOption(values.event),
    force: values.force === true,
    trustedProvider: readTrustedProviderOptions(values),
    requireEnv: values["require-env"] === true,
    base: stringOption(values.base),
    head: stringOption(values.head),
    piExecutable: stringOption(values["pi-executable"]),
  };
}

function parseCliArgs(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      "config-dir": { type: "string" },
      event: { type: "string" },
      force: { type: "boolean" },
      "provider-id": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "api-key-env": { type: "string" },
      "require-env": { type: "boolean" },
      base: { type: "string" },
      head: { type: "string" },
      "pi-executable": { type: "string" },
    },
  }).values;
}

function readTrustedProviderOptions(
  values: ReturnType<typeof parseCliArgs>,
): CliOptions["trustedProvider"] {
  const trustedProvider = {
    providerId: stringOption(values["provider-id"]),
    provider: stringOption(values.provider),
    model: stringOption(values.model),
    apiKeyEnv: stringOption(values["api-key-env"]),
  };
  return Object.values(trustedProvider).some((value) => value !== undefined)
    ? trustedProvider
    : undefined;
}

function stringOption(value: string | boolean | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getCommandHandler(command: string): CommandHandler | undefined {
  return Object.hasOwn(commandHandlers, command) ? commandHandlers[command] : undefined;
}

function isHelpOption(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

function actionWorkspace(): string {
  return process.env.GITHUB_WORKSPACE ?? process.cwd();
}

function isActionDryRun(): boolean {
  return process.env.PIPR_DRY_RUN === "1";
}

function actionConfigDir(options: CliOptions): string {
  return process.env["INPUT_CONFIG-DIR"] || options.configDir;
}

function actionEventPath(): string {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required for pipr action");
  }
  return eventPath;
}

function logActionEvent(event: { pullRequestNumber: number; repo: string }): void {
  core.info(`pipr loaded PR #${event.pullRequestNumber} for ${event.repo}`);
}

function fixturePublicationClient(options: {
  fixturePath: string | undefined;
  enabled: boolean;
}): GitHubPublicationClient | undefined {
  if (!options.fixturePath) {
    return undefined;
  }
  if (!options.enabled) {
    throw new Error("PIPR_GITHUB_FIXTURE_PATH requires PIPR_ENABLE_TEST_FIXTURES=1");
  }
  const fixturePath = options.fixturePath;
  return {
    async getAuthenticatedUserLogin() {
      return (await readFixture(fixturePath)).ownerLogin;
    },
    async getPullRequestHeadSha() {
      return (await readFixture(fixturePath)).headSha;
    },
    async listIssueComments() {
      return (await readFixture(fixturePath)).issueComments;
    },
    async createIssueComment(options) {
      const fixture = await readFixture(fixturePath);
      const comment = {
        id: fixture.issueComments.length + 1,
        body: options.body,
        authorLogin: fixture.ownerLogin,
      };
      fixture.issueComments.push(comment);
      await writeFixture(fixturePath, fixture);
      return { id: comment.id };
    },
    async updateIssueComment(options) {
      const fixture = await readFixture(fixturePath);
      const comment = fixture.issueComments.find((item) => item.id === options.commentId);
      if (!comment) {
        throw new Error(`Fixture issue comment ${options.commentId} not found`);
      }
      comment.body = options.body;
      await writeFixture(fixturePath, fixture);
      return { id: comment.id };
    },
    async listReviewComments() {
      return (await readFixture(fixturePath)).reviewComments;
    },
    async createReviewComment(options) {
      const fixture = await readFixture(fixturePath);
      if (fixture.failReviewComment) {
        throw new Error("fixture inline failed");
      }
      const comment = {
        id: fixture.reviewComments.length + 1,
        body: options.body,
        authorLogin: fixture.ownerLogin,
      };
      fixture.reviewComments.push(comment);
      fixture.reviewCommentPayloads.push(options);
      await writeFixture(fixturePath, fixture);
      return { id: comment.id };
    },
  };
}

type GitHubPublicationFixture = {
  ownerLogin: string;
  headSha: string;
  issueComments: Array<{ id: number; body: string; authorLogin: string | undefined }>;
  reviewComments: Array<{ id: number; body: string; authorLogin: string | undefined }>;
  reviewCommentPayloads: unknown[];
  failReviewComment?: boolean;
};

async function readFixture(fixturePath: string): Promise<GitHubPublicationFixture> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as GitHubPublicationFixture;
}

async function writeFixture(fixturePath: string, fixture: GitHubPublicationFixture): Promise<void> {
  await writeFile(fixturePath, JSON.stringify(fixture));
}

function printHelp(): void {
  console.log(help);
}

main().catch((error: unknown) => {
  if (error instanceof PublicationError && error.result) {
    core.setOutput("publication", JSON.stringify(error.result));
    core.error(`pipr publication metadata: ${JSON.stringify(error.result)}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
});
