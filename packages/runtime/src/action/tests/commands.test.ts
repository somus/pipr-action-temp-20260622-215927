import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runGit as runGitCommand } from "../../diff/git.js";
import type { GitHubCommandClient } from "../../hosts/github/command.js";
import type { RepositoryPermission } from "../../hosts/types.js";
import type { GitHubPublicationClient } from "../../review/publish.js";
import { runActionCommandWithDependencies } from "../commands.js";

describe("runActionCommand issue_comment dispatch", () => {
  it("ignores issue comments that are not pull request comments", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-action-command-"));
    try {
      const eventPath = path.join(rootDir, "event.json");
      await Bun.write(
        eventPath,
        JSON.stringify({
          action: "created",
          repository: { full_name: "local/pipr" },
          issue: { number: 1 },
          comment: { body: "@pipr review", user: { login: "somu" } },
        }),
      );

      await expect(
        runActionCommandWithDependencies({
          rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: false,
          env: issueCommentEnv(rootDir, eventPath),
          githubClient: failingGitHubClient(),
        }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "issue_comment did not target a pull request",
      });
    } finally {
      await removeWorkspace(rootDir);
    }
  });

  it("returns command help for invalid arguments without running Pi", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const result = await runIssueCommentCommand(workspace, "@pipr review --scope all", "write");

      expect(result).toMatchObject({
        kind: "command-help",
        reason: "Input 'scope' must be one of: changed, full",
      });
      expect(result.kind === "command-help" ? result.body : "").toContain("@pipr review");
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("skips issue comment command dispatch in dry-run mode without calling GitHub", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writeIssueCommentEvent(eventPath, "@pipr review");

      await expect(
        runActionCommandWithDependencies({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: true,
          env: issueCommentEnv(workspace.rootDir, eventPath),
          githubClient: failingGitHubClient(),
          piExecutable: workspace.piExecutable,
        }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "PIPR_DRY_RUN=1; command dispatch skipped",
      });
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("ignores edited issue comments", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writeIssueCommentEvent(eventPath, "@pipr review", "edited");

      await expect(
        runActionCommandWithDependencies({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: false,
          env: issueCommentEnv(workspace.rootDir, eventPath),
          githubClient: failingGitHubClient(),
          githubPublicationClient: failingGitHubPublishingClient(),
          piExecutable: workspace.piExecutable,
        }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "issue_comment action 'edited' is not supported",
      });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("denies commands when commenter permission is below the task command requirement", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const result = await runIssueCommentCommand(workspace, "@pipr review --scope full", "read");

      expect(result).toMatchObject({
        kind: "command-help",
        reason: "permission denied for '@pipr review --scope full'",
      });
      expect(result.kind === "command-help" ? result.body : "").toContain("requires write");
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("does not parse command arguments before permission passes", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ parseSideEffect: true }),
    });
    try {
      Reflect.set(globalThis, "__piprParseCalled", false);
      const result = await runIssueCommentCommand(workspace, "@pipr review --scope full", "read");

      expect(result).toMatchObject({ kind: "command-help" });
      expect(Reflect.get(globalThis, "__piprParseCalled")).toBe(false);
      await expectPiNotCalled(workspace);
    } finally {
      Reflect.deleteProperty(globalThis, "__piprParseCalled");
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("returns help when a trusted base config does not register a command", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ command: false }),
      checkoutBaseBeforeRun: true,
    });
    try {
      const result = await runIssueCommentCommand(workspace, "@pipr review", "write");

      expect(result).toMatchObject({ kind: "command-help" });
      expect(result.kind === "command-help" ? result.reason : "").toContain("unknown pipr command");
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("executes commands from the base commit config instead of PR-head config", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    try {
      expect(currentGitHead(workspace.rootDir)).toBe(workspace.baseSha);
      const result = await runIssueCommentCommand(workspace, "@pipr review --scope full", "write");

      expect(result).toMatchObject({
        kind: "review",
        command: "review",
      });
      expect(result.kind === "review" ? result.review.validated.validFindings : []).toEqual([]);
      await expectReviewRanAtHead(result, workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });
});

