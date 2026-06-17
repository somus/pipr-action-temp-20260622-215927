#!/usr/bin/env bun
import { inspect } from "node:util";
import * as core from "@actions/core";
import {
  createBuiltinRegistry,
  loadConfig,
  loadPullRequestEventContext,
  renderRegistryGraph,
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
  graph                            Print builtin workflow graph
  explain-config                   Print resolved config and source
  list-blocks|list-tools|list-agents|list-presets
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
  const handler = commandHandlers[command];
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
  const resolved = await loadConfig({
    rootDir: actionWorkspace(),
    configDir: actionConfigDir(options),
    env: process.env,
    requireProviderEnv: !dryRun,
  });
  await logActionEvent();
  core.info(`pipr config source: ${resolved.source}`);
  if (dryRun) {
    core.info("PIPR_DRY_RUN=1; stopping before review runtime, model, or GitHub publishing calls");
    return;
  }
  throw new Error("pipr action review runtime is not implemented yet");
}

async function runValidate(options: CliOptions): Promise<void> {
  const resolved = await loadConfig({
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
        registry: createBuiltinRegistry(),
      },
      { depth: 6, colors: false },
    ),
  );
}

async function runExplainConfig(options: CliOptions): Promise<void> {
  const resolved = await loadConfig({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
    requireProviderEnv: false,
  });
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
  const handler = optionHandlers[arg];
  if (!handler) {
    throw new Error(`Unknown option '${arg}'`);
  }
  return handler(options, args, index);
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

async function logActionEvent(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return;
  }
  const event = await loadPullRequestEventContext(eventPath, process.env);
  core.info(`pipr loaded PR #${event.pullRequestNumber} for ${event.repo}`);
}

function printGraph(): void {
  console.log(renderRegistryGraph(createBuiltinRegistry()));
}

function printHelp(): void {
  console.log(help);
}

function listBlocks(): void {
  listEntries(createBuiltinRegistry().blocks);
}

function listTools(): void {
  listEntries(createBuiltinRegistry().tools);
}

function listAgents(): void {
  listEntries(createBuiltinRegistry().agents);
}

function listPresets(): void {
  listEntries(createBuiltinRegistry().presets);
}

function listEntries(entries: Array<{ id: string; description: string }>): void {
  for (const entry of entries) {
    console.log(`${entry.id}\t${entry.description}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
});
