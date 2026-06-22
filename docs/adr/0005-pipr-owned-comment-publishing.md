# pipr-owned Comment Publishing

Status: Accepted

Review tasks produce typed comment contributions. They do not call code host APIs directly.

Comment Publishing:

- reduces `MainSectionContribution` values into one deterministic Main Review Comment
- renders that comment through the internal `MainCommentLayout`
- combines contributions from all selected tasks for change request event runs
- treats `ctx.output.summary` and `ctx.output.section` as named section contribution emitters
- defaults shared section writes to `exclusive` unless tasks explicitly choose `append`, `replace`, or `list`
- verifies the current change request head SHA before any write
- upserts the Main Review Comment by hidden marker
- caps Inline Review Comments only when `publication.maxInlineComments` is configured
- dedupes Inline Review Comments by hidden finding marker and reviewed head SHA
- leaves provider-specific inline comment payload mapping to the code host adapter
- reports comment publishing failures in metadata and fails the Action for the MVP

The reducer controls conflict handling and list item dedupe before adapter publication. This keeps write policy deterministic and pipr-owned. Tasks and future plugins can contribute review content, but comment order, conflict handling, stale-head checks, marker dedupe, and API writes remain inside pipr. The GitHub adapter maps inline findings to GitHub `line`, `side`, `start_line`, and `start_side`; future adapters can map the same neutral inline items to their native diff position model.
