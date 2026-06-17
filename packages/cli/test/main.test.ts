import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

const cliPath = path.resolve("src/main.ts");

describe("pipr CLI", () => {
  it("prints help for subcommands", async () => {
    const result = await runCli(["action", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("validate [--config-dir .pipr] [--require-env]");
  });

  it("runs action dry-run without requiring provider env", async () => {
    const result = await runActionWithEvent({
      PIPR_DRY_RUN: "1",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pipr loaded PR #1 for local/pipr");
    expect(result.stdout).toContain("PIPR_DRY_RUN=1");
  });

  it("fails explicitly when non-dry-run review runtime is not implemented", async () => {
    const result = await runActionWithEvent({
      DEEPSEEK_API_KEY: "provider-key",
    });

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "pipr action review runtime is not implemented yet",
    );
  });
});

async function runActionWithEvent(
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
  try {
    const eventPath = path.join(workspace, "event.json");
    await writeFile(eventPath, JSON.stringify(pullRequestPayload()));
    return await runCli(["action"], {
      ...env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_WORKSPACE: workspace,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = spawn("bun", [cliPath, ...args], {
    env: {
      ...minimalEnv(),
      ...env,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    waitForExit(proc),
  ]);
  return { exitCode, stdout, stderr };
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

function readStream(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      output += chunk;
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(output);
    });
  });
}

function waitForExit(proc: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}

function pullRequestPayload(): unknown {
  return {
    action: "opened",
    number: 1,
    repository: {
      full_name: "local/pipr",
    },
    pull_request: {
      number: 1,
      base: {
        sha: "base",
        repo: {
          full_name: "local/pipr",
        },
      },
      head: {
        sha: "head",
      },
    },
  };
}
