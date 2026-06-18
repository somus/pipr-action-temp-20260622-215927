import { describe, expect, it } from "vitest";
import { createRuntimeRegistry, renderRegistryGraph } from "../src/registry.js";
import type { RuntimeModuleSet } from "../src/types.js";

describe("runtime registry", () => {
  it("overrides built-in entries with runtime modules by id", () => {
    const registry = createRegistry({
      agents: [{ id: "reviewer", description: "Custom reviewer", source: "test" }],
      workflows: [
        {
          id: "review",
          description: "Custom review workflow",
          source: "test",
          events: ["pull_request.opened"],
          steps: [{ block: "custom.block", output: "result" }],
        },
      ],
      blocks: [{ id: "custom.block", description: "Custom block", source: "test" }],
    });

    expect(registry.agents.find((entry) => entry.id === "reviewer")).toMatchObject({
      description: "Custom reviewer",
      source: "test",
    });
    expect(registry.workflows.find((entry) => entry.id === "review")).toMatchObject({
      description: "Custom review workflow",
      steps: [{ block: "custom.block", output: "result" }],
    });
  });

  it("fails duplicate IDs in the same source", () => {
    expect(() =>
      createRegistry({
        blocks: [
          { id: "custom.block", description: "First", source: "test" },
          { id: "custom.block", description: "Second", source: "test" },
        ],
      }),
    ).toThrow("Duplicate blocks id 'custom.block' in test");
  });

  it("fails workflow references to unknown blocks", () => {
    expect(() =>
      createRegistry({
        workflows: [
          {
            id: "review",
            description: "Bad workflow",
            source: "test",
            events: ["pull_request.opened"],
            steps: [{ block: "missing.block", output: "result" }],
          },
        ],
      }),
    ).toThrow("workflow 'review' references unknown block 'missing.block'");
  });

  it("fails unsafe workflow paths before execution", () => {
    expect(() =>
      createRegistry({
        workflows: [
          {
            id: "review",
            description: "Bad workflow",
            source: "test",
            events: [],
            steps: [{ block: "custom.block", output: "__proto__.polluted" }],
          },
        ],
        blocks: [{ id: "custom.block", description: "Custom block", source: "test" }],
      }),
    ).toThrow("Unsafe workflow path segment '__proto__'");
  });

  it("fails declarative block cycles", () => {
    expect(() =>
      createRegistry({
        blocks: [
          {
            id: "first.block",
            description: "First block",
            source: "test",
            steps: [{ block: "second.block" }],
          },
          {
            id: "second.block",
            description: "Second block",
            source: "test",
            steps: [{ block: "first.block" }],
          },
        ],
      }),
    ).toThrow("declarative block cycle 'first.block -> second.block -> first.block'");
  });

  it("renders workflow and block composition in graph output", () => {
    const registry = createRegistry({
      workflows: [
        {
          id: "pipr/review",
          description: "Review workflow",
          source: "test",
          events: ["pull_request.opened"],
          steps: [{ block: "pipr/review-default", output: "validated_review" }],
        },
      ],
      blocks: [
        {
          id: "pipr/review-default",
          description: "Review block",
          source: "test",
          steps: [{ block: "core/diff-manifest", output: "diff_manifest" }],
        },
      ],
    });

    expect(renderRegistryGraph(registry)).toContain("pipr/review");
    expect(renderRegistryGraph(registry)).toContain("-> core/diff-manifest");
  });
});

function createRegistry(modules: RuntimeModuleSet) {
  return createRuntimeRegistry({ modules });
}
