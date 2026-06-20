# Runtime-owned review kernel

The default Review Workflow calls `core/run-agent` directly. The Official Minimal Distribution does not ship a custom review block.

`core/run-agent` owns the deterministic review kernel:

- build the Diff Manifest from local git state
- apply trusted Workflow and Agent path gates to the Diff Manifest
- run Pi with the selected reviewer agent and provider
- perform the single repair pass for invalid reviewer JSON
- validate `PrReview` output against the runtime-owned `core/pr-review` schema and Diff Manifest ranges
- return a validated review for comment rendering

Diff creation and review validation are internal to `core/run-agent` in the Core MVP. This keeps workflows from bypassing the deterministic safety checks needed before Main Review Comment and Inline Review Comment publication.

Workflows may compose around the review kernel and comment handlers, but the model-facing review path must pass through `core/run-agent`. Pull request event runs may select multiple enabled workflows; the runtime computes the Diff Manifest once, applies each workflow path gate, and runs selected workflows in parallel with isolated workflow state and scoped Diff Manifest views.
