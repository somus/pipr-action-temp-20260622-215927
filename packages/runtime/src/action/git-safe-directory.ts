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
