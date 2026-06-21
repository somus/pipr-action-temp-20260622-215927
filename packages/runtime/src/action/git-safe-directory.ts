import { spawnSync } from "node:child_process";

export function ensureGitHubWorkspaceSafeDirectory(options: {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = options.env ?? process.env;
  if (env.GITHUB_ACTIONS !== "true") {
    return;
  }
  const workspace = env.GITHUB_WORKSPACE ?? options.rootDir;
  const result = spawnSync("git", ["config", "--global", "--add", "safe.directory", workspace], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.error) {
    throw new Error(`git safe.directory setup failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git safe.directory setup failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}
