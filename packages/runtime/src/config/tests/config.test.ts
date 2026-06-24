import { describe, expect, it } from "bun:test";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initOfficialMinimalProject } from "../init.js";
import {
  inspectRuntimePlan,
  loadRuntimeConfig,
  loadRuntimeProject,
  validateProject,
} from "../project.js";
import { loadTypescriptConfig } from "../ts-loader.js";

describe("loadRuntimeProject", () => {
  it("requires an initialized TypeScript config", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));

    await expect(loadRuntimeProject({ rootDir })).rejects.toThrow(
      ".pipr/config.ts is required. Run pipr init to create it.",
    );
  });

  it("rejects invalid TypeScript config exports", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    await mkdir(path.join(rootDir, ".pipr"));
    await Bun.write(path.join(rootDir, ".pipr", "config.ts"), "export default {};\n");

    await expect(loadRuntimeProject({ rootDir })).rejects.toThrow(
      "default export must be created by definePipr()",
    );
  });

  it("normalizes TypeScript model config for current runtime execution", async () => {
    const rootDir = await newInitializedProject();

    const settings = await loadRuntimeConfig({ rootDir });

    expect(settings.source).toContain(".pipr/config.ts");
    expect(settings.config.defaultProvider).toBe("deepseek");
    expect(settings.config.providers[0]).toMatchObject({
      id: "deepseek",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      thinking: "high",
    });
    expect(settings.config.publication.maxInlineComments).toBe(5);
  });

  it("checks provider env vars only when requested", async () => {
    const rootDir = await newInitializedProject();

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

  it("type-checks .pipr/config.ts during validation", async () => {
    const rootDir = await newInitializedProject();
    await writePiprConfig(
      rootDir,
      `import { definePipr } from "@pipr/sdk";

export default definePipr((pipr) => {
  const model: string = pipr.model("deepseek/deepseek-v4-pro", {
    name: "deepseek",
    apiKey: pipr.secret("DEEPSEEK_API_KEY"),
  });

  pipr.review({
    id: "review",
    model,
    instructions: "Review this change.",
  });
});
`,
    );

    await expect(validateProject({ rootDir })).rejects.toThrow("TypeScript config check failed");
  });

  it("can load a TypeScript config without type-checking it", async () => {
    const rootDir = await newInitializedProject();
    await writePiprConfig(
      rootDir,
      `import { definePipr } from "@pipr/sdk";

export default definePipr((pipr) => {
  const model: string = pipr.model("deepseek/deepseek-v4-pro", {
    name: "deepseek",
    apiKey: pipr.secret("DEEPSEEK_API_KEY"),
  });

  pipr.review({
    id: "review",
    model,
    instructions: "Review this change.",
  });
});
`,
    );

    await expect(loadTypescriptConfig({ rootDir, typecheck: false })).resolves.toMatchObject({
      source: path.join(rootDir, ".pipr", "config.ts"),
    });
  });

  it("requires tsconfig.json when type-checking a TypeScript config", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    await mkdir(path.join(rootDir, ".pipr"));
    await writePiprConfig(
      rootDir,
      `import { definePipr } from "@pipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", {
    name: "deepseek",
    apiKey: pipr.secret("DEEPSEEK_API_KEY"),
  });
  pipr.review({ id: "review", model, instructions: "Review this change." });
});
`,
    );

    await expect(loadTypescriptConfig({ rootDir, typecheck: true })).rejects.toThrow(
      ".pipr/tsconfig.json is required for pipr check",
    );
  });

  it("rejects async TypeScript config callbacks", async () => {
    const rootDir = await newInitializedProject();
    await writePiprConfig(
      rootDir,
      `import { definePipr } from "@pipr/sdk";

export default definePipr(async () => {});
`,
    );

    await expect(loadTypescriptConfig({ rootDir })).rejects.toThrow(
      "definePipr configuration callback must be synchronous",
    );
  });

  it("type-checks user plugins and lists registered custom tools", async () => {
    const rootDir = await newInitializedProject();
    await writePiprConfig(
      rootDir,
      `import { definePipr, definePlugin } from "@pipr/sdk";

export default definePipr((pipr) => {
  const memory = pipr.use(definePlugin((pluginPipr) => ({
    store: pluginPipr.tool({
      name: "pipr_store_memory",
      description: "Store reviewer memory.",
      input: pluginPipr.schemas.summary,
      output: pluginPipr.schemas.summary,
      execute: async (_ctx, input) => input,
    }),
    search: pluginPipr.tool({
      name: "pipr_search_memories",
      description: "Search reviewer memories.",
      input: pluginPipr.schemas.summary,
      output: pluginPipr.schemas.summary,
      execute: async (_ctx, input) => input,
    }),
  })));
  const model = pipr.model("deepseek/deepseek-v4-pro", {
    name: "deepseek",
    apiKey: pipr.secret("DEEPSEEK_API_KEY"),
  });
  const agent = pipr.agent({
    name: "reviewer",
    model,
    instructions: "Review.",
    output: pipr.schemas.review,
    tools: [...pipr.tools.readOnly, memory.store, memory.search],
    prompt: (input: { manifest: unknown }, context) => {
      void context.change.title;
      return pipr.prompt\`Review \${input.manifest}\`;
    },
  });
  const task = pipr.task("review", async (ctx) => {
    const manifest = await ctx.change.diffManifest({ compressed: true, maxPreviewLines: 1 });
    const result = await ctx.pi.run(agent, { manifest });
    await ctx.comment({ main: ctx.change.title, inlineFindings: result.inlineFindings });
  });
  pipr.on.changeRequest(["opened"], task);
  pipr.command("@pipr review", { permission: "write" }, task);
  pipr.local("review", task);
  pipr.review({
    id: "default-review",
    model,
    instructions: "Review.",
    command: false,
    on: false,
    localName: false,
  });
});
`,
    );

    const loaded = await validateProject({ rootDir });
    expect(inspectRuntimePlan(loaded.plan, ".pipr/config.ts").tools).toEqual([
      "pipr_store_memory",
      "pipr_search_memories",
    ]);
  });

  it("loads SDK subpath imports from the runtime stub", async () => {
    const rootDir = await newInitializedProject();
    await writePiprConfig(
      rootDir,
      `import { definePipr } from "@pipr/sdk";
import { schemas } from "@pipr/sdk/review";
import { renderPromptValue } from "@pipr/sdk/tools";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", {
    name: "deepseek",
    apiKey: pipr.secret("DEEPSEEK_API_KEY"),
  });
  const reviewer = pipr.agent({
    name: "reviewer",
    model,
    instructions: renderPromptValue("Review."),
    output: schemas.review,
    prompt: () => "Review.",
  });
  const task = pipr.task("review", async () => {});
  pipr.on.changeRequest(["opened"], task);
  void reviewer;
});
`,
    );

    const loaded = await validateProject({ rootDir });

    expect(loaded.plan.agents.map((agent) => agent.name)).toEqual(["reviewer"]);
  });

  it("removes the temporary config copy after loading", async () => {
    const rootDir = await newInitializedProject();

    const loaded = await loadTypescriptConfig({ rootDir });

    await expect(access(loaded.tempRoot)).rejects.toThrow();
  });
});

async function newInitializedProject(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
  await initOfficialMinimalProject({ rootDir });
  return rootDir;
}

async function writePiprConfig(rootDir: string, contents: string): Promise<void> {
  await Bun.write(path.join(rootDir, ".pipr", "config.ts"), contents);
}
