# pipr

pipr is a Pi-powered GitHub PR automation runtime. The current runtime validates `.pipr/config.ts`, loads GitHub pull request events, builds a local Diff Manifest, runs Pi for schema-first review JSON, validates findings against commentable ranges, prepares comments, then upserts the Main Review Comment and publishes Inline Review Comments.

## Development

```bash
mise install
mise run install
mise run check
```

Local GitHub Action testing uses `act`:

```bash
mise run check-actions
```

This builds the Docker Action image, verifies the installed Pi CLI contract, and runs local Action fixtures through `act`. The dry-run fixture proves Docker Action packaging and event/config loading without calling Pi or publishing comments. The full-flow, condensed, and orchestrator fixtures use fake Pi and fake GitHub comment storage, then assert publication behavior.

`check-actions` builds one local image, `pipr-action:act`, then generates local-only Action metadata under `.github/act/` so every `act` fixture uses that prebuilt image instead of rebuilding the Dockerfile. To test a future published image after the repository exists on GitHub, run:

```bash
PIPR_SKIP_ACTION_IMAGE_BUILD=1 \
PIPR_ACTION_IMAGE=ghcr.io/somus/pipr-action:main \
mise run check-actions
```

The GHCR image workflow is manual and does not publish by default. Until `ghcr.io/somus/pipr-action:main` is pushed and made public or explicitly shared, external sample repositories cannot use the image.

## Repository setup

Start a repository with the TypeScript config:

```bash
pipr init
pipr check
```

`pipr init` creates `.pipr/config.ts`, `.pipr/tsconfig.json`, and `.pipr/types/pipr-sdk.d.ts`. Existing pipr files are not replaced unless `pipr init --force` is used. `config-dir` must resolve inside the repository root.

## GitHub Action shape

The Docker Action runs `pipr action`. Repositories should use this workflow shape:

```yaml
name: pipr

on:
  pull_request:
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: <owner>/pipr@v1
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
        with:
          config-dir: .pipr
          provider-id: deepseek
          provider: deepseek
          model: deepseek-v4-pro
          api-key-env: DEEPSEEK_API_KEY
```

The source Action metadata still uses `runs.image: Dockerfile`. The prebuilt GHCR image path is prepared for later publishing, but root `action.yml` will stay source-compatible until the project is available on GitHub.

The Docker Action pins provider execution from trusted Action inputs, not from PR-authored `.pipr/config.ts`. This keeps a pull request from redirecting the provider backend, model, or API-key environment variable. The provider profile's `thinking` value stays in the base-commit TypeScript config and maps to Pi's `--thinking` flag. Provider secrets stay env-only through `pipr.secret("ENV_NAME")`; pipr does not pass raw keys with `--api-key`. Pi runs with `--tools read,grep,find,ls`, so the reviewer can inspect the read-only workspace without `bash`, `write`, or `edit`.

For small pull requests, pipr sends the full Diff Manifest in the reviewer prompt. If the
serialized manifest exceeds configured byte or estimated-token limits, pipr sends a condensed
manifest that preserves deterministic mapping fields and attaches pipr Diff Read Tools:
`pipr_read_diff(path?, rangeId?)` and `pipr_read_at_ref(path, ref, rangeId)`. These are not
`.pipr/` plugin tools and never expose GitHub APIs, shell access, writes, comment publishing, or
path-only base file reads.

The Action ignores PR-head `.pipr/` as executable authority. Non-dry Action runs load `.pipr/config.ts` and local imports from the pull request base commit. Pi still reviews the PR head. pipr code owns deterministic diff creation, Pi execution, review validation, comment preparation, stale-head checks, main-comment upsert, inline marker dedupe, and GitHub comment writes. Invalid or deleted PR-head `.pipr/` files cannot block the trusted review run. The base commit must contain `.pipr/config.ts`.

## Minimal Config

Normal setup uses `pipr init`, which writes `.pipr/config.ts`:

```ts
import { definePipr } from "@pipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", {
    name: "deepseek",
    apiKey: pipr.secret("DEEPSEEK_API_KEY"),
    options: { thinking: "high" },
  });

  pipr.review({
    model,
    instructions: `
      Review the pull request diff for correctness, security,
      maintainability, and test coverage.
      Return only actionable findings that target valid diff ranges.
    `,
    inlineComments: { max: 5 },
    timeout: "5m",
  });
});
```

Diff Manifest prompt limits are optional. Defaults are `128 KiB` or `32k` estimated tokens for
the full manifest, then `256 KiB` or `64k` estimated tokens for the condensed manifest:

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

## Power User Config

The public authoring surface is the `@pipr/sdk` builder. Use `pipr.model`, `pipr.agent`, `pipr.task`, `pipr.command`, `pipr.local`, and `pipr.on.changeRequest` for custom review flows. A task receives a context with `ctx.change.diffManifest()`, `ctx.pi.run(agent, input)`, and `ctx.output.summary/findings/section/metadata`.

```ts
const security = pipr.agent({
  name: "security-reviewer",
  model,
  instructions: "Review only security issues.",
  output: pipr.schemas.review,
  prompt: (input) => pipr.prompt`
    Review this pull request for security issues.
    ${pipr.compactManifest(input.manifest)}
  `,
});

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

Model fallback and retry are part of the MVP API. `ctx.pi.run(agent, input, { model, fallbacks })`
overrides the agent's primary model and fallback list. Otherwise pipr uses `agent.model`, then
`agent.fallbacks`, then the config default model. Invalid structured output gets one repair attempt
by default; transient Pi execution retries default to zero. Set `agent.retry.invalidOutput` and
`agent.retry.transientFailure` to override those counts per agent. GitHub Action provider inputs are
an explicit trusted override: when they are present, pipr uses only that trusted provider and
does not run agent or task fallbacks.

`definePlugin`, `pipr.use`, and `pipr.tool` support explicit TypeScript plugin registration.
Plugin tools are typed and visible in the runtime plan, but attaching custom plugin tools to Pi
agents fails closed in the MVP. Pi only receives pipr's built-in read-only tools plus pipr
Diff Read Tools for condensed runs. Review output for inline comments must use
`pipr.schemas.review`; non-inline findings are not part of the MVP Review Result.

Command triggers run only for `issue_comment` events that target pull requests. pipr checks `github.event.issue.pull_request`, fetches PR metadata, checks the commenter with GitHub's collaborator permission API, parses command arguments, and only then starts the task. Permissions are ordered `read < triage < write < maintain < admin`; command permission defaults to `write`.

The runtime computes the Diff Manifest once per review run and shares it with all matching tasks. Pull request tasks run concurrently and publish one combined set of comments. Main Review Comment section writes default to `exclusive`; use `append`, `replace`, or `list` when multiple tasks intentionally share a section.

Use `pipr inspect` to see registered models, agents, tasks, events, commands, locals, and tools from the TypeScript runtime plan.

Local entrypoints run the same task logic without GitHub comment publishing. They require an explicit base commit:

```bash
pipr review --base origin/main
pipr run security --base origin/main --head HEAD
```
