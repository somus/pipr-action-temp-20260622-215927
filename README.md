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

## Repository setup

Start a repository by materializing the official minimal pipr distribution:

```bash
pipr init
pipr validate
```

`pipr init` creates editable files under `.pipr/` for config, workflows, blocks, the reviewer agent, comment templates, and PR review schemas. Existing pipr files are not replaced unless `pipr init --force` is used. `config-dir` must resolve inside the repository root.

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
          provider-id: deepseek
          provider: deepseek
          model: deepseek-v4-pro
          api-key-env: DEEPSEEK_API_KEY
```

The Docker Action pins provider execution from trusted Action inputs, not from PR-authored
`.pipr/config.yaml`. This keeps a pull request from redirecting the provider backend, model,
or API-key environment variable.

pipr maps the selected provider to Pi CLI flags: `--provider`, `--model`, and `--thinking`.
Provider secrets stay env-only through `apiKeyEnv`; pipr does not pass raw keys with
`--api-key`. Pi runs with `--tools read,grep,find,ls`, so the reviewer can inspect the
read-only workspace without `bash`, `write`, or `edit`.

The Action also runs pipr's trusted Core MVP review graph. Repository `.pipr/workflows/*.yaml`
is validated by local tooling, but cannot replace the Action review graph. Non-dry Action runs
load executable `.pipr/` control-plane files from the pull request base commit, so invalid or
deleted PR-head `.pipr/` files cannot block the trusted review run. Reviewer agent instructions
and the Main Review Comment template are loaded from the pull request base commit, so a PR cannot
change the prompt or rendered comment template that reviews it. The base commit must contain the
materialized `.pipr/` tree.

## Minimal config

Normal setup uses `pipr init`, which writes `.pipr/config.yaml` in the materialized `pipr.dev/v1` format:

```yaml
apiVersion: pipr.dev/v1
kind: Config

providers:
  - id: deepseek
    provider: deepseek
    model: deepseek-v4-pro
    apiKeyEnv: DEEPSEEK_API_KEY
    thinking: high

workflows:
  - pipr/review

limits:
  timeoutSeconds: 300
```

The bundled workflow owns Main Review Comment rendering:

```yaml
steps:
  - id: main-comment
    uses: core/main-comment
    with:
      review:
        from: validated_review
      template: pipr/main
    output: main_comment
```

## Registry modules

The materialized `.pipr/` tree contains conventional component files:

- `.pipr/workflows/*.yaml`
- `.pipr/blocks/*.yaml`
- `.pipr/agents/*.md`
- `.pipr/comments/*.yaml`
- `.pipr/schemas/*.json`

Bundled product components use the `pipr/*` namespace. Runtime primitive blocks use the reserved `core/*` namespace.

`pipr validate` checks the generated tree and reports source-file errors before model or GitHub publishing work starts.
