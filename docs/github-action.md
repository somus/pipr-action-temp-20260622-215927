# GitHub Action

The GitHub workflow runs `pipr action` inside the prebuilt pipr image. GitHub is the first code host adapter; `.pipr/config.ts` remains provider-neutral.

## Workflow

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
      - uses: somus/pipr@main
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
        with:
          provider: deepseek
          model: deepseek-v4-pro
          api-key-env: DEEPSEEK_API_KEY
```

## Trusted options

| Option | Default | Purpose |
| --- | --- | --- |
| `config-dir` | `.pipr` | Directory containing `config.ts` and `tsconfig.json`. |
| `provider` | `deepseek` | Trusted Pi provider backend and provider profile id. |
| `model` | `deepseek-v4-pro` | Trusted model for the Action run. |
| `api-key-env` | `DEEPSEEK_API_KEY` | Trusted environment variable name containing the provider key. |

Trusted provider options come from workflow YAML, not from pull request code. The provider profile's `thinking` option stays in the base-commit `.pipr/config.ts`.

`pull-requests: write` publishes Inline Review Comments and enables best-effort stale inline thread resolution after a finding disappears. `issues: write` publishes and updates the Main Review Comment and command help. If GitHub denies the cleanup call or the API fails, the review still succeeds and records the issue in `publication.metadata.inlineResolutionErrors`.

## Outputs

| Output | Description |
| --- | --- |
| `main-comment` | Rendered main pull request review comment body. |
| `inline-comments` | JSON array of inline review comment publication items. |
| `dropped-findings` | JSON array of findings dropped during validation. |
| `publication` | JSON publication result for main and inline comments. |

## Trust model

For pull request Action runs, pipr loads `.pipr/config.ts` and local imports from the pull request base commit. Pi reviews the pull request head, so PR-authored config changes are visible as code under review but cannot change review settings for the current run.

Pi runs in a read-only workspace copy with only `read`, `grep`, `find`, and `ls`. Condensed Diff Manifest runs may receive pipr Diff Read Tools, which expose bounded reads over pipr-owned diff data and base/head snapshots.

## Dry run

Set `PIPR_DRY_RUN=1` to load the event and trusted config without running Pi or publishing comments:

```yaml
env:
  PIPR_DRY_RUN: "1"
```

Dry run is useful for checking Action packaging, event parsing, and trusted config loading.

## Command comments

`issue_comment` events are used for `@pipr` commands on pull requests. pipr checks that the comment targets a pull request, fetches pull request metadata, checks the commenter permission, parses command arguments, and then starts the task.

Permissions are ordered:

```text
read < triage < write < maintain < admin
```

Command permission defaults to `write`.

## Related docs

- [Runtime Guide](runtime.md)
- [Code Host Adapters](code-host-adapters.md)
- [Configuration](configuration.md)
