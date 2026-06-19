#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { inspect } from "node:util";
import * as core from "@actions/core";
import type { GitHubPublicationClient, RegistryEntry } from "@pipr/runtime";
import {
  type ActionCommandResult,
  PublicationError,
  runActionCommand,
  runDryRunCommand,
  runExplainConfigCommand,
  runGraphCommand,
  runInitCommand,
  runListCommand,
  runListCommandsCommand,
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
};

type CommandHandler = (options: CliOptions) => Promise<void> | void;
type OptionHandler = (options: CliOptions, args: string[], index: number) => number;
type LoadedActionResult = Exclude<ActionCommandResult, { kind: "ignored" }>;

const help = `pipr

Commands:
  init [--config-dir .pipr] [--force]
                                   Create editable official minimal config
  action [--config-dir .pipr] [--provider-id id] [--provider name] [--model model] [--api-key-env ENV]
                                   Run inside GitHub Docker Action
  validate [--config-dir .pipr] [--require-env]
                                   Validate resolved config
  dry-run --event event.json [--config-dir .pipr]
                                   Load config and event without publishing
  graph [--config-dir .pipr]       Print resolved workflow graph
  explain-config [--config-dir .pipr]
                                   Print resolved config and source
  list-blocks|list-tools|list-agents|list-presets|list-commands [--config-dir .pipr]
`;

const commandHandlers: Record<string, CommandHandler> = {
  init: runInit,
  action: runAction,
  validate: runValidate,
  "dry-run": runDryRun,
  graph: printGraph,
  "explain-config": runExplainConfig,
  "list-blocks": listBlocks,
  "list-tools": listTools,
  "list-agents": listAgents,
  "list-presets": listPresets,
  "list-commands": listCommands,
  help: printHelp,
  "--help": printHelp,
  "-h": printHelp,
};

const optionHandlers: Record<string, OptionHandler> = {
  "--config-dir": readConfigDirOption,
  "--event": readEventOption,
  "--force": readForceOption,
  "--provider-id": readProviderIdOption,
  "--provider": readProviderOption,
  "--model": readModelOption,
  "--api-key-env": readApiKeyEnvOption,
  "--require-env": readRequireEnvOption,
};

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
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

async function runValidate(options: CliOptions): Promise<void> {
  const resolved = await runValidateCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
    requireProviderEnv: options.requireEnv,
  });
  console.log(`valid: ${resolved.source}`);
  for (const warning of resolved.warnings) {
    console.log(`warning: ${warning}`);
  }
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
        registry: result.registry,
      },
      { depth: 6, colors: false },
    ),
  );
}

async function runExplainConfig(options: CliOptions): Promise<void> {
  const resolved = await runExplainConfigCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
  });
  console.log(inspect(resolved, { depth: 8, colors: false }));
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    configDir: ".pipr",
    force: false,
    requireEnv: false,
  };
  let index = 0;
  while (index < args.length) {
    index = applyOption(options, args, index);
  }
  return options;
}

function applyOption(options: CliOptions, args: string[], index: number): number {
  const arg = args[index] ?? "";
  const handler = getOptionHandler(arg);
  if (!handler) {
    throw new Error(`Unknown option '${arg}'`);
  }
  return handler(options, args, index);
}

function getCommandHandler(command: string): CommandHandler | undefined {
  return hasOwn(commandHandlers, command) ? commandHandlers[command] : undefined;
}

function getOptionHandler(option: string): OptionHandler | undefined {
  return hasOwn(optionHandlers, option) ? optionHandlers[option] : undefined;
}

function isHelpOption(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

function readConfigDirOption(options: CliOptions, args: string[], index: number): number {
  options.configDir = readOptionValue(args, index);
  return index + 2;
}

function readEventOption(options: CliOptions, args: string[], index: number): number {
  options.event = readOptionValue(args, index);
  return index + 2;
}

function readForceOption(options: CliOptions, _args: string[], index: number): number {
  options.force = true;
  return index + 1;
}

function readRequireEnvOption(options: CliOptions, _args: string[], index: number): number {
  options.requireEnv = true;
  return index + 1;
}

function readProviderIdOption(options: CliOptions, args: string[], index: number): number {
  trustedProviderOptions(options).providerId = readOptionValue(args, index);
  return index + 2;
}

function readProviderOption(options: CliOptions, args: string[], index: number): number {
  trustedProviderOptions(options).provider = readOptionValue(args, index);
  return index + 2;
}

function readModelOption(options: CliOptions, args: string[], index: number): number {
  trustedProviderOptions(options).model = readOptionValue(args, index);
  return index + 2;
}

function readApiKeyEnvOption(options: CliOptions, args: string[], index: number): number {
  trustedProviderOptions(options).apiKeyEnv = readOptionValue(args, index);
  return index + 2;
}

function trustedProviderOptions(options: CliOptions): NonNullable<CliOptions["trustedProvider"]> {
  options.trustedProvider ??= {};
  return options.trustedProvider;
}

function readOptionValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${args[index]} requires a value`);
  }
  return value;
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

async function printGraph(options: CliOptions): Promise<void> {
  console.log(
    await runGraphCommand({
      rootDir: process.cwd(),
      configDir: options.configDir,
      env: process.env,
    }),
  );
}

function printHelp(): void {
  console.log(help);
}

async function listBlocks(options: CliOptions): Promise<void> {
  listEntries(await loadEntries(options, "blocks"));
}

async function listTools(options: CliOptions): Promise<void> {
  listEntries(await loadEntries(options, "tools"));
}

async function listAgents(options: CliOptions): Promise<void> {
  listEntries(await loadEntries(options, "agents"));
}

async function listPresets(options: CliOptions): Promise<void> {
  listEntries(await loadEntries(options, "presets"));
}

async function listCommands(options: CliOptions): Promise<void> {
  listEntries(
    await runListCommandsCommand({
      rootDir: process.cwd(),
      configDir: options.configDir,
      env: process.env,
    }),
  );
}

function loadEntries(
  options: CliOptions,
  collection: "blocks" | "tools" | "agents" | "presets",
): Promise<RegistryEntry[]> {
  return runListCommand(
    {
      rootDir: process.cwd(),
      configDir: options.configDir,
      env: process.env,
    },
    collection,
  );
}

function listEntries(entries: RegistryEntry[]): void {
  for (const entry of entries) {
    console.log(`${entry.id}\t${entry.description}`);
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
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