describe("runActionCommand pull_request dispatch", () => {
  it("marks the GitHub Action workspace as a git safe directory before trusted config reads", async () => {
    const workspace = await createCommandWorkspace();
    const gitConfigDir = await mkdtemp(path.join(os.tmpdir(), "pipr-action-gitconfig-"));
    const previousHome = process.env.HOME;
    const previousGitConfigEnv = snapshotGitConfigEnv();
    try {
      clearGitConfigEnv(previousGitConfigEnv);
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);

      const result = await runActionCommandWithDependencies({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: true,
        env: {
          ...pullRequestEnv(workspace.rootDir, eventPath),
          GITHUB_ACTIONS: "true",
          HOME: path.join(gitConfigDir, "read-only-home"),
          RUNNER_TEMP: gitConfigDir,
        },
        githubPublicationClient: failingGitHubPublishingClient(),
        piExecutable: workspace.piExecutable,
      });

      expect(result).toMatchObject({ kind: "dry-run" });
      expect(process.env.GIT_CONFIG_COUNT).toBe("1");
      expect(process.env.GIT_CONFIG_KEY_0).toBe("safe.directory");
      expect(process.env.GIT_CONFIG_VALUE_0).toBe(workspace.rootDir);
      expect(runGitCommand(["config", "--get-all", "safe.directory"], workspace.rootDir)).toContain(
        workspace.rootDir,
      );
      await expect(Bun.file(path.join(gitConfigDir, ".gitconfig")).text()).resolves.toContain(
        `directory = ${workspace.rootDir}`,
      );
    } finally {
      restoreEnv("HOME", previousHome);
      restoreGitConfigEnv(previousGitConfigEnv);
      await removeWorkspace(workspace.rootDir);
      await removeWorkspace(gitConfigDir);
    }
  });

  it("loads trusted base config in dry-run without executing PR-head config", async () => {
    const workspace = await createCommandWorkspace({
      headConfigTs: maliciousHeadConfigTs(),
      checkoutBaseBeforeRun: false,
    });
    const sideEffectPath = path.join(workspace.rootDir, "dry-run-side-effect");
    const previous = process.env.PIPR_DRY_RUN_SIDE_EFFECT_PATH;
    process.env.PIPR_DRY_RUN_SIDE_EFFECT_PATH = sideEffectPath;
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);

      const result = await runActionCommandWithDependencies({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: true,
        env: pullRequestEnv(workspace.rootDir, eventPath),
        githubPublicationClient: failingGitHubPublishingClient(),
        piExecutable: workspace.piExecutable,
      });

      expect(result).toMatchObject({ kind: "dry-run" });
      await expect(Bun.file(sideEffectPath).text()).rejects.toThrow();
      await expectPiNotCalled(workspace);
    } finally {
      if (previous === undefined) {
        delete process.env.PIPR_DRY_RUN_SIDE_EFFECT_PATH;
      } else {
        process.env.PIPR_DRY_RUN_SIDE_EFFECT_PATH = previous;
      }
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("checks out the PR head before running the review task", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);

      expect(currentGitHead(workspace.rootDir)).toBe(workspace.baseSha);
      const result = await runActionCommandWithDependencies({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: false,
        env: pullRequestEnv(workspace.rootDir, eventPath),
        githubPublicationClient: fakeGitHubPublicationClient(workspace),
        piExecutable: workspace.piExecutable,
      });

      expect(result).toMatchObject({ kind: "review" });
      await expectReviewRanAtHead(result, workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("skips publication when no change request task is registered", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ event: false }),
      checkoutBaseBeforeRun: true,
    });
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);

      const result = await runActionCommandWithDependencies({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: false,
        env: pullRequestEnv(workspace.rootDir, eventPath),
        githubPublicationClient: failingGitHubPublishingClient(),
        piExecutable: workspace.piExecutable,
      });

      expect(result).toMatchObject({ kind: "ignored" });
      expect(result.kind === "ignored" ? result.reason : "").toContain(
        "No tasks matched the change request event",
      );
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });
});

