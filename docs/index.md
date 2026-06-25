# pipr Docs

pipr is a repository-local code review runtime. You write a TypeScript config in `.pipr/config.ts`; pipr loads that trusted config, builds a Diff Manifest from a change request, runs Pi-backed Review Tasks, validates model output, and publishes one Main Review Comment plus bounded Inline Review Comments.

GitHub is the first delivery target. The runtime is shaped around code host adapters, so the public config stays provider-neutral while GitHub-specific event parsing, permissions, checkout, and comment APIs live behind the adapter boundary. GitLab, Bitbucket, and Azure DevOps support is coming soon.

## Project layout

`pipr init` creates the authoring files:

```text
repo/
├── .pipr/
│   ├── config.ts              # repository-local TypeScript config
│   ├── tsconfig.json          # config typecheck settings
│   └── types/
│       └── pipr-sdk.d.ts      # generated SDK declarations
└── .github/
    └── workflows/
        └── pipr.yml           # GitHub Action delivery target
```

Use `pipr init --adapters none` to skip adapter files and create only the `.pipr` tree.
Run `pipr init --help` to list supported init adapters.

The config is the only public authoring surface. Do not put runtime settings in `.pi`; pipr creates any Pi home it needs inside the Action image.

## Minimal config

```ts
import { definePipr } from "@pipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  const reviewer = pipr.reviewer({
    model,
    instructions: `
      Review the pull request diff for correctness, security,
      maintainability, and test coverage.
      Return only actionable findings that target valid diff ranges.
    `,
  });

  pipr.review({
    id: "review",
    reviewer,
    entrypoints: {
      changeRequest: ["opened", "updated", "reopened", "ready"],
      command: { pattern: "@pipr review", permission: "write" },
      local: "review",
    },
    inlineComments: { max: 5 },
    timeout: "5m",
  });
});
```

This registers three ways to run the same Review Task:

- change request events from the code host
- `@pipr review` command comments
- local `pipr review --base <sha>`

## Runtime model

1. A code host adapter parses a change request event, command comment, or local run context.
2. pipr loads `.pipr/config.ts` from the trusted config source.
3. pipr builds a Diff Manifest with commentable ranges.
4. Selected Review Tasks call `ctx.pi.run(...)`.
5. pipr validates structured Review Findings against the Diff Manifest.
6. pipr reduces task output into one Main Review Comment and capped Inline Review Comments.
7. The adapter maps provider-neutral publication items to native code host API payloads.

Pi executes the agent. pipr owns orchestration, validation, and publication policy.

## Docs map

| Page | Use it for |
| --- | --- |
| [Quickstart](quickstart.md) | Install pipr, create config, add the GitHub Action, trigger first review. |
| [Configuration](configuration.md) | Common config recipes and examples. |
| [PIPR SDK Reference](sdk-reference.md) | Public SDK imports, builder methods, task context, schemas, tools, and entrypoints. |
| [Runtime Guide](runtime.md) | Run modes, trust model, Diff Manifest, Pi execution, validation, publication. |
| [GitHub Action](github-action.md) | Workflow YAML, trusted options, outputs, permissions, dry run. |
| [Code Host Adapters](code-host-adapters.md) | Internal adapter seam for GitHub now, with GitLab, Bitbucket, and Azure DevOps support coming soon. |
| [Architecture](architecture.md) | Short architecture summary and ADR links. |
| [Development](development.md) | Repo setup, checks, Action e2e, release checks. |
