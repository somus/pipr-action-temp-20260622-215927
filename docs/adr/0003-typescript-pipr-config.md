# TypeScript pipr config

pipr uses repository-local `.pipr/config.ts` as the only supported user authoring surface. There is no YAML/Markdown config loader, migration mode, dual-loader, standalone command registry, or materialized component registry in the MVP.

`pipr init` creates:

- `.pipr/config.ts`
- `.pipr/tsconfig.json`
- `.pipr/types/pipr-sdk.d.ts`

The config imports `definePipr` and optional explicit `definePlugin` plugins from `@pipr/sdk`, then registers models, agents, tasks, change-request events, commands, local entrypoints, limits, and typed plugin tool handles through the builder API. Config execution is trusted planning code: it should register a runtime plan and should not perform repository reads, model calls, platform calls, or git operations.

For pull request Action runs, pipr loads `.pipr/config.ts` and local imports from the base commit. Pi still reviews the pull request head. This keeps PR-authored config changes visible in the Diff Manifest but unable to change review settings for the current run.

pipr-owned internals use `core/*` names for schemas and deterministic review/comment behavior, including `core/pr-review`. Users can compose tasks and agents in TypeScript, but diff creation, Pi call policy, model fallback and retry flow, review validation, stale-head checks, marker dedupe, and GitHub writes remain inside pipr. Custom plugin tools can be registered as typed handles, but Pi custom tool execution fails closed in the MVP.
