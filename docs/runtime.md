# Runtime Guide

pipr runtime has one job: turn a code host change request into a deterministic review run.

## Run modes

| Mode | Command or trigger | Publishes comments |
| --- | --- | --- |
| Change request event | GitHub `pull_request` event through `pipr action` | Yes |
| Command comment | GitHub `issue_comment` event such as `@pipr review` | Yes |
| Local review | `pipr review --base <sha> [--head <sha>]` | No |
| Local named task | `pipr run <name> --base <sha> [--head <sha>]` | No |
| Dry run | `pipr dry-run --event <path>` or `PIPR_DRY_RUN=1` in Action | No |

Local runs use the local code host adapter. They build the same Diff Manifest and execute the same task logic, but publication is disabled.

## Change request context

Runtime tasks receive provider-neutral context:

```ts
type TaskContext = {
  platform: { id: string };
  repository: {
    root: string;
    owner?: string;
    name: string;
    defaultBranch?: string;
    remoteUrl?: string;
  };
  change: {
    number?: number;
    title: string;
    description: string;
    url?: string;
    author?: { login: string };
    base: { ref?: string; sha: string };
    head: { ref?: string; sha: string };
    isFork?: boolean;
    diffManifest(options?: {
      compressed?: boolean;
      paths?: {
        include?: string[];
        exclude?: string[];
      };
    }): Promise<DiffManifest>;
  };
};
```

`change.number` means GitHub pull request number today. Future adapters can map it to a provider-native change id, such as a GitLab merge request IID. GitLab, Bitbucket, and Azure DevOps support is coming soon.

## Trust model

For GitHub Action pull request runs:

1. The workflow chooses trusted provider options.
2. pipr checks out the pull request for review.
3. pipr loads `.pipr/config.ts` and local imports from the base commit.
4. Pull request changes to `.pipr/config.ts` are reviewed as code, but do not affect the current run.
5. Pi receives a read-only workspace copy and pipr-owned diff tools.

This keeps model choice, API-key env names, task registration, command permissions, and publication policy out of untrusted pull request code.

## Runtime flow

```text
code host event
  -> adapter parses provider event
  -> trusted config loads
  -> adapter ensures checkout
  -> Diff Manifest builds
  -> selected tasks run
  -> Pi returns structured JSON
  -> pipr validates findings
  -> publication plan reduces task output
  -> adapter publishes native comments
```

Core runtime never calls GitHub APIs directly. It receives a `ChangeRequestEventContext` and delegates provider-specific reads and writes to the active adapter.

## Diff Manifest

The Diff Manifest is the source of truth for changed files and commentable ranges:

```ts
const manifest = await ctx.change.diffManifest({
  compressed: true,
  includePreviews: true,
  paths: {
    include: ["packages/runtime/**"],
    exclude: ["**/*.test.ts"],
  },
});
```

Each file carries changed-line ranges that can receive inline comments. Review Findings must point at a valid range:

```ts
{
  body: "Specific issue and why it matters.",
  path: "src/example.ts",
  rangeId: "rng_...",
  side: "RIGHT",
  startLine: 12,
  endLine: 12,
}
```

When the full manifest is too large, pipr sends a condensed manifest and attaches bounded Diff Read Tools. The model can ask for more range-scoped context without receiving shell or arbitrary filesystem access.

`paths` filters Diff Manifest files by include and exclude globs. For renamed files, current and previous paths are considered. Path scope also drops publishable findings outside the filter, but it does not restrict Pi read-only access to the rest of the repository.

## Pi execution

Tasks call Pi through `ctx.pi.run(...)`:

```ts
const result = await ctx.pi.run(
  reviewer,
  { manifest, change: ctx.change },
  {
    timeout: "5m",
    fallbacks: [backupModel],
  },
);
```

Model selection order:

1. `ctx.pi.run(...)` call override
2. `agent.model`
3. `agent.fallbacks`
4. trusted Action provider inputs or config default provider

Invalid structured output receives one repair attempt when configured. Transient retries are opt-in through agent retry settings.

## Publication

Review Tasks do not write code host comments. A selected run emits one final output:

- `ctx.comment(markdown)`
- `ctx.comment({ main, inlineFindings })`

pipr turns that output into a provider-neutral `PublicationPlan`:

- one Main Review Comment
- zero or more Inline Review Comment drafts
- dropped finding metadata
- run metadata

Before publishing, pipr checks the current head SHA. It upserts the Main Review Comment by hidden marker and replaces the visible main body wholesale. That marker also carries pipr-owned review state for prior finding IDs, locations, statuses, task scope, and head metadata. Reruns pass matching open prior finding locations back to the reviewer, keep same-head open findings visible if the reviewer omits them, and mark omitted prior findings resolved in hidden state when the reviewed head changes. GitHub publication replies to the stale Inline Review Comment with the resolving commit link and resolves that review thread when permissions allow; cleanup failures are recorded in publication metadata without failing the review. Inline Review Comments are deduped by stable finding id, reviewed head SHA, and pipr-owned same-head location overlap.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| No matching event or command | Action is ignored. |
| Config load or validation failure | Run fails before Pi execution. |
| Missing provider env when required | Run fails before Pi execution. |
| Pi returns invalid JSON after repair | Task fails and metadata records failure. |
| Finding targets invalid range | Finding is dropped, run continues. |
| Stale head before publication | Publication stops before writes. |
| Comment API failure | Publication metadata is emitted and the Action fails. |
| Stale review-thread cleanup failure | Publication metadata records the cleanup error and the Action continues. |

## Local checks

```bash
pipr check
pipr inspect
pipr review --base origin/main
pipr run security --base origin/main --head HEAD
```

`pipr inspect` prints models, agents, tasks, change request triggers, commands, locals, tools, publication settings, and limits.
