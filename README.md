# pipr

[![CI](https://github.com/somus/pipr/actions/workflows/ci.yml/badge.svg)](https://github.com/somus/pipr/actions/workflows/ci.yml)

pipr is a Pi-powered GitHub pull request review runtime. It loads a repository-local TypeScript config, builds a deterministic Diff Manifest, runs Pi for structured review output, validates findings against commentable ranges, and publishes one main review comment plus capped inline comments.

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

See [Quickstart](docs/quickstart.md) for the full first-run path.

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

The SDK also supports custom agents, tasks, `@pipr` commands, local entrypoints, model fallback, and retry settings. See [Configuration](docs/configuration.md).

## Guides

- [Quickstart](docs/quickstart.md)
- [Configuration](docs/configuration.md)
- [GitHub Action](docs/github-action.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Product language](docs/CONTEXT.md)
- [Architecture decisions](docs/adr)

## Status

pipr is early. CLI binaries ship through GitHub Releases, the config SDK ships as `@pipr/sdk` on npm, and the Docker Action image ships through GHCR.

## License

MIT
