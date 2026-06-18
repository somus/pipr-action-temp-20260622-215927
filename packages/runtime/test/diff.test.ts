import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { buildDiffManifest, parseNameStatus, parseUnifiedDiff } from "../src/diff.js";

describe("diff manifest parsing", () => {
  it("parses name-status output", () => {
    expect(parseNameStatus("A\tsrc/a.ts\nM\tsrc/b.ts\nR100\told.ts\tnew.ts\n")).toMatchObject([
      { path: "src/a.ts", status: "added" },
      { path: "src/b.ts", status: "modified" },
      { path: "new.ts", previousPath: "old.ts", status: "renamed" },
    ]);
  });

  it("creates same-side contiguous commentable ranges", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1;",
      "+const b = 2;",
      "+const c = 3;",
      "-const old = 4;",
    ].join("\n");

    const ranges = parseUnifiedDiff(diff).get("src/a.ts");

    expect(ranges).toHaveLength(2);
    expect(ranges?.[0]).toMatchObject({ side: "RIGHT", startLine: 2, endLine: 3 });
    expect(ranges?.[1]).toMatchObject({ side: "LEFT", startLine: 2, endLine: 2 });
  });

  it("uses the merge base when the base branch has advanced", async () => {
    await withGitRepo(async (repo) => {
      await writeFile(path.join(repo, "shared.txt"), "base\n");
      commitAll(repo, "base");
      const mergeBaseSha = git(repo, "rev-parse", "HEAD");

      git(repo, "checkout", "-b", "feature");
      await writeFile(path.join(repo, "feature.txt"), "feature\n");
      commitAll(repo, "feature");
      const headSha = git(repo, "rev-parse", "HEAD");

      git(repo, "checkout", "main");
      await writeFile(path.join(repo, "base-only.txt"), "base only\n");
      commitAll(repo, "base advance");
      const baseSha = git(repo, "rev-parse", "HEAD");

      const manifest = buildDiffManifest({ cwd: repo, baseSha, headSha });

      expect(manifest.mergeBaseSha).toBe(mergeBaseSha);
      expect(manifest.files).toMatchObject([
        {
          path: "feature.txt",
          additions: 1,
          deletions: 0,
        },
      ]);
    });
  });

  it("excludes oversized changed-line spans", async () => {
    await withGitRepo(async (repo) => {
      const baseSha = await commitFile(repo, "seed.txt", "base\n", "base");
      const largeFile = Array.from(
        { length: 1200 },
        (_, index) => `line ${index} ${"x".repeat(2000)}`,
      ).join("\n");
      const headSha = await commitFile(repo, "large.ts", `${largeFile}\n`, "large file");
      const file = changedFile(buildDiffManifest({ cwd: repo, baseSha, headSha }), "large.ts");

      expect(file?.excludedReason).toBe("oversized diff");
      expect(file?.additions).toBe(1200);
      expect(file?.deletions).toBe(0);
      expect(file?.commentableRanges).toEqual([]);
    });
  });

  it("excludes binary diffs before parsing inline ranges", async () => {
    await withGitRepo(async (repo) => {
      const baseSha = await commitFile(repo, "asset.bin", Buffer.from([0, 1, 2, 3, 4]), "base");
      const headSha = await commitFile(
        repo,
        "asset.bin",
        Buffer.from([0, 1, 2, 9, 10]),
        "binary change",
      );
      const file = changedFile(buildDiffManifest({ cwd: repo, baseSha, headSha }), "asset.bin");

      expect(file?.excludedReason).toBe("binary diff");
      expect(file?.additions).toBe(0);
      expect(file?.deletions).toBe(0);
      expect(file?.commentableRanges).toEqual([]);
    });
  });

  it("keeps additions and deletions for renamed files", async () => {
    await withGitRepo(async (repo) => {
      const baseSha = await commitFile(repo, "src/old.ts", "line 1\nline 2\n", "base");

      await rm(path.join(repo, "src", "old.ts"), { force: true });
      const headSha = await commitFile(repo, "src/new.ts", "line 1\nline 2\nline 3\n", "rename");

      const manifest = buildDiffManifest({ cwd: repo, baseSha, headSha });

      expect(manifest.files).toMatchObject([
        {
          path: "src/new.ts",
          previousPath: "src/old.ts",
          status: "renamed",
          additions: 1,
          deletions: 0,
        },
      ]);
    });
  });

  it("pre-excludes oversized renamed files while preserving target stats", async () => {
    await withGitRepo(async (repo) => {
      const baseSha = await commitFile(repo, "src/old.ts", makeNumberedLines("base", 3000), "base");

      await rm(path.join(repo, "src", "old.ts"), { force: true });
      const headSha = await commitFile(
        repo,
        "src/new.ts",
        makePartiallyChangedLines(1200, 3000),
        "oversized rename",
      );

      const file = changedFile(buildDiffManifest({ cwd: repo, baseSha, headSha }), "src/new.ts");

      expect(file).toMatchObject({
        previousPath: "src/old.ts",
        status: "renamed",
        additions: 1200,
        deletions: 1200,
        excludedReason: "oversized diff",
      });
      expect(file?.commentableRanges).toEqual([]);
    });
  });
});

async function withGitRepo<T>(run: (repo: string) => Promise<T>): Promise<T> {
  const repo = await createGitRepo();
  try {
    return await run(repo);
  } finally {
    await removeTempRepo(repo);
  }
}

async function removeTempRepo(repo: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(repo, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableRmError(error) || attempt === 4) {
        throw error;
      }
      await delay(50);
    }
  }
}

function isRetryableRmError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOTEMPTY";
}

async function createGitRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "pipr-diff-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.hooksPath", "/dev/null");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "pipr test");
  return repo;
}

function commitAll(repo: string, message: string): void {
  git(repo, "add", ".");
  git(repo, "commit", "--no-verify", "-m", message);
}

async function commitFile(
  repo: string,
  filePath: string,
  contents: string | Buffer,
  message: string,
): Promise<string> {
  const target = path.join(repo, filePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
  commitAll(repo, message);
  return git(repo, "rev-parse", "HEAD");
}

function changedFile(manifest: ReturnType<typeof buildDiffManifest>, filePath: string) {
  return manifest.files.find((entry) => entry.path === filePath);
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function makeNumberedLines(prefix: string, count: number): string {
  return `${Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join("\n")}\n`;
}

function makePartiallyChangedLines(changedCount: number, totalCount: number): string {
  return `${Array.from({ length: totalCount }, (_, index) =>
    index < changedCount ? `changed ${index}` : `base ${index}`,
  ).join("\n")}\n`;
}
