import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertNoSymlinkPath,
  type BaseRangeSnapshot,
  boundedLineSlice,
  type ReadAtRefParams,
  type ReadDiffParams,
  type RuntimeToolData,
  readAtRefParams,
  readDiffFromRuntimeData,
  readDiffParams,
  resolveAllowedPath,
  resolveReadAtRefRequest,
  unavailableReadAtRefResult,
} from "./runtime-tools-core.js";

type PiExtensionHost = {
  registerTool(tool: PiTool): void;
};

type PiTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: { cwd?: unknown },
  ) => Promise<ToolResult>;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

export default function piprRuntimeTools(pi: PiExtensionHost): void {
  const dataPath = runtimeDataPath();
  const dataRoot = path.dirname(dataPath);

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
      const data = await loadData(dataPath);
      const result = readDiff(data, readDiffParams(params));
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
      const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : "";
      const data = await loadData(dataPath);
      const result = await readAtRef(dataRoot, data, readAtRefParams(params), cwd);
      return textResult(result);
    },
  });
}

function runtimeDataPath(): string {
  const dataPath = process.env.PIPR_RUNTIME_TOOLS_DATA;
  if (!dataPath) {
    throw new Error("PIPR_RUNTIME_TOOLS_DATA is required for pipr runtime tools");
  }
  if (!path.isAbsolute(dataPath)) {
    throw new Error("PIPR_RUNTIME_TOOLS_DATA must be an absolute path");
  }
  return dataPath;
}

async function loadData(dataPath: string): Promise<RuntimeToolData> {
  return JSON.parse(await readFile(dataPath, "utf8")) as RuntimeToolData;
}

function textResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function readDiff(data: RuntimeToolData, params: ReadDiffParams): unknown {
  return readDiffFromRuntimeData(data, params);
}

async function readAtRef(
  dataRoot: string,
  data: RuntimeToolData,
  params: ReadAtRefParams,
  cwd: string,
): Promise<unknown> {
  const request = resolveReadAtRefRequest(data.manifest, params);
  if (!request.window) {
    return unavailableReadAtRefResult(request);
  }
  if (params.ref === "base") {
    return await readBaseSnapshot(dataRoot, data.baseRanges[params.rangeId], params, request);
  }
  return await readHeadWorkspaceFile(cwd, data.toolResponseMaxBytes, params, request);
}

async function readBaseSnapshot(
  dataRoot: string,
  snapshot: BaseRangeSnapshot | undefined,
  params: ReadAtRefParams,
  request: ReturnType<typeof resolveReadAtRefRequest>,
): Promise<unknown> {
  if (hasReadableBaseSnapshot(snapshot)) {
    return await readAvailableBaseSnapshot(dataRoot, snapshot, params, request);
  }
  return snapshot ?? unavailableReadAtRefResult(request);
}

function hasReadableBaseSnapshot(
  snapshot: BaseRangeSnapshot | undefined,
): snapshot is BaseRangeSnapshot & { available: true; relativePath: string } {
  return snapshot?.available === true && typeof snapshot.relativePath === "string";
}

async function readAvailableBaseSnapshot(
  dataRoot: string,
  snapshot: BaseRangeSnapshot & { available: true; relativePath: string },
  params: ReadAtRefParams,
  request: ReturnType<typeof resolveReadAtRefRequest>,
): Promise<unknown> {
  const content = await readFile(path.join(dataRoot, snapshot.relativePath));
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

async function readHeadWorkspaceFile(
  cwd: string,
  maxBytes: number,
  params: ReadAtRefParams,
  request: ReturnType<typeof resolveReadAtRefRequest>,
): Promise<unknown> {
  if (!request.window) {
    return unavailableReadAtRefResult(request);
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
    ...boundedLineSlice(await readFile(target, "utf8"), request.window, maxBytes),
  };
}
