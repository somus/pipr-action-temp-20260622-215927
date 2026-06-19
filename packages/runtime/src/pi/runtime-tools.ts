import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommentableRange, DiffHunk, DiffManifest, DiffManifestFile } from "../types.js";

export const piRuntimeReadToolNames = ["pipr_read_diff", "pipr_read_at_ref"] as const;

const readAtRefContextLines = 3;

export type PiRuntimeReadToolName = (typeof piRuntimeReadToolNames)[number];

export type PiRuntimeReadToolRequest = {
  manifest: DiffManifest;
  toolResponseMaxBytes: number;
};

export type PreparedPiRuntimeReadTools = {
  extensionPath: string;
  toolNames: readonly PiRuntimeReadToolName[];
};

export type ReadDiffParams = {
  path?: string;
  rangeId?: string;
};

type ReadAtRefParams = {
  path: string;
  ref: "base" | "head";
  rangeId: string;
};

type RuntimeToolData = {
  manifest: DiffManifest;
  toolResponseMaxBytes: number;
  baseRanges: Record<string, BaseRangeSnapshot>;
};

type BaseRangeSnapshot = {
  path: string;
  ref: "base" | "head";
  sourcePath: string;
  rangeId: string;
  startLine: number;
  endLine: number;
  available: boolean;
  relativePath?: string;
  bytes?: number;
  truncated?: boolean;
};

export async function preparePiRuntimeReadTools(options: {
  root: string;
  sourceWorkspace: string;
  request: PiRuntimeReadToolRequest;
}): Promise<PreparedPiRuntimeReadTools> {
  const toolRoot = path.join(options.root, "runtime-tools");
  const baseRoot = path.join(toolRoot, "base");
  await mkdir(baseRoot, { recursive: true });
  const baseRanges = await materializeBaseRangeSnapshots({
    baseRoot,
    manifest: options.request.manifest,
    sourceWorkspace: options.sourceWorkspace,
    maxBytes: options.request.toolResponseMaxBytes,
  });
  const data: RuntimeToolData = {
    manifest: options.request.manifest,
    toolResponseMaxBytes: options.request.toolResponseMaxBytes,
    baseRanges,
  };
  const dataPath = path.join(toolRoot, "data.json");
  const extensionPath = path.join(toolRoot, "pipr-runtime-tools.mjs");
  await writeFile(dataPath, JSON.stringify(data), "utf8");
  await writeFile(extensionPath, runtimeToolsExtensionSource(), "utf8");
  await chmod(extensionPath, 0o555);
  return { extensionPath, toolNames: piRuntimeReadToolNames };
}

export function readDiffFromManifest(
  manifest: DiffManifest,
  params: ReadDiffParams,
  maxBytes: number,
): unknown {
  const { path: filePath, rangeId } = params;
  if (filePath !== undefined) {
    assertSafeManifestPath(filePath);
    assertKnownManifestPath(manifest, filePath);
  }
  if (rangeId !== undefined && !findRange(manifest, rangeId)) {
    throw new Error(`Unknown Diff Manifest range '${rangeId}'`);
  }
  const files = manifest.files
    .filter((file) => filePath === undefined || file.path === filePath)
    .map((file) => filterManifestFileRanges(file, rangeId))
    .filter((file) => rangeId === undefined || file.commentableRanges.length > 0);
  return boundedJson({ files }, maxBytes);
}

export async function readAtRef(options: {
  workspace: string;
  manifest: DiffManifest;
  path: string;
  ref: "base" | "head";
  rangeId: string;
  maxBytes: number;
}): Promise<unknown> {
  const request = resolveReadAtRefRequest(options.manifest, {
    path: options.path,
    ref: options.ref,
    rangeId: options.rangeId,
  });
  if (!request.window) {
    return unavailableReadAtRefResult(request);
  }
  const content =
    options.ref === "base"
      ? readGitBlobSlice({
          cwd: options.workspace,
          ref: options.manifest.mergeBaseSha,
          filePath: request.sourcePath,
          window: request.window,
          maxBytes: options.maxBytes,
        })
      : await readWorkspaceFileSlice({
          workspace: options.workspace,
          filePath: request.sourcePath,
          window: request.window,
          maxBytes: options.maxBytes,
        });
  return {
    path: options.path,
    ref: options.ref,
    sourcePath: request.sourcePath,
    rangeId: options.rangeId,
    startLine: request.window.startLine,
    endLine: request.window.endLine,
    ...content,
  };
}

