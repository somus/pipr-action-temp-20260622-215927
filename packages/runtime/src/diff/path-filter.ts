import { compact, uniq } from "lodash-es";
import picomatch from "picomatch";
import type { DiffManifest, DiffManifestFile, PathFilter } from "../types.js";

const matcherOptions = {
  dot: true,
  nonegate: true,
  windows: false,
} as const;

type CompiledFilter = {
  include?: CompiledPattern[];
  exclude?: CompiledPattern[];
};

type CompiledPattern = {
  matches: picomatch.Matcher;
  matchBasename: boolean;
};

const compiledFilters = new WeakMap<PathFilter, CompiledFilter>();

export function diffManifestHasPathMatch(
  manifest: DiffManifest,
  filter: PathFilter | undefined,
): boolean {
  return manifest.files.some((file) => diffFileMatchesPathFilter(file, filter));
}

export function filterDiffManifestByPaths(
  manifest: DiffManifest,
  filter: PathFilter | undefined,
): DiffManifest {
  if (!filter) {
    return manifest;
  }
  return {
    ...manifest,
    files: manifest.files.filter((file) => diffFileMatchesPathFilter(file, filter)),
  };
}

export function diffFileMatchesPathFilter(
  file: Pick<DiffManifestFile, "path" | "previousPath">,
  filter: PathFilter | undefined,
): boolean {
  if (!filter) {
    return true;
  }
  const paths = candidatePaths(file).map(normalizePath);
  const compiled = readCompiledFilter(filter);
  const include = compiled.include;
  const exclude = compiled.exclude;
  const included = include ? paths.some((filePath) => matchesAnyPattern(filePath, include)) : true;
  const excluded = exclude ? paths.some((filePath) => matchesAnyPattern(filePath, exclude)) : false;
  return included && !excluded;
}

export function pathMatchesFilter(filePath: string, filter: PathFilter | undefined): boolean {
  if (!filter) {
    return true;
  }
  const normalizedPath = normalizePath(filePath);
  const compiled = readCompiledFilter(filter);
  const included = compiled.include ? matchesAnyPattern(normalizedPath, compiled.include) : true;
  if (!included) {
    return false;
  }
  return compiled.exclude ? !matchesAnyPattern(normalizedPath, compiled.exclude) : true;
}

function candidatePaths(file: Pick<DiffManifestFile, "path" | "previousPath">): string[] {
  return uniq(compact([file.path, file.previousPath]));
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function readCompiledFilter(filter: PathFilter): CompiledFilter {
  const existing = compiledFilters.get(filter);
  if (existing) {
    return existing;
  }
  const compiled = {
    include: filter.include?.map(compilePattern),
    exclude: filter.exclude?.map(compilePattern),
  };
  compiledFilters.set(filter, compiled);
  return compiled;
}

function compilePattern(pattern: string): CompiledPattern {
  return {
    matches: picomatch(pattern, matcherOptions),
    matchBasename: !pattern.includes("/"),
  };
}

function matchesAnyPattern(filePath: string, patterns: CompiledPattern[]): boolean {
  return patterns.some((pattern) =>
    pattern.matches(pattern.matchBasename ? basename(filePath) : filePath),
  );
}

function basename(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
}
