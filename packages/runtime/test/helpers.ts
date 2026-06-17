import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writePiprConfig(rootDir: string, lines: string[]): Promise<void> {
  await mkdir(path.join(rootDir, ".pipr"));
  await writeFile(path.join(rootDir, ".pipr", "config.yaml"), lines.join("\n"));
}

export async function writePiprRegistry(rootDir: string, lines: string[]): Promise<void> {
  await writeFile(path.join(rootDir, ".pipr", "registry.yaml"), lines.join("\n"));
}
