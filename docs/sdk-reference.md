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

Model ids default to `<provider>/<model>`:

```ts
const model = pipr.model({
  provider: "deepseek",
  model: "deepseek-v4-pro",
  apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
  options: { thinking: "high" },
});
```

Use `id` only when you configure the same provider and model with different API keys or options. `pipr.secret({ name })` stores only the environment variable name. It does not read or serialize the secret during plan creation.

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
  id: "review",
  reviewer,
  paths: {
    include: ["packages/runtime/**"],
    exclude: ["**/*.test.ts"],
  },
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
  id: "review",
  reviewer,
  entrypoints: {
    command: false,
    local: false,
  },
});
```

`paths` scopes the Diff Manifest and publishable Inline Review Comments for that review recipe. It is not a filesystem sandbox: Pi read-only tools can still inspect the repository, and pipr prompts the agent to read nonmatching files only when needed to review matching files.

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
const task = pipr.task({
  name: "security-review",
  check: { name: "security" },
  async run(ctx) {
    const paths = { include: ["packages/runtime/**"] };
    const manifest = await ctx.change.diffManifest({ compressed: true, paths });
    const result = await ctx.pi.run(security, { manifest }, { paths });

    await ctx.comment({ main: result.summary.body, inlineFindings: result.inlineFindings });
  },
});

pipr.on.changeRequest({ actions: ["opened", "updated"], task });
pipr.command({ pattern: "@pipr security", permission: "write", task });
pipr.local({ name: "security", task });
```

## Task context

| Property | Purpose |
| --- | --- |
| `ctx.run.id` | Stable id for the current runtime execution. |
| `ctx.platform.id` | Code host id, such as `github` or `local`. |
| `ctx.repository` | Provider-neutral repository metadata. |
| `ctx.change` | Provider-neutral change request metadata plus diff helpers. |
| `ctx.pi.run(agent, input, options?)` | Execute a Pi-backed agent and validate structured output. |
| `ctx.review.prior()` | Read prior review state: `main?`, `reviewedHeadSha?`, and `inlineFindings[]` with `id`, `status`, `path`, `rangeId`, `side`, `startLine`, and `endLine`. |
| `ctx.check.pass/fail/neutral(summary?)` | Set one explicit task check result. Check failure does not fail the Action process by itself. |
| `ctx.comment(value)` | Emit the selected run's final Main Review Comment markdown and Inline Review Comments. |
| `ctx.log` | Write runtime logs. |

`ctx.change.diffManifest(...)` returns commentable file ranges. Findings must reference those ranges by `rangeId`.

When a custom task uses path scoping, pass the same `paths` to `ctx.change.diffManifest(...)` and `ctx.pi.run(...)`. The manifest is filtered to matching files, the prompt carries the path scope, and pipr drops findings from that scoped Pi result when they are outside the scope. That scope is preserved when passing returned findings or cloning them with object spread.

## Check Runs

Task-level `check` controls individual GitHub Check Runs and aggregate participation:

```ts
const task = pipr.task({
  name: "security",
  check: { enabled: true, name: "security", required: true },
  async run(ctx) {
    ctx.check.pass("Security review completed.");
    await ctx.comment("## Security review\n\nNo blocking findings.");
  },
});
```

When `check` is an object, the individual task Check Run is enabled by default. `required` defaults to `true`. Use `check: false` to opt a task out of both its individual Check Run and the aggregate Check Run. A task without `check` does not get an individual Check Run, but still participates in the aggregate when aggregate checks are enabled.

The workflow job check is usually the branch protection gate. Enable the aggregate Check Run only when you explicitly want one pipr-owned Check Run across multiple tasks:

```ts
pipr.checks({
  aggregate: { enabled: true, name: "all" },
});
```

Checks publish only on GitHub `pull_request` Action runs. They do not publish for `issue_comment`, local runs, or dry runs. `ctx.check.pass/fail/neutral(...)` can be called at most once per task. `ctx.check.fail(...)` fails the task Check Run but does not fail the Action process by itself.

## Global config

`pipr.config(...)` sets global runtime behavior:

```ts
pipr.config({
  publication: {
    maxInlineComments: 5,
    autoResolve: {
      model,
      instructions: "Respect maintainer explanations about deliberate product behavior.",
      synchronize: true,
      userReplies: {
        enabled: true,
        respondWhenStillValid: true,
        allowedActors: "author-or-write",
      },
    },
  },
  checks: {
    aggregate: { enabled: true },
  },
  limits: {
    timeoutSeconds: 300,
  },
});
```

`publication.autoResolve` defaults to enabled. Use `autoResolve: false` to disable verifier-driven thread cleanup and user-reply handling. If `model` is omitted, pipr uses the default provider. Use `instructions` to add project-specific guidance for the internal verifier.

`userReplies.allowedActors` controls who can trigger verifier replies:

| Value | Behavior |
| --- | --- |
| `"author-or-write"` | PR author or users with write access. Default. |
| `"write"` | Only users with write access. |
| `"any"` | Any commenter. Use only when public reply-triggered model calls are acceptable. |

`"author-or-write"` lets the PR author trigger verifier model calls from review-comment replies, including external contributors on public forks. Use `"write"` when only trusted repository collaborators should spend provider quota or send bounded diff, finding, and thread context to the configured model provider.

Set `respondWhenStillValid: false` to keep user-reply verifier runs silent unless the finding is resolved.

## Comment output

Each selected run must call `ctx.comment(value)` exactly once. Missing or duplicate calls fail the run.

Use `ctx.comment(...)` for Main Review Comment markdown:

```ts
await ctx.comment("## Security review\n\nNo exploitable findings.");
```

Use object form when also publishing inline findings:

```ts
await ctx.comment({
  main: "## Security review\n\nFound one issue.",
  inlineFindings: [{
    body: "This branch can throw before cleanup runs.",
    path: "src/server.ts",
    rangeId: "rng_...",
    side: "RIGHT",
    startLine: 42,
    endLine: 42,
  }],
});
```

pipr validates findings against the Diff Manifest, drops invalid findings, dedupes finding markers, and caps inline publication.
Subjective labels such as severity, confidence, or category are not part of the built-in finding contract. Define them in a custom schema or render them into your own `ctx.comment(...)` markdown when your workflow needs them.

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
  const specialistOutput = pipr.schema({
    id: "security/specialist-output",
    schema: z.strictObject({
      summary: z.string(),
      risks: z.array(z.string()),
    }),
  });

  const summaryOutput = pipr.jsonSchema<{ summary: string }>({
    id: "security/summary",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: {
        summary: { type: "string" },
      },
    },
  });

  void specialistOutput;
  void summaryOutput;
});
```

Use `pipr.schemas.review` when an agent directly returns publishable Inline Review Comments. `suggestedFix` is optional exact replacement code for the selected range and is rendered as a GitHub suggested change.

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
