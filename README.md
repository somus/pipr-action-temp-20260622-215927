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
mise run check-actions
```

This builds the Docker Action image, verifies the installed Pi CLI contract, and runs the local Action fixture through `act`. The fixture runs with `PIPR_DRY_RUN=1`; it proves Docker Action packaging and event/config loading without calling Pi or publishing comments.

## Repository setup

Start a repository by materializing the official minimal pipr distribution:

```bash
pipr init
pipr validate
```

`pipr init` creates editable files under `.pipr/` for config, workflows, the reviewer agent, comment templates, and PR review schemas. Workflow-owned command triggers live under `Workflow.on.commands`. The minimal distribution does not create custom blocks; the default review flow calls `core/run-agent` directly. Existing pipr files are not replaced unless `pipr init --force` is used. `config-dir` must resolve inside the repository root.

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

The Docker Action pins provider execution from trusted Action inputs, not from PR-authored
`.pipr/config.yaml`. This keeps a pull request from redirecting the provider backend, model,
or API-key environment variable.

The provider profile's `thinking` value stays in `.pipr/config.yaml`. Non-dry Action runs read it
from the pull request base commit, then map it to Pi's `--thinking` flag.
Provider secrets stay env-only through `apiKeyEnv`; pipr does not pass raw keys with
`--api-key`. Pi runs with `--tools read,grep,find,ls`, so the reviewer can inspect the
read-only workspace without `bash`, `write`, or `edit`.

The Action ignores PR-head `.pipr/` as executable authority. Non-dry Action runs load the
materialized workflow, agent, schema, comment-template, and optional block registry from
the pull request base commit. That base-commit `.pipr/` tree is trusted review authority, while
runtime-owned `core/run-agent` owns deterministic diff creation, Pi execution, and review
validation. Runtime-owned comment handlers own comment preparation. Invalid or deleted PR-head
`.pipr/` files cannot block the trusted review run. The base commit must contain the materialized
`.pipr/` tree.

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

The bundled workflow calls the safe review primitive directly, then renders comments:

```yaml
on:
  events:
    - pull_request.opened
    - pull_request.synchronize
    - pull_request.reopened
  commands:
    - name: review
      aliases: ["@pipr review"]
      requiredPermission: write

steps:
  - id: review
    uses: core/run-agent
    with:
      agent: pipr/reviewer
  - id: main-comment
    uses: core/main-comment
    with:
      review: ${{ steps.review.outputs.result }}
      template: pipr/main
```

Review workflows must expose the reserved runtime step ids `review`, `main-comment`, and `inline-comments`.
Command triggers run only for `issue_comment` events that target pull requests. pipr checks `github.event.issue.pull_request`, fetches PR metadata, checks the commenter with GitHub's collaborator permission API, parses command arguments, and only then starts the workflow. Permissions are ordered `read < triage < write < maintain < admin`; `requiredPermission` defaults to `write`.

## Registry modules

The materialized `.pipr/` tree contains conventional component files:

- `.pipr/workflows/*.yaml`
- `.pipr/agents/*.md`
- `.pipr/comments/*.yaml`
- `.pipr/schemas/*.json`

Custom `.pipr/blocks/*.yaml` files are supported for explicit user extensions, but the minimal distribution does not include one. Bundled product components use the `pipr/*` namespace. Runtime primitive blocks use the reserved `core/*` namespace.

`pipr validate` checks the generated tree and reports source-file errors before model or GitHub publishing work starts.