function filterManifestFileRanges(
  file: DiffManifestFile,
  rangeId: string | undefined,
): DiffManifestFile {
  if (rangeId === undefined) {
    return file;
  }
  return {
    ...file,
    commentableRanges: file.commentableRanges.filter((range) => range.id === rangeId),
  };
}

function boundedJson(value: unknown, maxBytes: number): unknown {
  const text = JSON.stringify(value, null, 2);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return { truncated: false, bytes, value };
  }
  return {
    truncated: true,
    bytes,
    maxBytes,
    text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"),
  };
}

type ReadAtRefRequest = {
  file: DiffManifestFile;
  range: CommentableRange;
  hunk: DiffHunk;
  ref: "base" | "head";
  sourcePath: string;
  window: LineWindow | undefined;
};

type LineWindow = {
  startLine: number;
  endLine: number;
};

async function materializeBaseRangeSnapshots(options: {
  baseRoot: string;
  manifest: DiffManifest;
  sourceWorkspace: string;
  maxBytes: number;
}): Promise<Record<string, BaseRangeSnapshot>> {
  const ranges: Record<string, BaseRangeSnapshot> = {};
  for (const [index, file] of options.manifest.files.entries()) {
    if (!isSafeManifestPath(file.path)) {
      continue;
    }
    for (const [rangeIndex, range] of file.commentableRanges.entries()) {
      const request = resolveReadAtRefRequest(options.manifest, {
        path: file.path,
        ref: "base",
        rangeId: range.id,
      });
      if (!request.window) {
        ranges[range.id] = unavailableReadAtRefResult(request);
        continue;
      }
      const blob = readGitBlobSlice({
        cwd: options.sourceWorkspace,
        ref: options.manifest.mergeBaseSha,
        filePath: request.sourcePath,
        window: request.window,
        maxBytes: options.maxBytes,
        allowMissing: true,
      });
      if (!blob.available || blob.content === undefined) {
        ranges[range.id] = unavailableReadAtRefResult(request);
        continue;
      }
      const snapshotName = `${index}-${rangeIndex}.txt`;
      await writeFile(path.join(options.baseRoot, snapshotName), blob.content, "utf8");
      ranges[range.id] = {
        path: file.path,
        ref: "base",
        sourcePath: request.sourcePath,
        rangeId: range.id,
        startLine: request.window.startLine,
        endLine: request.window.endLine,
        available: true,
        relativePath: path.join("base", snapshotName),
        bytes: blob.bytes,
        truncated: blob.truncated,
      };
    }
  }
  return ranges;
}

