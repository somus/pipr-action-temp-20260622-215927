#!/usr/bin/env bun
import {
  type ActionCommandResult,
  type GitHubPublicationClient,
  PublicationError,
  runActionCommandWithDependencies,
} from "@pipr/runtime/e2e/action-fixture";
import { type ActAssertionMode, assertActFixture } from "./assertions.ts";

type LoadedActionResult = Exclude<ActionCommandResult, { kind: "ignored" }>;
type ActionResultHandlers = {
  [Kind in ActionCommandResult["kind"]]: (
    result: Extract<ActionCommandResult, { kind: Kind }>,
  ) => Promise<void> | void;
};
type ActionFixtureOptions = Parameters<typeof runActionCommandWithDependencies>[0];
type ActionFixtureContext = {
  fixturePath: string;
  options: ActionFixtureOptions;
};

const actionResultHandlers: ActionResultHandlers = {
  ignored: handleIgnoredActionResult,
  "dry-run": handleDryRunActionResult,
  "command-help": handleCommandHelpActionResult,
  review: handleReviewActionResult,
};

async function main(): Promise<void> {
  assertActionCommand(process.argv[2] ?? "action");
  const context = actionFixtureContext();
  await handleActionResult(await runActionCommandWithDependencies(context.options));
  await assertConfiguredFixture(context.fixturePath);
}

function assertActionCommand(command: string): void {
  if (command !== "action") {
    throw new Error(`act fixture wrapper only supports 'action', got '${command}'`);
  }
}

function actionFixtureContext(): ActionFixtureContext {
  const fixturePath = requiredEnv("PIPR_ACT_GITHUB_FIXTURE_PATH");
  return {
    fixturePath,
    options: {
      rootDir: envValue("GITHUB_WORKSPACE") ?? process.cwd(),
      configDir: envValue("INPUT_CONFIG-DIR") || ".pipr",
      env: Bun.env,
      eventPath: requiredEnv("GITHUB_EVENT_PATH"),
      dryRun: envValue("PIPR_DRY_RUN") === "1",
      piExecutable: requiredEnv("PIPR_ACT_PI_EXECUTABLE"),
      githubPublicationClient: fixturePublicationClient(fixturePath),
    },
  };
}

function requiredEnv(name: string): string {
  const value = envValue(name);
  if (!value) {
    throw new Error(`${name} is required for pipr act fixture wrapper`);
  }
  return value;
}

function envValue(name: string): string | undefined {
  return Bun.env[name];
}

async function handleActionResult(result: ActionCommandResult): Promise<void> {
  await actionResultHandlers[result.kind](result as never);
}

async function assertConfiguredFixture(fixturePath: string): Promise<void> {
  const mode = envValue("PIPR_ACT_ASSERTION") as ActAssertionMode | undefined;
  if (!mode) {
    return;
  }
  await assertActFixture({
    fixturePath,
    mode,
    telemetryPath: envValue("PIPR_ACT_TELEMETRY_PATH"),
  });
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

async function handleCommandHelpActionResult(
  result: Extract<ActionCommandResult, { kind: "command-help" }>,
): Promise<void> {
  logActionContext(result);
  info(`pipr command help: ${result.reason}`);
  await setOutput("main-comment", result.body);
}

async function handleReviewActionResult(
  result: Extract<ActionCommandResult, { kind: "review" }>,
): Promise<void> {
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
  await setOutput("main-comment", result.review.mainComment);
  await setOutput("inline-comments", JSON.stringify(result.review.inlineCommentDrafts));
  await setOutput("dropped-findings", JSON.stringify(result.review.validated.droppedFindings));
  await setOutput("publication", JSON.stringify(result.publication));
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
  return (await Bun.file(fixturePath).json()) as GitHubPublicationFixture;
}

async function writeFixture(fixturePath: string, fixture: GitHubPublicationFixture): Promise<void> {
  await Bun.write(fixturePath, JSON.stringify(fixture));
}

main().catch(async (error: unknown) => {
  if (error instanceof PublicationError && error.result) {
    await setOutput("publication", JSON.stringify(error.result));
    logError(`pipr publication metadata: ${JSON.stringify(error.result)}`);
  }
  setFailed(error instanceof Error ? error.message : String(error));
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

async function setOutput(name: string, value: string): Promise<void> {
  const outputPath = envValue("GITHUB_OUTPUT");
  if (!outputPath) {
    return;
  }
  const delimiter = `pipr_${crypto.randomUUID()}`;
  const output = Bun.file(outputPath);
  const existing = (await output.exists()) ? await output.text() : "";
  await Bun.write(outputPath, `${existing}${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
