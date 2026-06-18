# Agent Instructions

This repo owns `pipr`: a Bun and Turborepo TypeScript monorepo for Pi-powered GitHub pull request review automation, including the Docker Action, CLI, runtime package, SDK package, product docs, and local `act` fixtures.

## Workflow

- Start from the linked Linear issue or maintainer direction.
- Keep changes scoped to pipr's TypeScript package surface, Docker Action, `.pipr/` configuration behavior, docs, and local test fixtures.
- Use [docs/CONTEXT.md](docs/CONTEXT.md) for product language. Use `pipr`, `.pipr/`, `Pi Agent Runner`, `Review Workflow`, `Diff Manifest`, `Review Finding`, `Main Review Comment`, and `Inline Review Comment`.
- Treat [docs/adr](docs/adr) as the source for architectural decisions.
- Do not commit real local sessions, secrets, credentials, private logs, unredacted user data, or provider keys.

## Commands

- Use `mise run install` for local dependency setup.
- Use `mise run check` before opening or updating a pull request.
- Use `mise run check-actions` after editing the GitHub Action, Docker Action packaging, workflow fixtures, Pi CLI mapping, or PR event handling.
- Use `mise run act-pr` only when the local Action fixture is the narrowest useful check.
- Use `bun run fallow` when working on maintainability, dependency hygiene, dead exports, duplication, or complexity.
- Use package-level commands during development when narrower feedback is enough.

## Dependencies And Tools

- Before introducing a package, tool, or GitHub Action, check the latest upstream stable version and use it unless there is a documented reason not to.
- Keep versions pinned through the existing sources of truth: `mise.toml`, `package.json`, `bun.lock`, Docker image tags, and workflow action refs.
- Do not add a runtime dependency when Bun, Node, existing workspace packages, or small local code are enough.

## Architecture

- `pipr` owns the GitHub pull request runtime. Pi owns agent execution.
- Pi is the only agent runner in the Core MVP.
- Keep Fallow as repo quality tooling only. Do not put Fallow into pipr's review runtime.
- Keep package public surfaces small. Export only deliberate APIs from package roots.
- Put implementation details behind internal modules. Do not export helpers only for tests or convenience.
- Keep Docker Action, CLI command handling, runtime workflow, config loading, diff parsing, Pi subprocess execution, review validation, and comment rendering separated by package/module boundary.
- Keep user configuration under `.pipr/`. `.pi` is only an internal Pi home inside the Docker image.
- Preserve schema-first reviewer output: validate structured JSON, allow one repair attempt, and drop invalid findings with metadata.
- Keep inline publishing strict: same-range comments only, capped count, confidence filtering, invalid finding drops, and marker dedupe.
- Do not add backward compatibility aliases, legacy fallbacks, or migration shims for unreleased APIs unless explicitly requested.
- Use Fallow as a maintainability gate. Fix surfaced duplication, dependency hygiene, dead exports, and complexity instead of broad ignores.
- Fallow ignores must be narrow and temporary. Do not ignore TypeScript source or tests by package folder. Fixture and golden asset ignores are acceptable.

## File Organization

- Keep package root `src` small. Prefer `src/index.ts` plus deliberate public exports.
- Move package internals into named modules such as `src/config.ts`, `src/diff.ts`, `src/comment.ts`, or domain-specific folders when a package grows.
- Name modules by current responsibility. Avoid `legacy`, `compat`, or old-system names for unreleased code.
- Keep docs in `docs/`; keep ADRs in `docs/adr/`.
- Keep local Action fixtures under `test/fixtures/`.
- Test-only helpers should live in the nearest package `test/helpers.ts` or `test/helpers/*`.

## Test Organization

- Put executable package tests in the package-local `test/` folder, matching the current `packages/runtime/test` layout.
- Do not place `*.test.ts` directly beside runtime files.
- Package-level fixture directories are allowed when they contain assets, not executable tests.
- Prefer public API tests. Add internal tests only when a helper has meaningful independent complexity.
- Preserve fixture behavior unless an intentional divergence is documented in the test.

## TDD And Verification

- Use TDD for behavior changes: write or port one failing behavior test, implement the minimum, then refactor while green.
- Add tests for config merge behavior, provider ID resolution, registry resolution, explicit `from:` refs, diff parsing, schema validation, comment rendering, GitHub publishing, and dry-run boundaries when those areas change.
- Run the narrowest relevant package tests during development.
- Run `mise run check` before opening or updating a PR.
- Run `mise run check-actions` after Action, Docker, workflow, Pi CLI mapping, or event fixture changes.
- If Docker packaging changes, verify the image can run `pi --help` and `pipr action --help`.

## Pull Requests

- Use `.github/PULL_REQUEST_TEMPLATE.md` if present.
- Link the Linear issue.
- State CLI, runtime, config, Docker Action, or public package API impact.
- Include exact verification commands and results.
