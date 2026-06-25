import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initOfficialMinimalProject, listOfficialMinimalFiles } from "../init.js";
import { inspectRuntimePlan, validateProject } from "../project.js";
import { listOfficialInitRecipes, supportedOfficialInitRecipes } from "../recipes.js";

const configOnlyInitFiles = [
  path.join(".pipr", "config.ts"),
  path.join(".pipr", "tsconfig.json"),
  path.join(".pipr", "types", "pipr-sdk.d.ts"),
];

describe("initOfficialMinimalProject", () => {
  it("creates the official minimal .pipr tree and validates it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    const result = await initOfficialMinimalProject({ rootDir });
    const validation = await validateProject({ rootDir });

    expect(result.created.sort()).toEqual(listOfficialMinimalFiles().sort());
    expect(result.overwritten).toEqual([]);
    expect(await Bun.file(path.join(rootDir, ".pipr", "config.ts")).text()).toContain(
      "pipr.review",
    );
    expect(await Bun.file(path.join(rootDir, ".pipr", "tsconfig.json")).text()).toContain(
      "moduleResolution",
    );
    const sdkTypes = await Bun.file(path.join(rootDir, ".pipr", "types", "pipr-sdk.d.ts")).text();
    expect(sdkTypes).toContain('declare module "@pipr/sdk"');
    expect(sdkTypes).toContain('declare module "@pipr/sdk/review"');
    expect(sdkTypes).toContain('declare module "@pipr/sdk/tools"');
    expect(sdkTypes).toContain("reviewResultSchema");
    expect(sdkTypes).toContain("reviewFindingSchema");
    expect(sdkTypes).toContain("reviewSummarySchema");
    expect(sdkTypes).toContain("readonly id: string;");
    expect(sdkTypes).toContain("readonly apiKey?: SecretRef;");
    expect(sdkTypes).toContain("readonly options?: Record<string, unknown>;");
    expect(sdkTypes).toContain("const z:");
    expect(sdkTypes).toContain("type ZodSchema<T>");
    expect(sdkTypes).toContain("schema<T>");
    expect(sdkTypes).toContain("jsonSchema<T>");
    expect(sdkTypes).not.toContain('from "zod"');
    expect(sdkTypes).not.toContain("z.ZodType");
    const workflow = await Bun.file(path.join(rootDir, ".github", "workflows", "pipr.yml")).text();
    expect(workflow).toContain("uses: somus/pipr@main");
    expect(workflow).toContain("checks: write");
    expect(workflow).toContain("pull_request_review_comment:");
    expect(workflow).toContain("types: [created]");
    expect(workflow).not.toContain("config-dir:");
    expect([...workflow.matchAll(/^ {8}with:$/gm)]).toHaveLength(1);
    expect(workflow).not.toContain("provider-id:");
    expect(workflow).not.toContain("provider: deepseek");
    expect(workflow).not.toContain("model: deepseek-v4-pro");
    expect(workflow).not.toContain("api-key-env: DEEPSEEK_API_KEY");
    expect(workflow).toContain("DEEPSEEK_API_KEY:");
    expect(workflow).toContain("secrets.DEEPSEEK_API_KEY");
    expect(await listFiles(rootDir)).toEqual([
      ".github/workflows/pipr.yml",
      ".pipr/config.ts",
      ".pipr/tsconfig.json",
      ".pipr/types/pipr-sdk.d.ts",
    ]);
    expect(await listFiles(path.join(rootDir, ".pipr"))).toEqual([
      "config.ts",
      "tsconfig.json",
      "types/pipr-sdk.d.ts",
    ]);
    expect(validation.kind).toBe("typescript");
    expect(validation.settings.config.defaultProvider).toBe("deepseek/deepseek-v4-pro");
    expect(validation.settings.config.publication.maxInlineComments).toBe(5);
  });

  it("can initialize only the pipr config files without adapter files", async () => {
    const { rootDir, result, validation } = await initializedConfigOnlyProject();

    expect(result.created.sort()).toEqual(configOnlyInitFiles);
    expect(result.overwritten).toEqual([]);
    expect(await listFiles(rootDir)).toEqual([
      ".pipr/config.ts",
      ".pipr/tsconfig.json",
      ".pipr/types/pipr-sdk.d.ts",
    ]);
    expect(validation.kind).toBe("typescript");
  });

  it("initializes every official recipe and validates the generated config", async () => {
    expect(listOfficialInitRecipes().map((recipe) => recipe.id)).toEqual([
      ...supportedOfficialInitRecipes,
    ]);

    for (const recipe of supportedOfficialInitRecipes) {
      const { rootDir, result, validation } = await initializedConfigOnlyProject(recipe);

      expect(result.created.sort()).toEqual(configOnlyInitFiles);
      expect(result.overwritten).toEqual([]);
      expect(validation.kind).toBe("typescript");
      expect(await Bun.file(path.join(rootDir, ".pipr", "config.ts")).text()).toContain(
        "definePipr",
      );
    }
  });

  it("initializes advanced recipes with inspectable agents, tools, commands, and locals", async () => {
    const multiAgentRootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-multi-agent-"));
    const pluginRootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-plugin-tool-"));
    const commandRootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-command-"));

    await initOfficialMinimalProject({
      rootDir: multiAgentRootDir,
      adapters: [],
      recipe: "multi-agent-review",
    });
    await initOfficialMinimalProject({
      rootDir: pluginRootDir,
      adapters: [],
      recipe: "plugin-tool-review",
    });
    await initOfficialMinimalProject({
      rootDir: commandRootDir,
      adapters: [],
      recipe: "interactive-ask",
    });

    const multiAgent = await validateProject({ rootDir: multiAgentRootDir });
    const pluginTool = await validateProject({ rootDir: pluginRootDir });
    const command = await validateProject({ rootDir: commandRootDir });

    expect(inspectRuntimePlan(multiAgent.plan, ".pipr/config.ts").agents).toEqual(
      expect.arrayContaining([
        "security-specialist",
        "test-specialist",
        "maintainability-specialist",
        "review-aggregator",
      ]),
    );
    expect(inspectRuntimePlan(pluginTool.plan, ".pipr/config.ts").tools).toEqual(["owner_lookup"]);
    expect(inspectRuntimePlan(command.plan, ".pipr/config.ts").commands).toEqual([
      {
        pattern: "@pipr ask <question...>",
        task: "interactive-ask",
        permission: "read",
      },
    ]);
  });

  it("generates SDK types that preserve optional Zod object fields", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    await initOfficialMinimalProject({ rootDir });
    await Bun.write(
      path.join(rootDir, ".pipr", "config.ts"),
      `import { definePipr, z } from "@pipr/sdk";

export default definePipr((pipr) => {
  pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
  });

  const summary = pipr.schema({
    id: "custom/summary",
    schema: z.strictObject({
      title: z.string().optional(),
      body: z.string(),
    }),
  });

  const validSummary: ReturnType<typeof summary.parse> = { body: "ok" };
  void validSummary;
});
`,
    );

    const validation = await validateProject({ rootDir });
    expect(validation.kind).toBe("typescript");
  });

  it("refuses to overwrite existing pipr files without force", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    await mkdir(path.join(rootDir, ".pipr"), { recursive: true });
    await Bun.write(path.join(rootDir, ".pipr", "config.ts"), "custom: true\n");

    await expect(initOfficialMinimalProject({ rootDir })).rejects.toThrow(
      "Use --force to replace existing .pipr files",
    );
    await expect(Bun.file(path.join(rootDir, ".pipr", "config.ts")).text()).resolves.toBe(
      "custom: true\n",
    );
  });

  it("overwrites official target files when force is explicit", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    await mkdir(path.join(rootDir, ".pipr"), { recursive: true });
    await Bun.write(path.join(rootDir, ".pipr", "config.ts"), "custom: true\n");

    const result = await initOfficialMinimalProject({ rootDir, force: true });

    expect(result.overwritten).toEqual([path.join(".pipr", "config.ts")]);
    expect(await Bun.file(path.join(rootDir, ".pipr", "config.ts")).text()).toContain("definePipr");
  });

  it("creates the GitHub workflow with the selected config directory", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    const result = await initOfficialMinimalProject({ rootDir, configDir: "config/pipr" });
    const workflow = await Bun.file(path.join(rootDir, ".github", "workflows", "pipr.yml")).text();

    expect(result.created).toContain(path.join(".github", "workflows", "pipr.yml"));
    expect(workflow).toContain("config-dir: config/pipr");
    expect([...workflow.matchAll(/^ {8}with:$/gm)]).toHaveLength(2);
    expect(await Bun.file(path.join(rootDir, "config", "pipr", "config.ts")).text()).toContain(
      "pipr.review",
    );
  });

  it("refuses and force-overwrites an existing GitHub workflow", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    await mkdir(path.join(rootDir, ".github", "workflows"), { recursive: true });
    await Bun.write(path.join(rootDir, ".github", "workflows", "pipr.yml"), "custom: true\n");

    await expect(initOfficialMinimalProject({ rootDir })).rejects.toThrow(
      "Use --force to replace existing .pipr files",
    );
    await expect(
      Bun.file(path.join(rootDir, ".github", "workflows", "pipr.yml")).text(),
    ).resolves.toBe("custom: true\n");

    const result = await initOfficialMinimalProject({ rootDir, force: true });

    expect(result.overwritten).toEqual([path.join(".github", "workflows", "pipr.yml")]);
    expect(await Bun.file(path.join(rootDir, ".github", "workflows", "pipr.yml")).text()).toContain(
      "uses: somus/pipr@main",
    );
  });

  it("does not conflict with an existing GitHub workflow when no adapter is selected", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    await mkdir(path.join(rootDir, ".github", "workflows"), { recursive: true });
    await Bun.write(path.join(rootDir, ".github", "workflows", "pipr.yml"), "custom: true\n");

    const result = await initOfficialMinimalProject({ rootDir, adapters: [] });

    expect(result.created.sort()).toEqual(configOnlyInitFiles);
    expect(result.overwritten).toEqual([]);
    expect(await Bun.file(path.join(rootDir, ".github", "workflows", "pipr.yml")).text()).toBe(
      "custom: true\n",
    );
  });

  it("rejects unsupported init adapters", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    await expect(initOfficialMinimalProject({ rootDir, adapters: ["gitlab"] })).rejects.toThrow(
      "Unsupported pipr init adapter 'gitlab'. Supported adapters: github",
    );
    await expect(
      initOfficialMinimalProject({ rootDir, adapters: ["none", "github"] }),
    ).rejects.toThrow("Adapter 'none' cannot be mixed with other init adapters");
    await expect(initOfficialMinimalProject({ rootDir, adapters: [""] })).rejects.toThrow(
      "Unsupported pipr init adapter ''. Supported adapters: github",
    );
  });

  it("rejects unsupported init recipes", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    await expect(
      initOfficialMinimalProject({ rootDir, adapters: [], recipe: "missing" }),
    ).rejects.toThrow("Unsupported pipr init recipe 'missing'. Supported recipes:");
  });

  it("rejects symlinked target parent directories", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-outside-"));
    await mkdir(path.join(rootDir, ".pipr"), { recursive: true });
    await symlink(outsideDir, path.join(rootDir, ".pipr", "types"));

    await expect(initOfficialMinimalProject({ rootDir, force: true })).rejects.toThrow(
      "symbolic links are not supported",
    );
    await expect(Bun.file(path.join(outsideDir, "pipr-sdk.d.ts")).text()).rejects.toThrow();
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

async function initializedConfigOnlyProject(recipe?: string): Promise<{
  rootDir: string;
  result: Awaited<ReturnType<typeof initOfficialMinimalProject>>;
  validation: Awaited<ReturnType<typeof validateProject>>;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
  const result = await initOfficialMinimalProject({ rootDir, adapters: [], recipe });
  const validation = await validateProject({ rootDir });
  return { rootDir, result, validation };
}
