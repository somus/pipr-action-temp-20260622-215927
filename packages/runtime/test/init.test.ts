import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMaterializedProject } from "../src/config.js";
import { initOfficialMinimalProject, listOfficialMinimalFiles } from "../src/init.js";
import { validateProject } from "../src/project.js";

describe("initOfficialMinimalProject", () => {
  it("creates the official minimal .pipr tree and validates it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    const result = await initOfficialMinimalProject({ rootDir });
    const project = await loadMaterializedProject({ rootDir });
    const validation = await validateProject({ rootDir });

    expect(result.created.sort()).toEqual(listOfficialMinimalFiles().sort());
    expect(result.overwritten).toEqual([]);
    expect(project.config.limits?.timeoutSeconds).toBe(300);
    expect(project.config.publication?.maxInlineComments).toBeUndefined();
    expect(project.components.map((component) => component.id).sort()).toEqual([
      "pipr/main",
      "pipr/pr-review",
      "pipr/review",
      "pipr/review-default",
      "pipr/reviewer",
    ]);
    expect(validation.kind).toBe("materialized");
    expect(validation.resolved.config.defaultProvider).toBe("deepseek");
    expect(validation.resolved.config.limits?.timeoutSeconds).toBe(300);
    expect(validation.resolved.config.publication.maxInlineComments).toBe(5);
  });

  it("refuses to overwrite existing pipr files without force", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    await mkdir(path.join(rootDir, ".pipr"), { recursive: true });
    await writeFile(path.join(rootDir, ".pipr", "config.yaml"), "custom: true\n");

    await expect(initOfficialMinimalProject({ rootDir })).rejects.toThrow(
      "Use --force to replace existing .pipr files",
    );
    await expect(readFile(path.join(rootDir, ".pipr", "config.yaml"), "utf8")).resolves.toBe(
      "custom: true\n",
    );
  });

  it("overwrites official target files when force is explicit", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    await mkdir(path.join(rootDir, ".pipr"), { recursive: true });
    await writeFile(path.join(rootDir, ".pipr", "config.yaml"), "custom: true\n");

    const result = await initOfficialMinimalProject({ rootDir, force: true });

    expect(result.overwritten).toEqual(["config.yaml"]);
    expect(await readFile(path.join(rootDir, ".pipr", "config.yaml"), "utf8")).toContain(
      "apiVersion: pipr.dev/v1",
    );
  });

  it("rejects symlinked target parent directories", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-outside-"));
    await mkdir(path.join(rootDir, ".pipr"), { recursive: true });
    await symlink(outsideDir, path.join(rootDir, ".pipr", "comments"));

    await expect(initOfficialMinimalProject({ rootDir, force: true })).rejects.toThrow(
      "symbolic links are not supported",
    );
    await expect(readFile(path.join(outsideDir, "main.yaml"), "utf8")).rejects.toThrow();
  });

  it("rejects configDir paths outside the repo root", async () => {
    const parentDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    const rootDir = path.join(parentDir, "repo");
    await mkdir(rootDir);

    await expect(
      initOfficialMinimalProject({ rootDir, configDir: "../outside/.pipr" }),
    ).rejects.toThrow("configDir must be inside rootDir");
  });
});
