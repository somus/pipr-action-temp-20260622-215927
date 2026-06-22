# Architecture

pipr owns GitHub pull request runtime behavior. Pi owns agent execution.

## Runtime flow

1. Load the trusted TypeScript config.
2. Parse the GitHub pull request or command event.
3. Build the Diff Manifest from local git state.
4. Run selected Review Tasks.
5. Call Pi through `ctx.pi.run()`.
6. Validate structured review output against the Diff Manifest.
7. Build the Main Review Comment and Inline Review Comments.
8. Publish comments through the GitHub API after stale-head checks.

## Trust boundaries

For GitHub Action pull request runs, pipr loads `.pipr/config.ts` and local imports from the base commit. The pull request head is reviewed, but PR-authored config changes cannot change the current run's executable review settings.

Provider backend, model, and API-key env can be overridden only by trusted Action inputs. Provider options such as `thinking` come from the trusted config.

Pi receives a read-only workspace copy. It can use only read-only built-in tools and pipr-owned Diff Read Tools for condensed manifest runs.

## Extension points

User config can register models, agents, tasks, commands, local entrypoints, limits, and typed plugin handles through `@pipr/sdk`.

pipr-owned runtime code keeps diff creation, Pi invocation policy, structured output validation, stale-head checks, marker dedupe, and GitHub writes out of userland tasks.

## Decisions

- [0001: pipr owns PR runtime, Pi owns agent execution](adr/0001-pipr-owns-pr-runtime-pi-owns-agent-execution.md)
- [0002: Docker Action with read-only Pi workspace](adr/0002-docker-action-with-read-only-pi-workspace.md)
- [0003: TypeScript pipr config](adr/0003-typescript-pipr-config.md)
- [0004: pipr-owned Review Run](adr/0004-pipr-owned-review-run.md)
- [0005: pipr-owned Comment Publishing](adr/0005-pipr-owned-comment-publishing.md)
