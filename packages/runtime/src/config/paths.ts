import path from "node:path";

type ResolvedConfigDir = {
  configDir: string;
  projectDir: string;
  relativeConfigDir: string;
  gitPath: string;
};

export function resolveContainedConfigDir(options: {
  rootDir: string;
  configDir?: string;
}): ResolvedConfigDir {
  const configDir = options.configDir ?? ".pipr";
  const rootDir = path.resolve(options.rootDir);
  const projectDir = path.resolve(rootDir, configDir);
  if (!isPathContained(projectDir, rootDir)) {
    throw new Error(`${configDir}: configDir must be inside rootDir`);
  }

  const relativeConfigDir = path.relative(rootDir, projectDir) || ".";
  return {
    configDir,
    projectDir,
    relativeConfigDir,
    gitPath: toGitPath(relativeConfigDir),
  };
}

export function isPathContained(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toGitPath(filePath: string): string {
  return filePath === "." ? "." : filePath.split(path.sep).join("/");
}
