import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initOfficialMinimalProject } from "../src/init.js";
import { loadRuntimeConfig, loadRuntimeProject } from "../src/project.js";

describe("loadRuntimeProject", () => {
  it("requires an initialized materialized config tree", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));

    await expect(loadRuntimeProject({ rootDir })).rejects.toThrow(
      ".pipr/config.yaml is required. Run pipr init to create it.",
    );
  });

  it("rejects old versioned config files", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    await mkdir(path.join(rootDir, ".pipr"));
    await writeFile(path.join(rootDir, ".pipr", "config.yaml"), "version: 1\n");

    await expect(loadRuntimeProject({ rootDir })).rejects.toThrow("Invalid input");
  });

  it("normalizes materialized provider config for current runtime execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    await initOfficialMinimalProject({ rootDir });

    const resolved = await loadRuntimeConfig({ rootDir });

    expect(resolved.source).toContain(".pipr/config.yaml");
    expect(resolved.config.defaultProvider).toBe("deepseek");
    expect(resolved.config.providers[0]).toMatchObject({
      id: "deepseek",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      thinking: "high",
    });
    expect(resolved.config.publication.maxInlineComments).toBe(5);
  });

  it("checks provider env vars only when requested", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    await initOfficialMinimalProject({ rootDir });

    await expect(
      loadRuntimeConfig({ rootDir, env: {}, requireProviderEnv: false }),
    ).resolves.toMatchObject({
      config: {
        defaultProvider: "deepseek",
      },
    });
    await expect(loadRuntimeConfig({ rootDir, env: {}, requireProviderEnv: true })).rejects.toThrow(
      "Missing provider env vars: DEEPSEEK_API_KEY",
    );
  });
});
