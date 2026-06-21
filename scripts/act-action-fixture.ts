#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import {
  type ActionCommandResult,
  type GitHubPublicationClient,
  PublicationError,
  runActionCommandWithDependencies,
} from "../packages/runtime/dist/action/fixture-dependencies.mjs";

type LoadedActionResult = Exclude<ActionCommandResult, { kind: "ignored" }>;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "action";
  if (command !== "action") {
    throw new Error(`act fixture wrapper only supports 'action', got '${command}'`);
  }
  const result = await runActionCommandWithDependencies({
    rootDir: actionWorkspace(),
    configDir: actionConfigDir(),
    env: process.env,
    eventPath: actionEventPath(),
    dryRun: envValue("PIPR_DRY_RUN") === "1",
    piExecutable: requiredEnv("PIPR_ACT_PI_EXECUTABLE"),
    githubPublicationClient: fixturePublicationClient(requiredEnv("PIPR_ACT_GITHUB_FIXTURE_PATH")),
  });
  handleActionResult(result);
}

function actionWorkspace(): string {
  return envValue("GITHUB_WORKSPACE") ?? process.cwd();
}

function actionConfigDir(): string {
  return envValue("INPUT_CONFIG-DIR") || ".pipr";
}

function actionEventPath(): string {
  return requiredEnv("GITHUB_EVENT_PATH");
}

function requiredEnv(name: string): string {
  const value = envValue(name);
  if (!value) {
    throw new Error(`${name} is required for pipr act fixture wrapper`);
  }
  return value;
}

function envValue(name: string): string | undefined {
  return process.env[name];
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
  if (result.kind === "command-help") {
    handleCommandHelpActionResult(result);
    return;
  }
  handleReviewActionResult(result);
}

function handleIgnoredActionResult(
  result: Extract<ActionCommandResult, { kind: "ignored" }>,
): void {
  info(`pipr ignored event: ${result.reason}`);
}

function handleDryRunActionResult(result: Extract<ActionCommandResult, { kind: "dry-run" }>): void {
  logActionContext(result);
  info("PIPR_DRY_RUN=1; stopping before review runtime, model, or GitHub publishing calls");
}

function handleCommandHelpActionResult(
  result: Extract<ActionCommandResult, { kind: "command-help" }>,
): void {
  logActionContext(result);
  info(`pipr command help: ${result.reason}`);
  setOutput("main-comment", result.body);
}

function handleReviewActionResult(result: Extract<ActionCommandResult, { kind: "review" }>): void {
  logActionContext(result);
  info(
    `pipr review produced ${result.review.validated.validFindings.length} valid inline finding(s), ` +
      `${result.review.validated.droppedFindings.length} dropped finding(s)`,
  );
  info(
    `pipr published main comment (${result.publication.mainComment.action}) and ` +
      `${result.publication.inlineComments.posted} inline comment(s); ` +
      `${result.publication.inlineComments.skipped} skipped`,
  );
  if (result.review.repairAttempted) {
    info("pipr repaired reviewer JSON once before validation");
  }
  setOutput("main-comment", result.review.mainComment);
  setOutput("inline-comments", JSON.stringify(result.review.inlineCommentDrafts));
  setOutput("dropped-findings", JSON.stringify(result.review.validated.droppedFindings));
  setOutput("publication", JSON.stringify(result.publication));
}

function logActionContext(result: LoadedActionResult): void {
  info(`pipr loaded PR #${result.event.pullRequestNumber} for ${result.event.repo}`);
  info(`pipr config source: ${result.configSource}`);
}

function fixturePublicationClient(fixturePath: string): GitHubPublicationClient {
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

main().catch((error: unknown) => {
  if (error instanceof PublicationError && error.result) {
    setOutput("publication", JSON.stringify(error.result));
    logError(`pipr publication metadata: ${JSON.stringify(error.result)}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  setFailed(message);
  process.exitCode = 1;
});

function info(message: string): void {
  console.log(message);
}

function logError(message: string): void {
  console.error(message);
}

function setFailed(message: string): void {
  logError(message);
}

function setOutput(name: string, value: string): void {
  const outputPath = envValue("GITHUB_OUTPUT");
  if (!outputPath) {
    return;
  }
  const delimiter = `pipr_${randomUUID()}`;
  appendFileSync(outputPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
