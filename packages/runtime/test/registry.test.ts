import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createRuntimeRegistry, renderRegistryGraph } from "../src/registry.js";
import { writePiprConfig, writePiprRegistry } from "./helpers.js";

describe("runtime registry", () => {
  it("overrides built-in entries with user modules by id", async () => {
    const resolved = await loadRegistry([
      "agents:",
      "  - id: reviewer",
      "    description: Custom reviewer",
      "workflows:",
      "  - id: review",
      "    description: Custom review workflow",
      "    events:",
      "      - pull_request.opened",
      "    steps:",
      "      - block: custom.block",
      "        output: result",
      "blocks:",
      "  - id: custom.block",
      "    description: Custom block",
    ]);
    const registry = createRuntimeRegistry(resolved);

    expect(registry.agents.find((entry) => entry.id === "reviewer")).toMatchObject({
      description: "Custom reviewer",
      source: expect.stringContaining(".pipr/registry.yaml"),
    });
    expect(registry.workflows.find((entry) => entry.id === "review")).toMatchObject({
      description: "Custom review workflow",
      steps: [{ block: "custom.block", output: "result" }],
    });
  });

  it("fails duplicate IDs in the same source", async () => {
    const resolved = await loadRegistry([
      "blocks:",
      "  - id: custom.block",
      "    description: First",
      "  - id: custom.block",
      "    description: Second",
    ]);

    expect(() => createRuntimeRegistry(resolved)).toThrow("Duplicate blocks id 'custom.block' in");
  });

  it("fails workflow references to unknown blocks", async () => {
    const resolved = await loadRegistry([
      "workflows:",
      "  - id: review",
      "    description: Bad workflow",
      "    events:",
      "      - pull_request.opened",
      "    steps:",
      "      - block: missing.block",
      "        output: result",
    ]);

    expect(() => createRuntimeRegistry(resolved)).toThrow(
      "workflow 'review' references unknown block 'missing.block'",
    );
  });

  it("fails unsafe workflow paths before execution", async () => {
    const resolved = await loadRegistry([
      "workflows:",
      "  - id: review",
      "    description: Bad workflow",
      "    steps:",
      "      - block: custom.block",
      "        output: __proto__.polluted",
      "blocks:",
      "  - id: custom.block",
      "    description: Custom block",
    ]);

    expect(() => createRuntimeRegistry(resolved)).toThrow(
      "Unsafe workflow path segment '__proto__'",
    );
  });

  it("fails declarative block cycles", async () => {
    const resolved = await loadRegistry([
      "blocks:",
      "  - id: first.block",
      "    description: First block",
      "    steps:",
      "      - block: second.block",
      "  - id: second.block",
      "    description: Second block",
      "    steps:",
      "      - block: first.block",
    ]);

    expect(() => createRuntimeRegistry(resolved)).toThrow(
      "declarative block cycle 'first.block -> second.block -> first.block'",
    );
  });

  it("renders workflow and block composition in graph output", async () => {
    const registry = createRuntimeRegistry();

    expect(renderRegistryGraph(registry)).toContain("review.default");
    expect(renderRegistryGraph(registry)).toContain("-> context.diff_manifest");
  });
});

async function loadRegistry(lines: string[]) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-registry-"));
  await writePiprConfig(rootDir, ["version: 1"]);
  await writePiprRegistry(rootDir, lines);
  return await loadConfig({ rootDir });
}
