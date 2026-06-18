#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  piBuiltinToolNames,
  piReadOnlyToolNames,
  piRequiredCliFlags,
  piThinkingLevels,
} from "../packages/runtime/src/pi-contract.js";

type CheckOptions = {
  image?: string;
  piExecutable: string;
};

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const help = runPi(options, ["--help"]);
  const version = runPi(options, ["--version"]).trim();
  const dockerfileVersion = readDockerfilePiVersion();

  assertEqual(version, dockerfileVersion, "Dockerfile Pi package version must match pi --version");
  assertContainsAll(help, piRequiredCliFlags, "Pi CLI flag");
  assertContainsAll(help, piThinkingLevels, "Pi thinking level");
  assertContainsAll(help, piBuiltinToolNames, "Pi built-in tool");
  assertSubset(
    piReadOnlyToolNames,
    piBuiltinToolNames,
    "pipr read-only tools must be Pi built-ins",
  );

  console.log(
    `Pi contract ok: pi ${version}; thinking=${piThinkingLevels.join(",")}; ` +
      `readOnlyTools=${piReadOnlyToolNames.join(",")}`,
  );
}

function parseArgs(args: string[]): CheckOptions {
  const options: CheckOptions = { piExecutable: "pi" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--image") {
      options.image = readArgValue(args, index);
      index += 1;
      continue;
    }
    if (arg === "--pi") {
      options.piExecutable = readArgValue(args, index);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option '${arg}'`);
  }
  return options;
}

function readArgValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${args[index]} requires a value`);
  }
  return value;
}

function runPi(options: CheckOptions, args: string[]): string {
  const [command, commandArgs] = piCommand(options, args);
  return runCommand(command, commandArgs);
}

function piCommand(options: CheckOptions, args: string[]): [string, string[]] {
  if (options.image) {
    return ["docker", ["run", "--rm", "--entrypoint", "pi", options.image, ...args]];
  }
  return [options.piExecutable, args];
}

function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function readDockerfilePiVersion(): string {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const match = dockerfile.match(/@earendil-works\/pi-coding-agent@([^\s\\]+)/);
  if (!match?.[1]) {
    throw new Error("Dockerfile does not pin @earendil-works/pi-coding-agent");
  }
  return match[1];
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected '${expected}', got '${actual}'`);
  }
}

function assertContainsAll(haystack: string, needles: readonly string[], label: string): void {
  const missing = needles.filter((needle) => !haystack.includes(needle));
  if (missing.length > 0) {
    throw new Error(`${label} missing from pi --help: ${missing.join(", ")}`);
  }
}

function assertSubset<T extends string>(
  subset: readonly T[],
  superset: readonly string[],
  label: string,
): void {
  const missing = subset.filter((value) => !superset.includes(value));
  if (missing.length > 0) {
    throw new Error(`${label}: ${missing.join(", ")}`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
