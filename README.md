# pipr

pipr is a Pi-powered GitHub PR automation runtime. The current runtime validates `.pipr/` configuration, loads GitHub pull request events, builds a local Diff Manifest, runs Pi for schema-first review JSON, validates findings against commentable ranges, reduces workflow contributions into one publication plan, then upserts the Main Review Comment and publishes Inline Review Comments.

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

This builds the Docker Action image, verifies the installed Pi CLI contract, and runs local Action fixtures through `act`. The dry-run fixture proves Docker Action packaging and event/config loading without calling Pi or publishing comments. The full-flow fixture uses fake Pi and fake GitHub publication storage, then asserts one Main Review Comment and one Inline Review Comment payload are produced.

`check-actions` builds one local image, `pipr-action:act`, then generates local-only Action metadata under `.github/act/` so every `act` fixture uses that prebuilt image instead of rebuilding the Dockerfile. To test a future published image after the repository exists on GitHub, run:

```bash
PIPR_SKIP_ACTION_IMAGE_BUILD=1 \
PIPR_ACTION_IMAGE=ghcr.io/somus/pipr-action:main \
mise run act-pr-full
```

The GHCR image workflow is manual and does not publish by default. Until `ghcr.io/somus/pipr-action:main` is pushed and made public or explicitly shared, external sample repositories cannot use the image.

## Repository setup

Start a repository by materializing the official minimal pipr distribution:

```bash
pipr init
pipr validate
```

`pipr init` creates editable files under `.pipr/` for config, workflows, the reviewer agent, and comment templates. Workflow-owned command triggers live under `Workflow.on.commands`. The PR review schema is runtime-owned as `core/pr-review`. The minimal distribution does not create custom blocks; the default review flow calls `core/run-agent` directly. Existing pipr files are not replaced unless `pipr init --force` is used. `config-dir` must resolve inside the repository root.

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

The Docker Action pins provider execution from trusted Action inputs, not from PR-authored
`.pipr/config.yaml`. This keeps a pull request from redirecting the provider backend, model,
or API-key environment variable.

The provider profile's `thinking` value stays in `.pipr/config.yaml`. Non-dry Action runs read it
from the pull request base commit, then map it to Pi's `--thinking` flag.
Provider secrets stay env-only through `apiKeyEnv`; pipr does not pass raw keys with
`--api-key`. Pi runs with `--tools read,grep,find,ls`, so the reviewer can inspect the
read-only workspace without `bash`, `write`, or `edit`.

For small pull requests, pipr sends the full Diff Manifest in the reviewer prompt. If the
serialized manifest exceeds configured byte or estimated-token limits, pipr sends a condensed
manifest that preserves deterministic mapping fields and attaches runtime-owned read tools:
`pipr_read_diff(path?, rangeId?)` and `pipr_read_at_ref(path, ref, rangeId)`. These are not
`.pipr/` plugin tools and never expose GitHub APIs, shell access, writes, comment publishing, or
path-only base file reads.

The Action ignores PR-head `.pipr/` as executable authority. Non-dry Action runs load the
materialized workflow, agent, comment-template, optional custom schema, and optional block registry from
the pull request base commit. That base-commit `.pipr/` tree is trusted review authority, while
runtime-owned `core/run-agent` owns deterministic diff creation, Pi execution, and review
validation. Runtime-owned publication code owns comment reduction, stale-head checks, main-comment
upsert, inline marker dedupe, and GitHub comment writes. Invalid or deleted PR-head
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

Diff Manifest prompt limits are optional. Defaults are `128 KiB` or `32k` estimated tokens for
the full manifest, then `256 KiB` or `64k` estimated tokens for the condensed manifest:

```yaml
limits:
  timeoutSeconds: 300
  diffManifest:
    fullMaxBytes: 131072
    fullMaxEstimatedTokens: 32000
    condensedMaxBytes: 262144
    condensedMaxEstimatedTokens: 64000
    toolResponseMaxBytes: 65536
```

The bundled workflow calls the safe review primitive directly, then renders comments:

```yaml
paths:
  include: ["src/**", "packages/**"]
  exclude: ["**/*.md"]

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
  - id: inline-comments
    uses: core/inline-comments
    with:
      review: ${{ steps.review.outputs.result }}
```

Review workflows must expose the reserved runtime step ids `review`, `main-comment`, and `inline-comments`.
Workflow and Agent `paths` use repo-relative glob patterns. `include` defaults to all files, `exclude` wins, dotfiles are matched, patterns without `/` match basenames at any depth, and renamed files match both `path` and `previousPath`. Pull request events run every enabled workflow whose event and paths match in parallel; command comments run only the matched workflow and still respect paths.

`core/main-comment` emits named Main Review Comment section contributions. Passing `review` emits the default `summary` and `findings` sections. Passing `sectionId` and `value` emits one explicit section. `merge` defaults to `exclusive`, so multiple workflows writing the same section fail unless they explicitly choose `append`, `replace`, or `list`. `list` can dedupe structured items with `itemKey`.

```yaml
steps:
  - id: summary
    uses: core/main-comment
    with:
      sectionId: summary
      value: ${{ steps.review.outputs.result.review.summary.body }}
      merge: exclusive
      priority: 100
```

Command triggers run only for `issue_comment` events that target pull requests. pipr checks `github.event.issue.pull_request`, fetches PR metadata, checks the commenter with GitHub's collaborator permission API, parses command arguments, and only then starts the workflow. Permissions are ordered `read < triage < write < maintain < admin`; `requiredPermission` defaults to `write`.

Agents may declare `string` or `json` inputs. `core/run-agent` validates those inputs before Pi runs, and Agent markdown can embed them with `${{ inputs.name }}`. Objects and arrays render as stable pretty JSON. Agent `provider` may also be `${{ inputs.provider }}` or an inline provider object without an `id`; string providers must resolve to a configured provider id. Independent `core/run-agent` steps are scheduled from workflow `steps.*` dependencies, so specialist reviewers can run before a final reserved `review` orchestrator step.

Agents may also declare `paths`. Agent paths narrow the workflow-scoped Diff Manifest before Pi runs. If no files remain, pipr returns an empty validated review for that Agent without calling Pi.

```yaml
steps:
  - id: correctness
    uses: core/run-agent
    with:
      agent: pipr/specialist-reviewer
      inputs:
        focus: correctness
  - id: security
    uses: core/run-agent
    with:
      agent: pipr/specialist-reviewer
      inputs:
        focus: security
  - id: review
    uses: core/run-agent
    with:
      agent: pipr/review-orchestrator
      inputs:
        reviews:
          correctness: ${{ steps.correctness.outputs.result }}
          security: ${{ steps.security.outputs.result }}
```

## Registry modules

The materialized `.pipr/` tree contains conventional component files:

- `.pipr/workflows/*.yaml`
- `.pipr/agents/*.md`
- `.pipr/comments/*.yaml`
- `.pipr/schemas/*.json` for optional user schemas

Custom `.pipr/blocks/*.yaml` files are supported for explicit user extensions, but the minimal distribution does not include one. Bundled product components use the `pipr/*` namespace. Runtime internals use the reserved `core/*` namespace, including the canonical `core/pr-review` schema.

`pipr validate` checks the generated tree and reports source-file errors before model or GitHub publishing work starts. If `publication.maxInlineComments` is omitted, inline publication is uncapped for the current validated finding set.