type CommandWorkspace = {
  rootDir: string;
  baseSha: string;
  headSha: string;
  piExecutable: string;
};

async function createCommandWorkspace(
  options: { baseConfigTs?: string; checkoutBaseBeforeRun?: boolean; headConfigTs?: string } = {},
): Promise<CommandWorkspace> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-action-command-"));
  runGit(rootDir, ["init", "--initial-branch=main"]);
  runGit(rootDir, ["config", "user.name", "pipr test"]);
  runGit(rootDir, ["config", "user.email", "pipr@example.test"]);
  runGit(rootDir, ["config", "core.hooksPath", "/dev/null"]);
  runGit(rootDir, ["config", "commit.gpgsign", "false"]);
  await mkdir(path.join(rootDir, ".pipr"), { recursive: true });
  await Bun.write(
    path.join(rootDir, ".pipr", "config.ts"),
    options.baseConfigTs ?? reviewConfigTs(),
  );
  await mkdir(path.join(rootDir, "src"));
  await Bun.write(path.join(rootDir, "src", "a.ts"), "export const value = 1;\n");
  runGit(rootDir, ["add", "."]);
  runGit(rootDir, ["commit", "--no-verify", "-m", "base"]);
  const baseSha = runGit(rootDir, ["rev-parse", "HEAD"]).trim();
  await Bun.write(
    path.join(rootDir, ".pipr", "config.ts"),
    options.headConfigTs ?? headOnlyConfigTs(),
  );
  await Bun.write(path.join(rootDir, "src", "a.ts"), "export const value = 2;\n");
  runGit(rootDir, ["add", "."]);
  runGit(rootDir, ["commit", "--no-verify", "-m", "head"]);
  const headSha = runGit(rootDir, ["rev-parse", "HEAD"]).trim();
  const piExecutable = path.join(rootDir, "fake-pi.sh");
  await Bun.write(
    piExecutable,
    [
      "#!/bin/sh",
      'touch "$(dirname "$0")/pi-called"',
      'printf \'%s\\n\' \'{"summary":{"body":"No findings."},"inlineFindings":[]}\'',
    ].join("\n"),
  );
  await chmod(piExecutable, 0o755);
  if (options.checkoutBaseBeforeRun) {
    runGit(rootDir, ["checkout", "--detach", baseSha]);
  }
  return { rootDir, baseSha, headSha, piExecutable };
}

async function runIssueCommentCommand(
  workspace: CommandWorkspace,
  body: string,
  permission: RepositoryPermission,
) {
  const eventPath = path.join(workspace.rootDir, "event.json");
  await writeIssueCommentEvent(eventPath, body);
  return await runActionCommandWithDependencies({
    rootDir: workspace.rootDir,
    configDir: ".pipr",
    eventPath,
    dryRun: false,
    env: issueCommentEnv(workspace.rootDir, eventPath),
    githubClient: fakeGitHubClient(workspace, permission),
    githubPublicationClient: fakeGitHubPublicationClient(workspace),
    piExecutable: workspace.piExecutable,
  });
}

async function expectPiNotCalled(workspace: CommandWorkspace): Promise<void> {
  await expect(Bun.file(path.join(workspace.rootDir, "pi-called")).text()).rejects.toThrow();
}

async function expectPiCalled(workspace: CommandWorkspace): Promise<void> {
  await expect(Bun.file(path.join(workspace.rootDir, "pi-called")).text()).resolves.toBe("");
}

async function expectReviewRanAtHead(
  result: Awaited<ReturnType<typeof runActionCommandWithDependencies>>,
  workspace: CommandWorkspace,
): Promise<void> {
  expect(result).toMatchObject({ kind: "review" });
  await expectPiCalled(workspace);
  expect(currentGitHead(workspace.rootDir)).toBe(workspace.headSha);
}

