import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const cliPath = path.resolve("src/main.ts");

describe("pipr CLI", () => {
  it("prints TS-first subcommands", async () => {
    const result = await runCli(["action", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("init [--config-dir .pipr] [--force]");
    expect(result.stdout).toContain("check [--config-dir .pipr] [--require-env]");
    expect(result.stdout).toContain("inspect [--config-dir .pipr]");
    expect(result.stdout).toContain("review --base sha");
    expect(result.stdout).toContain("run name --base sha");
    expect(result.stdout).not.toContain("graph");
    expect(result.stdout).not.toContain("explain-config");
    expect(result.stdout).not.toContain("list-blocks");
    expect(result.stdout).not.toContain("list-presets");
    expect(result.stdout).not.toContain("list-agents");
    expect(result.stdout).not.toContain("list-tools");
    expect(result.stdout).not.toContain("list-commands");
    expect(result.stdout).not.toContain("validate [--config-dir .pipr]");
  });

  it("rejects removed inspection commands", async () => {
    for (const command of [
      "validate",
      "explain-config",
      "graph",
      "list-blocks",
      "list-presets",
      "list-agents",
      "list-tools",
      "list-commands",
    ]) {
      const result = await runCli([command]);

      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(`Unknown pipr command '${command}'`);
    }
  });

  it("requires an explicit base SHA for local review runs", async () => {
    const result = await runCli(["review"]);

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("pipr review requires --base <sha>");
  });

  it("runs a named local entrypoint without GitHub publication", async () => {
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
      expect(await readFile(path.join(workspace, ".pipr", "config.ts"), "utf8")).toContain(
        "pipr.review",
      );
      await expect(access(path.join(workspace, ".pipr", "workflows"))).rejects.toThrow();
      await expect(access(path.join(workspace, ".pipr", "agents"))).rejects.toThrow();
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
      await writeFile(path.join(workspace, ".pipr", "config.ts"), "custom: true\n");

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

  it("rejects inherited command and option names", async () => {
    const command = await runCli(["toString"]);
    const option = await runCli(["check", "toString"]);

    expect(command.exitCode).toBe(1);
    expect(`${command.stdout}\n${command.stderr}`).toContain("Unknown pipr command 'toString'");
    expect(option.exitCode).toBe(1);
    expect(`${option.stdout}\n${option.stderr}`).toContain("Unexpected argument 'toString'");
  });

  it("runs action dry-run without requiring provider env", async () => {
    const result = await runActionWithGitWorkspace({
      env: { PIPR_DRY_RUN: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pipr loaded PR #1 for local/pipr");
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

  it("runs action runtime with fake Pi", async () => {
    const result = await runActionWithGitWorkspace({});

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("pipr loaded PR #1 for local/pipr");
    expect(result.stdout).toContain(
      "pipr review produced 0 valid inline finding(s), 0 dropped finding(s)",
    );
    expect(result.stdout).toContain("pipr published main comment (created)");
    expect(result.githubOutput).toContain(`Reviewed head: \`${result.headSha}\``);
    expect(result.githubOutput).toContain(`Trusted config SHA: \`${result.baseSha}\``);
  });

  it("uses trusted Action provider inputs instead of PR-controlled config", async () => {
    const result = await runActionWithGitWorkspace({
      headConfigTs: configTs({ provider: "untrusted-backend", model: "untrusted-model" }),
      env: {
        DEEPSEEK_API_KEY: "trusted-key",
        EVIL_API_KEY: "evil-key",
      },
      piScript: [
        "#!/bin/sh",
        'case " $* " in *" --provider deepseek "*) ;; *) echo "wrong provider: $*" >&2; exit 41;; esac',
        'case " $* " in *" --model deepseek-v4-pro "*) ;; *) echo "wrong model: $*" >&2; exit 42;; esac',
        '[ "$DEEPSEEK_API_KEY" = "trusted-key" ] || { echo "missing trusted key" >&2; exit 43; }',
        '[ -z "$EVIL_API_KEY" ] || { echo "untrusted key leaked" >&2; exit 44; }',
        noFindingsJsonCommand(),
      ].join("\n"),
    });

    expect(`${result.stdout}\n${result.stderr}`).not.toContain("untrusted");
    expect(result.exitCode).toBe(0);
  });

  it("passes custom trusted Action provider inputs into Pi", async () => {
    const result = await runActionWithGitWorkspace({
      actionArgs: [
        "--provider-id",
        "trusted-profile",
        "--provider",
        "trusted-backend",
        "--model",
        "trusted-model",
        "--api-key-env",
        "TRUSTED_API_KEY",
      ],
      env: {
        TRUSTED_API_KEY: "trusted-key",
      },
      piScript: [
        "#!/bin/sh",
        'case " $* " in *" --provider trusted-backend "*) ;; *) echo "wrong provider: $*" >&2; exit 41;; esac',
        'case " $* " in *" --model trusted-model "*) ;; *) echo "wrong model: $*" >&2; exit 42;; esac',
        'case " $* " in *" --thinking high "*) ;; *) echo "wrong thinking: $*" >&2; exit 45;; esac',
        '[ "$TRUSTED_API_KEY" = "trusted-key" ] || { echo "missing trusted key" >&2; exit 43; }',
        noFindingsJsonCommand(),
      ].join("\n"),
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("does not let invalid PR-head config block trusted Action execution", async () => {
    const result = await runActionWithGitWorkspace({
      headConfigTs: "export default [\n",
      piScript: ["#!/bin/sh", noFindingsJsonCommand()].join("\n"),
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("pins Action instructions to the base commit while manifest includes PR-head config changes", async () => {
    const result = await runActionWithGitWorkspace({
      configTs: configTs({ instructions: "BASE PROMPT" }),
      headConfigTs: configTs({ instructions: "HEAD PROMPT" }),
      piScript: [
        "#!/bin/sh",
        "bun -e '",
        'const prompt = process.argv.at(-1) ?? "";',
        'const instructions = prompt.split("Instructions:\\n").at(1)?.split("\\n\\nPrompt:").at(0) ?? "";',
        'if (instructions.includes("HEAD PROMPT")) { console.error("head prompt used"); process.exit(45); }',
        'if (!instructions.includes("BASE PROMPT")) { console.error("base prompt missing"); process.exit(46); }',
        'if (!prompt.includes(".pipr/config.ts")) { console.error("head config change missing from manifest"); process.exit(47); }',
        'console.log(JSON.stringify({ summary: { body: "No findings." }, inlineFindings: [] }));',
        '\' -- "$@"',
      ].join("\n"),
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("executes base-commit task logic instead of PR-head task logic", async () => {
    const result = await runActionWithGitWorkspace({
      configTs: configTs({ piRuns: 2, summary: "Base task used." }),
      headConfigTs: configTs({ piRuns: 1, summary: "Head task used." }),
      piScript: [
        "#!/bin/sh",
        'printf "1\\n" >> "$(dirname "$0")/pi-called"',
        'printf \'%s\\n\' \'{"summary":{"body":"Base task used."},"inlineFindings":[]}\'',
      ].join("\n"),
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.piCallCount).toBe(2);
    expect(result.githubOutput).toContain("Base task used.");
    expect(result.githubOutput).not.toContain("Head task used.");
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
      expect(inspect.stdout).not.toContain("registry");
    } finally {
      await removeWorkspace(workspace);
    }
  });
});

async function runActionWithGitWorkspace(options: {
  actionArgs?: string[];
  configTs?: string;
  env?: NodeJS.ProcessEnv;
  headConfigTs?: string;
  githubFixture?: Record<string, unknown>;
  initConfig?: boolean;
  piScript?: string;
}): Promise<{
  exitCode: number;
  baseSha: string;
  headSha: string;
  githubOutput: string;
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
    await writeOptionalFile(path.join(workspace, ".pipr", "config.ts"), options.configTs);
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src/a.ts"), "export const value = 1;\n");
    await runCommand("git", ["add", "."], workspace);
    await runCommand("git", ["commit", "--no-verify", "-m", "base"], workspace);
    const baseSha = (await runCommand("git", ["rev-parse", "HEAD"], workspace)).trim();
    await writeOptionalFile(path.join(workspace, ".pipr", "config.ts"), options.headConfigTs);
    await writeFile(path.join(workspace, "src/a.ts"), "export const value = 2;\n");
    await runCommand("git", ["add", "."], workspace);
    await runCommand("git", ["commit", "--no-verify", "-m", "head"], workspace);
    const headSha = (await runCommand("git", ["rev-parse", "HEAD"], workspace)).trim();
    const eventPath = path.join(workspace, "event.json");
    const githubOutputPath = path.join(workspace, "github-output.txt");
    const githubFixturePath = path.join(workspace, "github-fixture.json");
    const piExecutable = path.join(workspace, "fake-pi.sh");
    await writeFile(eventPath, JSON.stringify(pullRequestPayload(baseSha, headSha)));
    await writeFile(githubOutputPath, "");
    await writeFile(
      githubFixturePath,
      JSON.stringify({
        ownerLogin: "github-actions[bot]",
        headSha,
        issueComments: [],
        reviewComments: [],
        reviewCommentPayloads: [],
        ...(options.githubFixture ?? {}),
      }),
    );
    await writeFile(
      piExecutable,
      options.piScript ?? ["#!/bin/sh", noFindingsJsonCommand()].join("\n"),
    );
    await chmod(piExecutable, 0o755);

    const result = await runCli(["action", ...(options.actionArgs ?? [])], {
      DEEPSEEK_API_KEY: "provider-key",
      ...options.env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_OUTPUT: githubOutputPath,
      GITHUB_WORKSPACE: workspace,
      PIPR_ENABLE_TEST_FIXTURES: "1",
      PIPR_GITHUB_FIXTURE_PATH: githubFixturePath,
      PIPR_PI_EXECUTABLE: piExecutable,
    });
    return {
      ...result,
      baseSha,
      headSha,
      githubOutput: (await fileExists(githubOutputPath))
        ? await readFile(githubOutputPath, "utf8")
        : "",
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
  await writeFile(path.join(rootDir, "src/a.ts"), "export const value = 1;\n");
  await runCommand("git", ["add", "."], rootDir);
  await runCommand("git", ["commit", "--no-verify", "-m", "base"], rootDir);
  const baseSha = (await runCommand("git", ["rev-parse", "HEAD"], rootDir)).trim();
  await writeFile(path.join(rootDir, "src/a.ts"), "export const value = 2;\n");
  await runCommand("git", ["add", "."], rootDir);
  await runCommand("git", ["commit", "--no-verify", "-m", "head"], rootDir);
  const piExecutable = path.join(rootDir, "fake-pi.sh");
  await writeFile(
    piExecutable,
    ["#!/bin/sh", 'printf "1\\n" >> "$(dirname "$0")/pi-called"', noFindingsJsonCommand()].join(
      "\n",
    ),
  );
  await chmod(piExecutable, 0o755);
  return { rootDir, baseSha, piExecutable };
}

function configTs(
  options: {
    provider?: string;
    model?: string;
    instructions?: string;
    piRuns?: number;
    summary?: string;
  } = {},
): string {
  const piRuns = options.piRuns ?? 1;
  const template = "$";
  const runLines = Array.from({ length: piRuns }, (_, index) =>
    index === piRuns - 1
      ? "    const result = await ctx.pi.run(reviewer, { manifest });"
      : "    await ctx.pi.run(reviewer, { manifest });",
  );
  return [
    'import { definePipr } from "@pipr/sdk";',
    "",
    "export default definePipr((pipr) => {",
    `  const model = pipr.model("${options.provider ?? "deepseek"}/${options.model ?? "deepseek-v4-pro"}", {`,
    '    name: "deepseek",',
    '    apiKey: pipr.secret("DEEPSEEK_API_KEY"),',
    '    options: { thinking: "high" },',
    "  });",
    "  const reviewer = pipr.agent({",
    '    name: "review",',
    "    model,",
    `    instructions: ${JSON.stringify(options.instructions ?? "Review this change.")},`,
    "    output: pipr.schemas.review,",
    `    prompt: (input) => pipr.prompt\`Review this change.\\n${template}{pipr.compactManifest(input.manifest)}\`,`,
    "  });",
    "  const task = pipr.task('review', async (ctx) => {",
    "    const manifest = await ctx.change.diffManifest({ compressed: true });",
    ...runLines,
    options.summary
      ? `    ctx.output.summary(${JSON.stringify(options.summary)});`
      : "    ctx.output.summary(result.summary);",
    "    ctx.output.findings(result.inlineFindings);",
    "  });",
    '  pipr.on.changeRequest(["opened"], task);',
    '  pipr.command("@pipr review", { permission: "write" }, task);',
    '  pipr.local("review", task);',
    "});",
  ].join("\n");
}

function noFindingsJsonCommand(): string {
  return 'printf \'%s\\n\' \'{"summary":{"body":"No findings."},"inlineFindings":[]}\'';
}

async function countLines(filePath: string): Promise<number> {
  if (!(await fileExists(filePath))) {
    return 0;
  }
  return (await readFile(filePath, "utf8")).split("\n").filter(Boolean).length;
}

async function writeOptionalFile(filePath: string, contents: string | undefined): Promise<void> {
  if (contents !== undefined) {
    await writeFile(filePath, contents);
  }
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
  const proc = spawn("bun", [cliPath, ...args], {
    cwd,
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

function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  const proc = spawn(command, args, {
    cwd,
    env: minimalEnv(),
  });
  return Promise.all([readStream(proc.stdout), readStream(proc.stderr), waitForExit(proc)]).then(
    ([stdout, stderr, exitCode]) => {
      if (exitCode !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`);
      }
      return stdout;
    },
  );
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
