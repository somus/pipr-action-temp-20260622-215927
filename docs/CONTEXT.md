# pipr

pipr is a Pi-powered pull request automation context. Its language describes the product surface and review workflow concepts, not implementation details.

## Language

**pipr**:
The GitHub pull request automation product that reviews pull requests through Pi-powered agents.
_Avoid_: legacy product names

**pipr Configuration**:
The repository-local product control plane under `.pipr/`.
_Avoid_: legacy configuration roots, `.pi/`

**Action Trust Boundary**:
The Docker Action treats PR-head `.pipr/` changes as reviewed code, but loads executable review authority from trusted Action provider inputs, base-commit provider thinking config, the base-commit materialized workflow registry, and runtime-owned `core/*` handlers. Custom blocks are optional base-commit extensions, not part of the minimal distribution.
_Avoid_: PR-authored runtime authority

**Official Minimal Distribution**:
The editable `.pipr/` tree created by `pipr init` as the normal starting point for a repository. It ships config, workflows with command triggers, agents, and comments, but no custom blocks or core review schemas.
_Avoid_: hidden runtime defaults

**Component Namespace**:
Use `pipr/*` for product components shipped in the editable distribution. Use `core/*` only for runtime-owned internals such as primitive blocks and core schemas.
_Avoid_: `official/*`

**@pipr**:
The GitHub pull request command mention for workflow-owned commands such as `@pipr review` and built-in `@pipr help`. Command permissions control who may trigger a workflow, not what the workflow may do.
_Avoid_: bot aliases

**Pi Agent Runner**:
The agent execution boundary where Pi runs reviewer prompts and returns structured output to pipr.
_Avoid_: workflow runner, publisher

**Review Workflow**:
An ordered pull request automation flow that gathers context, runs a reviewer, validates output, and produces review comments.
_Avoid_: pipeline, job

**Review Kernel**:
The runtime-owned `core/run-agent` primitive that creates the Diff Manifest, runs Pi, and validates Review Findings before comment rendering.
_Avoid_: user-authored diff or validation block

**Review Finding**:
An actionable issue found in a pull request and anchored to a validated diff range.
_Avoid_: nit, alert

**Diff Manifest**:
The compact changed-code model that defines files, hunks, and ranges where review findings may be anchored.
_Avoid_: raw diff

**Main Review Comment**:
The single pull request comment that summarizes pipr's review and metadata.
_Avoid_: summary post

**Inline Review Comment**:
A pull request review comment anchored to one validated diff range.
_Avoid_: annotation