function readGitBlobSlice(options: {
  cwd: string;
  ref: string;
  filePath: string;
  window: LineWindow;
  maxBytes: number;
  allowMissing?: boolean;
}): { available: boolean; content?: string; bytes?: number; truncated?: boolean } {
  const result = spawnSync("git", ["show", `${options.ref}:${options.filePath}`], {
    cwd: options.cwd,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (isMaxBufferError(result.error)) {
    return { available: false };
  }
  if (result.status !== 0) {
    if (options.allowMissing) {
      return { available: false };
    }
    throw new Error(`Unable to read '${options.filePath}' at ${options.ref}`);
  }
  return boundedLineSlice(result.stdout.toString("utf8"), options.window, options.maxBytes);
}

function isMaxBufferError(error: Error | undefined): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOBUFS";
}

async function readWorkspaceFileSlice(options: {
  workspace: string;
  filePath: string;
  window: LineWindow;
  maxBytes: number;
}): Promise<{ available: boolean; content?: string; bytes?: number; truncated?: boolean }> {
  const resolved = resolveAllowedPath(options.workspace, options.filePath);
  await assertNoSymlinkPath(options.workspace, options.filePath);
  const content = await readFile(resolved, "utf8");
  return boundedLineSlice(content, options.window, options.maxBytes);
}

function boundedLineSlice(
  content: string,
  window: LineWindow,
  maxBytes: number,
): { available: true; content: string; bytes: number; truncated: boolean } {
  const lines = splitLinesWithEndings(content);
  const slice = lines.slice(window.startLine - 1, window.endLine).join("");
  const buffer = Buffer.from(slice, "utf8");
  return {
    available: true,
    content: buffer.subarray(0, maxBytes).toString("utf8"),
    bytes: buffer.byteLength,
    truncated: buffer.byteLength > maxBytes,
  };
}

function splitLinesWithEndings(content: string): string[] {
  const lines = content.match(/[^\n]*(?:\n|$)/g) ?? [];
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function resolveReadAtRefRequest(
  manifest: DiffManifest,
  params: ReadAtRefParams,
): ReadAtRefRequest {
  if (params.ref !== "base" && params.ref !== "head") {
    throw new Error(`Unsupported ref '${String(params.ref)}'`);
  }
  assertSafeManifestPath(params.path);
  const file = assertKnownManifestPath(manifest, params.path);
  const range = assertKnownRange(manifest, file, params.rangeId);
  const hunk = assertKnownHunk(file, range);
  const sourcePath = params.ref === "base" ? (file.previousPath ?? file.path) : file.path;
  assertSafeManifestPath(sourcePath);
  return {
    file,
    range,
    hunk,
    ref: params.ref,
    sourcePath,
    window: lineWindowForRange(range, hunk, params.ref),
  };
}

function lineWindowForRange(
  range: CommentableRange,
  hunk: DiffHunk,
  ref: "base" | "head",
): LineWindow | undefined {
  const targetSide = ref === "base" ? "LEFT" : "RIGHT";
  if (range.side !== targetSide) {
    return undefined;
  }
  const hunkStart = ref === "base" ? hunk.oldStart : hunk.newStart;
  const hunkLines = ref === "base" ? hunk.oldLines : hunk.newLines;
  if (hunkLines === 0) {
    return undefined;
  }
  const hunkEnd = hunkStart + hunkLines - 1;
  return {
    startLine: Math.max(hunkStart, range.startLine - readAtRefContextLines),
    endLine: Math.min(hunkEnd, range.endLine + readAtRefContextLines),
  };
}

function unavailableReadAtRefResult(request: ReadAtRefRequest): BaseRangeSnapshot {
  return {
    path: request.file.path,
    ref: request.ref,
    sourcePath: request.sourcePath,
    rangeId: request.range.id,
    startLine: 0,
    endLine: 0,
    available: false,
  };
}

function assertKnownManifestPath(manifest: DiffManifest, filePath: string): DiffManifestFile {
  const file = manifest.files.find((item) => item.path === filePath);
  if (!file) {
    throw new Error(`Path '${filePath}' is not in the Diff Manifest`);
  }
  return file;
}

function assertKnownRange(
  manifest: DiffManifest,
  file: DiffManifestFile,
  rangeId: string,
): CommentableRange {
  const range = file.commentableRanges.find((item) => item.id === rangeId);
  if (range) {
    return range;
  }
  if (findRange(manifest, rangeId)) {
    throw new Error(`Diff Manifest range '${rangeId}' is not in path '${file.path}'`);
  }
  throw new Error(`Unknown Diff Manifest range '${rangeId}'`);
}

function assertKnownHunk(file: DiffManifestFile, range: CommentableRange): DiffHunk {
  const hunk = file.hunks.find(
    (item) => item.hunkIndex === range.hunkIndex && item.contentHash === range.hunkContentHash,
  );
  if (!hunk) {
    throw new Error(`Diff Manifest range '${range.id}' has no matching hunk`);
  }
  return hunk;
}

function findRange(manifest: DiffManifest, rangeId: string): boolean {
  return manifest.files.some((file) =>
    file.commentableRanges.some((range) => range.id === rangeId),
  );
}

function assertSafeManifestPath(filePath: string): void {
  if (!isSafeManifestPath(filePath)) {
    throw new Error(`Unsafe manifest path '${filePath}'`);
  }
}

function isSafeManifestPath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    !filePath.includes("\0") &&
    !path.isAbsolute(filePath) &&
    !filePath.split(/[\\/]/).some((part) => part === ".." || part === ".git" || part === "")
  );
}

