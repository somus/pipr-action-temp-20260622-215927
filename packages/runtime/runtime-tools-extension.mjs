import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const readAtRefContextLines = 3;

export default function piprRuntimeTools(pi) {
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
      const result = readDiff(data, params ?? {});
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
      const data = await loadData(dataPath);
      const result = await readAtRef(dataRoot, data, params, ctx.cwd);
      return textResult(result);
    },
  });
}

function runtimeDataPath() {
  const dataPath = process.env.PIPR_RUNTIME_TOOLS_DATA;
  if (!dataPath) {
    throw new Error("PIPR_RUNTIME_TOOLS_DATA is required for pipr runtime tools");
  }
  if (!path.isAbsolute(dataPath)) {
    throw new Error("PIPR_RUNTIME_TOOLS_DATA must be an absolute path");
  }
  return dataPath;
}

async function loadData(dataPath) {
  return JSON.parse(await readFile(dataPath, "utf8"));
}

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function readDiff(data, params) {
  const requestedPath = params.path;
  const rangeId = params.rangeId;
  if (requestedPath !== undefined) {
    assertSafePath(requestedPath);
    assertKnownPath(data, requestedPath);
  }
  if (rangeId !== undefined && !findRange(data, rangeId)) {
    throw new Error(`Unknown Diff Manifest range '${rangeId}'`);
  }
  const files = data.manifest.files
    .filter((file) => requestedPath === undefined || file.path === requestedPath)
    .map((file) =>
      rangeId === undefined
        ? file
        : {
            ...file,
            commentableRanges: file.commentableRanges.filter((range) => range.id === rangeId),
          },
    )
    .filter((file) => rangeId === undefined || file.commentableRanges.length > 0);
  return boundedJson(data, { files });
}

async function readAtRef(dataRoot, data, params, cwd) {
  const request = resolveReadAtRefRequest(data, params);
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
  const target = resolveAllowedPath(cwd, request.sourcePath);
  await assertNoSymlinkPath(cwd, request.sourcePath);
  return {
    path: params.path,
    ref: params.ref,
    sourcePath: request.sourcePath,
    rangeId: params.rangeId,
    startLine: request.window.startLine,
    endLine: request.window.endLine,
    ...boundedLineSlice(data, await readFile(target, "utf8"), request.window),
  };
}

function boundedJson(data, value) {
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

function boundedLineSlice(data, content, window) {
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

function resolveReadAtRefRequest(data, params) {
  if (params.ref !== "base" && params.ref !== "head") {
    throw new Error(`Unsupported ref '${params.ref}'`);
  }
  assertSafePath(params.path);
  const file = assertKnownPath(data, params.path);
  const range = assertKnownRange(data, file, params.rangeId);
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
    startLine: Math.max(hunkStart, range.startLine - readAtRefContextLines),
    endLine: Math.min(hunkEnd, range.endLine + readAtRefContextLines),
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

function assertKnownPath(data, filePath) {
  const file = data.manifest.files.find((item) => item.path === filePath);
  if (!file) {
    throw new Error(`Path '${filePath}' is not in the Diff Manifest`);
  }
  return file;
}

function assertKnownRange(data, file, rangeId) {
  const range = file.commentableRanges.find((item) => item.id === rangeId);
  if (range) {
    return range;
  }
  if (findRange(data, rangeId)) {
    throw new Error(`Diff Manifest range '${rangeId}' is not in path '${file.path}'`);
  }
  throw new Error(`Unknown Diff Manifest range '${rangeId}'`);
}

function assertKnownHunk(file, range) {
  const hunk = file.hunks.find(
    (item) => item.hunkIndex === range.hunkIndex && item.contentHash === range.hunkContentHash,
  );
  if (!hunk) {
    throw new Error(`Diff Manifest range '${range.id}' has no matching hunk`);
  }
  return hunk;
}

function findRange(data, rangeId) {
  return data.manifest.files.some((file) =>
    file.commentableRanges.some((range) => range.id === rangeId),
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
    throw new Error(`Unsafe manifest path '${filePath}'`);
  }
}

function resolveAllowedPath(rootPath, filePath) {
  const resolved = path.resolve(rootPath, filePath);
  const relative = path.relative(rootPath, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path '${filePath}' resolves outside the workspace`);
  }
  return resolved;
}

async function assertNoSymlinkPath(rootPath, filePath) {
  const parts = filePath.split(/[\\/]/);
  let current = rootPath;
  for (const part of parts) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`Path '${filePath}' crosses a symlink`);
    }
  }
}
