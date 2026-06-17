import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { writePiprConfig, writePiprRegistry } from "./helpers.js";

describe("loadConfig", () => {
  it("uses builtin:minimal when .pipr is absent", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    const resolved = await loadConfig({ rootDir });

    expect(resolved.source).toBe("builtin:minimal");
    expect(resolved.sources.config).toBe("builtin:minimal");
    expect(resolved.sources.fields.default_provider).toBe("builtin:minimal#default_provider");
    expect(resolved.config.default_provider).toBe("deepseek");
    expect(resolved.config.providers[0]?.model).toBe("deepseek-v4-pro");
  });

  it("merges explicit top-level overrides over builtin:minimal", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    await writePiprConfig(rootDir, [
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
    expect(resolved.sources.fields.review).toContain(".pipr/config.yaml#review");
    expect(resolved.sources.fields.default_provider).toContain(
      ".pipr/config.yaml#default_provider",
    );
  });

  it("requires default_provider to reference a provider id", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    await writePiprConfig(rootDir, [
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

  it("loads user registry modules from .pipr with source locations", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    await writePiprConfig(rootDir, ["version: 1"]);
    await writePiprRegistry(rootDir, [
      "agents:",
      "  - id: reviewer",
      "    description: Custom reviewer",
      "blocks:",
      "  - id: custom.block",
      "    description: Custom block",
    ]);

    const resolved = await loadConfig({ rootDir });

    expect(resolved.modules.agents?.[0]).toMatchObject({
      id: "reviewer",
      description: "Custom reviewer",
    });
    expect(resolved.sources.modules.agents?.reviewer).toContain(
      ".pipr/registry.yaml#agents.reviewer",
    );
    expect(resolved.sources.modules.blocks?.["custom.block"]).toContain(
      ".pipr/registry.yaml#blocks.custom.block",
    );
  });

  it("tracks runtime defaults when config opts out of builtin:minimal", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    await writePiprConfig(rootDir, [
      "version: 1",
      "extends: []",
      "default_provider: deepseek",
      "providers:",
      "  - id: deepseek",
      "    model: deepseek-v4-pro",
      "    api_key_env: DEEPSEEK_API_KEY",
    ]);

    const resolved = await loadConfig({ rootDir });

    expect(resolved.config.review.max_inline_comments).toBe(5);
    expect(resolved.sources.fields.review).toBe("runtime:defaults#review");
    expect(resolved.sources.fields.extends).toContain(".pipr/config.yaml#extends");
  });

  it("fails invalid config YAML with the config path", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    await mkdir(path.join(rootDir, ".pipr"));
    await writeFile(path.join(rootDir, ".pipr", "config.yaml"), "version: [");

    await expect(loadConfig({ rootDir })).rejects.toThrow(".pipr/config.yaml");
  });
});