function resolveAllowedPath(root: string, filePath: string): string {
  const resolved = path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path '${filePath}' resolves outside the workspace`);
  }
  return resolved;
}

async function assertNoSymlinkPath(root: string, filePath: string): Promise<void> {
  const parts = filePath.split(/[\\/]/);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`Path '${filePath}' crosses a symlink`);
    }
  }
}

function runtimeToolsExtensionSource(): string {
  return String.raw`
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(await readFile(path.join(root, "data.json"), "utf8"));

export default function piprRuntimeTools(pi) {
  pi.registerTool({
    name: "pipr_read_diff",
    label: "Read pipr Diff Manifest",
    description: "Read bounded full Diff Manifest data by path and/or range id.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        rangeId: { type: "string" },
      },
    },
    async execute(_toolCallId, params) {
      const result = readDiff(params ?? {});
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "pipr_read_at_ref",
    label: "Read pipr file at ref",
    description: "Read bounded file content for a Diff Manifest path at base or head.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "ref", "rangeId"],
      properties: {
        path: { type: "string" },
        ref: { type: "string", enum: ["base", "head"] },
        rangeId: { type: "string" },
      },
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await readAtRef(params, ctx.cwd);
      return textResult(result);
    },
  });
}

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function readDiff(params) {
  const requestedPath = params.path;
  const rangeId = params.rangeId;
  if (requestedPath !== undefined) {
    assertSafePath(requestedPath);
    assertKnownPath(requestedPath);
  }
  if (rangeId !== undefined && !findRange(rangeId)) {
    throw new Error("Unknown Diff Manifest range '" + rangeId + "'");
  }
  const files = data.manifest.files
    .filter((file) => requestedPath === undefined || file.path === requestedPath)
    .map((file) => rangeId === undefined ? file : {
      ...file,
      commentableRanges: file.commentableRanges.filter((range) => range.id === rangeId),
    })
    .filter((file) => rangeId === undefined || file.commentableRanges.length > 0);
  return boundedJson({ files });
}

async function readAtRef(params, cwd) {
  const request = resolveReadAtRefRequest(params);
  if (!request.window) {
    return unavailableReadAtRefResult(request);
  }
  if (params.ref === "base") {
    const snapshot = data.baseRanges[params.rangeId];
    if (!snapshot) {
      return unavailableReadAtRefResult(request);
    }
    if (!snapshot.available) {
      return snapshot;
    }
    const content = await readFile(path.join(root, snapshot.relativePath));
    return {
      path: params.path,
      ref: params.ref,
      sourcePath: request.sourcePath,
      rangeId: params.rangeId,
      startLine: snapshot.startLine,
      endLine: snapshot.endLine,
      available: true,
      content: content.toString("utf8"),
      bytes: snapshot.bytes,
      truncated: snapshot.truncated,
    };
  }
  const target = resolveAllowedPath(cwd, request.sourcePath);
  await assertNoSymlinkPath(cwd, request.sourcePath);
  return {
    path: params.path,
    ref: params.ref,
    sourcePath: request.sourcePath,
    rangeId: params.rangeId,
    startLine: request.window.startLine,
    endLine: request.window.endLine,
    ...boundedLineSlice(await readFile(target, "utf8"), request.window),
  };
}

function boundedJson(value) {
  const text = JSON.stringify(value, null, 2);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= data.toolResponseMaxBytes) {
    return { truncated: false, bytes, value };
  }
  return {
    truncated: true,
    bytes,
    maxBytes: data.toolResponseMaxBytes,
    text: Buffer.from(text, "utf8").subarray(0, data.toolResponseMaxBytes).toString("utf8"),
  };
}

