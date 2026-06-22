#!/usr/bin/env bun
const sourceRootResult = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
  stderr: "pipe",
  stdout: "pipe",
});
if (sourceRootResult.exitCode !== 0) {
  throw new Error(`git rev-parse --show-toplevel failed with exit ${sourceRootResult.exitCode}`);
}
const sourceRoot = sourceRootResult.stdout.toString().trim();
const actionImage = envValue("PIPR_ACTION_IMAGE") ?? "pipr-action:act";

if (envValue("PIPR_SKIP_ACTION_IMAGE_BUILD") !== "1") {
  run("docker", ["build", "-t", actionImage, "."]);
}

run("bun", ["run", "--cwd", "packages/runtime", "build"]);
const { checkPiContract } = await import("./pi-contract.ts");
await checkPiContract({ cwd: sourceRoot, image: actionImage });
run("bun", ["packages/e2e/assertions.test.ts"]);
for (const scenario of ["dry-run", "full", "condensed", "orchestrator"]) {
  run("bun", ["packages/e2e/run.ts", scenario]);
}

function run(command: string, args: string[]): void {
  const label = [command, ...args].join(" ");
  const result = Bun.spawnSync([command, ...args], {
    cwd: sourceRoot,
    env: Bun.env,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode === 0) {
    return;
  }
  process.exitCode = result.exitCode;
  throw new Error(`${label} failed`);
}

function envValue(name: string): string | undefined {
  const value = Bun.env[name];
  return value ? value : undefined;
}
