# Code Host Adapters

Code host adapters are an internal runtime seam. They are not part of `.pipr/config.ts`.

GitHub is the first adapter. GitLab, Bitbucket, and Azure DevOps support is coming soon.

The public config stays provider-neutral:

```ts
pipr.review({
  id: "review",
  reviewer,
  entrypoints: {
    changeRequest: ["opened", "updated"],
    command: { pattern: "@pipr review", permission: "write" },
    local: "review",
  },
});
```

The adapter decides how a native provider event, permission model, checkout operation, and inline comment API map to pipr's neutral runtime objects.

## Why this seam exists

GitHub and GitLab both have change requests and inline comments, but their APIs do not share the same location model.

- GitHub pull request review comments use fields such as commit id, side, line, and optional start line.
- GitLab merge request discussions use merge request versions and provider-specific diff positions.

If those fields leak into Review Tasks or `.pipr/config.ts`, every future provider would need GitHub-shaped compatibility code. Instead, core produces neutral publication items and adapters map them to native payloads.

## Neutral event context

Adapters parse native events into `ChangeRequestEventContext`:

```ts
type ChangeRequestEventContext = {
  eventName: string;
  action?: string;
  rawAction?: string;
  platform: { id: string; host?: string };
  repository: { slug: string; url?: string };
  change: {
    number: number;
    title: string;
    description: string;
    url?: string;
    author?: { login: string };
    base: { sha: string; ref?: string; url?: string };
    head: { sha: string; ref?: string; url?: string; author?: { login: string }; fork?: boolean };
    isFork?: boolean;
  };
  workspace: string;
};
```

`change.number` is provider-relative. For GitHub it is the pull request number. For GitLab it can be the merge request IID.

## Ownership split

| Core runtime owns | Code host adapter owns |
| --- | --- |
| Config loading and validation | Native event parsing |
| Review Task selection | Command comment resolution |
| Diff Manifest creation | Native repository permission mapping |
| Pi run policy | Safe checkout and provider refs |
| Structured output validation | Native inline location mapping |
| Main comment and inline reducers | Main and inline comment API calls |
| Marker dedupe and stale-head policy | Provider-specific publication payloads |

Core imports no GitHub modules. GitHub is one adapter implementation.

## Current adapters

### GitHub

The GitHub adapter handles:

- `pull_request` event parsing
- `issue_comment` command parsing
- pull request metadata loading
- repository permission normalization into `read | triage | write | maintain | admin`
- safe workspace setup
- pull request head checkout
- Main Review Comment upsert
- Inline Review Comment publication
- GitHub inline payload mapping

GitHub-specific setup stays in [GitHub Action](github-action.md).

### Local

The local adapter handles local CLI runs:

- synthesizes provider-neutral repository and change metadata from local git state
- supports local review task execution
- never publishes comments

Use it through:

```bash
pipr review --base origin/main
pipr run <name> --base origin/main --head HEAD
```

## Coming soon

Provider support planned next:

- GitLab
- Bitbucket
- Azure DevOps

The public config should remain provider-neutral as these adapters land.

## Internal adapter shape

The internal runtime interface is intentionally not exported from the package root:

```ts
type CodeHostAdapter = {
  id: string;
  parseEvent(options): Promise<ChangeRequestEventContext>;
  loadChangeRequest(ref): Promise<LoadedChangeRequest>;
  resolveCommandComment(options): Promise<CommandCommentEvent>;
  getRepositoryPermission(options): Promise<RepositoryPermission>;
  ensureHeadCheckout(options): void;
  publish(options): Promise<PublicationResult>;
  mapInlineLocation(item, change): unknown;
};
```

`RepositoryPermission` is:

```text
none | read | triage | write | maintain | admin
```

Command config can require every level except `none`.

## Future provider checklist

A future adapter should land with contract fixtures before becoming public:

- native event fixtures for opened, updated, reopened, ready, closed
- command comment fixtures
- permission fixtures for each provider role
- checkout fixture for fork and same-repository changes
- inline location mapping fixtures
- main comment upsert fixture
- stale-head prevention fixture
- local dry-run parity fixture

The public config should not grow `pipr.github.*`, `pipr.gitlab.*`, `pipr.bitbucket.*`, or `pipr.azureDevOps.*` namespaces until a provider-specific user setting is proven necessary.
