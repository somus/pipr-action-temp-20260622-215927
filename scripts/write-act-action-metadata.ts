#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const defaultImage = "pipr-action:act";

export function renderActActionMetadata(
  source: string,
  image: string,
  options: { entrypointScript?: string } = {},
): string {
  assertNonEmptyImage(image);
  let rendered = source.replace(
    dockerImagePattern(source),
    `$1image: docker://${image}${options.entrypointScript ? "\n$1entrypoint: /usr/local/bin/bun" : ""}`,
  );
  if (options.entrypointScript) {
    rendered = insertEntrypointScriptArg(rendered, options.entrypointScript);
  }
  return rendered;
}

function assertNonEmptyImage(image: string): void {
  if (!image.trim()) {
    throw new Error("PIPR_ACTION_IMAGE must not be empty");
  }
}

function dockerImagePattern(source: string): RegExp {
  const pattern = /^(\s*)image:\s*Dockerfile\s*$/m;
  return assertPattern(source, "action metadata must contain runs.image: Dockerfile", pattern);
}

function insertEntrypointScriptArg(source: string, entrypointScript: string): string {
  return source.replace(actArgsPattern(source), `$1args:\n$1  - ${entrypointScript}`);
}

function actArgsPattern(source: string): RegExp {
  const pattern = /^(\s*)args:\s*$/m;
  return assertPattern(
    source,
    "action metadata must contain runs.args for act fixture wrapper",
    pattern,
  );
}

function assertPattern(source: string, message: string, pattern: RegExp): RegExp {
  if (!pattern.test(source)) {
    throw new Error(message);
  }
  return pattern;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [
    sourcePath = "action.yml",
    outputPath = ".github/act/action.yml",
    image = defaultImage,
    entrypointScript,
  ] = process.argv.slice(2);
  const source = await readFile(sourcePath, "utf8");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderActActionMetadata(source, image, { entrypointScript }));
}