function reviewConfigTs(
  options: { command?: boolean; event?: boolean; parseSideEffect?: boolean } = {},
): string {
  const template = "$";
  return [
    'import { definePipr } from "@pipr/sdk";',
    "",
    "export default definePipr((pipr) => {",
    '  const model = pipr.model("deepseek/deepseek-v4-pro", {',
    '    name: "deepseek",',
    '    apiKey: pipr.secret("DEEPSEEK_API_KEY"),',
    '    options: { thinking: "high" },',
    "  });",
    "  const reviewer = pipr.agent({",
    '    name: "reviewer",',
    "    model,",
    '    instructions: "Review this change.",',
    "    output: pipr.schemas.review,",
    `    prompt: (input) => pipr.prompt\`Review scope: ${template}{input.scope}\`,`,
    "  });",
    "  const task = pipr.task('review', async (ctx, input = {}) => {",
    "    const manifest = await ctx.change.diffManifest({ compressed: true });",
    "    const result = await ctx.pi.run(reviewer, { manifest, scope: input.scope ?? 'changed' });",
    "    ctx.output.summary(result.summary);",
    "    ctx.output.findings(result.inlineFindings);",
    "  });",
    options.event === false ? "" : '  pipr.on.changeRequest(["opened"], task);',
    options.command === false
      ? ""
      : [
          '  pipr.command("@pipr review [--scope <scope>]", {',
          '    permission: "write",',
          "    parse(args) {",
          options.parseSideEffect ? "      globalThis.__piprParseCalled = true;" : "",
          "      const scope = args.scope ?? 'changed';",
          "      if (scope !== 'changed' && scope !== 'full') {",
          "        throw new Error(\"Input 'scope' must be one of: changed, full\");",
          "      }",
          "      return { scope };",
          "    },",
          "  }, task);",
        ].join("\n"),
    "});",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function headOnlyConfigTs(): string {
  return [
    'import { definePipr } from "@pipr/sdk";',
    "",
    "export default definePipr((pipr) => {",
    '  const model = pipr.model("deepseek/deepseek-v4-pro", {',
    '    name: "deepseek",',
    '    apiKey: pipr.secret("DEEPSEEK_API_KEY"),',
    "  });",
    "  const task = pipr.task('head-only', async () => {});",
    '  pipr.command("@pipr head-only", { permission: "write" }, task);',
    "  void model;",
    "});",
  ].join("\n");
}

function maliciousHeadConfigTs(): string {
  return [
    'import { writeFileSync } from "node:fs";',
    'import { definePipr } from "@pipr/sdk";',
    "",
    "if (process.env.PIPR_DRY_RUN_SIDE_EFFECT_PATH) {",
    '  writeFileSync(process.env.PIPR_DRY_RUN_SIDE_EFFECT_PATH, "executed");',
    "}",
    "",
    "export default definePipr((pipr) => {",
    "  const task = pipr.task('head-only', async () => {});",
    '  pipr.command("@pipr head-only", { permission: "write" }, task);',
    "});",
  ].join("\n");
}

async function writeIssueCommentEvent(
  eventPath: string,
  body: string,
  action = "created",
): Promise<void> {
  await Bun.write(
    eventPath,
    JSON.stringify({
      action,
      repository: { full_name: "local/pipr" },
      issue: { number: 1, pull_request: {} },
      comment: { body, user: { login: "somu" } },
    }),
  );
}

async function writePullRequestEvent(
  eventPath: string,
  workspace: CommandWorkspace,
): Promise<void> {
  await Bun.write(
    eventPath,
    JSON.stringify({
      action: "opened",
      number: 1,
      repository: { full_name: "local/pipr" },
      pull_request: {
        number: 1,
        title: "Test PR",
        body: "Test body",
        base: {
          sha: workspace.baseSha,
          repo: { full_name: "local/pipr" },
        },
        head: { sha: workspace.headSha },
      },
    }),
  );
}

function fakeGitHubClient(
  workspace: CommandWorkspace,
  permission: RepositoryPermission,
): GitHubCommandClient {
  return {
    async getPullRequest() {
      return {
        repository: { slug: "local/pipr" },
        change: {
          number: 1,
          title: "Test PR",
          description: "Test body",
          base: { sha: workspace.baseSha },
          head: { sha: workspace.headSha },
        },
      };
    },
    async getRepositoryPermission() {
      return permission;
    },
  };
}

function failingGitHubClient(): GitHubCommandClient {
  return {
    async getPullRequest() {
      throw new Error("GitHub should not be called");
    },
    async getRepositoryPermission() {
      throw new Error("GitHub should not be called");
    },
  };
}

function fakeGitHubPublicationClient(workspace: CommandWorkspace): GitHubPublicationClient {
  return {
    async getAuthenticatedUserLogin() {
      return "github-actions[bot]";
    },
    async getPullRequestHeadSha() {
      return workspace.headSha;
    },
    async listIssueComments() {
      return [];
    },
    async createIssueComment() {
      return { id: 1 };
    },
    async updateIssueComment() {
      return { id: 1 };
    },
    async listReviewComments() {
      return [];
    },
    async listReviewThreads() {
      return [];
    },
    async createReviewComment() {
      return { id: 2 };
    },
    async createReviewCommentReply() {
      return { id: 3 };
    },
    async resolveReviewThread() {},
  };
}

function failingGitHubPublishingClient(): GitHubPublicationClient {
  return {
    async getAuthenticatedUserLogin() {
      throw new Error("GitHub publishing should not be called");
    },
    async getPullRequestHeadSha() {
      throw new Error("GitHub publishing should not be called");
    },
    async listIssueComments() {
      throw new Error("GitHub publishing should not be called");
    },
    async createIssueComment() {
      throw new Error("GitHub publishing should not be called");
    },
    async updateIssueComment() {
      throw new Error("GitHub publishing should not be called");
    },
    async listReviewComments() {
      throw new Error("GitHub publishing should not be called");
    },
    async listReviewThreads() {
      throw new Error("GitHub publishing should not be called");
    },
    async createReviewComment() {
      throw new Error("GitHub publishing should not be called");
    },
    async createReviewCommentReply() {
      throw new Error("GitHub publishing should not be called");
    },
    async resolveReviewThread() {
      throw new Error("GitHub publishing should not be called");
    },
  };
}

function issueCommentEnv(rootDir: string, eventPath: string): NodeJS.ProcessEnv {
  return {
    DEEPSEEK_API_KEY: "provider-key",
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: rootDir,
  };
}

function pullRequestEnv(rootDir: string, eventPath: string): NodeJS.ProcessEnv {
  return {
    DEEPSEEK_API_KEY: "provider-key",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: rootDir,
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    delete Bun.env[key];
  } else {
    process.env[key] = value;
    Bun.env[key] = value;
  }
}

function snapshotGitConfigEnv(): Map<string, string | undefined> {
  const count = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10);
  const limit = Number.isSafeInteger(count) && count >= 0 ? count : 0;
  const snapshot = new Map<string, string | undefined>([
    ["GIT_CONFIG_COUNT", process.env.GIT_CONFIG_COUNT],
  ]);
  for (let index = 0; index <= limit; index += 1) {
    snapshot.set(`GIT_CONFIG_KEY_${index}`, process.env[`GIT_CONFIG_KEY_${index}`]);
    snapshot.set(`GIT_CONFIG_VALUE_${index}`, process.env[`GIT_CONFIG_VALUE_${index}`]);
  }
  return snapshot;
}

function clearGitConfigEnv(snapshot: Map<string, string | undefined>): void {
  for (const key of snapshot.keys()) {
    restoreEnv(key, undefined);
  }
}

function restoreGitConfigEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    restoreEnv(key, value);
  }
}

async function removeWorkspace(rootDir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(rootDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) {
        throw error;
      }
      await delay(100);
    }
  }
}

function runGit(cwd: string, args: string[]): string {
  return runGitCommand(args, cwd);
}

function currentGitHead(cwd: string): string {
  return runGit(cwd, ["rev-parse", "HEAD"]).trim();
}
