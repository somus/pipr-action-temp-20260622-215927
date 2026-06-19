import type {
  DiffManifest,
  DiffManifestFile,
  DiffManifestLimitsConfig,
  DiffManifestPromptMetrics,
} from "../types.js";

export type DiffManifestPromptMode = "full" | "condensed";

export type DiffManifestPromptLimits = {
  fullMaxBytes: number;
  fullMaxEstimatedTokens: number;
  condensedMaxBytes: number;
  condensedMaxEstimatedTokens: number;
  toolResponseMaxBytes: number;
};

export type PreparedDiffManifestPrompt = {
  mode: DiffManifestPromptMode;
  manifest: DiffManifest;
  metrics: {
    full: DiffManifestPromptMetrics;
    selected: DiffManifestPromptMetrics;
  };
  limits: DiffManifestPromptLimits;
};

const defaultDiffManifestPromptLimits: DiffManifestPromptLimits = {
  fullMaxBytes: 128 * 1024,
  fullMaxEstimatedTokens: 32_000,
  condensedMaxBytes: 256 * 1024,
  condensedMaxEstimatedTokens: 64_000,
  toolResponseMaxBytes: 64 * 1024,
};

export function prepareDiffManifestPrompt(
  manifest: DiffManifest,
  config: DiffManifestLimitsConfig | undefined,
): PreparedDiffManifestPrompt {
  const limits = resolveDiffManifestPromptLimits(config);
  const full = measureDiffManifestPrompt(manifest);
  if (fitsLimit(full, limits.fullMaxBytes, limits.fullMaxEstimatedTokens)) {
    return { mode: "full", manifest, metrics: { full, selected: full }, limits };
  }

  const condensedManifest = condenseDiffManifest(manifest);
  const condensed = measureDiffManifestPrompt(condensedManifest);
  if (!fitsLimit(condensed, limits.condensedMaxBytes, limits.condensedMaxEstimatedTokens)) {
    throw new Error(
      [
        "Diff Manifest payload exceeds condensed limit before Pi execution",
        `selected=${condensed.bytes} bytes/${condensed.estimatedTokens} estimated tokens`,
        `limit=${limits.condensedMaxBytes} bytes/${limits.condensedMaxEstimatedTokens} estimated tokens`,
      ].join("; "),
    );
  }

  return {
    mode: "condensed",
    manifest: condensedManifest,
    metrics: { full, selected: condensed },
    limits,
  };
}

function resolveDiffManifestPromptLimits(
  config: DiffManifestLimitsConfig | undefined,
): DiffManifestPromptLimits {
  return {
    ...defaultDiffManifestPromptLimits,
    ...Object.fromEntries(Object.entries(config ?? {}).filter((entry) => entry[1] !== undefined)),
  };
}

export function condenseDiffManifest(manifest: DiffManifest): DiffManifest {
  return {
    baseSha: manifest.baseSha,
    headSha: manifest.headSha,
    mergeBaseSha: manifest.mergeBaseSha,
    files: manifest.files.map(condenseDiffManifestFile),
  };
}

export function measureDiffManifestPrompt(manifest: DiffManifest): DiffManifestPromptMetrics {
  const json = JSON.stringify(manifest, null, 2);
  const bytes = Buffer.byteLength(json, "utf8");
  return {
    bytes,
    estimatedTokens: Math.ceil(bytes / 4),
  };
}

function condenseDiffManifestFile(file: DiffManifestFile): DiffManifestFile {
  return {
    path: file.path,
    previousPath: file.previousPath,
    status: file.status,
    language: file.language,
    additions: file.additions,
    deletions: file.deletions,
    hunks: file.hunks.map((hunk) => ({
      hunkIndex: hunk.hunkIndex,
      header: hunk.header,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      contentHash: hunk.contentHash,
    })),
    commentableRanges: file.commentableRanges.map((range) => ({
      id: range.id,
      path: range.path,
      side: range.side,
      startLine: range.startLine,
      endLine: range.endLine,
      kind: range.kind,
      hunkIndex: range.hunkIndex,
      hunkHeader: range.hunkHeader,
      hunkContentHash: range.hunkContentHash,
    })),
    excludedReason: file.excludedReason,
  };
}

function fitsLimit(
  metrics: DiffManifestPromptMetrics,
  maxBytes: number,
  maxEstimatedTokens: number,
): boolean {
  return metrics.bytes <= maxBytes && metrics.estimatedTokens <= maxEstimatedTokens;
}
