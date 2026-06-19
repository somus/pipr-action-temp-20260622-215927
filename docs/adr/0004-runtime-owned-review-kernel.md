# Runtime-owned review kernel

The default Review Workflow calls `core/run-agent` directly. The Official Minimal Distribution does not ship a custom review block.

`core/run-agent` owns the deterministic review kernel:

- build the Diff Manifest from local git state
- run Pi with the selected reviewer agent and provider
- perform the single repair pass for invalid reviewer JSON
- validate `PrReview` output against schema and Diff Manifest ranges
- return a validated review for comment rendering

Diff creation and review validation are not exposed as separate userland blocks in the Core MVP. In particular, `core/diff-manifest` and `core/validate-pr-review` are not registry-visible blocks. This keeps workflows from accidentally or intentionally bypassing the deterministic safety checks needed before Main Review Comment and Inline Review Comment publication.

Workflows may compose around the review kernel and comment handlers, but the model-facing review path must pass through `core/run-agent`.

