# Runtime-owned publication kernel

Review workflows produce typed comment contributions. They do not call GitHub APIs directly.

The runtime-owned Publication Kernel:

- reduces `MainSectionContribution` values into one deterministic Main Review Comment
- renders that comment through the selected `CommentTemplate`
- verifies the current pull request head SHA before any write
- upserts the Main Review Comment by hidden marker
- caps Inline Review Comments only when `publication.maxInlineComments` is configured
- dedupes Inline Review Comments by hidden finding marker and reviewed head SHA
- maps inline findings to GitHub `line`, `side`, `start_line`, and `start_side` fields
- reports publication failures in metadata and fails the Action for the MVP

This keeps GitHub mutation policy deterministic and runtime-owned. Workflows and future plugins can contribute review content, but publication order, conflict handling, stale-head checks, marker dedupe, and API writes remain inside pipr.
