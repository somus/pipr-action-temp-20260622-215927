# pipr

pipr is a Pi-powered pull request automation context. Its language describes the product surface and review task concepts, not implementation details.

## Language

**pipr**:
The GitHub pull request automation product that reviews pull requests through Pi-powered agents.
_Avoid_: legacy product names

**pipr Configuration**:
The repository-local TypeScript config under `.pipr/config.ts`.
_Avoid_: legacy configuration roots, `.pi/`

**Trusted Action Inputs**:
The Docker Action treats PR-head `.pipr/` changes as reviewed code, but loads executable review settings from trusted Action provider inputs and base-commit `.pipr/config.ts` plus its local imports.
_Avoid_: PR-authored review settings

**TypeScript Config**:
The single supported user authoring surface. `pipr init` creates `.pipr/config.ts`, `.pipr/tsconfig.json`, and `.pipr/types/pipr-sdk.d.ts`.
_Avoid_: hidden runtime defaults

**PIPR SDK**:
The public builder API imported from `@pipr/sdk`. It exposes `definePipr`, `definePlugin`, `model`, `secret`, `agent`, `task`, `review`, `command`, `local`, `on.changeRequest`, prompt helpers, core schemas, and explicit TypeScript plugin hooks.
_Avoid_: YAML component registry

**@pipr**:
The GitHub pull request command mention for task-owned commands such as `@pipr review`. Command permissions control who may trigger a task, not what the task may do.
_Avoid_: bot aliases

**Pi Agent Runner**:
The agent execution boundary where Pi runs reviewer prompts and returns structured output to pipr.
_Avoid_: publisher

**Task Input**:
A typed value parsed from a command or local entrypoint and passed to a `pipr.task()` callback.
_Avoid_: environment variable, hidden prompt state

**pipr Diff Read Tool**:
A pipr-attached Pi tool enabled by trusted pipr code for condensed Diff Manifest runs, such as `pipr_read_diff(path?, rangeId?)` or range-scoped `pipr_read_at_ref(path, ref, rangeId)`.
_Avoid_: plugin tool, GitHub API tool, shell access

**Review Task**:
A `pipr.task()` callback that gathers context, runs agents, validates output through runtime helpers, and contributes review comments.
_Avoid_: YAML workflow, block graph

**Review Run**:
The pipr-owned review path used by `ctx.change.diffManifest()` and `ctx.pi.run()`. It creates the Diff Manifest, prepares prompt payloads and pipr Diff Read Tools, runs Pi with configured model fallback and retry policy, repairs invalid structured output when configured, and validates Review Findings before comment rendering.
_Avoid_: user-authored diff or validation block

The Review Run computes the Diff Manifest once per pull request runtime call and shares it across matching Review Tasks and Agent calls. Matching pull request tasks run in parallel and reduce in deterministic config order.

**Comment Publishing**:
The pipr-owned reducer and GitHub writer that turns task comment contributions into one Main Review Comment upsert and capped Inline Review Comment writes.
_Avoid_: task-authored GitHub comment writes

Pull request events can select multiple Review Tasks. Comment Publishing reduces all task contributions into one Main Review Comment and one capped Inline Review Comment set. `ctx.output.section` and `ctx.output.summary` emit named section contributions. The default section merge policy is `exclusive`; tasks must explicitly choose `append`, `replace`, or `list` when sharing a section.

**Review Finding**:
An actionable issue found in a pull request and anchored to a validated diff range.
_Avoid_: nit, alert

**Non-inline Finding**:
Not part of the MVP Review Result. pipr only accepts inline findings anchored to valid Diff Manifest ranges.
_Avoid_: repository-wide finding, unanchored review alert

**Diff Manifest**:
The compact changed-code model that defines files, hunks, and ranges where review findings may be anchored.
_Avoid_: raw diff

**Condensed Diff Manifest**:
A size-reduced prompt form that preserves mapping fields while dropping non-mapping context. Pi can use pipr Diff Read Tools to request bounded, range-scoped extra context.
_Avoid_: lossy location model, model-owned diff parsing

**Main Review Comment**:
The single pull request comment that summarizes pipr's review and metadata.
_Avoid_: summary post

**Inline Review Comment**:
A pull request review comment anchored to one validated diff range.
_Avoid_: annotation
