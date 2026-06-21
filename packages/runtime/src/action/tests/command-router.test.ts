import { buildPiprPlan, definePipr } from "@pipr/sdk";
import { describe, expect, it } from "vitest";
import {
  createGitHubCommandClient,
  hasRequiredRepositoryPermission,
  parsePlanCommandInputs,
  permissionDeniedHelp,
  resolvePlanCommand,
} from "../command-router.js";

describe("plan command routing", () => {
  it("matches required positional and optional named arguments into task inputs", () => {
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        const task = pipr.task<{ finding: string; scope: "changed" | "full" }>("explain", () => {});
        pipr.command(
          "@pipr explain <finding> [--scope <scope>]",
          {
            permission: "read",
            parse(arguments_) {
              const scope = arguments_.scope ?? "changed";
              if (scope !== "changed" && scope !== "full") {
                throw new Error("scope must be changed or full");
              }
              const narrowedScope: "changed" | "full" = scope;
              return { finding: arguments_.finding, scope: narrowedScope };
            },
          },
          task,
        );
      }),
    );

    expect(resolvePlanCommand(plan, "@pipr explain FND-123")).toMatchObject({
      kind: "matched",
      invocation: {
        taskName: "explain",
        commandName: "explain",
        arguments: { finding: "FND-123" },
      },
    });
    const full = resolvePlanCommand(plan, "@pipr explain FND-123 --scope full");
    expect(full).toMatchObject({
      kind: "matched",
      invocation: {
        arguments: { finding: "FND-123", scope: "full" },
      },
    });
    expect(
      full.kind === "matched" ? parsePlanCommandInputs(plan, full.invocation) : full,
    ).toMatchObject({
      kind: "matched",
      invocation: {
        inputs: { finding: "FND-123", scope: "full" },
      },
    });
    const invalid = resolvePlanCommand(plan, "@pipr explain FND-123 --scope all");
    expect(
      invalid.kind === "matched" ? parsePlanCommandInputs(plan, invalid.invocation) : invalid,
    ).toMatchObject({
      kind: "invalid",
      reason: "scope must be changed or full",
    });
  });

  it("ignores non-pipr comments and renders permission denial help", () => {
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        const task = pipr.task("review", () => {});
        pipr.command("@pipr review", {}, task);
      }),
    );

    expect(resolvePlanCommand(plan, "@piprbot review")).toMatchObject({
      kind: "ignored",
      reason: "comment did not target pipr",
    });
    expect(permissionDeniedHelp(plan, "write")).toContain("Permission denied");
  });

  it("matches a later longer command when an earlier prefix command rejects extra args", () => {
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        const review = pipr.task("review", () => {});
        const explain = pipr.task("explain", () => {});
        pipr.command("@pipr review", {}, review);
        pipr.command("@pipr review <finding>", { permission: "read" }, explain);
      }),
    );

    expect(resolvePlanCommand(plan, "@pipr review FND-123")).toMatchObject({
      kind: "matched",
      invocation: {
        taskName: "explain",
        arguments: { finding: "FND-123" },
      },
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
