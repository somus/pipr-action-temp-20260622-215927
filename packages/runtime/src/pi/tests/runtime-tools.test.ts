import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { reviewTestManifest } from "../../review/tests/fixtures.js";
import type { DiffManifest } from "../../types.js";
import { preparePiRuntimeReadTools, readAtRef, readDiffFromManifest } from "../runtime-tools.js";

describe("pipr runtime Pi read tools", () => {
  it("reads bounded Diff Manifest data by path and range id", () => {
    const result = readDiffFromManifest(
      reviewTestManifest(),
      {
        path: "src/a.ts",
        rangeId: "range-1",
      },
      10_000,
    ) as { value: { files: DiffManifest["files"] } };

    expect(result.value.files).toHaveLength(1);
    expect(result.value.files[0]?.path).toBe("src/a.ts");
    expect(result.value.files[0]?.commentableRanges).toHaveLength(1);
    expect(result.value.files[0]?.commentableRanges[0]?.id).toBe("range-1");
  });

  it("rejects unknown tool paths and ranges", () => {
    expect(() =>
      readDiffFromManifest(reviewTestManifest(), { path: "src/missing.ts" }, 10_000),
    ).toThrow("is not in the Diff Manifest");
    expect(() =>
      readDiffFromManifest(reviewTestManifest(), { rangeId: "missing-range" }, 10_000),
    ).toThrow("Unknown Diff Manifest range");
  });

  it("caps Diff Manifest tool responses", () => {
    const result = readDiffFromManifest(reviewTestManifest(), {}, 12) as {
      truncated: boolean;
      maxBytes: number;
    };

    expect(result.truncated).toBe(true);
    expect(result.maxBytes).toBe(12);
  });

  it("reads head and base file content for manifest paths", async () => {
    const repo = await createGitRepo();
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);

      await expect(
        readAtRef({
          workspace: repo.root,
          manifest,
          path: "src/new.ts",
          ref: "base",
          rangeId: "range-left",
          maxBytes: 10_000,
        }),
      ).resolves.toMatchObject({
        path: "src/new.ts",
        ref: "base",
        rangeId: "range-left",
        sourcePath: "src/old.ts",
        content: "base content\n",
        truncated: false,
      });
      await expect(
        readAtRef({
          workspace: repo.root,
          manifest,
          path: "src/new.ts",
          ref: "head",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).resolves.toMatchObject({
        path: "src/new.ts",
        ref: "head",
        rangeId: "range-1",
        sourcePath: "src/new.ts",
        content: "head content\n",
        truncated: false,
      });
    } finally {
      await rm(repo.root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe paths, bad refs, and symlinks", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-runtime-tools-"));
    try {
      await writeFile(path.join(workspace, "target.ts"), "target\n");
      await symlink(path.join(workspace, "target.ts"), path.join(workspace, "link.ts"));
      const manifest = manifestForPath("link.ts");

      await expect(
        readAtRef({
          workspace,
          manifest,
          path: "../target.ts",
          ref: "head",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("Unsafe manifest path");
      await expect(
        readAtRef({
          workspace,
          manifest: manifestForPath(".git/config"),
          path: ".git/config",
          ref: "head",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("Unsafe manifest path");
      await expect(
        readAtRef({
          workspace,
          manifest: manifestWithPreviousPath("safe.ts", "../old.ts"),
          path: "safe.ts",
          ref: "base",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("Unsafe manifest path");
      await expect(
        readAtRef({
          workspace,
          manifest,
          path: "link.ts",
          ref: "head",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("crosses a symlink");
      await expect(
        readAtRef({
          workspace,
          manifest,
          path: "link.ts",
          ref: "main" as never,
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("Unsupported ref");
      await expect(
        readAtRef({
          workspace,
          manifest,
          path: "link.ts",
          ref: "head",
          rangeId: "missing-range",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("Unknown Diff Manifest range");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("caps head and base file reads by range", async () => {
    const repo = await createGitRepo({
      baseContent: `${"base ".repeat(20)}\n`,
      headContent: `${"head ".repeat(20)}\n`,
    });
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);

      await expect(
        readAtRef({
          workspace: repo.root,
          manifest,
          path: "src/new.ts",
          ref: "base",
          rangeId: "range-left",
          maxBytes: 10,
        }),
      ).resolves.toMatchObject({
        content: "base base ",
        bytes: 101,
        truncated: true,
      });
      await expect(
        readAtRef({
          workspace: repo.root,
          manifest,
          path: "src/new.ts",
          ref: "head",
          rangeId: "range-1",
          maxBytes: 10,
        }),
      ).resolves.toMatchObject({
        content: "head head ",
        bytes: 101,
        truncated: true,
      });
    } finally {
      await rm(repo.root, { recursive: true, force: true });
    }
  });

  it("generates runtime extension tools with range-scoped base truncation metadata", async () => {
    const repo = await createGitRepo({
      baseContent: `${"base ".repeat(20)}\n`,
      headContent: `${"head ".repeat(20)}\n`,
    });
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-runtime-tools-extension-"));
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);
      const prepared = await preparePiRuntimeReadTools({
        root: toolRoot,
        sourceWorkspace: repo.root,
        request: { manifest, toolResponseMaxBytes: 10 },
      });
      const atRefTool = await loadExtensionTool(prepared.extensionPath, "pipr_read_at_ref");

      const result = await executeExtensionTool(atRefTool, repo.root, {
        path: "src/new.ts",
        ref: "base",
        rangeId: "range-left",
      });

      expect(result).toMatchObject({
        path: "src/new.ts",
        ref: "base",
        rangeId: "range-left",
        content: "base base ",
        bytes: 101,
        truncated: true,
      });
    } finally {
      await rm(repo.root, { recursive: true, force: true });
      await rm(toolRoot, { recursive: true, force: true });
    }
  });

  it("keeps typed helpers and generated extension tools in parity", async () => {
    const repo = await createGitRepo();
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-runtime-tools-parity-"));
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);
      const prepared = await preparePiRuntimeReadTools({
        root: toolRoot,
        sourceWorkspace: repo.root,
        request: { manifest, toolResponseMaxBytes: 10_000 },
      });
      const diffTool = await loadExtensionTool(prepared.extensionPath, "pipr_read_diff");
      const atRefTool = await loadExtensionTool(prepared.extensionPath, "pipr_read_at_ref");

      const diffParams = { path: "src/new.ts", rangeId: "range-1" };
      expect(await executeExtensionTool(diffTool, repo.root, diffParams)).toEqual(
        readDiffFromManifest(manifest, diffParams, 10_000),
      );

      const atRefParams = { path: "src/new.ts", ref: "head" as const, rangeId: "range-1" };
      expect(await executeExtensionTool(atRefTool, repo.root, atRefParams)).toEqual(
        await readAtRef({
          workspace: repo.root,
          manifest,
          ...atRefParams,
          maxBytes: 10_000,
        }),
      );

      expect(() => readDiffFromManifest(manifest, { path: "src/missing.ts" }, 10_000)).toThrow(
        "is not in the Diff Manifest",
      );
      await expect(
        executeExtensionTool(diffTool, repo.root, { path: "src/missing.ts" }),
      ).rejects.toThrow("is not in the Diff Manifest");
    } finally {
      await rm(repo.root, { recursive: true, force: true });
      await rm(toolRoot, { recursive: true, force: true });
    }
  });

  it("returns unavailable instead of widening opposite-side reads to the whole hunk", async () => {
    const repo = await createGitRepo();
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);

      await expect(
        readAtRef({
          workspace: repo.root,
          manifest,
          path: "src/new.ts",
          ref: "base",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).resolves.toMatchObject({
        path: "src/new.ts",
        ref: "base",
        rangeId: "range-1",
        available: false,
      });
    } finally {
      await rm(repo.root, { recursive: true, force: true });
    }
  });

  it("reads base slices from merge base, not advanced base tip", async () => {
    const repo = await createAdvancedBaseRepo();
    try {
      const manifest = {
        ...manifestForPath("src/a.ts"),
        baseSha: repo.baseSha,
        headSha: repo.headSha,
        mergeBaseSha: repo.mergeBaseSha,
      };

      await expect(
        readAtRef({
          workspace: repo.root,
          manifest,
          path: "src/a.ts",
          ref: "base",
          rangeId: "range-left",
          maxBytes: 10_000,
        }),
      ).resolves.toMatchObject({
        content: "merge-base content\n",
        sourcePath: "src/a.ts",
      });
    } finally {
      await rm(repo.root, { recursive: true, force: true });
    }
  });
});

async function createGitRepo(
  options: { baseContent?: string; headContent?: string } = {},
): Promise<{ root: string; baseSha: string; headSha: string }> {
  const root = await initTestGitRepo("pipr-runtime-tools-git-");
  await writeFile(path.join(root, "src", "old.ts"), options.baseContent ?? "base content\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "base"]);
  const baseSha = runGit(root, ["rev-parse", "HEAD"]).trim();
  runGit(root, ["mv", "src/old.ts", "src/new.ts"]);
  await writeFile(path.join(root, "src", "new.ts"), options.headContent ?? "head content\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "head"]);
  const headSha = runGit(root, ["rev-parse", "HEAD"]).trim();
  return { root, baseSha, headSha };
}

function renamedManifest(baseSha: string, headSha: string): DiffManifest {
  const file = manifestForPath("src/new.ts").files[0];
  if (!file) {
    throw new Error("missing test manifest file");
  }
  return {
    ...manifestForPath("src/new.ts"),
    baseSha,
    headSha,
    mergeBaseSha: baseSha,
    files: [
      {
        ...file,
        previousPath: "src/old.ts",
        status: "renamed",
      },
    ],
  };
}

function manifestForPath(filePath: string): DiffManifest {
  const hunkHeader = "@@ -1 +1 @@";
  const hunkContentHash = "abcdefabcdef";
  return {
    baseSha: "base",
    headSha: "head",
    mergeBaseSha: "base",
    files: [
      {
        path: filePath,
        status: "modified",
        additions: 1,
        deletions: 1,
        hunks: [
          {
            hunkIndex: 1,
            header: hunkHeader,
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            contentHash: hunkContentHash,
          },
        ],
        commentableRanges: [
          {
            id: "range-left",
            path: filePath,
            side: "LEFT",
            startLine: 1,
            endLine: 1,
            kind: "deleted",
            hunkIndex: 1,
            hunkHeader,
            hunkContentHash,
          },
          {
            id: "range-1",
            path: filePath,
            side: "RIGHT",
            startLine: 1,
            endLine: 1,
            kind: "mixed",
            hunkIndex: 1,
            hunkHeader,
            hunkContentHash,
          },
        ],
      },
    ],
  };
}

function manifestWithPreviousPath(filePath: string, previousPath: string): DiffManifest {
  const file = manifestForPath(filePath).files[0];
  if (!file) {
    throw new Error("missing test manifest file");
  }
  return {
    ...manifestForPath(filePath),
    files: [{ ...file, previousPath }],
  };
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function initTestGitRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.name", "pipr test"]);
  runGit(root, ["config", "user.email", "pipr@example.test"]);
  runGit(root, ["config", "commit.gpgsign", "false"]);
  await mkdir(path.join(root, "src"));
  return root;
}

async function createAdvancedBaseRepo(): Promise<{
  root: string;
  mergeBaseSha: string;
  baseSha: string;
  headSha: string;
}> {
  const root = await initTestGitRepo("pipr-runtime-tools-advanced-base-");
  await writeFile(path.join(root, "src", "a.ts"), "merge-base content\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "merge base"]);
  const mergeBaseSha = runGit(root, ["rev-parse", "HEAD"]).trim();
  await writeFile(path.join(root, "src", "a.ts"), "advanced base content\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "advanced base"]);
  const baseSha = runGit(root, ["rev-parse", "HEAD"]).trim();
  runGit(root, ["checkout", "-b", "feature", mergeBaseSha]);
  await writeFile(path.join(root, "src", "a.ts"), "head content\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "head"]);
  const headSha = runGit(root, ["rev-parse", "HEAD"]).trim();
  return { root, mergeBaseSha, baseSha, headSha };
}

async function loadExtensionTool(
  extensionPath: string,
  toolName: string,
): Promise<{
  execute: (...args: unknown[]) => Promise<{ details?: unknown; content: Array<{ text: string }> }>;
}> {
  const tools = new Map<string, unknown>();
  const extension = await import(pathToFileURL(extensionPath).href);
  await extension.default({
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
  });
  const tool = tools.get(toolName);
  if (!tool || typeof tool !== "object" || !("execute" in tool)) {
    throw new Error(`missing extension tool ${toolName}`);
  }
  return tool as {
    execute: (
      ...args: unknown[]
    ) => Promise<{ details?: unknown; content: Array<{ text: string }> }>;
  };
}

async function executeExtensionTool(
  tool: {
    execute: (
      ...args: unknown[]
    ) => Promise<{ details?: unknown; content: Array<{ text: string }> }>;
  },
  cwd: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const result = await tool.execute("test", params, undefined, undefined, { cwd });
  return result.details ?? JSON.parse(result.content[0]?.text ?? "{}");
}
