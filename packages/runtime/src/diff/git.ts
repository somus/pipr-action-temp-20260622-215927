import { spawnSync } from "node:child_process";

export function runGit(args: string[], cwd: string, maxBuffer?: number): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer });
  const failure = gitFailure(result);
  if (failure) {
    throw new Error(`git ${args.join(" ")} failed: ${failure}`);
  }
  return result.stdout;
}

function gitFailure(result: ReturnType<typeof spawnSync>): string | undefined {
  if (result.error) {
    return result.error.message;
  }
  if (result.status !== 0) {
    return stderrText(result).trim() || "unknown error";
  }
  return undefined;
}

function stderrText(result: ReturnType<typeof spawnSync>): string {
  return typeof result.stderr === "string" ? result.stderr : result.stderr.toString("utf8");
}
