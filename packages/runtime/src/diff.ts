import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import type { CommentableRange, DiffManifest, FileStatus, ReviewSide } from "./types.js";

type DiffFile = DiffManifest["files"][number];
type DiffStat = {
  additions: number;
  deletions: number;
  excludedReason?: string;
};

const lockFilePattern =
  /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock)$/;
const generatedPattern = /(^|\/)(dist|build|coverage|vendor)\//;
const maxInlineChangedLines = 1000;

export type BuildDiffManifestOptions = {
  cwd: string;
  baseSha: string;
  headSha: string;
};

export function buildDiffManifest(options: BuildDiffManifestOptions): DiffManifest {
  const mergeBaseSha = runGit(["merge-base", options.baseSha, options.headSha], options.cwd).trim();
  const nameStatus = runGit(
    ["diff", "--name-status", "--find-renames", mergeBaseSha, options.headSha],
    options.cwd,
  );
  const diffStats = getDiffStats(options.cwd, mergeBaseSha, options.headSha);
  const preExcludedFiles = getPreExcludedFiles(diffStats);
  const diff = runGit(
    buildUnifiedDiffArgs(mergeBaseSha, options.headSha, preExcludedFiles),
    options.cwd,
  );

  const files = parseNameStatus(nameStatus);
  const rangesByPath = parseUnifiedDiff(diff);
  for (const file of files) {
    const stats = diffStats.get(file.path);
    file.additions = stats?.additions ?? 0;
    file.deletions = stats?.deletions ?? 0;
    const preExcludedReason = stats?.excludedReason;
    const ranges = preExcludedReason ? [] : (rangesByPath.get(file.path) ?? []);
    file.commentableRanges = ranges;
    const excludedReason = preExcludedReason ?? getExcludedReason(file);
    if (excludedReason) {
      file.commentableRanges = [];
    }
    file.excludedReason = excludedReason;
  }

  return {
    baseSha: options.baseSha,
    headSha: options.headSha,
    mergeBaseSha,
    files,
  };
}

export function parseNameStatus(output: string): DiffFile[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseNameStatusLine);
}

export function parseUnifiedDiff(diff: string): Map<string, CommentableRange[]> {
  const state = createDiffParserState();

  for (const line of diff.split("\n")) {
    parseUnifiedDiffLine(state, line);
  }

  flushPendingRange(state);
  return state.rangesByPath;
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const reason = result.stderr.trim() || result.error?.message || "unknown error";
    throw new Error(`git ${args.join(" ")} failed: ${reason}`);
  }
  return result.stdout;
}

function getDiffStats(cwd: string, baseSha: string, headSha: string): Map<string, DiffStat> {
  const output = runGit(["diff", "--numstat", "--find-renames", baseSha, headSha], cwd);
  const stats = new Map<string, DiffStat>();
  for (const line of output.split("\n").filter(Boolean)) {
    const stat = parseNumstatLine(line);
    if (!stat) {
      continue;
    }
    if (stat.kind === "binary") {
      stats.set(stat.path, { additions: 0, deletions: 0, excludedReason: "binary diff" });
      continue;
    }
    stats.set(stat.path, {
      additions: stat.additions,
      deletions: stat.deletions,
      excludedReason: stat.changedLines > maxInlineChangedLines ? "oversized diff" : undefined,
    });
  }
  return stats;
}

function getPreExcludedFiles(stats: Map<string, DiffStat>): Map<string, string> {
  const excluded = new Map<string, string>();
  for (const [filePath, stat] of stats) {
    if (stat.excludedReason) {
      excluded.set(filePath, stat.excludedReason);
    }
  }
  return excluded;
}

function buildUnifiedDiffArgs(
  baseSha: string,
  headSha: string,
  excludedFiles: Map<string, string>,
): string[] {
  const args = ["diff", "--unified=80", "--find-renames", baseSha, headSha];
  if (excludedFiles.size === 0) {
    return args;
  }
  return [
    ...args,
    "--",
    ".",
    ...[...excludedFiles.keys()].map((filePath) => `:(exclude)${filePath}`),
  ];
}

function parseNumstatLine(
  line: string,
):
  | { kind: "text"; path: string; additions: number; deletions: number; changedLines: number }
  | { kind: "binary"; path: string }
  | undefined {
  const [rawAdditions, rawDeletions, ...pathParts] = line.split("\t");
  const filePath = pathParts.join("\t");
  if (!rawAdditions || !rawDeletions || !filePath) {
    return undefined;
  }
  if (rawAdditions === "-" || rawDeletions === "-") {
    return { kind: "binary", path: normalizeNumstatPath(filePath) };
  }
  const additions = Number(rawAdditions);
  const deletions = Number(rawDeletions);
  return {
    kind: "text",
    path: normalizeNumstatPath(filePath),
    additions,
    deletions,
    changedLines: additions + deletions,
  };
}

function normalizeNumstatPath(filePath: string): string {
  if (filePath.includes("{") && filePath.includes(" => ") && filePath.includes("}")) {
    return filePath.replace(/\{(?<before>.*) => (?<after>.*)\}/, "$<after>");
  }
  const renameTarget = / => (?<target>.*)$/.exec(filePath)?.groups?.target;
  return renameTarget ?? filePath;
}

function baseFile(filePath: string, status: FileStatus, previousPath?: string): DiffFile {
  return {
    path: filePath,
    previousPath,
    status,
    language: languageForPath(filePath),
    additions: 0,
    deletions: 0,
    commentableRanges: [],
  };
}

