import { chmod, lstat, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPiArgs, createReadOnlyWorkspace, runPi } from "../src/pi.js";

describe("buildPiArgs", () => {
  it("uses real Pi CLI flags without PR-controlled context or tools", () => {
    const args = buildPiArgs(
      {
        id: "deepseek",
        model: "deepseek-v4-pro",
        thinking: "enabled",
        reasoning_effort: "high",
        api_key_env: "DEEPSEEK_API_KEY",
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
      "--no-context-files",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-tools",
      "--thinking",
      "high",
      "Review this diff.",
    ]);
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
          id: "deepseek",
          model: "deepseek-v4-pro",
          thinking: "enabled",
          reasoning_effort: "high",
          api_key_env: "DEEPSEEK_API_KEY",
        },
      });

      expect(result.exitCode).toBe(0);
      const hostHome = os.homedir();
      expect(result.stdout).toContain("DEEPSEEK_API_KEY=provider-key");
      expect(result.stdout).toContain("HOME=");
      expect(result.stdout).toContain("PI_CODING_AGENT_DIR=");
      expect(result.stdout).toContain("PI_CODING_AGENT_SESSION_DIR=");
      expect(result.stdout).toContain("PIPR_PROVIDER_ID=deepseek");
      expect(result.stdout).not.toContain(`HOME=${hostHome}`);
      expect(result.stdout).not.toContain("SECRET_SHOULD_NOT_LEAK");
    } finally {
      restoreEnv("DEEPSEEK_API_KEY", previousProviderKey);
      restoreEnv("SECRET_SHOULD_NOT_LEAK", previousSecret);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

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
