import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    const repo = await createGitRepo();
    try {
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
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("excludes oversized changed-line spans", async () => {
    const repo = await createGitRepo();
    try {
      await writeFile(path.join(repo, "seed.txt"), "base\n");
      commitAll(repo, "base");
      const baseSha = git(repo, "rev-parse", "HEAD");

      const largeFile = Array.from(
        { length: 1200 },
        (_, index) => `line ${index} ${"x".repeat(2000)}`,
      ).join("\n");
      await writeFile(path.join(repo, "large.ts"), `${largeFile}\n`);
      commitAll(repo, "large file");
      const headSha = git(repo, "rev-parse", "HEAD");

      const manifest = buildDiffManifest({ cwd: repo, baseSha, headSha });
      const file = manifest.files.find((entry) => entry.path === "large.ts");

      expect(file?.excludedReason).toBe("oversized diff");
      expect(file?.additions).toBe(1200);
      expect(file?.deletions).toBe(0);
      expect(file?.commentableRanges).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("excludes binary diffs before parsing inline ranges", async () => {
    const repo = await createGitRepo();
    try {
      await writeFile(path.join(repo, "asset.bin"), Buffer.from([0, 1, 2, 3, 4]));
      commitAll(repo, "base");
      const baseSha = git(repo, "rev-parse", "HEAD");

      await writeFile(path.join(repo, "asset.bin"), Buffer.from([0, 1, 2, 9, 10]));
      commitAll(repo, "binary change");
      const headSha = git(repo, "rev-parse", "HEAD");

      const manifest = buildDiffManifest({ cwd: repo, baseSha, headSha });
      const file = manifest.files.find((entry) => entry.path === "asset.bin");

      expect(file?.excludedReason).toBe("binary diff");
      expect(file?.additions).toBe(0);
      expect(file?.deletions).toBe(0);
      expect(file?.commentableRanges).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("keeps additions and deletions for renamed files", async () => {
    const repo = await createGitRepo();
    try {
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src", "old.ts"), "line 1\nline 2\n");
      commitAll(repo, "base");
      const baseSha = git(repo, "rev-parse", "HEAD");

      await rm(path.join(repo, "src", "old.ts"), { force: true });
      await writeFile(path.join(repo, "src", "new.ts"), "line 1\nline 2\nline 3\n");
      commitAll(repo, "rename");
      const headSha = git(repo, "rev-parse", "HEAD");

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
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("pre-excludes oversized renamed files while preserving target stats", async () => {
    const repo = await createGitRepo();
    try {
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src", "old.ts"), makeNumberedLines("base", 3000));
      commitAll(repo, "base");
      const baseSha = git(repo, "rev-parse", "HEAD");

      await rm(path.join(repo, "src", "old.ts"), { force: true });
      await writeFile(path.join(repo, "src", "new.ts"), makePartiallyChangedLines(1200, 3000));
      commitAll(repo, "oversized rename");
      const headSha = git(repo, "rev-parse", "HEAD");

      const manifest = buildDiffManifest({ cwd: repo, baseSha, headSha });
      const file = manifest.files.find((entry) => entry.path === "src/new.ts");

      expect(file).toMatchObject({
        previousPath: "src/old.ts",
        status: "renamed",
        additions: 1200,
        deletions: 1200,
        excludedReason: "oversized diff",
      });
      expect(file?.commentableRanges).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

async function createGitRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "pipr-diff-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "pipr test");
  return repo;
}

function commitAll(repo: string, message: string): void {
  git(repo, "add", ".");
  git(repo, "commit", "-m", message);
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
