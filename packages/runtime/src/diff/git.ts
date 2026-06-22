export function runGit(args: string[], cwd: string, maxBuffer?: number): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: process.env,
    maxBuffer,
    stderr: "pipe",
    stdout: "pipe",
  });
  const failure = gitFailure(result);
  if (failure) {
    throw new Error(`git ${args.join(" ")} failed: ${failure}`);
  }
  return result.stdout.toString();
}

function gitFailure(result: ReturnType<typeof Bun.spawnSync>): string | undefined {
  if (result.exitCode !== 0) {
    return stderrText(result).trim() || "unknown error";
  }
  return undefined;
}

function stderrText(result: ReturnType<typeof Bun.spawnSync>): string {
  return result.stderr?.toString() ?? "";
}
