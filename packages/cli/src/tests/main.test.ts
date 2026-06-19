import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const cliPath = path.resolve("src/main.ts");

describe("pipr CLI", () => {
  it("prints help for subcommands", async () => {
    const result = await runCli(["action", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("init [--config-dir .pipr] [--force]");
    expect(result.stdout).toContain("validate [--config-dir .pipr] [--require-env]");
  });

  it("initializes the official minimal tree and validates it", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      const init = await runCli(["init"], {}, workspace);
      const validate = await runCli(["validate"], {}, workspace);

      expect(init.exitCode).toBe(0);
      expect(init.stdout).toContain("created 4 file(s) in .pipr");
      expect(validate.exitCode).toBe(0);
      expect(validate.stdout).toContain("valid:");
      const configYaml = await readFile(path.join(workspace, ".pipr", "config.yaml"), "utf8");
      expect(configYaml).toContain("- pipr/review");
      expect(configYaml).toContain("timeoutSeconds: 300");
      await expect(access(path.join(workspace, ".pipr", "schemas"))).rejects.toThrow();
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("refuses init conflicts unless force is explicit", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await mkdir(path.join(workspace, ".pipr"));
      await writeFile(path.join(workspace, ".pipr", "config.yaml"), "custom: true\n");

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
    const option = await runCli(["validate", "toString"]);

    expect(command.exitCode).toBe(1);
    expect(`${command.stdout}\n${command.stderr}`).toContain("Unknown pipr command 'toString'");
    expect(option.exitCode).toBe(1);
    expect(`${option.stdout}\n${option.stderr}`).toContain("Unknown option 'toString'");
  });

  it("runs action dry-run without requiring provider env", async () => {
    const result = await runActionWithEvent({
      PIPR_DRY_RUN: "1",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pipr loaded PR #1 for local/pipr");
    expect(result.stdout).toContain("PIPR_DRY_RUN=1");
  });

  it("fails action dry-run before model work when config is missing", async () => {
    const result = await runActionWithEvent(
      {
        PIPR_DRY_RUN: "1",
      },
      { initConfig: false },
    );

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Run pipr init to create it");
  });

  it("runs action runtime with fake Pi", async () => {
    const result = await runActionWithGitWorkspace({});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pipr loaded PR #1 for local/pipr");
    expect(result.stdout).toContain("pipr review produced 0 inline draft(s), 0 dropped finding(s)");
  });

  it("uses trusted Action provider inputs instead of PR-controlled provider config", async () => {
    const result = await runActionWithGitWorkspace({
      headConfigYaml: [
        "apiVersion: pipr.dev/v1",
        "kind: Config",
        "providers:",
        "  - id: deepseek",
        "    provider: untrusted-backend",
        "    model: untrusted-model",
        "    apiKeyEnv: EVIL_API_KEY",
        "workflows:",
        "  - pipr/review",
        "publication:",
        "  maxInlineComments: 5",
      ].join("\n"),
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
        'printf \'%s\\n\' \'{"summary":{"body":"No findings."},"inlineFindings":[]}\'',
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
        'printf \'%s\\n\' \'{"summary":{"body":"No findings."},"inlineFindings":[]}\'',
      ].join("\n"),
    });

    expect(result.exitCode).toBe(0);
  });

  it("passes trusted Action provider inputs from environment into Pi", async () => {
    const result = await runActionWithGitWorkspace({
      env: {
        INPUT_PROVIDER_ID: "trusted-profile",
        INPUT_PROVIDER: "trusted-backend",
        INPUT_MODEL: "trusted-model",
        INPUT_API_KEY_ENV: "TRUSTED_API_KEY",
        TRUSTED_API_KEY: "trusted-key",
      },
      piScript: [
        "#!/bin/sh",
        'case " $* " in *" --provider trusted-backend "*) ;; *) echo "wrong provider: $*" >&2; exit 41;; esac',
        'case " $* " in *" --model trusted-model "*) ;; *) echo "wrong model: $*" >&2; exit 42;; esac',
        'case " $* " in *" --thinking high "*) ;; *) echo "wrong thinking: $*" >&2; exit 45;; esac',
        '[ "$TRUSTED_API_KEY" = "trusted-key" ] || { echo "missing trusted key" >&2; exit 43; }',
        '[ -z "$DEEPSEEK_API_KEY" ] || { echo "default key leaked" >&2; exit 44; }',
        'printf \'%s\\n\' \'{"summary":{"body":"No findings."},"inlineFindings":[]}\'',
      ].join("\n"),
    });

    expect(result.exitCode).toBe(0);
  });

  it("uses provider thinking from the base-commit config, not Action inputs", async () => {
    const result = await runActionWithGitWorkspace({
      configYaml: [
        "apiVersion: pipr.dev/v1",
        "kind: Config",
        "providers:",
        "  - id: deepseek",
        "    provider: deepseek",
        "    model: deepseek-v4-pro",
        "    apiKeyEnv: DEEPSEEK_API_KEY",
        "    thinking: xhigh",
        "workflows:",
        "  - pipr/review",
        "publication:",
        "  maxInlineComments: 5",
        "limits:",
        "  timeoutSeconds: 300",
      ].join("\n"),
      env: {
        INPUT_THINKING: "minimal",
      },
      piScript: [
        "#!/bin/sh",
        'case " $* " in *" --thinking xhigh "*) ;; *) echo "wrong thinking: $*" >&2; exit 45;; esac',
        'printf \'%s\\n\' \'{"summary":{"body":"No findings."},"inlineFindings":[]}\'',
      ].join("\n"),
    });

    expect(result.exitCode).toBe(0);
  });

  it("uses base-commit Action config for execution limits and publication caps", async () => {
    const result = await runActionWithGitWorkspace({
      headConfigYaml: [
        "apiVersion: pipr.dev/v1",
        "kind: Config",
        "providers:",
        "  - id: deepseek",
        "    provider: deepseek",
        "    model: deepseek-v4-pro",
        "    apiKeyEnv: DEEPSEEK_API_KEY",
        "workflows:",
        "  - pipr/review",
        "publication:",
        "  maxInlineComments: 0",
        "limits:",
        "  timeoutSeconds: 1",
      ].join("\n"),
      piScript: [
        "#!/bin/sh",
        "sleep 2",
        "bun -e '",
        'const prompt = process.argv.at(-1) ?? "";',
        'const manifest = JSON.parse(prompt.split("Diff Manifest:\\n\\n").at(-1));',
        'const range = manifest.files.find((file) => file.path === "src/a.ts").commentableRanges[0];',
        "console.log(JSON.stringify({",
        '  summary: { body: "One finding." },',
        "  inlineFindings: [{",
        '    title: "Bug",',
        '    body: "This can fail.",',
        "    path: range.path,",
        "    rangeId: range.id,",
        "    side: range.side,",
        "    startLine: range.startLine,",
        "    endLine: range.endLine,",
        '    severity: "high",',
        '    category: "correctness",',
        "    confidence: 0.9,",
        '    evidenceSnippet: "export const value = 2;"',
        "  }]",
        "}));",
        '\' -- "$@"',
      ].join("\n"),
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("pipr review produced 1 inline draft(s), 0 dropped finding(s)");
  });

  it("does not let invalid PR-head config block trusted Action execution", async () => {
    const result = await runActionWithGitWorkspace({
      headConfigYaml: "apiVersion: [\n",
      piScript: [
        "#!/bin/sh",
        'printf \'%s\\n\' \'{"summary":{"body":"No findings."},"inlineFindings":[]}\'',
      ].join("\n"),
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("ignores PR-head action workflow graphs", async () => {
    const result = await runActionWithGitWorkspace({
      headWorkflowYaml: [
        "apiVersion: pipr.dev/v1",
        "kind: Workflow",
        "id: pipr/review",
        "on:",
        "  events:",
        "    - pull_request.opened",
        "steps:",
        "  - id: review",
        "    uses: core/run-agent",
        "  - id: main-comment",
        "    uses: core/main-comment",
        "    with:",
        "      review:",
        "        review:",
        "          summary:",
        "            body: Forged review.",
        "          inlineFindings: []",
        "        validFindings: []",
        "        droppedFindings: []",
        "  - id: inline-comments",
        "    uses: core/inline-comments",
        "    with:",
        `      review: ${expr("steps.review.outputs.result")}`,
      ].join("\n"),
      piScript: [
        "#!/bin/sh",
        'touch "$(dirname "$0")/pi-called"',
        'printf \'%s\\n\' \'{"summary":{"body":"No findings."},"inlineFindings":[]}\'',
      ].join("\n"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.piCalled).toBe(true);
  });

  it("executes the base-commit materialized Action workflow graph", async () => {
    const result = await runActionWithGitWorkspace({
      workflowYaml: [
        "apiVersion: pipr.dev/v1",
        "kind: Workflow",
        "id: pipr/review",
        "on:",
        "  events:",
        "    - pull_request.opened",
        "steps:",
        "  - id: warmup",
        "    uses: core/run-agent",
        "  - id: review",
        "    uses: core/run-agent",
        "  - id: main-comment",
        "    uses: core/main-comment",
        "    with:",
        `      review: ${expr("steps.review.outputs.result")}`,
        "  - id: inline-comments",
        "    uses: core/inline-comments",
        "    with:",
        `      review: ${expr("steps.review.outputs.result")}`,
      ].join("\n"),
      piScript: [
        "#!/bin/sh",
        'printf "1\\n" >> "$(dirname "$0")/pi-called"',
        'printf \'%s\\n\' \'{"summary":{"body":"Base graph used."},"inlineFindings":[]}\'',
      ].join("\n"),
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.piCallCount).toBe(2);
    expect(result.githubOutput).toContain("Base graph used.");
  });

  it("pins Action agent and main comment template content to the base commit", async () => {
    const result = await runActionWithGitWorkspace({
      headAgentMarkdown: [
        "---",
        "apiVersion: pipr.dev/v1",
        "kind: Agent",
        "id: pipr/reviewer",
        "provider: deepseek",
        "output:",
        "  schema: core/pr-review",
        "---",
        "",
        "HEAD CONTROLLED PROMPT",
      ].join("\n"),
      headCommentYaml: [
        "apiVersion: pipr.dev/v1",
        "kind: CommentTemplate",
        "id: pipr/main",
        "marker: pipr:head-main",
        "heading: Head Review",
        "sections:",
        "  - id: summary",
        "    title: Head Digest",
        "    order: 10",
      ].join("\n"),
      piScript: [
        "#!/bin/sh",
        'case " $* " in *"Agent Instructions:"*"HEAD CONTROLLED PROMPT"*"Return only valid JSON"*) echo "head prompt used" >&2; exit 45;; esac',
        'case " $* " in *"Agent Instructions:"*"Review the pull request diff for correctness, security, maintainability, and test risk."*"Return only valid JSON"*) ;; *) echo "base prompt missing" >&2; exit 46;; esac',
        'printf \'%s\\n\' \'{"summary":{"body":"No findings."},"inlineFindings":[]}\'',
      ].join("\n"),
    });

    const output = `${result.stdout}\n${result.stderr}\n${result.githubOutput}`;

    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("pipr:main-comment");
    expect(output).not.toContain("pipr:head-main");
    expect(output).not.toContain("Head Review");
  });

  it("still repairs invalid Pi output after initialized config validation", async () => {
    const result = await runActionWithGitWorkspace({
      piScript: ["#!/bin/sh", "printf '%s\\n' 'not json'"].join("\n"),
    });

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Pi reviewer output failed schema validation after repair attempt",
    );
  });

  it("lists materialized runtime registry entries after config validation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await initWorkspaceConfig(workspace);
      const result = await runCli(["list-agents"], {}, workspace);
      const commands = await runCli(["list-commands"], {}, workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("pipr/reviewer\tpipr/reviewer");
      expect(commands.exitCode).toBe(0);
      expect(commands.stdout).toContain("@pipr help\tBuilt-in pipr command help.");
      expect(commands.stdout).toContain("@pipr review\tpipr/review command 'review'");
    } finally {
      await removeWorkspace(workspace);
    }
  });
});

async function runActionWithEvent(
  env: NodeJS.ProcessEnv,
  options: { initConfig?: boolean } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
  try {
    if (options.initConfig !== false) {
      await initWorkspaceConfig(workspace);
    }
    const eventPath = path.join(workspace, "event.json");
    await writeFile(eventPath, JSON.stringify(pullRequestPayload()));
    return await runCli(["action"], {
      ...env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_WORKSPACE: workspace,
    });
  } finally {
    await removeWorkspace(workspace);
  }
}

async function runActionWithGitWorkspace(options: {
  actionArgs?: string[];
  configYaml?: string;
  env?: NodeJS.ProcessEnv;
  headConfigYaml?: string;
  headAgentMarkdown?: string;
  headCommentYaml?: string;
  piScript?: string;
  headWorkflowYaml?: string;
  workflowYaml?: string;
}): Promise<{
  exitCode: number;
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
    await initWorkspaceConfig(workspace);
    await writeOptionalFile(path.join(workspace, ".pipr", "config.yaml"), options.configYaml);
    await writeOptionalFile(
      path.join(workspace, ".pipr", "workflows", "review.yaml"),
      options.workflowYaml,
    );
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src/a.ts"), "export const value = 1;\n");
    await runCommand("git", ["add", "."], workspace);
    await runCommand("git", ["commit", "--no-verify", "-m", "base"], workspace);
    const baseSha = (await runCommand("git", ["rev-parse", "HEAD"], workspace)).trim();
    await writeOptionalFile(path.join(workspace, ".pipr", "config.yaml"), options.headConfigYaml);
    await writeOptionalFile(
      path.join(workspace, ".pipr", "agents", "reviewer.md"),
      options.headAgentMarkdown,
    );
    await writeOptionalFile(
      path.join(workspace, ".pipr", "comments", "main.yaml"),
      options.headCommentYaml,
    );
    await writeOptionalFile(
      path.join(workspace, ".pipr", "workflows", "review.yaml"),
      options.headWorkflowYaml,
    );
    await writeFile(path.join(workspace, "src/a.ts"), "export const value = 2;\n");
    await runCommand("git", ["add", "."], workspace);
    await runCommand("git", ["commit", "--no-verify", "-m", "head"], workspace);
    const headSha = (await runCommand("git", ["rev-parse", "HEAD"], workspace)).trim();
    const eventPath = path.join(workspace, "event.json");
    const githubOutputPath = path.join(workspace, "github-output.txt");
    const piExecutable = path.join(workspace, "fake-pi.sh");
    await writeFile(eventPath, JSON.stringify(pullRequestPayload(baseSha, headSha)));
    await writeFile(githubOutputPath, "");
    await writeFile(
      piExecutable,
      options.piScript ??
        [
          "#!/bin/sh",
          'printf \'%s\\n\' \'{"summary":{"body":"No findings."},"inlineFindings":[]}\'',
        ].join("\n"),
    );
    await chmod(piExecutable, 0o755);

    const result = await runCli(["action", ...(options.actionArgs ?? [])], {
      DEEPSEEK_API_KEY: "provider-key",
      ...options.env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_OUTPUT: githubOutputPath,
      GITHUB_WORKSPACE: workspace,
      PIPR_PI_EXECUTABLE: piExecutable,
    });
    return {
      ...result,
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

function expr(source: string): string {
  return ["$", "{{ ", source, " }}"].join("");
}
