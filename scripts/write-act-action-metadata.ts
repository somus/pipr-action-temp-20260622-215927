#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const defaultImage = "pipr-action:act";

export function renderActActionMetadata(source: string, image: string): string {
  if (!image.trim()) {
    throw new Error("PIPR_ACTION_IMAGE must not be empty");
  }
  const pattern = /^(\s*)image:\s*Dockerfile\s*$/m;
  if (!pattern.test(source)) {
    throw new Error("action metadata must contain runs.image: Dockerfile");
  }
  return source.replace(pattern, `$1image: docker://${image}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sourcePath = "action.yml", outputPath = ".github/act/action.yml", image = defaultImage] =
    process.argv.slice(2);
  const source = await readFile(sourcePath, "utf8");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderActActionMetadata(source, image));
}
