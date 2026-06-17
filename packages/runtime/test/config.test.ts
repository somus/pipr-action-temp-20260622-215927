import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses builtin:minimal when .pipr is absent", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    const resolved = await loadConfig({ rootDir });

    expect(resolved.source).toBe("builtin:minimal");
    expect(resolved.config.default_provider).toBe("deepseek");
    expect(resolved.config.providers[0]?.model).toBe("deepseek-v4-pro");
  });

  it("merges explicit top-level overrides over builtin:minimal", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    await writeConfig(rootDir, [
      "version: 1",
      "extends:",
      "  - builtin:minimal",
      "default_provider: deepseek",
      "providers:",
      "  - id: deepseek",
      "    model: deepseek-v4-pro",
      "    api_key_env: DEEPSEEK_API_KEY",
      "review:",
      "  max_inline_comments: 2",
    ]);

    const resolved = await loadConfig({ rootDir });

    expect(resolved.config.review.max_inline_comments).toBe(2);
    expect(resolved.config.review.min_confidence).toBe(0.75);
  });

  it("requires default_provider to reference a provider id", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    await writeConfig(rootDir, [
      "version: 1",
      "default_provider: missing",
      "providers:",
      "  - id: deepseek",
      "    model: deepseek-v4-pro",
      "    api_key_env: DEEPSEEK_API_KEY",
      "review:",
      "  max_inline_comments: 5",
      "  min_confidence: 0.75",
    ]);

    await expect(loadConfig({ rootDir })).rejects.toThrow("default_provider 'missing'");
  });
});

async function writeConfig(rootDir: string, lines: string[]): Promise<void> {
  await mkdir(path.join(rootDir, ".pipr"));
  await writeFile(path.join(rootDir, ".pipr", "config.yaml"), lines.join("\n"));
}
