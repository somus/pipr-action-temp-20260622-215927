import type { ChangeRequestEventContext } from "../../types.js";

export function ensureGitHubWorkspaceSafeDirectory(options: {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = options.env ?? process.env;
  if (env.GITHUB_ACTIONS !== "true") {
    return;
  }
  const workspace = env.GITHUB_WORKSPACE ?? options.rootDir;
  const result = Bun.spawnSync(
    ["git", "config", "--global", "--add", "safe.directory", workspace],
    {
      env: { ...process.env, ...env },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git safe.directory setup failed: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`,
    );
  }
}

export function ensureGitHubHeadCheckout(options: {
  rootDir: string;
  change: ChangeRequestEventContext;
}): void {
  const headSha = options.change.change.head.sha;
  if (!hasGitCommit(options.rootDir, headSha)) {
    runGit(options.rootDir, [
      "fetch",
      "--no-tags",
      "--depth=1",
      "origin",
      `refs/pull/${options.change.change.number}/head`,
    ]);
  }
  if (runGit(options.rootDir, ["rev-parse", "HEAD"]).trim() !== headSha) {
    runGit(options.rootDir, ["checkout", "--detach", headSha]);
  }
}

function hasGitCommit(rootDir: string, sha: string): boolean {
  try {
    runGit(rootDir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function runGit(rootDir: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: rootDir,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.toString();
}
