# pipr Product Language

Use these terms consistently in product docs, code comments, issues, and pull requests.

## Terms

**pipr**:
The GitHub pull request automation product that reviews pull requests through Pi-powered agents.
_Avoid_: legacy product names

**pipr Configuration**:
The repository-local TypeScript config under `.pipr/config.ts`.
_Avoid_: legacy configuration roots, `.pi/`

**Trusted Action Inputs**:
GitHub Action inputs controlled by workflow YAML, used for trusted provider selection.
_Avoid_: PR-authored provider settings

**TypeScript Config**:
The single supported user authoring surface. `pipr init` creates `.pipr/config.ts`, `.pipr/tsconfig.json`, and `.pipr/types/pipr-sdk.d.ts`.
_Avoid_: hidden runtime defaults

**PIPR SDK**:
The public builder API imported from `@pipr/sdk`.
_Avoid_: YAML component registry

**@pipr**:
The GitHub pull request command mention for task-owned commands such as `@pipr review`.
_Avoid_: bot aliases

**Pi Agent Runner**:
The agent execution boundary where Pi runs reviewer prompts and returns structured output to pipr.
_Avoid_: publisher

**Task Input**:
A typed value parsed from a command or local entrypoint and passed to a `pipr.task()` callback.
_Avoid_: environment variable, hidden prompt state

**Review Task**:
A `pipr.task()` callback that gathers context, runs agents, and contributes review output.
_Avoid_: YAML workflow, block graph

**Review Run**:
The pipr-owned path used by `ctx.change.diffManifest()` and `ctx.pi.run()`.
_Avoid_: user-authored diff or validation block

**Diff Manifest**:
The compact changed-code model that defines files, hunks, and ranges where review findings may be anchored.
_Avoid_: raw diff

**Condensed Diff Manifest**:
A size-reduced prompt form that preserves mapping fields while allowing bounded follow-up reads.
_Avoid_: lossy location model, model-owned diff parsing

**pipr Diff Read Tool**:
A pipr-attached Pi tool for bounded reads over trusted Diff Manifest data and base/head snapshots.
_Avoid_: plugin tool, GitHub API tool, shell access

**Review Finding**:
An actionable issue found in a pull request and anchored to a validated diff range.
_Avoid_: nit, alert

**Main Review Comment**:
The single pull request comment that summarizes pipr's review and metadata.
_Avoid_: summary post

**Inline Review Comment**:
A pull request review comment anchored to one validated diff range.
_Avoid_: annotation

**Comment Publishing**:
The pipr-owned reducer and GitHub writer for Main Review Comments and Inline Review Comments.
_Avoid_: task-authored GitHub comment writes
