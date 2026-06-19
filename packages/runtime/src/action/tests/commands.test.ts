import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initOfficialMinimalProject } from "../../config/init.js";
import type { GitHubPublicationClient } from "../../review/publish.js";
import type { GitHubCommandClient } from "../command-router.js";
import { runActionCommand } from "../commands.js";

describe("runActionCommand issue_comment dispatch", () => {
  it("ignores issue comments that are not pull request comments", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-action-command-"));
    try {
      const eventPath = path.join(rootDir, "event.json");
      await writeFile(
        eventPath,
        JSON.stringify({
          action: "created",
          repository: { full_name: "local/pipr" },
          issue: { number: 1 },
          comment: { body: "@pipr review", user: { login: "somu" } },
        }),
      );

      await expect(
        runActionCommand({
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
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("returns command help for invalid arguments without running Pi", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const result = await runIssueCommentCommand(workspace, "@pipr review --scope all", {
        permission: "write",
        role_name: "write",
      });

      expect(result).toMatchObject({
        kind: "command-help",
        reason: "Input 'scope' must be one of: changed, full",
      });
      expect(result.kind === "command-help" ? result.body : "").toContain("@pipr review");
      await expectPiNotCalled(workspace);
    } finally {
      await rm(workspace.rootDir, { recursive: true, force: true });
    }
  });

  it("skips issue comment command dispatch in dry-run mode without calling GitHub", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writeIssueCommentEvent(eventPath, "@pipr review");

      await expect(
        runActionCommand({
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
      await rm(workspace.rootDir, { recursive: true, force: true });
    }
  });

  it("ignores edited issue comments", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writeIssueCommentEvent(eventPath, "@pipr review", "edited");

      await expect(
        runActionCommand({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: false,
          env: issueCommentEnv(workspace.rootDir, eventPath),
          githubClient: failingGitHubClient(),
          githubPublicationClient: failingGitHubPublicationClient(),
          piExecutable: workspace.piExecutable,
        }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "issue_comment action 'edited' is not supported",
      });
    } finally {
      await rm(workspace.rootDir, { recursive: true, force: true });
    }
  });

  it("denies commands when commenter permission is below the workflow requirement", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const result = await runIssueCommentCommand(workspace, "@pipr review --scope full", {
        permission: "read",
        role_name: "read",
      });

      expect(result).toMatchObject({
        kind: "command-help",
        reason: "permission denied for '@pipr review --scope full'",
      });
      expect(result.kind === "command-help" ? result.body : "").toContain("requires write");
      await expectPiNotCalled(workspace);
    } finally {
      await rm(workspace.rootDir, { recursive: true, force: true });
    }
  });

  it("executes commands from the base commit config instead of PR-head config", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    try {
      expect(currentGitHead(workspace.rootDir)).toBe(workspace.baseSha);
      const result = await runIssueCommentCommand(workspace, "@pipr review --scope full", {
        permission: "write",
        role_name: "write",
      });

      expect(result).toMatchObject({
        kind: "review",
        command: "review",
      });
      expect(result.kind === "review" ? result.review.validated.validFindings : []).toEqual([]);
      await expectReviewRanAtHead(result, workspace);
    } finally {
      await rm(workspace.rootDir, { recursive: true, force: true });
    }
  });
});