function parseNameStatusLine(line: string): DiffFile {
  const [rawStatus = "M", firstPath = "", secondPath = ""] = line.split("\t");
  const status = parseFileStatus(rawStatus);
  if (status === "renamed") {
    return baseFile(secondPath || firstPath, "renamed", firstPath);
  }
  return baseFile(firstPath, status);
}

function parseFileStatus(rawStatus: string): FileStatus {
  if (rawStatus.startsWith("R")) {
    return "renamed";
  }
  if (rawStatus === "A") {
    return "added";
  }
  if (rawStatus === "D") {
    return "removed";
  }
  return "modified";
}

function getExcludedReason(file: DiffFile): string | undefined {
  if (file.status === "removed") {
    return "removed file";
  }
  if (lockFilePattern.test(file.path)) {
    return "lock file";
  }
  if (generatedPattern.test(file.path)) {
    return "generated or build output";
  }
  if (changedLineCount(file.commentableRanges) > maxInlineChangedLines) {
    return "oversized diff";
  }
  return undefined;
}

function changedLineCount(ranges: CommentableRange[]): number {
  return ranges.reduce((total, range) => total + range.endLine - range.startLine + 1, 0);
}

function languageForPath(filePath: string): string | undefined {
  const extension = path.extname(filePath).slice(1);
  return extension || undefined;
}

function makeRangeId(
  filePath: string,
  side: ReviewSide,
  startLine: number,
  endLine: number,
): string {
  const stable = `${filePath}:${side}:${startLine}-${endLine}`;
  return `rng_${crypto.createHash("sha1").update(stable).digest("hex").slice(0, 12)}`;
}

type PendingRange = {
  side: ReviewSide;
  startLine: number;
  endLine: number;
  preview: string[];
};

type DiffParserState = {
  rangesByPath: Map<string, CommentableRange[]>;
  currentPath?: string;
  hunkHeader?: string;
  oldLine: number;
  newLine: number;
  pending?: PendingRange;
};

function createDiffParserState(): DiffParserState {
  return {
    rangesByPath: new Map(),
    oldLine: 0,
    newLine: 0,
  };
}

function parseUnifiedDiffLine(state: DiffParserState, line: string): void {
  if (line.startsWith("diff --git ")) {
    resetFileState(state);
    return;
  }

  if (line.startsWith("+++ b/")) {
    state.currentPath = line.slice("+++ b/".length);
    return;
  }

  if (line.startsWith("@@")) {
    startHunk(state, line);
    return;
  }

  if (!state.hunkHeader || !state.currentPath || line.startsWith("+++ /dev/null")) {
    return;
  }

  applyHunkLine(state, line);
}

function resetFileState(state: DiffParserState): void {
  flushPendingRange(state);
  state.currentPath = undefined;
  state.hunkHeader = undefined;
}

function startHunk(state: DiffParserState, line: string): void {
  flushPendingRange(state);
  state.hunkHeader = line;
  const location = parseHunkLocation(line);
  if (location) {
    state.oldLine = location.oldLine;
    state.newLine = location.newLine;
  }
}

function parseHunkLocation(line: string): { oldLine: number; newLine: number } | undefined {
  const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) {
    return undefined;
  }
  return {
    oldLine: Number(match[1]),
    newLine: Number(match[2]),
  };
}

function applyHunkLine(state: DiffParserState, line: string): void {
  if (applyChangedLine(state, line)) {
    return;
  }

  flushPendingRange(state);
  if (line.startsWith(" ")) {
    state.oldLine += 1;
    state.newLine += 1;
  }
}

function applyChangedLine(state: DiffParserState, line: string): boolean {
  const side = changedLineSide(line);
  if (!side) {
    return false;
  }

  const lineNumber = side === "RIGHT" ? state.newLine : state.oldLine;
  state.pending = extendOrStartRange(state.pending, side, lineNumber, line.slice(1), () =>
    flushPendingRange(state),
  );
  advanceChangedLine(state, side);
  return true;
}

function changedLineSide(line: string): ReviewSide | undefined {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "RIGHT";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "LEFT";
  }
  return undefined;
}

function advanceChangedLine(state: DiffParserState, side: ReviewSide): void {
  if (side === "RIGHT") {
    state.newLine += 1;
  } else {
    state.oldLine += 1;
  }
}

function flushPendingRange(state: DiffParserState): void {
  if (!state.pending || !state.currentPath || !state.hunkHeader) {
    state.pending = undefined;
    return;
  }

  const pending = state.pending;
  const ranges = state.rangesByPath.get(state.currentPath) ?? [];
  ranges.push({
    id: makeRangeId(state.currentPath, pending.side, pending.startLine, pending.endLine),
    path: state.currentPath,
    side: pending.side,
    startLine: pending.startLine,
    endLine: pending.endLine,
    kind: pending.side === "RIGHT" ? "added" : "deleted",
    hunkHeader: state.hunkHeader,
    preview: pending.preview.join("\n"),
  });
  state.rangesByPath.set(state.currentPath, ranges);
  state.pending = undefined;
}

function extendOrStartRange(
  pending: PendingRange | undefined,
  side: ReviewSide,
  line: number,
  preview: string,
  flush: () => void,
): PendingRange {
  if (pending && pending.side === side && pending.endLine + 1 === line) {
    pending.endLine = line;
    pending.preview.push(preview);
    return pending;
  }

  flush();
  return {
    side,
    startLine: line,
    endLine: line,
    preview: [preview],
  };
}
