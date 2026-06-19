import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initOfficialMinimalProject } from "../../config/init.js";
import { runGit } from "../../diff/git.js";
import { loadRuntimeProjectFromGitCommit } from "../git-project.js";

describe("loadRuntimeProjectFromGitCommit", () => {
  it("loads config files whose git paths contain tabs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-git-project-"));
    await initGitRepo(rootDir);
    await initOfficialMinimalProject({ rootDir });
    await writeFile(
      path.join(rootDir, ".pipr", "agents", "reviewer\tcopy.md"),
      [
        "---",
        "apiVersion: pipr.dev/v1",
        "kind: Agent",
        "id: pipr/reviewer-copy",
        "provider: deepseek",
        "output:",
        "  schema: core/pr-review",
        "---",
        "",
        "Review copy.",
      ].join("\n"),
    );
    runGit(["add", "."], rootDir);
    runGit(["commit", "--no-verify", "-m", "base"], rootDir);
    const baseSha = runGit(["rev-parse", "HEAD"], rootDir).trim();

    const runtime = await loadRuntimeProjectFromGitCommit({
      rootDir,
      commitSha: baseSha,
    });

    expect(runtime.project.componentFiles["pipr/reviewer-copy"]?.source).toContain(
      "reviewer\tcopy.md",
    );
  });

  it("fails clearly when the base commit does not contain pipr config", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-git-project-"));
    await initGitRepo(rootDir);
    await writeFile(path.join(rootDir, "README.md"), "# empty\n");
    runGit(["add", "."], rootDir);
    runGit(["commit", "--no-verify", "-m", "base"], rootDir);
    const baseSha = runGit(["rev-parse", "HEAD"], rootDir).trim();

    await expect(
      loadRuntimeProjectFromGitCommit({
        rootDir,
        commitSha: baseSha,
      }),
    ).rejects.toThrow(".pipr/config.yaml is required at base commit");
  });
});

async function initGitRepo(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  runGit(["init", "--initial-branch=main"], rootDir);
  runGit(["config", "user.name", "pipr test"], rootDir);
  runGit(["config", "user.email", "pipr@example.test"], rootDir);
  runGit(["config", "core.hooksPath", "/dev/null"], rootDir);
  runGit(["config", "commit.gpgsign", "false"], rootDir);
}
