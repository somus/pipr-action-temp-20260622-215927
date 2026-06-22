import { access, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initOfficialMinimalProject, listOfficialMinimalFiles } from "../init.js";
import { validateProject } from "../project.js";

describe("initOfficialMinimalProject", () => {
  it("creates the official minimal .pipr tree and validates it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    const result = await initOfficialMinimalProject({ rootDir });
    const validation = await validateProject({ rootDir });

    expect(result.created.sort()).toEqual(listOfficialMinimalFiles().sort());
    expect(result.overwritten).toEqual([]);
    expect(await readFile(path.join(rootDir, ".pipr", "config.ts"), "utf8")).toContain(
      "pipr.review",
    );
    expect(await readFile(path.join(rootDir, ".pipr", "tsconfig.json"), "utf8")).toContain(
      "moduleResolution",
    );
    const sdkTypes = await readFile(path.join(rootDir, ".pipr", "types", "pipr-sdk.d.ts"), "utf8");
    expect(sdkTypes).toContain('declare module "@pipr/sdk"');
    expect(sdkTypes).toContain("readonly id: symbol;");
    expect(sdkTypes).toContain("readonly apiKey?: SecretRef;");
    expect(sdkTypes).toContain("readonly options?: Record<string, unknown>;");
    expect(sdkTypes).not.toContain("piprSdkDeclaration");
    expect(sdkTypes).toBe(
      await readFile(path.join(repoRoot(), ".pipr", "types", "pipr-sdk.d.ts"), "utf8"),
    );
    expect(await listFiles(path.join(rootDir, ".pipr"))).toEqual([
      "config.ts",
      "tsconfig.json",
      "types/pipr-sdk.d.ts",
    ]);
    await expect(access(path.join(rootDir, ".pipr", "agents"))).rejects.toThrow();
    await expect(access(path.join(rootDir, ".pipr", "workflows"))).rejects.toThrow();
    await expect(access(path.join(rootDir, ".pipr", "comments"))).rejects.toThrow();
    expect(validation.kind).toBe("typescript");
    expect(validation.settings.config.defaultProvider).toBe("deepseek");
    expect(validation.settings.config.publication.maxInlineComments).toBe(5);
  });

  it("refuses to overwrite existing pipr files without force", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    await mkdir(path.join(rootDir, ".pipr"), { recursive: true });
    await writeFile(path.join(rootDir, ".pipr", "config.ts"), "custom: true\n");

    await expect(initOfficialMinimalProject({ rootDir })).rejects.toThrow(
      "Use --force to replace existing .pipr files",
    );
    await expect(readFile(path.join(rootDir, ".pipr", "config.ts"), "utf8")).resolves.toBe(
      "custom: true\n",
    );
  });

  it("overwrites official target files when force is explicit", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    await mkdir(path.join(rootDir, ".pipr"), { recursive: true });
    await writeFile(path.join(rootDir, ".pipr", "config.ts"), "custom: true\n");

    const result = await initOfficialMinimalProject({ rootDir, force: true });

    expect(result.overwritten).toEqual(["config.ts"]);
    expect(await readFile(path.join(rootDir, ".pipr", "config.ts"), "utf8")).toContain(
      "definePipr",
    );
  });

  it("rejects symlinked target parent directories", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-outside-"));
    await mkdir(path.join(rootDir, ".pipr"), { recursive: true });
    await symlink(outsideDir, path.join(rootDir, ".pipr", "types"));

    await expect(initOfficialMinimalProject({ rootDir, force: true })).rejects.toThrow(
      "symbolic links are not supported",
    );
    await expect(readFile(path.join(outsideDir, "pipr-sdk.d.ts"), "utf8")).rejects.toThrow();
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

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
}

async function listFiles(rootDir: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  const pending = [prefix];
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    for (const entry of await readdir(path.join(rootDir, current), { withFileTypes: true })) {
      const relativePath = current ? path.join(current, entry.name) : entry.name;
      if (entry.isDirectory()) {
        pending.push(relativePath);
      } else {
        files.push(relativePath.split(path.sep).join("/"));
      }
    }
  }
  return files.sort();
}
