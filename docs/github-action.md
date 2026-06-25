# GitHub Action

The GitHub workflow runs `pipr action` inside the prebuilt pipr image. GitHub is the first code host adapter; `.pipr/config.ts` remains provider-neutral.

## Workflow

```yaml
name: pipr

on:
  pull_request:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: write

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
```

## Trusted options

| Option | Default | Purpose |
| --- | --- | --- |
| `config-dir` | `.pipr` | Directory containing `config.ts` and `tsconfig.json`. |

Provider settings come from the base-commit `.pipr/config.ts`, not from pull request code. The Action uses the base config's default model and configured fallbacks, including provider backend, model name, API key env name, and provider options.

`checks: write` lets pipr publish task and aggregate Check Runs when enabled by config. `pull-requests: write` publishes Inline Review Comments, lets pipr resolve verified fixed threads, and lets pipr respond to user replies on pipr-owned Inline Review Comments. `issues: write` publishes and updates the Main Review Comment and command help. If GitHub denies the cleanup call or the API fails, the review still succeeds and records the issue in `publication.metadata.inlineResolutionErrors`.

## Outputs

| Output | Description |
| --- | --- |
| `main-comment` | Rendered main pull request review comment body. |
| `inline-comments` | JSON array of inline review comment publication items. |
| `dropped-findings` | JSON array of findings dropped during validation. |
| `publication` | JSON publication result for main and inline comments. On `pull_request_review_comment` verifier runs, this contains verifier thread action errors such as `inlineResolutionErrors`. |

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

`pull_request_review_comment` events are used for verifier replies. When a user replies to a pipr-owned Inline Review Comment, pipr can run its internal verifier against the current diff and thread context. If the finding is fixed, pipr replies and resolves the thread. If the finding is still valid, pipr can reply with a short explanation and keep the thread open.

Permissions are ordered:

```text
read < triage < write < maintain < admin
```

Command permission defaults to `write`.

## Related docs

- [Runtime Guide](runtime.md)
- [Code Host Adapters](code-host-adapters.md)
- [Configuration](configuration.md)
