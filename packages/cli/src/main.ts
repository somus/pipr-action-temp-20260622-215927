#!/usr/bin/env bun
import { inspect } from "node:util";
import * as core from "@actions/core";
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
import { Command } from "commander";

type ActionOptions = Parameters<typeof runActionCommand>[0];

type CliOptions = {
  configDir: string;
  event?: string;
  force?: boolean;
  providerId?: string;
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  requireEnv?: boolean;
  base?: string;
  head?: string;
  piExecutable?: string;
};

async function main(): Promise<void> {
  const program = createProgram();
  if (process.argv.length <= 2) {
    program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

function createProgram(): Command {
  const program = new Command();
  program.name("pipr").showHelpAfterError();

  program
    .command("init")
    .description("Create editable TypeScript config")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .option("--force", "Overwrite existing pipr files")
    .action(runInit);

  program
    .command("action")
    .description("Run inside GitHub Docker Action")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .option("--provider-id <id>", "Trusted provider id")
    .option("--provider <name>", "Trusted provider name")
    .option("--model <model>", "Trusted provider model")
    .option("--api-key-env <env>", "Trusted provider API key env var")
    .action(runAction);

  program
    .command("check")
    .description("Type-load config and validate the runtime plan")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .option("--require-env", "Require configured provider env vars")
    .action(runCheck);

  program
    .command("dry-run")
    .description("Load config and event without publishing")
    .requiredOption("--event <path>", "GitHub event JSON path")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .action(runDryRun);

  program
    .command("inspect")
    .description("Print models, agents, tasks, commands, locals, and tools")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .action(runInspect);

  program
    .command("review")
    .description("Run local review entrypoint without publishing")
    .option("--base <sha>", "Base commit SHA")
    .option("--head <sha>", "Head commit SHA")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .option("--pi-executable <path>", "Pi executable path")
    .action((options: CliOptions) => runLocalEntrypoint("review", options));

  program
    .command("run")
    .description("Run a named local entrypoint without publishing")
    .argument("<name>", "Local entrypoint name")
    .option("--base <sha>", "Base commit SHA")
    .option("--head <sha>", "Head commit SHA")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .option("--pi-executable <path>", "Pi executable path")
    .action(runLocal);

  return program;
}

async function runAction(options: CliOptions): Promise<void> {
  writeActionResult(await runActionCommand(actionOptions(options)));
}

function actionOptions(options: CliOptions): ActionOptions {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required for pipr action");
  }
  return {
    rootDir: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    configDir: process.env["INPUT_CONFIG-DIR"] || options.configDir,
    env: process.env,
    eventPath,
    dryRun: process.env.PIPR_DRY_RUN === "1",
    trustedProvider: {
      providerId: options.providerId,
      provider: options.provider,
      model: options.model,
      apiKeyEnv: options.apiKeyEnv,
    },
  };
}

function writeActionResult(result: ActionCommandResult): void {
  if (result.kind === "ignored") {
    core.info(`pipr ignored event: ${result.reason}`);
    return;
  }

  core.info(
    `pipr loaded change #${result.event.change.number} for ${result.event.repository.slug}`,
  );
  core.info(`pipr config source: ${result.configSource}`);

  if (result.kind === "dry-run") {
    core.info("PIPR_DRY_RUN=1; stopping before review runtime, model, or GitHub publishing calls");
    return;
  }

  if (result.kind === "command-help") {
    core.info(`pipr command help: ${result.reason}`);
    core.setOutput("main-comment", result.body);
    return;
  }

  writeReviewActionResult(result);
}

function writeReviewActionResult(result: Extract<ActionCommandResult, { kind: "review" }>): void {
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

async function runInit(options: CliOptions): Promise<void> {
  const result = await runInitCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    force: options.force === true,
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
    requireProviderEnv: options.requireEnv === true,
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

async function runLocal(localName: string, options: CliOptions): Promise<void> {
  await runLocalEntrypoint(localName, options);
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

main().catch((error: unknown) => {
  if (error instanceof PublicationError && error.result) {
    core.setOutput("publication", JSON.stringify(error.result));
    core.error(`pipr publication metadata: ${JSON.stringify(error.result)}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
});
