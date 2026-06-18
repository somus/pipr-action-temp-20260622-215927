import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMaterializedProject } from "../src/config.js";

describe("loadMaterializedProject", () => {
  it("loads a conventional pipr.dev/v1 .pipr tree with source locations", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await writeMinimalTree(rootDir);
    await writeFile(path.join(rootDir, ".pipr", "suggestions", "ignored.yaml"), "not: valid: yaml");
    await writeFile(path.join(rootDir, ".pipr", ".pipr.lock"), "{not json");

    const project = await loadMaterializedProject({ rootDir });

    expect(project.config.providers[0]?.id).toBe("primary");
    expect(project.sources.config).toContain(".pipr/config.yaml");
    expect(project.components.map((component) => component.id).sort()).toEqual([
      "official/default-commands",
      "official/main",
      "official/pr-review",
      "official/review",
      "official/review-default",
      "official/reviewer",
    ]);
    expect(project.sources.components["official/reviewer"]).toContain(".pipr/agents/reviewer.md");
    expect(project.componentFiles["official/reviewer"]?.body).toContain("Review the pull request.");
  });

  it("loads from a custom configDir", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    const configRoot = path.join(rootDir, "config-root");
    await writeMinimalTree(configRoot);

    const project = await loadMaterializedProject({ rootDir, configDir: "config-root/.pipr" });

    expect(project.sources.config).toContain("config-root/.pipr/config.yaml");
    expect(project.componentFiles["official/reviewer"]?.source).toContain(
      "config-root/.pipr/agents/reviewer.md",
    );
  });

  it("fails when config.yaml is missing", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await mkdir(path.join(rootDir, ".pipr"), { recursive: true });

    await expect(loadMaterializedProject({ rootDir })).rejects.toThrow(
      ".pipr/config.yaml is required",
    );
  });

  it("fails invalid component YAML with the source path", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await writeMinimalTree(rootDir);
    await writeFile(path.join(rootDir, ".pipr", "workflows", "bad.yaml"), "apiVersion: [");

    await expect(loadMaterializedProject({ rootDir })).rejects.toThrow(".pipr/workflows/bad.yaml");
  });

  it("fails invalid agent frontmatter with the source path", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await writeMinimalTree(rootDir);
    await writeFile(
      path.join(rootDir, ".pipr", "agents", "bad.md"),
      ["---", "apiVersion: [", "---", "body"].join("\n"),
    );

    await expect(loadMaterializedProject({ rootDir })).rejects.toThrow(".pipr/agents/bad.md");
  });

  it("fails invalid schema JSON with the source path", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await writeMinimalTree(rootDir);
    await writeFile(path.join(rootDir, ".pipr", "schemas", "bad.schema.json"), "{");

    await expect(loadMaterializedProject({ rootDir })).rejects.toThrow(
      ".pipr/schemas/bad.schema.json",
    );
  });

  it("rejects secret-looking values in agent Markdown bodies", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await writeMinimalTree(rootDir);
    await writeFile(
      path.join(rootDir, ".pipr", "agents", "leaky.md"),
      [
        "---",
        "apiVersion: pipr.dev/v1",
        "kind: Agent",
        "id: official/leaky-reviewer",
        "provider: primary",
        "output:",
        "  schema: official/pr-review",
        "---",
        "",
        "Use sk-secret00000000 for testing.",
      ].join("\n"),
    );

    await expect(loadMaterializedProject({ rootDir })).rejects.toThrow("Raw secret-looking value");
  });

  it("rejects components materialized in the wrong directory", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await writeMinimalTree(rootDir);
    await writeFile(
      path.join(rootDir, ".pipr", "agents", "workflow.md"),
      [
        "---",
        "apiVersion: pipr.dev/v1",
        "kind: Workflow",
        "id: official/wrong-place",
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
    await writeMinimalTree(rootDir);
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
    await writeMinimalTree(outsideRootDir);
    await symlink(path.join(outsideRootDir, ".pipr"), path.join(rootDir, ".pipr"));

    await expect(loadMaterializedProject({ rootDir })).rejects.toThrow(
      "symbolic links are not supported",
    );
  });

  it("rejects symlinked component directories and files", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-outside-"));
    await writeMinimalTree(rootDir);
    await rm(path.join(rootDir, ".pipr", "agents"), { recursive: true });
    await mkdir(path.join(outsideDir, "agents"));
    await symlink(path.join(outsideDir, "agents"), path.join(rootDir, ".pipr", "agents"));

    await expect(loadMaterializedProject({ rootDir })).rejects.toThrow(
      "symbolic links are not supported",
    );

    const fileRootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-materialized-"));
    await writeMinimalTree(fileRootDir);
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

async function writeMinimalTree(rootDir: string): Promise<void> {
  const piprDir = path.join(rootDir, ".pipr");
  for (const directory of [
    "workflows",
    "blocks",
    "agents",
    "comments",
    "commands",
    "schemas",
    "suggestions",
  ]) {
    await mkdir(path.join(piprDir, directory), { recursive: true });
  }
  await writeFile(
    path.join(piprDir, "config.yaml"),
    [
      "apiVersion: pipr.dev/v1",
      "kind: Config",
      "providers:",
      "  - id: primary",
      "    provider: anthropic",
      "    model: claude-sonnet",
      "    apiKeyEnv: ANTHROPIC_API_KEY",
      "workflows:",
      "  enabled:",
      "    - official/review",
      "commands:",
      "  enabled:",
      "    - official/default-commands",
      "publication:",
      "  mainCommentTemplate: official/main",
      "  maxInlineComments: 5",
      "limits:",
      "  timeoutSeconds: 300",
      "artifacts:",
      "  enabled: false",
      "plugins: []",
    ].join("\n"),
  );
  await writeFile(
    path.join(piprDir, "workflows", "review.yaml"),
    [
      "apiVersion: pipr.dev/v1",
      "kind: Workflow",
      "id: official/review",
      "on:",
      "  - pull_request.opened",
      "steps:",
      "  - id: review",
      "    uses: official/review-default",
    ].join("\n"),
  );
  await writeFile(
    path.join(piprDir, "blocks", "review-default.yaml"),
    [
      "apiVersion: pipr.dev/v1",
      "kind: Block",
      "id: official/review-default",
      "steps:",
      "  - id: manifest",
      "    uses: core/diff-manifest",
    ].join("\n"),
  );
  await writeFile(
    path.join(piprDir, "agents", "reviewer.md"),
    [
      "---",
      "apiVersion: pipr.dev/v1",
      "kind: Agent",
      "id: official/reviewer",
      "provider: primary",
      "tools:",
      "  - core/read-file",
      "output:",
      "  schema: official/pr-review",
      "---",
      "",
      "Review the pull request.",
    ].join("\n"),
  );
  await writeFile(
    path.join(piprDir, "comments", "main.yaml"),
    [
      "apiVersion: pipr.dev/v1",
      "kind: CommentTemplate",
      "id: official/main",
      "marker: pipr:main-comment",
      "heading: Pi PR Review",
      "sections:",
      "  - id: summary",
      "    title: Summary",
      "    order: 10",
    ].join("\n"),
  );
  await writeFile(
    path.join(piprDir, "commands", "default.yaml"),
    [
      "apiVersion: pipr.dev/v1",
      "kind: CommandSet",
      "id: official/default-commands",
      "commands:",
      "  - id: review",
      "    aliases:",
      "      - '@pipr review'",
      "    run:",
      "      workflows:",
      "        - official/review",
    ].join("\n"),
  );
  await writeFile(
    path.join(piprDir, "schemas", "pr-review.schema.json"),
    JSON.stringify({
      apiVersion: "pipr.dev/v1",
      kind: "Schema",
      id: "official/pr-review",
      schema: { type: "object" },
    }),
  );
}
