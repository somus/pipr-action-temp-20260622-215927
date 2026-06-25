import type { OfficialInitRecipe } from "./types.js";

export const pluginToolReviewRecipe = {
  id: "plugin-tool-review",
  title: "Plugin Tool Review",
  description: "Typed plugin exposing an owner lookup tool to reviewer agents.",
  sourceTools: ["CodeRabbit path instructions", "GitHub Copilot repository instructions"],
  configTs: `import { definePipr, definePlugin, z } from "@pipr/sdk";

const ownersPlugin = definePlugin((pipr) => {
  const ownerInput = pipr.schema({
    id: "owners/input",
    schema: z.strictObject({ path: z.string() }),
  });
  const ownerOutput = pipr.schema({
    id: "owners/output",
    schema: z.strictObject({
      path: z.string(),
      owner: z.string(),
      policy: z.string(),
    }),
  });
  const catalog = [
    { prefix: "packages/runtime/", owner: "runtime", policy: "Review runtime and publication behavior strictly." },
    { prefix: "packages/cli/", owner: "cli", policy: "Review command UX and local developer workflows." },
    { prefix: "docs/", owner: "docs", policy: "Review product language and examples." },
  ];

  return {
    ownerLookup: pipr.tool({
      name: "owner_lookup",
      description: "Return the owner and review policy for a repository path.",
      input: ownerInput,
      output: ownerOutput,
      run({ input, signal }) {
        signal?.throwIfAborted();
        const match = catalog.find((entry) => input.path.startsWith(entry.prefix));
        return {
          path: input.path,
          owner: match?.owner ?? "general",
          policy: match?.policy ?? "Review with the default repository policy.",
        };
      },
      toModelOutput(output) {
        return {
          path: output.path,
          owner: output.owner,
          policy: output.policy,
        };
      },
    }),
  };
});

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  const owners = pipr.use(ownersPlugin);

  const reviewer = pipr.agent({
    name: "owner-aware-review",
    model,
    output: pipr.schemas.review,
    tools: pipr.tools.readOnly,
    instructions: \`
      Review the pull request using the precomputed owner policy context.
      Apply owner policy, but report only actionable defects.
    \`,
    prompt: (input: { manifest: unknown; ownerPolicies: unknown }) => pipr.prompt\`
      \${pipr.section("Diff Manifest", input.manifest)}

      \${pipr.section("Owner Policies", pipr.json(input.ownerPolicies))}
    \`,
  });

  const task = pipr.task({
    name: "owner-aware-review",
    async run(ctx) {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const ownerPolicies = await Promise.all(
        manifest.files.slice(0, 20).map(async (file) => {
          const output = await owners.ownerLookup.run?.({
            input: { path: file.path },
            ctx,
          });
          if (!output) {
            throw new Error("owner_lookup returned no output");
          }
          return owners.ownerLookup.toModelOutput?.(output) ?? output;
        }),
      );
      const review = await ctx.pi.run(reviewer, { manifest, ownerPolicies });
      await ctx.comment({
        main: review.summary.body,
        inlineFindings: review.inlineFindings,
      });
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated"], task });
  pipr.command({ pattern: "@pipr owner-review", permission: "write", task });
  pipr.local({ name: "owner-review", task });
});
`,
} as const satisfies OfficialInitRecipe;
