# pipr-owned Comment Publishing

Status: Accepted

Review tasks produce typed comment contributions. They do not call GitHub APIs directly.

Comment Publishing:

- reduces `MainSectionContribution` values into one deterministic Main Review Comment
- renders that comment through the internal `MainCommentLayout`
- combines contributions from all selected tasks for pull request event runs
- treats `ctx.output.summary` and `ctx.output.section` as named section contribution emitters
- defaults shared section writes to `exclusive` unless tasks explicitly choose `append`, `replace`, or `list`
- verifies the current pull request head SHA before any write
- upserts the Main Review Comment by hidden marker
- caps Inline Review Comments only when `publication.maxInlineComments` is configured
- dedupes Inline Review Comments by hidden finding marker and reviewed head SHA
- maps inline findings to GitHub `line`, `side`, `start_line`, and `start_side` fields
- reports comment publishing failures in metadata and fails the Action for the MVP

The reducer controls conflict handling and list item dedupe before one GitHub comment upsert. This keeps GitHub write policy deterministic and pipr-owned. Tasks and future plugins can contribute review content, but comment order, conflict handling, stale-head checks, marker dedupe, and API writes remain inside pipr.
