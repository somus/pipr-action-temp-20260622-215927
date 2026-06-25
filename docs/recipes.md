# pipr Init Recipes

`pipr init --recipe <id>` creates a starter `.pipr/config.ts` for a specific review workflow. Omit `--recipe` to keep the default config.

```bash
pipr init --recipe security-sast
pipr check
```

Recipes are starter configs, not runtime plugins. They do not call external scanners, CI systems, ticket trackers, or changelog writers. They translate common patterns from tools such as [CodeRabbit](https://docs.coderabbit.ai/overview/pull-request-review), [GitHub Copilot code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review), [Graphite AI Reviews](https://graphite.com/docs/ai-reviews), [SonarQube pull request analysis](https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/pull-request-analysis/introduction), [Semgrep Code](https://docs.semgrep.dev/semgrep-code/overview), [Snyk Code](https://docs.snyk.io/developer-tools/snyk-cli/commands/code-test), [reviewdog](https://github.com/reviewdog/reviewdog), [Danger JS](https://danger.systems/js/), [Renovate](https://docs.renovatebot.com/key-concepts/dashboard/), [GitHub code scanning](https://docs.github.com/en/code-security/concepts/code-scanning/code-scanning), and [PR-Agent](https://github.com/The-PR-Agent/pr-agent) into pipr-native TypeScript config.

## Recipe Index

| Recipe | Command | What it sets up |
| --- | --- | --- |
| `default-review` | `pipr init` | General review with `pipr.review`, default entrypoints, and capped inline comments. |
| `bug-hunter` | `pipr init --recipe bug-hunter` | Bug-focused reviewer with fallback model, custom command, local entrypoint, and higher inline cap. |
| `security-sast` | `pipr init --recipe security-sast` | Security agent with custom severity/category schema, required check, and mapped inline findings. |
| `quality-gate` | `pipr init --recipe quality-gate` | Required merge gate with aggregate check and stricter auto-resolve policy. |
| `diff-diagnostics` | `pipr init --recipe diff-diagnostics` | reviewdog-style diagnostics mapped to `ReviewFinding` with optional `suggestedFix`. |
| `pr-hygiene` | `pipr init --recipe pr-hygiene` | Danger-style tests, docs, lockfile, PR size, and consistency review. |
| `dependency-risk` | `pipr init --recipe dependency-risk` | Renovate-style review scoped to dependency manifests and lockfiles. |
| `ci-triage-command` | `pipr init --recipe ci-triage-command` | Command-only `@pipr ci <log...>` workflow that replies to pasted CI logs. |
| `multi-agent-review` | `pipr init --recipe multi-agent-review` | Security, tests, and maintainability specialists with an aggregator agent. |
| `plugin-tool-review` | `pipr init --recipe plugin-tool-review` | `definePlugin` example that exposes an `owner_lookup` custom tool. |
| `pr-briefing` | `pipr init --recipe pr-briefing` | PR-Agent `/describe` style main comment with PR briefing and walkthrough. |
| `interactive-ask` | `pipr init --recipe interactive-ask` | PR-Agent `/ask` style `@pipr ask <question...>` command over diff and prior review. |
| `changelog-draft` | `pipr init --recipe changelog-draft` | PR-Agent `/update_changelog` style changelog draft comment. It does not edit files. |

## API Coverage

The full recipe set covers the public config surface:

- Builder setup: `definePipr`, `definePlugin`, `pipr.use`, `pipr.model`, `pipr.secret`, `pipr.config`, `pipr.limits`, `pipr.checks`.
- Review helpers: `pipr.review`, `pipr.reviewer`, `inlineComments`, `comment`, `paths`, change-request, command, and local entrypoints.
- Custom orchestration: `pipr.agent`, `agent.extend`, `pipr.task`, `pipr.on.changeRequest`, `pipr.command`, `pipr.local`.
- Runtime context: `ctx.change.diffManifest`, `ctx.change.changedFiles`, `ctx.pi.run`, `ctx.review.prior`, `ctx.comment`, `ctx.command.reply`, `ctx.check`, `ctx.log`.
- Schemas and tools: `pipr.schemas.review`, `pipr.schemas.summary`, `pipr.schema`, `pipr.jsonSchema`, `z`, `pipr.tool`, `toModelOutput`.
- Prompt and execution controls: `pipr.prompt`, `pipr.section`, `pipr.json`, `fallbacks`, `retry`, `timeout`, and per-call model override.

## Recipe Notes

### `default-review`

Use this when you want the smallest working setup. It registers one general review task on pull request events, `@pipr review`, and local `pipr review --base <sha>`.

### `bug-hunter`

Use this when comments should focus on defects instead of style. It is inspired by bug-focused AI review tools and configures fallback model behavior plus a dedicated `@pipr bugs` command.

### `security-sast`

Use this when security findings need extra metadata before publication. The agent returns a custom schema with severity and category, then the task maps publishable findings into `ctx.comment({ inlineFindings })`.

### `quality-gate`

Use this when branch protection should have a pipr-owned review gate. It enables aggregate checks and a required task check. The recipe still publishes comments instead of failing the Action process.

### `diff-diagnostics`

Use this when you want linter-style diagnostics from model output. The task maps diagnostics into pipr's review finding contract and keeps suggested fixes exact.

### `pr-hygiene`

Use this for rule-like PR chores. It checks changed files and diff context for tests, docs, lockfile drift, and PR size signals, then logs the inspected file count.

### `dependency-risk`

Use this for manifest and lockfile changes. It scopes the Diff Manifest to dependency files and avoids live vulnerability claims unless evidence appears in the diff.

### `ci-triage-command`

Use this when maintainers paste failing CI logs into a PR comment. It registers only a command, replies to that command thread, and does not publish a main review comment.

### `multi-agent-review`

Use this as the orchestration example. Three specialists run over the Diff Manifest, then an aggregator deduplicates findings and uses prior review state before publishing one review.

### `plugin-tool-review`

Use this as the custom plugin and tool example. The plugin installs a typed `owner_lookup` tool, returns a config-time handle through `pipr.use`, and calls the tool from task code before passing owner policy context into the reviewer prompt.

### `pr-briefing`

Use this for a PR summary instead of defect hunting. It disables inline comments and renders a main comment with the change title, summary, and a small Mermaid walkthrough scaffold.

### `interactive-ask`

Use this for free-form reviewer questions. It captures `@pipr ask <question...>`, reads prior review state, and responds with `ctx.command.reply`.

### `changelog-draft`

Use this to draft a changelog entry as a comment. It intentionally does not write to `CHANGELOG.md`; file mutation is outside current pipr review publication.
