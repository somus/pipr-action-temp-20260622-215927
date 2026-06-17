# pipr

pipr is a Pi-powered GitHub PR automation runtime. The current scaffold validates configuration, GitHub pull request event loading, Docker Action packaging, and local `act` execution. The full review runtime still fails explicitly until Diff Manifest, Pi review, schema validation, and comment publishing are wired end to end.

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

The non-dry-run Action currently exits with `pipr action review runtime is not implemented yet`. Once review execution is wired, repositories should use this workflow shape:

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