describe("runActionCommand pull_request dispatch", () => {
  it("checks out the PR head before running the review workflow", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);

      expect(currentGitHead(workspace.rootDir)).toBe(workspace.baseSha);
      const result = await runActionCommand({
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
      await rm(workspace.rootDir, { recursive: true, force: true });
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
  options: { checkoutBaseBeforeRun?: boolean } = {},
): Promise<CommandWorkspace> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-action-command-"));
  runGit(rootDir, ["init", "--initial-branch=main"]);
  runGit(rootDir, ["config", "user.name", "pipr test"]);
  runGit(rootDir, ["config", "user.email", "pipr@example.test"]);
  runGit(rootDir, ["config", "core.hooksPath", "/dev/null"]);
  runGit(rootDir, ["config", "commit.gpgsign", "false"]);
  await initOfficialMinimalProject({ rootDir });
  await writeFile(path.join(rootDir, ".pipr", "workflows", "review.yaml"), commandWorkflowYaml());
  await mkdir(path.join(rootDir, "src"));
  await writeFile(path.join(rootDir, "src", "a.ts"), "export const value = 1;\n");
  runGit(rootDir, ["add", "."]);
  runGit(rootDir, ["commit", "--no-verify", "-m", "base"]);
  const baseSha = runGit(rootDir, ["rev-parse", "HEAD"]).trim();
  await writeFile(
    path.join(rootDir, ".pipr", "workflows", "review.yaml"),
    headOnlyCommandWorkflowYaml(),
  );
  await writeFile(path.join(rootDir, "src", "a.ts"), "export const value = 2;\n");
  runGit(rootDir, ["add", "."]);
  runGit(rootDir, ["commit", "--no-verify", "-m", "head"]);
  const headSha = runGit(rootDir, ["rev-parse", "HEAD"]).trim();
  const piExecutable = path.join(rootDir, "fake-pi.sh");
  await writeFile(
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
  permission: { permission: string; role_name?: string },
) {
  const eventPath = path.join(workspace.rootDir, "event.json");
  await writeIssueCommentEvent(eventPath, body);
  return await runActionCommand({
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
  await expect(readFile(path.join(workspace.rootDir, "pi-called"), "utf8")).rejects.toThrow();
}

async function expectPiCalled(workspace: CommandWorkspace): Promise<void> {
  await expect(readFile(path.join(workspace.rootDir, "pi-called"), "utf8")).resolves.toBe("");
}

async function expectReviewRanAtHead(
  result: Awaited<ReturnType<typeof runActionCommand>>,
  workspace: CommandWorkspace,
): Promise<void> {
  expect(result).toMatchObject({ kind: "review" });
  await expectPiCalled(workspace);
  expect(currentGitHead(workspace.rootDir)).toBe(workspace.headSha);
}

function commandWorkflowYaml(): string {
  return [
    "apiVersion: pipr.dev/v1",
    "kind: Workflow",
    "id: pipr/review",
    "inputs:",
    "  scope:",
    "    type: string",
    "    default: changed",
    "    enum: [changed, full]",
    "on:",
    "  events:",
    "    - pull_request.opened",
    "  commands:",
    "    - name: review",
    '      pattern: "@pipr review [--scope <scope>]"',
    "      requiredPermission: write",
    "steps:",
    "  - id: review",
    "    uses: core/run-agent",
    "    with:",
    "      agent: pipr/reviewer",
    "  - id: main-comment",
    "    uses: core/main-comment",
    "    with:",
    `      review: ${expr("steps.review.outputs.result")}`,
    "  - id: inline-comments",
    "    uses: core/inline-comments",
    "    with:",
    `      review: ${expr("steps.review.outputs.result")}`,
  ].join("\n");
}

function headOnlyCommandWorkflowYaml(): string {
  return [
    "apiVersion: pipr.dev/v1",
    "kind: Workflow",
    "id: pipr/review",
    "on:",
    "  events:",
    "    - pull_request.opened",
    "  commands:",
    "    - name: head-only",
    '      aliases: ["@pipr head-only"]',
    "steps:",
    "  - id: review",
    "    uses: core/run-agent",
    "    with:",
    "      agent: pipr/reviewer",
    "  - id: main-comment",
    "    uses: core/main-comment",
    "    with:",
    `      review: ${expr("steps.review.outputs.result")}`,
    "  - id: inline-comments",
    "    uses: core/inline-comments",
    "    with:",
    `      review: ${expr("steps.review.outputs.result")}`,
  ].join("\n");
}

async function writeIssueCommentEvent(
  eventPath: string,
  body: string,
  action = "created",
): Promise<void> {
  await writeFile(
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
  await writeFile(
    eventPath,
    JSON.stringify({
      action: "opened",
      number: 1,
      repository: { full_name: "local/pipr" },
      pull_request: {
        number: 1,
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
  permission: { permission: string; role_name?: string },
): GitHubCommandClient {
  return {
    async getPullRequest() {
      return {
        repo: "local/pipr",
        baseSha: workspace.baseSha,
        headSha: workspace.headSha,
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
    async createReviewComment() {
      return { id: 2 };
    },
  };
}

function failingGitHubPublicationClient(): GitHubPublicationClient {
  return {
    async getAuthenticatedUserLogin() {
      throw new Error("GitHub publication should not be called");
    },
    async getPullRequestHeadSha() {
      throw new Error("GitHub publication should not be called");
    },
    async listIssueComments() {
      throw new Error("GitHub publication should not be called");
    },
    async createIssueComment() {
      throw new Error("GitHub publication should not be called");
    },
    async updateIssueComment() {
      throw new Error("GitHub publication should not be called");
    },
    async listReviewComments() {
      throw new Error("GitHub publication should not be called");
    },
    async createReviewComment() {
      throw new Error("GitHub publication should not be called");
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

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function currentGitHead(cwd: string): string {
  return runGit(cwd, ["rev-parse", "HEAD"]).trim();
}

function expr(source: string): string {
  return ["$", "{{ ", source, " }}"].join("");
}
