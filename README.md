# pipr

pipr is a Pi-powered GitHub PR automation runtime. The current runtime validates `.pipr/` configuration, loads GitHub pull request events, builds a local Diff Manifest, runs Pi for schema-first review JSON, validates findings against commentable ranges, renders the Main Review Comment, and prepares Inline Review Comment drafts. GitHub publishing is still not wired in the Core MVP scaffold.

## Development

```bash
mise install
mise run install
mise run check
```

Local GitHub Action testing uses `act`:

```bash
mise run act-pr
```

The local Action fixture runs with `PIPR_DRY_RUN=1`; it proves Docker Action packaging and event/config loading without calling Pi or publishing comments.

## GitHub Action shape

The Docker Action runs `pipr action`. Repositories should use this workflow shape:

```yaml
name: pipr

on:
  pull_request:

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
        with:
          config-dir: .pipr
```

## Minimal config

pipr reads `.pipr/config.yaml`. If the directory is missing, `builtin:minimal` is used.

```yaml
version: 1

extends:
  - builtin:minimal

default_provider: deepseek

providers:
  - id: deepseek
    model: deepseek-v4-pro
    thinking: enabled
    reasoning_effort: high
    api_key_env: DEEPSEEK_API_KEY

review:
  max_inline_comments: 5
  min_confidence: 0.75
```

## Registry modules

pipr can also read `.pipr/registry.yaml` for presets, workflows, blocks, agents, schemas, comments, and tools. Entries override by `id` for CLI graph/list commands and explicit runtime registry construction; duplicate IDs in the same source, unknown block references, unsafe workflow refs, and declarative block cycles fail validation.

The GitHub Action validates `.pipr/registry.yaml`, but it executes the trusted built-in review workflow for Core MVP so pull requests cannot replace the review workflow that evaluates them.
