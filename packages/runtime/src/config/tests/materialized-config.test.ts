import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMaterializedProject } from "../config.js";
import { initOfficialMinimalProject } from "../init.js";
import { loadRuntimeProject } from "../project.js";

describe("loadMaterializedProject", () => {
  it("loads a conventional pipr.dev/v1 .pipr tree with source locations", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await initOfficialMinimalProject({ rootDir });
    await mkdir(path.join(rootDir, ".pipr", "suggestions"));
    await writeFile(path.join(rootDir, ".pipr", "suggestions", "ignored.yaml"), "not: valid: yaml");
    await writeFile(path.join(rootDir, ".pipr", ".pipr.lock"), "{not json");

    const project = await loadMaterializedProject({ rootDir });

    expect(project.config.providers[0]?.id).toBe("deepseek");
    expect(project.sources.config).toContain(".pipr/config.yaml");
    expect(project.components.map((component) => component.id).sort()).toEqual([
      "pipr/default-commands",
      "pipr/main",
      "pipr/pr-review",
      "pipr/review",
      "pipr/reviewer",
    ]);
    expect(project.sources.components["pipr/reviewer"]).toContain(".pipr/agents/reviewer.md");
    expect(project.componentFiles["pipr/reviewer"]?.body).toContain("Review the pull request diff");
  });

  it("loads from a custom configDir", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    const configRoot = path.join(rootDir, "config-root");
    await initOfficialMinimalProject({ rootDir: configRoot });

    const project = await loadMaterializedProject({ rootDir, configDir: "config-root/.pipr" });

    expect(project.sources.config).toContain("config-root/.pipr/config.yaml");
    expect(project.componentFiles["pipr/reviewer"]?.source).toContain(
      "config-root/.pipr/agents/reviewer.md",
    );
  });

  it("rejects configDir paths outside the repo root", async () => {
    const parentDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    const rootDir = path.join(parentDir, "repo");
    await mkdir(rootDir);

    await expect(
      loadMaterializedProject({ rootDir, configDir: "../outside/.pipr" }),
    ).rejects.toThrow("configDir must be inside rootDir");
  });

  it("builds the runtime registry from the materialized Review Workflow", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await initOfficialMinimalProject({ rootDir });

    const runtime = await loadRuntimeProject({ rootDir });
    const workflowIds = runtime.registry.workflows.map((workflow) => workflow.id);
    const blockIds = runtime.registry.blocks.map((block) => block.id);
    const commandIds = runtime.registry.commands.map((command) => command.id);

    expect(workflowIds).toEqual(["pipr/review"]);
    expect(commandIds).toEqual(["pipr/default-commands"]);
    expect(blockIds).toContain("core/run-agent");
    expect(blockIds).not.toContain("pipr/review-default");
    expect(blockIds).not.toContain("core/diff-manifest");
    expect(blockIds).not.toContain("core/validate-pr-review");
    expect(blockIds).not.toContain("context.diff_manifest");
    expect(blockIds).not.toContain("agent.run");
    expect(runtime.resolved.sources.modules.workflows?.["pipr/review"]).toContain(
      ".pipr/workflows/review.yaml",
    );
    expect(runtime.resolved.sources.modules.commands?.["pipr/default-commands"]).toContain(
      ".pipr/commands/default.yaml",
    );
  });

  it("only registers workflows enabled by config", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await initOfficialMinimalProject({ rootDir });
    await writeFile(
      path.join(rootDir, ".pipr", "workflows", "hijack.yaml"),
      [
        "apiVersion: pipr.dev/v1",
        "kind: Workflow",
        "id: pipr/hijack",
        "on:",
        "  - pull_request.opened",
        "steps:",
        "  - id: review",
        "    uses: core/run-agent",
      ].join("\n"),
    );

    const runtime = await loadRuntimeProject({ rootDir });

    expect(runtime.registry.workflows.map((workflow) => workflow.id)).toEqual(["pipr/review"]);
    expect(runtime.resolved.sources.modules.workflows).toEqual({
      "pipr/review": expect.stringContaining(".pipr/workflows/review.yaml"),
    });
  });

  it("only registers commands enabled by config", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await initOfficialMinimalProject({ rootDir });
    await writeFile(
      path.join(rootDir, ".pipr", "commands", "extra.yaml"),
      [
        "apiVersion: pipr.dev/v1",
        "kind: CommandSet",
        "id: pipr/extra-commands",
        "commands:",
        "  - id: review",
        "    aliases: ['@pipr extra']",
        "    run:",
        "      workflows: [pipr/review]",
      ].join("\n"),
    );

    const runtime = await loadRuntimeProject({ rootDir });

    expect(runtime.registry.commands.map((command) => command.id)).toEqual([
      "pipr/default-commands",
    ]);
  });

  it("fails when config.yaml is missing", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await mkdir(path.join(rootDir, ".pipr"), { recursive: true });

    await expect(loadMaterializedProject({ rootDir })).rejects.toThrow(
      ".pipr/config.yaml is required",
    );
  });

  it("fails invalid component YAML with the source path", async () => {
    await expectMaterializedProjectErrorFromFile("workflows/bad.yaml", "apiVersion: [");
  });

  it("fails invalid agent frontmatter with the source path", async () => {
    await expectMaterializedProjectErrorFromFile(
      "agents/bad.md",
      ["---", "apiVersion: [", "---", "body"].join("\n"),
    );
  });

  it("fails invalid schema JSON with the source path", async () => {
    await expectMaterializedProjectErrorFromFile("schemas/bad.schema.json", "{");
  });

  it("fails invalid command YAML with the source path", async () => {
    await expectMaterializedProjectErrorFromFile("commands/bad.yaml", "apiVersion: [");
  });

  it("fails malformed CommandSet documents with the source path", async () => {
    await expectMaterializedProjectErrorFromFile(
      "commands/bad.yaml",
      [
        "apiVersion: pipr.dev/v1",
        "kind: CommandSet",
        "id: pipr/bad-commands",
        "commands:",
        "  - id: review",
        "    aliases: []",
      ].join("\n"),
    );
  });

  it("rejects secret-looking values in agent Markdown bodies", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await initOfficialMinimalProject({ rootDir });
    await writeFile(
      path.join(rootDir, ".pipr", "agents", "leaky.md"),
      [
        "---",
        "apiVersion: pipr.dev/v1",
        "kind: Agent",
        "id: pipr/leaky-reviewer",
        "provider: deepseek",
        "output:",
        "  schema: pipr/pr-review",
        "---",
        "",
        "Use sk-secret00000000 for testing.",
      ].join("\n"),
    );

    await expect(loadMaterializedProject({ rootDir })).rejects.toThrow("Raw secret-looking value");
  });

  it("rejects Agent tool refs when no plugin tool definition exists", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await initOfficialMinimalProject({ rootDir });
    await writeFile(
      path.join(rootDir, ".pipr", "agents", "reviewer.md"),
      [
        "---",
        "apiVersion: pipr.dev/v1",
        "kind: Agent",
        "id: pipr/reviewer",
        "provider: deepseek",
        "tools:",
        "  - plugin/custom-review-tool",
        "output:",
        "  schema: pipr/pr-review",
        "---",
        "",
        "Review the diff.",
      ].join("\n"),
    );

    await expect(loadMaterializedProject({ rootDir })).rejects.toThrow(
      "Agent 'pipr/reviewer' references unknown tool 'plugin/custom-review-tool'",
    );
  });

  it("rejects components materialized in the wrong directory", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await initOfficialMinimalProject({ rootDir });
    await writeFile(
      path.join(rootDir, ".pipr", "agents", "workflow.md"),
      [
        "---",
        "apiVersion: pipr.dev/v1",
        "kind: Workflow",
        "id: pipr/wrong-place",
        "steps: []",
        "---",
        "",
        "Not an agent.",
      ].join("\n"),
    );

    await expect(loadMaterializedProject({ rootDir })).rejects.toThrow(
      "expected Agent, got Workflow",
    );
  });

  it("rejects symlinked config files", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-outside-"));
    await initOfficialMinimalProject({ rootDir });
    await writeFile(
      path.join(outsideDir, "config.yaml"),
      "apiVersion: pipr.dev/v1\nkind: Config\n",
    );
    await rm(path.join(rootDir, ".pipr", "config.yaml"));
    await symlink(path.join(outsideDir, "config.yaml"), path.join(rootDir, ".pipr", "config.yaml"));

    await expect(loadMaterializedProject({ rootDir })).rejects.toThrow(
      "symbolic links are not supported",
    );
  });

  it("rejects symlinked .pipr roots", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    const outsideRootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-outside-"));
    await initOfficialMinimalProject({ rootDir: outsideRootDir });
    await symlink(path.join(outsideRootDir, ".pipr"), path.join(rootDir, ".pipr"));

    await expect(loadMaterializedProject({ rootDir })).rejects.toThrow(
      "symbolic links are not supported",
    );
  });

  it("rejects symlinked component directories and files", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-outside-"));
    await initOfficialMinimalProject({ rootDir });
    await rm(path.join(rootDir, ".pipr", "agents"), { recursive: true });
    await mkdir(path.join(outsideDir, "agents"));
    await symlink(path.join(outsideDir, "agents"), path.join(rootDir, ".pipr", "agents"));

    await expect(loadMaterializedProject({ rootDir })).rejects.toThrow(
      "symbolic links are not supported",
    );

    const fileRootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await initOfficialMinimalProject({ rootDir: fileRootDir });
    await writeFile(
      path.join(outsideDir, "workflow.yaml"),
      "apiVersion: pipr.dev/v1\nkind: Workflow\n",
    );
    await symlink(
      path.join(outsideDir, "workflow.yaml"),
      path.join(fileRootDir, ".pipr", "workflows", "linked.yaml"),
    );

    await expect(loadMaterializedProject({ rootDir: fileRootDir })).rejects.toThrow(
      "symbolic links are not supported",
    );
  });
});

async function expectMaterializedProjectErrorFromFile(
  relativePath: string,
  content: string,
): Promise<void> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
  await initOfficialMinimalProject({ rootDir });
  await writeFile(path.join(rootDir, ".pipr", ...relativePath.split("/")), content);

  await expect(loadMaterializedProject({ rootDir })).rejects.toThrow(`.pipr/${relativePath}`);
}
