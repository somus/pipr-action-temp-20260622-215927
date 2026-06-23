# PIPR SDK Reference

The PIPR SDK is the public TypeScript authoring API for `.pipr/config.ts`.

```ts
import { definePipr } from "@pipr/sdk";
```

Subpath exports are available when you want type and schema names without importing the full builder surface:

```ts
import type { ReviewFinding, ReviewResult } from "@pipr/sdk/review";
import type { AgentTool, ToolRunOptions } from "@pipr/sdk/tools";
```

## `definePipr`

Every config must default-export a synchronous factory:

```ts
export default definePipr((pipr) => {
  // register models, reviewers, tasks, commands, locals, limits, tools
});
```

The callback must be synchronous. Runtime work belongs in `pipr.task(...)`, not at config load time.

## Models and secrets

Models use `<provider>/<model>`:

```ts
const model = pipr.model("deepseek/deepseek-v4-pro", {
  name: "deepseek",
  apiKey: pipr.secret("DEEPSEEK_API_KEY"),
  options: { thinking: "high" },
});
```

`pipr.secret(name)` stores only the environment variable name. It does not read or serialize the secret during plan creation.

## Review recipe

`pipr.reviewer(...)` creates the default structured pull request reviewer. `pipr.review(...)` wires that reviewer into change request, command, and local entrypoints.

```ts
const reviewer = pipr.reviewer({
  name: "reviewer",
  model,
  instructions: "Review the change for correctness and security.",
  tools: pipr.tools.readOnly,
  timeout: "5m",
});

pipr.review({
  name: "review",
  reviewer,
  entrypoints: {
    changeRequest: ["opened", "updated", "reopened", "ready"],
    command: {
      pattern: "@pipr review",
      permission: "write",
      description: "Run the default pipr review.",
    },
    local: "review",
  },
  inlineComments: { max: 5 },
});
```

`entrypoints.changeRequest` accepts these actions:

```text
opened | updated | reopened | ready | closed
```

`entrypoints.command.permission` is provider-neutral:

```text
read < triage < write < maintain < admin
```

Adapters map native roles into this order.

To disable one entrypoint:

```ts
pipr.review({
  reviewer,
  entrypoints: {
    command: false,
    local: false,
  },
});
```

## Custom reviewer prompt

pipr injects the Diff Manifest and tool contract into the Pi prompt. Override the reviewer prompt when the model needs a stricter review rubric:

```ts
const reviewer = pipr.reviewer({
  model,
  instructions: "Return JSON that matches the pipr review schema.",
  prompt: (input, ctx) => pipr.prompt`
    Repository: ${ctx.repository.owner}/${ctx.repository.name}
    Change: ${input.change.title}

    Only report actionable defects.
  `,
});
```

## Agents

Use `pipr.agent(...)` for non-default structured agent calls:

```ts
const security = pipr.agent({
  name: "security-reviewer",
  model,
  instructions: "Review only security issues.",
  output: pipr.schemas.review,
  prompt: () => pipr.prompt`
    Review this pull request for exploitable security issues.
  `,
  retry: {
    invalidOutput: 1,
    transientFailure: 1,
  },
  timeout: "5m",
});
```

`agent.extend(...)` creates a derived agent and appends replacement instructions to the base instructions:

```ts
const strictSecurity = security.extend({
  instructions: "Ignore style-only findings.",
});
```

## Tasks

Tasks are the executable review units. They receive a `TaskContext` and optional parsed input.

```ts
const task = pipr.task("security-review", async (ctx) => {
  const manifest = await ctx.change.diffManifest({ compressed: true });
  const result = await ctx.pi.run(security, { manifest });

  ctx.output.summary(result.summary, { key: "security", merge: "append" });
  ctx.output.findings(result.inlineFindings);
});

pipr.on.changeRequest(["opened", "updated"], task);
pipr.command("@pipr security", { permission: "write" }, task);
pipr.local("security", task);
```

## Task context

| Property | Purpose |
| --- | --- |
| `ctx.run.id` | Stable id for the current runtime execution. |
| `ctx.platform.id` | Code host id, such as `github` or `local`. |
| `ctx.repository` | Provider-neutral repository metadata. |
| `ctx.change` | Provider-neutral change request metadata plus diff helpers. |
| `ctx.pi.run(agent, input, options?)` | Execute a Pi-backed agent and validate structured output. |
| `ctx.output` | Contribute summary sections, findings, metadata, and custom sections. |
| `ctx.log` | Write runtime logs. |

