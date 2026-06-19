import { describe, expect, it } from "vitest";
import type { RuntimeModuleSet } from "../../types.js";
import { createRuntimeRegistry, renderRegistryGraph } from "../registry.js";

describe("runtime registry", () => {
  it("registers runtime modules without replacing built-ins", () => {
    const registry = createRegistry({
      agents: [{ id: "pipr/reviewer", description: "Custom reviewer", source: "test" }],
      workflows: [
        {
          id: "pipr/review",
          description: "Custom review workflow",
          source: "test",
          events: ["pull_request.opened"],
          steps: [{ id: "review", block: "pipr/custom-block" }],
        },
      ],
      blocks: [{ id: "pipr/custom-block", description: "Custom block", source: "test" }],
    });

    expect(registry.agents.find((entry) => entry.id === "pipr/reviewer")).toMatchObject({
      description: "Custom reviewer",
      source: "test",
    });
    expect(registry.workflows.find((entry) => entry.id === "pipr/review")).toMatchObject({
      description: "Custom review workflow",
      steps: [{ id: "review", block: "pipr/custom-block" }],
    });
  });

  it("fails attempts to replace built-in entries", () => {
    expect(() =>
      createRegistry({
        blocks: [{ id: "core/run-agent", description: "Replacement", source: "test" }],
      }),
    ).toThrow("Duplicate blocks id 'core/run-agent'");
  });

  it("fails duplicate IDs in the same source", () => {
    expect(() =>
      createRegistry({
        blocks: [
          { id: "pipr/custom-block", description: "First", source: "test" },
          { id: "pipr/custom-block", description: "Second", source: "test" },
        ],
      }),
    ).toThrow("Duplicate blocks id 'pipr/custom-block'");
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
            steps: [{ id: "missing", block: "pipr/missing-block" }],
          },
        ],
      }),
    ).toThrow("workflow 'review' references unknown block 'pipr/missing-block'");
  });

  it("fails duplicate step IDs before execution", () => {
    expect(() =>
      createRegistry({
        workflows: [
          {
            id: "review",
            description: "Bad workflow",
            source: "test",
            events: [],
            steps: [
              { id: "same", block: "pipr/custom-block" },
              { id: "same", block: "pipr/custom-block" },
            ],
          },
        ],
        blocks: [{ id: "pipr/custom-block", description: "Custom block", source: "test" }],
      }),
    ).toThrow("duplicate step id 'same'");
  });

  it("fails declarative block cycles", () => {
    expect(() =>
      createRegistry({
        blocks: [
          {
            id: "first.block",
            description: "First block",
            source: "test",
            steps: [{ id: "second", block: "second.block" }],
          },
          {
            id: "second.block",
            description: "Second block",
            source: "test",
            steps: [{ id: "first", block: "first.block" }],
          },
        ],
      }),
    ).toThrow("declarative block cycle 'first.block -> second.block -> first.block'");
  });

  it("renders workflow, block, command, and comment wiring in graph output", () => {
    const registry = createRegistry({
      workflows: [
        {
          id: "pipr/review",
          description: "Review workflow",
          source: "test",
          events: ["pull_request.opened"],
          steps: [
            { id: "review", block: "core/run-agent" },
            { id: "main-comment", block: "core/main-comment", with: { template: "pipr/main" } },
          ],
        },
      ],
      agents: [{ id: "pipr/reviewer", description: "Reviewer", source: "test" }],
      comments: [{ id: "pipr/main", description: "Main comment", source: "test" }],
      commands: [
        {
          id: "pipr/default-commands",
          description: "Default commands",
          source: "test",
          commands: [
            {
              id: "review",
              aliases: ["@pipr review"],
              run: { workflows: ["pipr/review"] },
            },
          ],
        },
      ],
    });

    const graph = renderRegistryGraph(registry);

    expect(graph).toContain("pipr/review");
    expect(graph).toContain("pull_request.opened");
    expect(graph).toContain("review -> core/run-agent");
    expect(graph).toContain("@pipr review -> workflow pipr/review");
    expect(graph).toContain("template pipr/main");
  });
});

function createRegistry(modules: RuntimeModuleSet) {
  return createRuntimeRegistry({ modules });
}
