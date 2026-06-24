# pipr-owned Comment Publishing

Status: Accepted

Review tasks produce typed comment contributions. They do not call code host APIs directly.

Comment Publishing:

- reduces `ctx.comment(...)` main contributions into one deterministic Main Review Comment
- renders runtime-owned hidden contribution blocks
- combines contributions from all selected tasks for change request event runs
- treats each `ctx.comment(...)` key as the replace/remove unit for one main comment contribution
- preserves prior contribution blocks from tasks that did not run
- verifies the current change request head SHA before any write
- upserts the Main Review Comment by hidden marker and stores pipr-owned review state on that marker
- caps Inline Review Comments only when `publication.maxInlineComments` is configured
- dedupes Inline Review Comments by stable finding id, reviewed head SHA, and pipr-owned same-head location overlap
- passes open prior findings into rerun prompts so the reviewer can reuse prior finding ids or let fixed findings become resolved
- replies to stale GitHub Inline Review Comments with the resolving commit link and resolves their review threads when prior findings are fixed
- leaves provider-specific inline comment payload mapping to the code host adapter
- reports comment publishing failures in metadata and fails the Action for the MVP

The reducer controls conflict handling and list item dedupe before adapter publication. This keeps write policy deterministic and pipr-owned. Tasks and future plugins can contribute review content, but comment order, conflict handling, stale-head checks, marker dedupe, and API writes remain inside pipr. The GitHub adapter maps inline findings to GitHub `line`, `side`, `start_line`, and `start_side`; future adapters can map the same neutral inline items to their native diff position model.
