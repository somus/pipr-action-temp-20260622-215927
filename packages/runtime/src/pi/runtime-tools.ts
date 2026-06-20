import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DiffManifest } from "../types.js";
import {
  assertNoSymlinkPath,
  type BaseRangeSnapshot,
  boundedLineSlice,
  isSafeManifestPath,
  type LineWindow,
  type ReadDiffParams,
  type RuntimeToolData,
  readAtRefParams,
  readDiffFromRuntimeData,
  resolveAllowedPath,
  resolveReadAtRefRequest,
  unavailableReadAtRefResult,
} from "./runtime-tools-core.js";

export const piRuntimeReadToolNames = ["pipr_read_diff", "pipr_read_at_ref"] as const;

export type PiRuntimeReadToolName = (typeof piRuntimeReadToolNames)[number];

export type PiRuntimeReadToolRequest = {
  manifest: DiffManifest;
  toolResponseMaxBytes: number;
};

export type PreparedPiRuntimeReadTools = {
  extensionPath: string;
  dataPath: string;
  toolNames: readonly PiRuntimeReadToolName[];
};

export type { ReadDiffParams } from "./runtime-tools-core.js";

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
  await writeFile(dataPath, JSON.stringify(data), "utf8");
  return {
    extensionPath: await runtimeToolsExtensionPath(),
    dataPath,
    toolNames: piRuntimeReadToolNames,
  };
}

async function runtimeToolsExtensionPath(): Promise<string> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "pi", "runtime-tools-extension.mjs"),
    path.join(moduleDir, "runtime-tools-extension.mjs"),
    path.join(moduleDir, "runtime-tools-extension.ts"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  throw new Error("Unable to locate pipr runtime tools extension");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function readDiffFromManifest(
  manifest: DiffManifest,
  params: ReadDiffParams,
  maxBytes: number,
): unknown {
  return readDiffFromRuntimeData(
    { manifest, toolResponseMaxBytes: maxBytes, baseRanges: {} },
    params,
  );
}

export async function readAtRef(options: {
  workspace: string;
  manifest: DiffManifest;
  path: string;
  ref: "base" | "head";
  rangeId: string;
  maxBytes: number;
}): Promise<unknown> {
  const params = readAtRefParams({
    path: options.path,
    ref: options.ref,
    rangeId: options.rangeId,
  });
  const request = resolveReadAtRefRequest(options.manifest, params);
  if (!request.window) {
    return unavailableReadAtRefResult(request);
  }
  const content =
    params.ref === "base"
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
    path: params.path,
    ref: params.ref,
    sourcePath: request.sourcePath,
    rangeId: params.rangeId,
    startLine: request.window.startLine,
    endLine: request.window.endLine,
    ...content,
  };
}

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
