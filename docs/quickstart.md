# Quickstart

This guide gets pipr running in a repository that already uses GitHub pull requests. For the full docs map, start with [pipr Docs](index.md).

## 1. Create the config

Install the CLI from the latest GitHub Release:

```bash
curl -fsSL https://raw.githubusercontent.com/somus/pipr/main/install.sh | sh
```

The installer downloads the matching GitHub Release binary to `~/.local/bin`. Set
`PIPR_VERSION=v0.1.0` to install a specific release or `PIPR_INSTALL_DIR=/usr/local/bin`
to choose a different destination.

If you want npm-managed SDK types in addition to the generated `.pipr/types` file, install the SDK:

```bash
npm install -D @pipr/sdk
```

```bash
pipr init
pipr check
```

`pipr init` creates:

- `.pipr/config.ts`
- `.pipr/tsconfig.json`
- `.pipr/types/pipr-sdk.d.ts`
- `.github/workflows/pipr.yml`

Existing pipr files are not overwritten unless `pipr init --force` is used.

The resulting project layout is:

```text
repo/
├── .pipr/
│   ├── config.ts
│   ├── tsconfig.json
│   └── types/pipr-sdk.d.ts
└── .github/workflows/pipr.yml
```

## 2. Add the provider secret

The default config uses DeepSeek:

```ts
apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" });
```

Create a GitHub Actions secret named `DEEPSEEK_API_KEY`.

## 3. Review the workflow

`pipr init` creates `.github/workflows/pipr.yml`:

```yaml
name: pipr

on:
  pull_request:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: write
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

`fetch-depth: 0` is required so pipr can compare the pull request head against the trusted base commit. pipr loads provider/model/API key settings from the base-branch `.pipr/config.ts`, so pull request changes cannot alter the model used for that run. `contents: write` is required by GitHub's integration token for resolving review threads. `checks: write` lets pipr publish Check Runs when your config enables them. `pull-requests: write` lets pipr publish Inline Review Comments and respond to user replies on pipr-owned comments.

## 4. Trigger a review

Open or update a pull request. pipr runs the configured review task and publishes:

- one Main Review Comment
- Inline Review Comments for valid findings, capped by config

You can also trigger the default command on a pull request:

```text
@pipr review
```

Command access defaults to repository `write` permission.

## 5. Check the config locally

```bash
pipr check
pipr inspect
pipr review --base origin/main
```

`pipr review` runs the local `review` entrypoint and prints the rendered main comment instead of publishing to GitHub.

## Next steps

- Read [Configuration](configuration.md) for common config patterns.
- Read [PIPR SDK Reference](sdk-reference.md) for the public builder API.
- Read [Runtime Guide](runtime.md) for Diff Manifest, Pi execution, validation, and publication behavior.
- Read [GitHub Action](github-action.md) for trusted options, outputs, dry runs, and permissions.
