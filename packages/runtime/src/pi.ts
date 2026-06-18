import { spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toPiProviderInvocation } from "./pi-provider.js";
import type { ProviderConfig } from "./types.js";

export type PiRunOptions = {
  workspace: string;
  provider: ProviderConfig;
  prompt: string;
  env?: NodeJS.ProcessEnv;
  piExecutable?: string;
  timeoutSeconds?: number;
};

export type PiRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

type PiRunSandbox = {
  root: string;
  workspace: string;
  home: string;
  sessionDir: string;
  tmp: string;
};

export async function runPi(options: PiRunOptions): Promise<PiRunResult> {
  const started = Date.now();
  const sandbox = await createPiRunSandbox(options.workspace);
  try {
    const args = buildPiArgs(options.provider, options.prompt, sandbox.sessionDir);
    return await runProcess(options.piExecutable ?? "pi", args, {
      cwd: sandbox.workspace,
      env: buildPiEnv(options.provider, sandbox, options.env),
      started,
      timeoutSeconds: options.timeoutSeconds,
    });
  } finally {
    await chmodRecursive(sandbox.root, 0o755);
    await rm(sandbox.root, { recursive: true, force: true });
  }
}

export function buildPiArgs(
  provider: ProviderConfig,
  prompt: string,
  sessionDir = ".pipr/pi-sessions",
): string[] {
  const invocation = toPiProviderInvocation(provider);
  return [
    "--provider",
    invocation.provider,
    "--model",
    invocation.model,
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--session-dir",
    sessionDir,
    "--tools",
    invocation.tools.join(","),
    "--no-context-files",
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--thinking",
    invocation.thinking,
    prompt,
  ];
}

function buildPiEnv(
  provider: ProviderConfig,
  sandbox: Pick<PiRunSandbox, "home" | "sessionDir" | "tmp">,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: sandbox.home,
    PI_CODING_AGENT_DIR: path.join(sandbox.home, ".pi", "agent"),
    PI_CODING_AGENT_SESSION_DIR: sandbox.sessionDir,
    PI_TELEMETRY: "0",
    PIPR_PROVIDER_ID: provider.id,
    PIPR_PROVIDER_API_KEY_ENV: provider.apiKeyEnv,
    TMPDIR: sandbox.tmp,
    USER: "pipr",
  };
  for (const key of ["BUN_INSTALL", "LANG", "PATH"]) {
    copyEnvValue(env, sourceEnv, key);
  }
  copyEnvValue(env, sourceEnv, provider.apiKeyEnv);
  return env;
}

async function createPiRunSandbox(workspace: string): Promise<PiRunSandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipr-pi-"));
  const runWorkspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const sessionDir = path.join(root, "sessions");
  const tmp = path.join(root, "tmp");
  await mkdir(home, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(tmp, { recursive: true });
  await copyWorkspace(workspace, runWorkspace);
  await chmodRecursive(runWorkspace, 0o555);
  return { root, workspace: runWorkspace, home, sessionDir, tmp };
}

export async function createReadOnlyWorkspace(workspace: string): Promise<string> {
  const destination = await mkdtemp(path.join(os.tmpdir(), "pipr-workspace-"));
  await copyWorkspace(workspace, destination);
  await chmodRecursive(destination, 0o555);
  return destination;
}

async function copyWorkspace(sourceWorkspace: string, destination: string): Promise<void> {
  await cp(sourceWorkspace, destination, {
    recursive: true,
    filter: async (source) => {
      const relative = path.relative(sourceWorkspace, source);
      if (!relative) {
        return true;
      }
      const first = relative.split(path.sep)[0];
      return !isIgnoredWorkspacePath(first) && !(await lstat(source)).isSymbolicLink();
    },
  });
}

function copyEnvValue(target: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv, key: string): void {
  const value = source[key];
  if (value !== undefined) {
    target[key] = value;
  }
}

function isIgnoredWorkspacePath(first: string | undefined): boolean {
  return [".git", "node_modules", "dist", ".turbo", ".fallow", "coverage"].includes(first ?? "");
}

async function chmodRecursive(target: string, mode: number): Promise<void> {
  const stats = await lstat(target);
  if (stats.isSymbolicLink()) {
    return;
  }
  await chmod(target, mode);
  if (!stats.isDirectory()) {
    return;
  }
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    await chmodRecursive(path.join(target, entry.name), mode);
  }
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; started: number; timeoutSeconds?: number },
): Promise<PiRunResult> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    if (options.timeoutSeconds !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child, "SIGTERM");
      }, options.timeoutSeconds * 1000);
    }
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (timedOut) {
        stderr += `${stderr ? "\n" : ""}Pi timed out after ${options.timeoutSeconds}s`;
      }
      resolve({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : (exitCode ?? 1),
        durationMs: Date.now() - options.started,
      });
    });
  });
}

function killProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch (error) {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : "";
    if (code === "ESRCH") {
      return;
    }
  }
}
