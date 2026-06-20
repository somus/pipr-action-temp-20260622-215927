import { lstat } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "../shared/record.js";
import type { CommentableRange, DiffHunk, DiffManifest, DiffManifestFile } from "../types.js";

const readAtRefContextLines = 3;

export type ReadDiffParams = {
  path?: string;
  rangeId?: string;
};

export type ReadAtRefParams = {
  path: string;
  ref: "base" | "head";
  rangeId: string;
};

export type RuntimeToolData = {
  manifest: DiffManifest;
  toolResponseMaxBytes: number;
  baseRanges: Record<string, BaseRangeSnapshot>;
};

export type BaseRangeSnapshot = {
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

export type ReadAtRefRequest = {
  file: DiffManifestFile;
  range: CommentableRange;
  hunk: DiffHunk;
  ref: "base" | "head";
  sourcePath: string;
  window: LineWindow | undefined;
};

export type LineWindow = {
  startLine: number;
  endLine: number;
};

export type LineSliceResult = {
  available: true;
  content: string;
  bytes: number;
  truncated: boolean;
};

export function readDiffFromRuntimeData(data: RuntimeToolData, params: ReadDiffParams): unknown {
  const { path: filePath, rangeId } = params;
  if (filePath !== undefined) {
    assertSafeManifestPath(filePath);
    assertKnownManifestPath(data.manifest, filePath);
  }
  if (rangeId !== undefined && !findRange(data.manifest, rangeId)) {
    throw new Error(`Unknown Diff Manifest range '${rangeId}'`);
  }
  const files = data.manifest.files
    .filter((file) => filePath === undefined || file.path === filePath)
    .map((file) => filterManifestFileRanges(file, rangeId))
    .filter((file) => rangeId === undefined || file.commentableRanges.length > 0);
  return boundedJson({ files }, data.toolResponseMaxBytes);
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

export function boundedLineSlice(
  content: string,
  window: LineWindow,
  maxBytes: number,
): LineSliceResult {
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

export function resolveReadAtRefRequest(
  manifest: DiffManifest,
  params: ReadAtRefParams,
): ReadAtRefRequest {
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

export function unavailableReadAtRefResult(request: ReadAtRefRequest): BaseRangeSnapshot {
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

export function isSafeManifestPath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    !filePath.includes("\0") &&
    !path.isAbsolute(filePath) &&
    !filePath.split(/[\\/]/).some((part) => part === ".." || part === ".git" || part === "")
  );
}

function assertSafeManifestPath(filePath: unknown): asserts filePath is string {
  if (typeof filePath !== "string" || !isSafeManifestPath(filePath)) {
    throw new Error(`Unsafe manifest path '${String(filePath)}'`);
  }
}

export function resolveAllowedPath(root: string, filePath: string): string {
  const resolved = path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path '${filePath}' resolves outside the workspace`);
  }
  return resolved;
}

export async function assertNoSymlinkPath(root: string, filePath: string): Promise<void> {
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

export function readDiffParams(params: unknown): ReadDiffParams {
  const record = isRecord(params) ? params : {};
  return {
    path: optionalString(record.path),
    rangeId: optionalString(record.rangeId),
  };
}

export function readAtRefParams(params: unknown): ReadAtRefParams {
  const record = isRecord(params) ? params : {};
  const filePath = record.path;
  const ref = record.ref;
  const rangeId = record.rangeId;
  assertSafeManifestPath(filePath);
  if (ref !== "base" && ref !== "head") {
    throw new Error(`Unsupported ref '${String(ref)}'`);
  }
  if (typeof rangeId !== "string") {
    throw new Error("rangeId must be a string");
  }
  return { path: filePath, ref, rangeId };
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

function splitLinesWithEndings(content: string): string[] {
  const lines = content.match(/[^\n]*(?:\n|$)/g) ?? [];
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function lineWindowForRange(
  range: CommentableRange,
  hunk: DiffHunk,
  ref: "base" | "head",
): LineWindow | undefined {
  const targetSide: CommentableRange["side"] = ref === "base" ? "LEFT" : "RIGHT";
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
