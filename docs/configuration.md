# Configuration

pipr uses `.pipr/config.ts` as the repository-local authoring surface. The config is TypeScript and must export `definePipr(...)`.

This page shows common recipes. For the full public API, see [PIPR SDK Reference](sdk-reference.md).

`pipr init` writes generated SDK declarations under `.pipr/types`. If you prefer package-managed types, install the SDK:

```bash
npm install -D @pipr/sdk
```

## Minimal review

```ts
import { definePipr } from "@pipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", {
    name: "deepseek",
    apiKey: pipr.secret("DEEPSEEK_API_KEY"),
    options: { thinking: "high" },
  });

  const reviewer = pipr.reviewer({
    name: "reviewer",
    model,
    instructions: `
      Review the pull request diff for correctness, security,
      maintainability, and test coverage.
      Return only actionable findings that target valid diff ranges.
    `,
  });

  pipr.review({
    reviewer,
    entrypoints: {
      changeRequest: ["opened", "updated", "reopened", "ready"],
      command: { pattern: "@pipr review", permission: "write" },
      local: "review",
    },
    inlineComments: { max: 5 },
    timeout: "5m",
  });
});
```

`pipr.review` registers a change request review task, the `@pipr review` command, and the local `review` entrypoint unless `entrypoints` disables or renames them.

Use `paths` to scope a review recipe to matching repository paths:

```ts
pipr.review({
  reviewer,
  paths: {
    include: ["packages/runtime/**"],
    exclude: ["**/*.test.ts"],
  },
});
```

`paths` filters the Diff Manifest and publishable Inline Review Comments. Pi still receives read-only access to the whole repository, and pipr instructs it to read nonmatching files only when needed to review matching files.

The `entrypoints` object is the preferred public API:

```ts
entrypoints: {
  changeRequest: ["opened", "updated", "reopened", "ready"],
  command: { pattern: "@pipr review", permission: "write" },
  local: "review",
}
```

## Models

Use `<provider>/<model>` for model profiles:

```ts
const primary = pipr.model("deepseek/deepseek-v4-pro", {
  name: "deepseek",
  apiKey: pipr.secret("DEEPSEEK_API_KEY"),
  options: { thinking: "high" },
});
```

Provider secrets are env-only. `pipr.secret("DEEPSEEK_API_KEY")` records the env var name and does not put raw secret values in the runtime plan.

## Diff Manifest limits

pipr sends the full Diff Manifest while it fits configured limits. When it is too large, pipr sends a condensed manifest and attaches bounded Diff Read Tools for range-scoped context.

```ts
pipr.limits({
  timeoutSeconds: 300,
  diffManifest: {
    fullMaxBytes: 131072,
    fullMaxEstimatedTokens: 32000,
    condensedMaxBytes: 262144,
    condensedMaxEstimatedTokens: 64000,
    toolResponseMaxBytes: 65536,
  },
});
```

## Custom task

Use `pipr.agent`, `pipr.task`, and `pipr.on.changeRequest` when the default review recipe is not enough.

```ts
const security = pipr.agent({
  name: "security-reviewer",
  model,
  instructions: "Review only security issues.",
  output: pipr.schemas.review,
  prompt: () => pipr.prompt`
    Review this pull request for security issues.
  `,
});

const task = pipr.task("security-review", async (ctx) => {
  const paths = { include: ["packages/runtime/**"] };
  const manifest = await ctx.change.diffManifest({ compressed: true, paths });
  const result = await ctx.pi.run(security, { manifest }, { paths });
  ctx.output.summary(result.summary, { key: "security", merge: "append" });
  ctx.output.findings(result.inlineFindings, { paths });
});

pipr.on.changeRequest(["opened", "updated"], task);
```

Pass `manifest` to `ctx.pi.run(...)`. pipr injects the full or condensed Diff Manifest into the Pi prompt and attaches read-only diff tools when needed.

Inline findings passed to `ctx.output.findings(...)` must target valid Diff Manifest ranges.

## Custom schemas

Use custom schemas for intermediate agents and custom workflows. Use `pipr.schemas.review` only for output that should publish Inline Review Comments.

Use SDK-owned Zod for typed agent outputs:

```ts
import { definePipr, z } from "@pipr/sdk";

export default definePipr((pipr) => {
  const specialistOutput = pipr.schema(
    "security/specialist-output",
    z.strictObject({
      summary: z.string(),
      risks: z.array(z.string()),
    }),
  );

  const jsonBacked = pipr.jsonSchema<{ summary: string }>("security/summary", {
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: {
      summary: { type: "string" },
    },
  });

  void specialistOutput;
  void jsonBacked;
});
```

The runtime includes schema details in the Pi prompt when they are available. Tasks can map custom outputs into `ctx.output.summary(...)`, `ctx.output.findings(...)`, or `ctx.output.section(...)`.

To publish inline comments from a custom schema, map the custom output into `ReviewFinding[]` and call `ctx.output.findings(...)`.

Schema metadata is model-visible prompt content. Do not put secrets, private data, or sensitive internal notes in JSON Schema fields such as `description`, `examples`, `default`, or `$comment`.

## Commands and local entrypoints

Commands run from pull request issue comments:

```ts
pipr.command("@pipr security", { permission: "write" }, task);
```

Permission levels are provider-neutral:

```text
read < triage < write < maintain < admin
```

The active code host adapter maps native roles into these levels.

Local entrypoints run the same task logic without GitHub publishing:

```ts
pipr.local("security", task);
```

Run local entrypoints with an explicit base commit:

```bash
pipr review --base origin/main
pipr run security --base origin/main --head HEAD
```

## Fallback and retry

`ctx.pi.run(agent, input, { model, fallbacks })` can override the agent primary model and fallback list for one call. Otherwise pipr uses:

1. the call override
2. `agent.model`
3. `agent.fallbacks`
4. the runtime provider selected from trusted workflow options or the config default provider

Invalid structured output gets one repair attempt by default. Transient Pi execution retries default to zero.

```ts
const reviewer = pipr.agent({
  name: "review",
  model,
  fallbacks: [backupModel],
  instructions: "Review the pull request.",
  output: pipr.schemas.review,
  retry: {
    invalidOutput: 1,
    transientFailure: 1,
  },
  prompt: () => "Review the pull request.",
});
```

When GitHub workflow trusted provider options are present, pipr uses only that trusted provider and does not run agent or task fallbacks.

## Inspect

Use `pipr inspect` to see the loaded runtime plan:

```bash
pipr inspect
```

It prints registered models, agents, tasks, events, commands, locals, and tools.
