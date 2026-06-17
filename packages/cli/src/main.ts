#!/usr/bin/env bun
import { inspect } from "node:util";
import * as core from "@actions/core";
import type { RegistryEntry, ResolvedConfig, RuntimeRegistry } from "@pipr/runtime";
import {
  createBuiltinRegistry,
  createRuntimeRegistry,
  loadConfig,
  loadPullRequestEventContext,
  renderRegistryGraph,
  runReviewRuntime,
} from "@pipr/runtime";

type CliOptions = {
  configDir: string;
  event?: string;
  requireEnv: boolean;
};

type CommandHandler = (options: CliOptions) => Promise<void> | void;
type OptionHandler = (options: CliOptions, args: string[], index: number) => number;

const help = `pipr

Commands:
  action [--config-dir .pipr]      Run inside GitHub Docker Action
  validate [--config-dir .pipr] [--require-env]
                                   Validate resolved config
  dry-run --event event.json [--config-dir .pipr]
                                   Load config and event without publishing
  graph [--config-dir .pipr]       Print resolved workflow graph
  explain-config [--config-dir .pipr]
                                   Print resolved config and source
  list-blocks|list-tools|list-agents|list-presets [--config-dir .pipr]
`;

const commandHandlers: Record<string, CommandHandler> = {
  action: runAction,
  validate: runValidate,
  "dry-run": runDryRun,
  graph: printGraph,
  "explain-config": runExplainConfig,
  "list-blocks": listBlocks,
  "list-tools": listTools,
  "list-agents": listAgents,
  "list-presets": listPresets,
  help: printHelp,
  "--help": printHelp,
  "-h": printHelp,
};

const optionHandlers: Record<string, OptionHandler> = {
  "--config-dir": readConfigDirOption,
  "--event": readEventOption,
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
  const dryRun = isActionDryRun();
  const event = await loadActionEvent();
  const resolved = await loadConfig({
    rootDir: actionWorkspace(),
    configDir: actionConfigDir(options),
    env: process.env,
    requireProviderEnv: !dryRun,
  });
  createRuntimeRegistry(resolved);
  logActionEvent(event);
  core.info(`pipr config source: ${resolved.source}`);
  if (dryRun) {
    core.info("PIPR_DRY_RUN=1; stopping before review runtime, model, or GitHub publishing calls");
    return;
  }
  const result = await runReviewRuntime({
    workspace: actionWorkspace(),
    config: resolved.config,
    event,
    registry: createBuiltinRegistry(),
    piExecutable: process.env.PIPR_PI_EXECUTABLE,
  });
  core.info(
    `pipr review produced ${result.validated.validFindings.length} inline draft(s), ` +
      `${result.validated.droppedFindings.length} dropped finding(s)`,
  );
  if (result.repairAttempted) {
    core.info("pipr repaired reviewer JSON once before validation");
  }
  core.setOutput("main-comment", result.mainComment);
  core.setOutput("inline-comments", JSON.stringify(result.inlineCommentDrafts));
  core.setOutput("dropped-findings", JSON.stringify(result.validated.droppedFindings));
}

async function runValidate(options: CliOptions): Promise<void> {
  const resolved = await loadResolvedConfig(options);
  createRuntimeRegistry(resolved);
  console.log(`valid: ${resolved.source}`);
  for (const warning of resolved.warnings) {
    console.log(`warning: ${warning}`);
  }
}

async function runDryRun(options: CliOptions): Promise<void> {
  if (!options.event) {
    throw new Error("dry-run requires --event <path>");
  }
  const resolved = await loadConfig({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
    requireProviderEnv: false,
  });
  const event = await loadPullRequestEventContext(options.event, {
    ...process.env,
    GITHUB_WORKSPACE: process.cwd(),
    GITHUB_EVENT_NAME: "pull_request",
  });
  console.log(
    inspect(
      {
        configSource: resolved.source,
        event,
        registry: createRuntimeRegistry(resolved),
      },
      { depth: 6, colors: false },
    ),
  );
}

function loadResolvedConfig(options: CliOptions): Promise<ResolvedConfig> {
  return loadConfig({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
    requireProviderEnv: options.requireEnv,
  });
}

async function loadRuntimeRegistry(options: CliOptions): Promise<RuntimeRegistry> {
  const resolved = await loadResolvedConfig({ ...options, requireEnv: false });
  return createRuntimeRegistry(resolved);
}

async function runExplainConfig(options: CliOptions): Promise<void> {
  const resolved = await loadResolvedConfig({ ...options, requireEnv: false });
  console.log(inspect(resolved, { depth: 8, colors: false }));
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    configDir: ".pipr",
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

function readRequireEnvOption(options: CliOptions, _args: string[], index: number): number {
  options.requireEnv = true;
  return index + 1;
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

function actionConfigDir(options: CliOptions): string {
  return process.env["INPUT_CONFIG-DIR"] || options.configDir;
}

function isActionDryRun(): boolean {
  return process.env.PIPR_DRY_RUN === "1";
}

async function loadActionEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required for pipr action");
  }
  return await loadPullRequestEventContext(eventPath, process.env);
}

function logActionEvent(event: Awaited<ReturnType<typeof loadActionEvent>>): void {
  core.info(`pipr loaded PR #${event.pullRequestNumber} for ${event.repo}`);
}

async function printGraph(options: CliOptions): Promise<void> {
  console.log(renderRegistryGraph(await loadRuntimeRegistry(options)));
}

function printHelp(): void {
  console.log(help);
}

async function listBlocks(options: CliOptions): Promise<void> {
  listEntries((await loadRuntimeRegistry(options)).blocks);
}

async function listTools(options: CliOptions): Promise<void> {
  listEntries((await loadRuntimeRegistry(options)).tools);
}

async function listAgents(options: CliOptions): Promise<void> {
  listEntries((await loadRuntimeRegistry(options)).agents);
}

async function listPresets(options: CliOptions): Promise<void> {
  listEntries((await loadRuntimeRegistry(options)).presets);
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
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
});
