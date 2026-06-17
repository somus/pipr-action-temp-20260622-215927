# pipr

pipr is a Pi-powered pull request automation context. Its language describes the product surface and review workflow concepts, not implementation details.

## Language

**pipr**:
The GitHub pull request automation product that reviews pull requests through Pi-powered agents.
_Avoid_: legacy product names

**pipr Configuration**:
The repository-local product control plane under `.pipr/`.
_Avoid_: legacy configuration roots, `.pi/`

**@pipr**:
The GitHub pull request command mention used to request pipr review, summaries, or help from a pull request conversation.
_Avoid_: bot aliases

**Pi Agent Runner**:
The agent execution boundary where Pi runs reviewer prompts and returns structured output to pipr.
_Avoid_: workflow runner, publisher

**Review Workflow**:
An ordered pull request automation flow that gathers context, runs a reviewer, validates output, and produces review comments.
_Avoid_: pipeline, job

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