`ctx.change.diffManifest(...)` returns commentable file ranges. Findings must reference those ranges by `rangeId`.

## Output collection

Use `ctx.output.summary(...)` for text that belongs in the Main Review Comment:

```ts
ctx.output.summary(
  { title: "Security review", body: "No exploitable findings." },
  { key: "security", merge: "replace", priority: 20 },
);
```

Use `ctx.output.section(...)` for custom rendered sections:

```ts
ctx.output.section(
  "test-plan",
  ["unit tests passed", "no e2e evidence"],
  {
    title: "Test Plan",
    order: 30,
    merge: "list",
    render: (items) => items.map((item) => `- ${item}`).join("\n"),
  },
);
```

Use `ctx.output.findings(...)` for inline comments:

```ts
ctx.output.findings([
  {
    body: "This branch can throw before cleanup runs.",
    path: "src/server.ts",
    rangeId: "rng_...",
    side: "RIGHT",
    startLine: 42,
    endLine: 42,
    data: { category: "correctness" },
  },
]);
```

pipr validates findings against the Diff Manifest, drops invalid findings, dedupes finding markers, and caps inline publication.

## Tools

`pipr.tool(...)` defines typed model-facing tools.

```ts
const lookupOwner = pipr.tool({
  name: "lookup_owner",
  description: "Return the owner for a repository path.",
  input: myInputSchema,
  output: myOutputSchema,
  async run({ input, ctx, signal }) {
    signal?.throwIfAborted();
    return await lookupOwnerFromCatalog(input.path, ctx);
  },
  toModelOutput(output) {
    return {
      owner: output.team,
      confidence: output.confidence,
    };
  },
});
```

Tool `run(...)` receives:

| Field | Meaning |
| --- | --- |
| `input` | Parsed tool input. |
| `ctx` | Runtime-provided tool context. |
| `signal` | Optional abort signal. |

`toModelOutput(...)` can project a rich internal result into a smaller model-facing value.

## Schemas

Built-in schemas:

| Schema | Use |
| --- | --- |
| `pipr.schemas.review` | Main review result with summary and inline findings. |
| `pipr.schemas.summary` | Main-comment summary block. |

Custom schemas are useful for intermediate agents and workflows that map their final output into pipr publication calls:

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

  const summaryOutput = pipr.jsonSchema<{ summary: string }>("security/summary", {
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: {
      summary: { type: "string" },
    },
  });

  void specialistOutput;
  void summaryOutput;
});
```

Use `pipr.schemas.review` when an agent directly returns publishable Inline Review Comments.

The `z` export is the recommended typed path for JSON-Schema-representable schemas. Generated `.pipr/types` include a standalone Zod authoring subset so `pipr init` projects type-check without installing `zod`; use `pipr.jsonSchema<T>()` for advanced JSON Schema shapes or when a Zod helper is outside that generated subset.

Parsing helpers are exported from `@pipr/sdk/review`:

```ts
import { parseReviewFinding, parseReviewResult, reviewSchemaExample } from "@pipr/sdk/review";
```

## Prompts

Use prompt helpers to keep prompts structured:

```ts
pipr.prompt`
  ${pipr.section("Review policy", "Only report actionable defects.")}
`;
```

`pipr.json(value, { pretty, maxCharacters })` renders bounded JSON and throws if it exceeds `maxCharacters`.

## Runtime limits

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

These limits control runtime timeout and Diff Manifest prompt sizing.

## Plugins

Plugins install config-time handles through the builder:

```ts
import { definePlugin } from "@pipr/sdk";

const owners = definePlugin((pipr) => {
  return {
    tool: pipr.tool({
      name: "owner_lookup",
      description: "Look up path owners.",
      input: ownerInputSchema,
      output: ownerOutputSchema,
      run: ({ input }) => ownerCatalog.get(input.path),
    }),
  };
});

const ownerTools = pipr.use(owners);
```

Plugin setup runs during config loading. Runtime effects still belong in tasks and tools.
