import { describe, expect, it } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const cliPath = path.resolve("src/main.ts");

describe("pipr CLI", () => {
  it("prints TS-first subcommands", async () => {
    const result = await runCli(["--help"]);
    const action = await runCli(["action", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(action.exitCode).toBe(0);
    expect(result.stdout).toContain("init [options]");
    expect(result.stdout).toContain("check [options]");
    expect(result.stdout).toContain("inspect [options]");
    expect(result.stdout).toContain("review [options]");
    expect(result.stdout).toContain("run [options] <name>");
    expect(action.stdout).toContain("--config-dir <dir>");
    expect(action.stdout).toContain("--provider-id <id>");
  });

  it("requires an explicit base SHA for local review runs", async () => {
    const result = await runCli(["review"]);

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("pipr review requires --base <sha>");
  });

  it("runs a named local entrypoint without GitHub publishing", async () => {
    const workspace = await createLocalReviewWorkspace();
    try {
      const result = await runCli(
        ["run", "review", "--base", workspace.baseSha, "--pi-executable", workspace.piExecutable],
        { DEEPSEEK_API_KEY: "provider-key" },
        workspace.rootDir,
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("# pipr Review");
      expect(result.stdout).toContain("No findings.");
      expect(await countLines(path.join(workspace.rootDir, "pi-called"))).toBe(1);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("fails unknown local entrypoints before running Pi", async () => {
    const workspace = await createLocalReviewWorkspace();
    try {
      const result = await runCli(
        ["run", "missing", "--base", workspace.baseSha, "--pi-executable", workspace.piExecutable],
        { DEEPSEEK_API_KEY: "provider-key" },
        workspace.rootDir,
      );

      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "Local entry 'missing' was not registered",
      );
      expect(await countLines(path.join(workspace.rootDir, "pi-called"))).toBe(0);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("initializes and checks the TypeScript config", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      const init = await runCli(["init"], {}, workspace);
      const check = await runCli(["check"], {}, workspace);

      expect(init.exitCode).toBe(0);
      expect(init.stdout).toContain("created 3 file(s) in .pipr");
      expect(check.exitCode).toBe(0);
      expect(check.stdout).toContain("valid:");
      expect(await Bun.file(path.join(workspace, ".pipr", "config.ts")).text()).toContain(
        "pipr.review",
      );
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("checks the repo root dogfood config", async () => {
    const repoRoot = path.resolve("../..");
    const result = await runCli(["check"], {}, repoRoot);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("valid:");
    expect(result.stdout).toContain(".pipr/config.ts");
    expect(await listFiles(path.join(repoRoot, ".pipr"))).toEqual([
      "config.ts",
      "tsconfig.json",
      "types/pipr-sdk.d.ts",
    ]);
  });

  it("refuses init conflicts unless force is explicit", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await mkdir(path.join(workspace, ".pipr"));
      await Bun.write(path.join(workspace, ".pipr", "config.ts"), "custom: true\n");

      const conflict = await runCli(["init"], {}, workspace);
      const forced = await runCli(["init", "--force"], {}, workspace);

      expect(conflict.exitCode).toBe(1);
      expect(`${conflict.stdout}\n${conflict.stderr}`).toContain(
        "Use --force to replace existing .pipr files",
      );
      expect(forced.exitCode).toBe(0);
      expect(forced.stdout).toContain("overwrote 1");
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("runs action dry-run without requiring provider env", async () => {
    const result = await runActionWithGitWorkspace({
      env: { PIPR_DRY_RUN: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pipr loaded change #1 for local/pipr");
    expect(result.stdout).toContain("PIPR_DRY_RUN=1");
    expect(result.piCalled).toBe(false);
  });

  it("fails action dry-run before model work when config is missing", async () => {
    const result = await runActionWithGitWorkspace({
      initConfig: false,
      env: { PIPR_DRY_RUN: "1" },
    });

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("config.ts is required at base commit");
    expect(result.piCalled).toBe(false);
  });

  it("inspects the TS runtime plan after config validation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await initWorkspaceConfig(workspace);
      const inspect = await runCli(["inspect"], {}, workspace);

      expect(inspect.exitCode).toBe(0);
      expect(inspect.stdout).toContain("models");
      expect(inspect.stdout).toContain("agents");
      expect(inspect.stdout).toContain("tasks");
      expect(inspect.stdout).toContain("events");
      expect(inspect.stdout).toContain("commands");
      expect(inspect.stdout).toContain("locals");
      expect(inspect.stdout).toContain("tools");
      expect(inspect.stdout).toContain("schemas");
      expect(inspect.stdout).toContain("deepseek");
      expect(inspect.stdout).toContain("@pipr review");
    } finally {
      await removeWorkspace(workspace);
    }
  });
});

async function runActionWithGitWorkspace(options: {
  env?: NodeJS.ProcessEnv;
  initConfig?: boolean;
}): Promise<{
  exitCode: number;
  baseSha: string;
  headSha: string;
  piCalled: boolean;
  piCallCount: number;
  stdout: string;
  stderr: string;
}> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
  try {
    await runCommand("git", ["init", "--initial-branch=main"], workspace);
    await runCommand("git", ["config", "user.name", "pipr test"], workspace);
    await runCommand("git", ["config", "user.email", "pipr@example.test"], workspace);
    await runCommand("git", ["config", "core.hooksPath", "/dev/null"], workspace);
    await runCommand("git", ["config", "commit.gpgsign", "false"], workspace);
    if (options.initConfig !== false) {
      await initWorkspaceConfig(workspace);
    }
    await mkdir(path.join(workspace, "src"));
    await Bun.write(path.join(workspace, "src/a.ts"), "export const value = 1;\n");
    await runCommand("git", ["add", "."], workspace);
    await runCommand("git", ["commit", "--no-verify", "-m", "base"], workspace);
    const baseSha = (await runCommand("git", ["rev-parse", "HEAD"], workspace)).trim();
    await Bun.write(path.join(workspace, "src/a.ts"), "export const value = 2;\n");
    await runCommand("git", ["add", "."], workspace);
    await runCommand("git", ["commit", "--no-verify", "-m", "head"], workspace);
    const headSha = (await runCommand("git", ["rev-parse", "HEAD"], workspace)).trim();
    const eventPath = path.join(workspace, "event.json");
    const githubOutputPath = path.join(workspace, "github-output.txt");
    await Bun.write(eventPath, JSON.stringify(pullRequestPayload(baseSha, headSha)));
    await Bun.write(githubOutputPath, "");

    const result = await runCli(["action"], {
      DEEPSEEK_API_KEY: "provider-key",
      ...options.env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_OUTPUT: githubOutputPath,
      GITHUB_WORKSPACE: workspace,
    });
    return {
      ...result,
      baseSha,
      headSha,
      piCalled: await fileExists(path.join(workspace, "pi-called")),
      piCallCount: await countLines(path.join(workspace, "pi-called")),
    };
  } finally {
    await removeWorkspace(workspace);
  }
}

async function createLocalReviewWorkspace(): Promise<{
  rootDir: string;
  baseSha: string;
  piExecutable: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
  await runCommand("git", ["init", "--initial-branch=main"], rootDir);
  await runCommand("git", ["config", "user.name", "pipr test"], rootDir);
  await runCommand("git", ["config", "user.email", "pipr@example.test"], rootDir);
  await runCommand("git", ["config", "core.hooksPath", "/dev/null"], rootDir);
  await runCommand("git", ["config", "commit.gpgsign", "false"], rootDir);
  await initWorkspaceConfig(rootDir);
  await mkdir(path.join(rootDir, "src"));
  await Bun.write(path.join(rootDir, "src/a.ts"), "export const value = 1;\n");
  await runCommand("git", ["add", "."], rootDir);
  await runCommand("git", ["commit", "--no-verify", "-m", "base"], rootDir);
  const baseSha = (await runCommand("git", ["rev-parse", "HEAD"], rootDir)).trim();
  await Bun.write(path.join(rootDir, "src/a.ts"), "export const value = 2;\n");
  await runCommand("git", ["add", "."], rootDir);
  await runCommand("git", ["commit", "--no-verify", "-m", "head"], rootDir);
  const piExecutable = path.join(rootDir, "fake-pi.sh");
  await Bun.write(
    piExecutable,
    ["#!/bin/sh", 'printf "1\\n" >> "$(dirname "$0")/pi-called"', noFindingsJsonCommand()].join(
      "\n",
    ),
  );
  await chmod(piExecutable, 0o755);
  return { rootDir, baseSha, piExecutable };
}

function noFindingsJsonCommand(): string {
  return 'printf \'%s\\n\' \'{"summary":{"body":"No findings."},"inlineFindings":[]}\'';
}

async function countLines(filePath: string): Promise<number> {
  if (!(await fileExists(filePath))) {
    return 0;
  }
  return (await Bun.file(filePath).text()).split("\n").filter(Boolean).length;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function initWorkspaceConfig(workspace: string): Promise<void> {
  const result = await runCli(["init"], {}, workspace);
  if (result.exitCode !== 0) {
    throw new Error(`pipr init failed: ${result.stderr || result.stdout}`);
  }
}

async function removeWorkspace(workspace: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(workspace, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) {
        throw error;
      }
      await delay(100);
    }
  }
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = Bun.spawnSync(["bun", cliPath, ...args], {
    cwd,
    env: {
      ...minimalEnv(),
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["BUN_INSTALL", "HOME", "LANG", "PATH", "TMPDIR", "USER"]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: minimalEnv(),
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
}

function pullRequestPayload(baseSha = "base", headSha = "head"): unknown {
  return {
    action: "opened",
    number: 1,
    repository: {
      full_name: "local/pipr",
    },
    pull_request: {
      number: 1,
      base: {
        sha: baseSha,
        repo: {
          full_name: "local/pipr",
        },
      },
      head: {
        sha: headSha,
      },
    },
  };
}

async function listFiles(rootDir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(rootDir, prefix), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        return await listFiles(rootDir, relativePath);
      }
      return [relativePath.split(path.sep).join("/")];
    }),
  );
  return files.flat().sort();
}
