import { readdirSync, readFileSync } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMaterializedProject } from "./config.js";
import { isPathContained, resolveContainedConfigDir } from "./project-paths.js";

export type InitOfficialMinimalProjectOptions = {
  rootDir: string;
  configDir?: string;
  force?: boolean;
};

export type InitOfficialMinimalProjectResult = {
  configDir: string;
  created: string[];
  overwritten: string[];
};

type DistributionFile = {
  relativePath: string;
  contents: string;
};

// TODO: Move the official pipr distribution files to a separate config repository.
const officialMinimalRoot = fileURLToPath(
  new URL("../distribution/official-minimal/.pipr", import.meta.url),
);

export function listOfficialMinimalFiles(): string[] {
  return readOfficialMinimalFiles().map((file) => file.relativePath);
}

export async function initOfficialMinimalProject(
  options: InitOfficialMinimalProjectOptions,
): Promise<InitOfficialMinimalProjectResult> {
  const { configDir, projectDir } = resolveContainedConfigDir(options);
  const targets = readOfficialMinimalFiles().map((file) => ({
    ...file,
    absolutePath: path.join(projectDir, file.relativePath),
  }));
  await assertSafeTargetAncestors(targets, projectDir);
  const existing = await findExistingTargets(targets);
  if (existing.length > 0 && !options.force) {
    throw new Error(
      `${configDir} already contains pipr files: ${existing.join(", ")}. ` +
        "Use --force to replace existing .pipr files.",
    );
  }

  const created: string[] = [];
  const overwritten: string[] = [];
  for (const target of targets) {
    await mkdir(path.dirname(target.absolutePath), { recursive: true });
    const existed = existing.includes(target.relativePath);
    await writeFile(target.absolutePath, target.contents);
    if (existed) {
      overwritten.push(target.relativePath);
    } else {
      created.push(target.relativePath);
    }
  }

  await loadMaterializedProject({ rootDir: options.rootDir, configDir });
  return { configDir, created, overwritten };
}

async function assertSafeTargetAncestors(
  targets: Array<DistributionFile & { absolutePath: string }>,
  projectDir: string,
): Promise<void> {
  for (const target of targets) {
    await assertNoSymlinkAncestors(target.absolutePath, projectDir);
  }
}

async function assertNoSymlinkAncestors(filePath: string, projectDir: string): Promise<void> {
  const root = path.resolve(projectDir);
  let current = path.resolve(path.dirname(filePath));
  const ancestors: string[] = [];

  while (current === root || isPathInside(current, root)) {
    ancestors.push(current);
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }

  for (const ancestor of ancestors.reverse()) {
    const stats = await maybeLstat(ancestor);
    if (!stats) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${ancestor}: symbolic links are not supported`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`${ancestor}: expected a directory path`);
    }
  }
}

function readOfficialMinimalFiles(): DistributionFile[] {
  return listDistributionRelativePaths(officialMinimalRoot).map((relativePath) => ({
    relativePath,
    contents: readFileSync(path.join(officialMinimalRoot, relativePath), "utf8"),
  }));
}

function listDistributionRelativePaths(rootDir: string, relativeDir = ""): string[] {
  const directory = path.join(rootDir, relativeDir);
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        return listDistributionRelativePaths(rootDir, relativePath);
      }
      if (entry.isFile()) {
        return [relativePath];
      }
      return [];
    })
    .sort((left, right) => left.localeCompare(right));
}

async function findExistingTargets(
  targets: Array<DistributionFile & { absolutePath: string }>,
): Promise<string[]> {
  const existing: string[] = [];
  for (const target of targets) {
    const stats = await maybeLstat(target.absolutePath);
    if (!stats) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${target.absolutePath}: symbolic links are not supported`);
    }
    if (!stats.isFile()) {
      throw new Error(`${target.absolutePath}: expected a file path`);
    }
    existing.push(target.relativePath);
  }
  return existing;
}

async function maybeLstat(
  filePath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(filePath);
  } catch {
    return undefined;
  }
}

function isPathInside(child: string, parent: string): boolean {
  return child !== parent && isPathContained(child, parent);
}