function boundedLineSlice(content, window) {
  const lines = splitLinesWithEndings(content);
  const slice = lines.slice(window.startLine - 1, window.endLine).join("");
  const buffer = Buffer.from(slice, "utf8");
  return {
    available: true,
    content: buffer.subarray(0, data.toolResponseMaxBytes).toString("utf8"),
    bytes: buffer.byteLength,
    truncated: buffer.byteLength > data.toolResponseMaxBytes,
  };
}

function splitLinesWithEndings(content) {
  const lines = content.match(/[^\n]*(?:\n|$)/g) ?? [];
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function resolveReadAtRefRequest(params) {
  if (params.ref !== "base" && params.ref !== "head") {
    throw new Error("Unsupported ref '" + params.ref + "'");
  }
  assertSafePath(params.path);
  const file = assertKnownPath(params.path);
  const range = assertKnownRange(file, params.rangeId);
  const hunk = assertKnownHunk(file, range);
  const sourcePath = params.ref === "base" ? (file.previousPath ?? file.path) : file.path;
  assertSafePath(sourcePath);
  return {
    file,
    range,
    hunk,
    ref: params.ref,
    sourcePath,
    window: lineWindowForRange(range, hunk, params.ref),
  };
}

function lineWindowForRange(range, hunk, ref) {
  const targetSide = ref === "base" ? "LEFT" : "RIGHT";
  if (range.side !== targetSide) {
    return undefined;
  }
  const hunkStart = ref === "base" ? hunk.oldStart : hunk.newStart;
  const hunkLines = ref === "base" ? hunk.oldLines : hunk.newLines;
  if (hunkLines === 0) {
    return undefined;
  }
  const hunkEnd = hunkStart + hunkLines - 1;
  return {
    startLine: Math.max(hunkStart, range.startLine - ${readAtRefContextLines}),
    endLine: Math.min(hunkEnd, range.endLine + ${readAtRefContextLines}),
  };
}

function unavailableReadAtRefResult(request) {
  return {
    path: request.file.path,
    ref: request.ref,
    sourcePath: request.sourcePath,
    rangeId: request.range.id,
    startLine: 0,
    endLine: 0,
    available: false,
  };
}

function assertKnownPath(filePath) {
  const file = data.manifest.files.find((item) => item.path === filePath);
  if (!file) {
    throw new Error("Path '" + filePath + "' is not in the Diff Manifest");
  }
  return file;
}

function assertKnownRange(file, rangeId) {
  const range = file.commentableRanges.find((item) => item.id === rangeId);
  if (range) {
    return range;
  }
  if (findRange(rangeId)) {
    throw new Error("Diff Manifest range '" + rangeId + "' is not in path '" + file.path + "'");
  }
  throw new Error("Unknown Diff Manifest range '" + rangeId + "'");
}

function assertKnownHunk(file, range) {
  const hunk = file.hunks.find((item) =>
    item.hunkIndex === range.hunkIndex && item.contentHash === range.hunkContentHash
  );
  if (!hunk) {
    throw new Error("Diff Manifest range '" + range.id + "' has no matching hunk");
  }
  return hunk;
}

function findRange(rangeId) {
  return data.manifest.files.some((file) =>
    file.commentableRanges.some((range) => range.id === rangeId)
  );
}

function assertSafePath(filePath) {
  if (
    typeof filePath !== "string" ||
    filePath.length === 0 ||
    filePath.includes("\0") ||
    path.isAbsolute(filePath) ||
    filePath.split(/[\\/]/).some((part) => part === ".." || part === ".git" || part === "")
  ) {
    throw new Error("Unsafe manifest path '" + filePath + "'");
  }
}

function resolveAllowedPath(rootPath, filePath) {
  const resolved = path.resolve(rootPath, filePath);
  const relative = path.relative(rootPath, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path '" + filePath + "' resolves outside the workspace");
  }
  return resolved;
}

async function assertNoSymlinkPath(rootPath, filePath) {
  const { lstat } = await import("node:fs/promises");
  const parts = filePath.split(/[\\/]/);
  let current = rootPath;
  for (const part of parts) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error("Path '" + filePath + "' crosses a symlink");
    }
  }
}
`;
}
