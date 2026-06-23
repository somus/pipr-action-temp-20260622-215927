# pipr

[![CI](https://github.com/somus/pipr/actions/workflows/ci.yml/badge.svg)](https://github.com/somus/pipr/actions/workflows/ci.yml)

pipr is a Pi-powered code review runtime. It loads a repository-local TypeScript config, builds a deterministic Diff Manifest, runs Pi for structured review output, validates findings against commentable ranges, and publishes one Main Review Comment plus capped Inline Review Comments.

GitHub is the first delivery target. Internally, GitHub is a code host adapter, so `.pipr/config.ts` stays provider-neutral. GitLab, Bitbucket, and Azure DevOps support is coming soon.

## Quickstart

Create the TypeScript config:

```bash
curl -fsSL https://raw.githubusercontent.com/somus/pipr/main/install.sh | sh
pipr init
pipr check
```

Set the provider secret used by the default config:

```bash
DEEPSEEK_API_KEY=...
```

Add the GitHub Action:

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
      - uses: somus/pipr@v1
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

See [Docs](docs/index.md) or [Quickstart](docs/quickstart.md) for the full first-run path.

## Configuration

`pipr init` creates `.pipr/config.ts`:

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

The SDK also supports custom agents, tasks, `@pipr` commands, local entrypoints, model fallback, and retry settings. See [Configuration](docs/configuration.md).

## Guides

- [Docs home](docs/index.md)
- [Quickstart](docs/quickstart.md)
- [Configuration](docs/configuration.md)
- [PIPR SDK Reference](docs/sdk-reference.md)
- [Runtime Guide](docs/runtime.md)
- [GitHub Action](docs/github-action.md)
- [Code Host Adapters](docs/code-host-adapters.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Product language](docs/CONTEXT.md)
- [Architecture decisions](docs/adr)

## Status

pipr is early. CLI binaries ship through GitHub Releases, the config SDK ships as `@pipr/sdk` on npm, and the Docker Action image ships through GHCR.

## Privacy

pipr runs in your local environment or CI runner. This repo does not use a hosted pipr control plane.

When a review runs, pipr may send the configured model provider:

- repository and change request metadata needed for the review
- task instructions from the trusted `.pipr/config.ts`
- the Diff Manifest, including changed file paths, hunks, commentable ranges, and bounded code previews
- bounded Diff Read Tool responses when the manifest is condensed

Provider API keys are read from environment variables such as `DEEPSEEK_API_KEY`. `pipr.secret(...)` stores the variable name in the runtime plan, not the secret value.

On GitHub, pipr uses `GITHUB_TOKEN` to read pull request metadata, publish the Main Review Comment and Inline Review Comments, and resolve review threads for fixed findings. Published comments become part of the repository's normal GitHub pull request record. Local runs do not publish comments.

Do not run pipr on code you are not permitted to send to the configured model provider.

## License

MIT
