import { describe, expect, it } from "vitest";
import { createRuntimeRegistry } from "../../registry/registry.js";
import {
  createGitHubCommandClient,
  hasRequiredRepositoryPermission,
  listWorkflowCommandEntries,
  resolveWorkflowCommand,
} from "../command-router.js";

describe("workflow command routing", () => {
  it("matches required positional and optional named arguments into workflow inputs", () => {
    const registry = createRuntimeRegistry({
      modules: {
        workflows: [
          {
            id: "pipr/explain",
            description: "Explain finding",
            source: "test",
            events: [],
            inputs: {
              finding: { type: "string", required: true },
              scope: { type: "string", default: "changed", enum: ["changed", "full"] },
            },
            commands: [
              {
                name: "explain",
                pattern: "@pipr explain <finding> [--scope <scope>]",
                requiredPermission: "read",
              },
            ],
            steps: [{ id: "review", block: "core/run-agent" }],
          },
        ],
      },
    });

    expect(resolveWorkflowCommand(registry, "@pipr explain FND-123")).toMatchObject({
      kind: "matched",
      invocation: {
        workflowId: "pipr/explain",
        commandName: "explain",
        inputs: { finding: "FND-123", scope: "changed" },
      },
    });
    expect(resolveWorkflowCommand(registry, "@pipr explain FND-123 --scope full")).toMatchObject({
      kind: "matched",
      invocation: {
        inputs: { finding: "FND-123", scope: "full" },
      },
    });
    expect(resolveWorkflowCommand(registry, "@pipr explain FND-123 --scope all")).toMatchObject({
      kind: "invalid",
      reason: "Input 'scope' must be one of: changed, full",
    });
  });

  it("exposes built-in help and workflow command entries", () => {
    const registry = createRuntimeRegistry({
      modules: {
        workflows: [
          {
            id: "pipr/review",
            description: "Review",
            source: "test",
            events: [],
            commands: [{ name: "review", aliases: ["@pipr review"] }],
            steps: [{ id: "review", block: "core/run-agent" }],
          },
        ],
      },
    });

    expect(resolveWorkflowCommand(registry, "@pipr help")).toMatchObject({
      kind: "help",
      requiredPermission: "read",
    });
    expect(listWorkflowCommandEntries(registry).map((entry) => entry.id)).toEqual([
      "@pipr help",
      "@pipr review",
    ]);
    expect(resolveWorkflowCommand(registry, "@piprbot review")).toMatchObject({
      kind: "ignored",
      reason: "comment did not target pipr",
    });
  });

  it("checks ordered permissions with safe legacy fallback", () => {
    expect(
      hasRequiredRepositoryPermission({ permission: "read", role_name: "triage" }, "triage"),
    ).toBe(true);
    expect(
      hasRequiredRepositoryPermission({ permission: "read", role_name: "triage" }, "write"),
    ).toBe(false);
    expect(hasRequiredRepositoryPermission({ permission: "read" }, "triage")).toBe(false);
    expect(hasRequiredRepositoryPermission({ permission: "write" }, "write")).toBe(true);
    expect(hasRequiredRepositoryPermission({ permission: "write" }, "maintain")).toBe(false);
    expect(hasRequiredRepositoryPermission({ permission: "admin" }, "maintain")).toBe(false);
    expect(
      hasRequiredRepositoryPermission({ permission: "read", role_name: "admin" }, "admin"),
    ).toBe(true);
  });

  it("maps repository permission 404 to no access", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response("{}", { status: 404 })) as unknown as typeof fetch;
      const client = createGitHubCommandClient({
        GITHUB_API_URL: "https://api.github.test",
        GITHUB_TOKEN: "token",
      });

      await expect(
        client.getRepositoryPermission({ repo: "local/pipr", username: "outsider" }),
      ).resolves.toEqual({ permission: "none" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
