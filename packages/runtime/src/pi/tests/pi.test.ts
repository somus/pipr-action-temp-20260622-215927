import { chmod, lstat, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DiffManifest } from "../../types.js";
import {
  parsePiProviderInvocation,
  parsePiProviderProfile,
  piBuiltinToolNames,
  piReadOnlyToolNames,
  piRequiredCliFlags,
  piThinkingLevels,
} from "../contract.js";
import { toPiProviderInvocation } from "../provider.js";
import { buildPiArgs, createReadOnlyWorkspace, runPi } from "../runner.js";
import { piRuntimeReadToolNames } from "../runtime-tools.js";

describe("Pi contract", () => {
  it("tracks the Pi CLI contract pipr depends on", () => {
    expect(piThinkingLevels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(piBuiltinToolNames).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    expect(piReadOnlyToolNames).toEqual(["read", "grep", "find", "ls"]);
    expect(piRequiredCliFlags).toEqual([
      "--provider",
      "--model",
      "--mode",
      "--print",
      "--no-session",
      "--session-dir",
      "--tools",
      "--extension",
      "--no-context-files",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--thinking",
    ]);
  });

  it("accepts only Pi-native provider profile fields", () => {
    expect(
      parsePiProviderProfile({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "high",
      }),
    ).toMatchObject({ thinking: "high" });

    expect(() =>
      parsePiProviderProfile({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        options: { reasoning_effort: "high" },
      }),
    ).toThrow();
    expect(() =>
      parsePiProviderProfile({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "enabled",
      }),
    ).toThrow();
  });

  it("keeps Pi invocation read-only and schema-backed", () => {
    expect(
      parsePiProviderInvocation({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "high",
        tools: ["read", "grep", "find", "ls"],
      }),
    ).toMatchObject({ tools: ["read", "grep", "find", "ls"] });

    expect(() =>
      parsePiProviderInvocation({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "high",
        tools: ["read", "bash", "grep", "find", "ls"],
      }),
    ).toThrow();
  });
});

describe("buildPiArgs", () => {
  it("uses real Pi CLI flags with explicit read-only tools and without PR-controlled context", () => {
    const args = buildPiArgs(
      {
        id: "backup",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        thinking: "high",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
      "Review this diff.",
      "/tmp/pipr-session",
    );

    expect(args).toEqual([
      "--provider",
      "deepseek",
      "--model",
      "deepseek-v4-pro",
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--session-dir",
      "/tmp/pipr-session",
      "--tools",
      "read,grep,find,ls",
      "--no-context-files",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--thinking",
      "high",
      "Review this diff.",
    ]);
    expect(args).not.toContain("--no-tools");
    expect(args).not.toContain("--no-builtin-tools");
    expect(args).not.toContain("bash");
    expect(args).not.toContain("write");
    expect(args).not.toContain("edit");
  });

  it("uses Pi-native provider thinking levels", () => {
    expect(
      toPiProviderInvocation({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "xhigh",
      }).thinking,
    ).toBe("xhigh");
    expect(
      toPiProviderInvocation({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "off",
      }).thinking,
    ).toBe("off");
  });

  it("adds runtime-owned read tools through an explicit extension", () => {
    const args = buildPiArgs(
      {
        id: "backup",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        thinking: "high",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
      "Review this diff.",
      "/tmp/pipr-session",
      {
        extensionPath: "/tmp/runtime-tools-extension.mjs",
        dataPath: "/tmp/pipr-runtime-tools-data.json",
        toolNames: piRuntimeReadToolNames,
      },
    );

    expect(args).toContain("--no-extensions");
    expect(args).toContain("--extension");
    expect(args[args.indexOf("--extension") + 1]).toBe("/tmp/runtime-tools-extension.mjs");
    expect(args[args.indexOf("--tools") + 1]).toBe(
      "read,grep,find,ls,pipr_read_diff,pipr_read_at_ref",
    );
    expect(args[args.indexOf("--tools") + 1]).not.toContain("bash");
    expect(args[args.indexOf("--tools") + 1]).not.toContain("edit");
    expect(args[args.indexOf("--tools") + 1]).not.toContain("write");
  });

  it("drops symlinks from the read-only workspace copy", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-source-"));
    let copy: string | undefined;
    try {
      await writeFile(path.join(workspace, "target.txt"), "ok\n");
      await symlink(path.join(workspace, "target.txt"), path.join(workspace, "link.txt"));

      copy = await createReadOnlyWorkspace(workspace);

      await expect(lstat(path.join(copy, "link.txt"))).rejects.toThrow();
      await expect(lstat(path.join(copy, "target.txt"))).resolves.toBeDefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      if (copy) {
        await chmodTree(copy, 0o755);
        await rm(copy, { recursive: true, force: true });
      }
    }
  });

  it("does not leak unrelated parent env vars into Pi", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-source-"));
    const piExecutable = path.join(workspace, "fake-pi.sh");
    const previousProviderKey = process.env.DEEPSEEK_API_KEY;
    const previousSecret = process.env.SECRET_SHOULD_NOT_LEAK;
    try {
      await writeFile(piExecutable, "#!/bin/sh\nprintenv\n");
      await chmod(piExecutable, 0o755);
      process.env.DEEPSEEK_API_KEY = "provider-key";
      process.env.SECRET_SHOULD_NOT_LEAK = "hidden";

      const result = await runPi({
        workspace,
        piExecutable,
        prompt: "Review this diff.",
        provider: {
          id: "backup",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          thinking: "high",
          apiKeyEnv: "DEEPSEEK_API_KEY",
        },
      });

      expect(result.exitCode).toBe(0);
      const hostHome = os.homedir();
      expect(result.stdout).toContain("DEEPSEEK_API_KEY=provider-key");
      expect(result.stdout).toContain("HOME=");
      expect(result.stdout).toContain("PI_CODING_AGENT_DIR=");
      expect(result.stdout).toContain("PI_CODING_AGENT_SESSION_DIR=");
      expect(result.stdout).toContain("PIPR_PROVIDER_ID=backup");
      expect(result.stdout).not.toContain(`HOME=${hostHome}`);
      expect(result.stdout).not.toContain("PIPR_RUNTIME_TOOLS_DATA=");
      expect(result.stdout).not.toContain("SECRET_SHOULD_NOT_LEAK");
    } finally {
      restoreEnv("DEEPSEEK_API_KEY", previousProviderKey);
      restoreEnv("SECRET_SHOULD_NOT_LEAK", previousSecret);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("passes runtime tool data env only when condensed runtime tools are enabled", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-source-"));
    const piExecutable = path.join(workspace, "fake-pi.sh");
    try {
      await writeFile(piExecutable, "#!/bin/sh\nprintenv\nprintf 'ARGS=%s\\n' \"$*\"\n");
      await chmod(piExecutable, 0o755);

      const result = await runPi({
        workspace,
        piExecutable,
        prompt: "Review this diff.",
        env: {
          DEEPSEEK_API_KEY: "provided-key",
          PATH: process.env.PATH,
        },
        provider: {
          id: "deepseek",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          thinking: "high",
          apiKeyEnv: "DEEPSEEK_API_KEY",
        },
        runtimeTools: {
          manifest: emptyDiffManifest(),
          toolResponseMaxBytes: 10_000,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("PIPR_RUNTIME_TOOLS_DATA=");
      expect(result.stdout).toContain("runtime-tools/data.json");
      expect(result.stdout).toContain("--extension");
      expect(result.stdout).toMatch(/runtime-tools-extension\.(ts|mjs)/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("copies provider keys from the supplied source env", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-source-"));
    const piExecutable = path.join(workspace, "fake-pi.sh");
    const previousProviderKey = process.env.DEEPSEEK_API_KEY;
    try {
      await writeFile(piExecutable, "#!/bin/sh\nprintenv\n");
      await chmod(piExecutable, 0o755);
      delete process.env.DEEPSEEK_API_KEY;

      const result = await runPi({
        workspace,
        piExecutable,
        prompt: "Review this diff.",
        env: {
          DEEPSEEK_API_KEY: "provided-key",
          PATH: process.env.PATH,
        },
        provider: {
          id: "deepseek",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          thinking: "high",
          apiKeyEnv: "DEEPSEEK_API_KEY",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("DEEPSEEK_API_KEY=provided-key");
    } finally {
      restoreEnv("DEEPSEEK_API_KEY", previousProviderKey);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("times out long-running Pi subprocesses", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-source-"));
    const piExecutable = path.join(workspace, "slow-pi.sh");
    try {
      await writeFile(piExecutable, "#!/bin/sh\nsleep 2\nprintf '{}\\n'\n");
      await chmod(piExecutable, 0o755);

      const result = await runPi({
        workspace,
        piExecutable,
        prompt: "Review this diff.",
        timeoutSeconds: 1,
        provider: {
          id: "backup",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          thinking: "high",
          apiKeyEnv: "DEEPSEEK_API_KEY",
        },
      });

      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain("Pi timed out after 1s");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function emptyDiffManifest(): DiffManifest {
  return {
    baseSha: "base",
    headSha: "head",
    mergeBaseSha: "base",
    files: [],
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function chmodTree(target: string, mode: number): Promise<void> {
  await chmod(target, mode);
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    await chmod(entryPath, mode);
    if (entry.isDirectory()) {
      await chmodTree(entryPath, mode);
    }
  }
}
