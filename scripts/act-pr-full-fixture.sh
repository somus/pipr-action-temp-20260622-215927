#!/usr/bin/env bash
set -euo pipefail

source_root="$(git rev-parse --show-toplevel)"
source "$source_root/scripts/act-helpers.sh"

container_architecture="$(pipr_container_architecture)"
runner_image="$(pipr_act_runner_image)"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/pipr-act-full.XXXXXX")"
worktree="$tmp_root/worktree"

cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

pipr_clone_fixture_worktree "$source_root" "$worktree"
pipr_overlay_current_worktree \
  "$source_root" \
  "$worktree" \
  "packages/runtime/src/diff/path-filter.ts" \
  "packages/runtime/src/diff/tests/path-filter.test.ts" \
  "scripts/assert-act-fixture-helpers.mjs" \
  "scripts/assert-act-full-fixture.mjs" \
  "test/fixtures/act/fake-pi" \
  "test/fixtures/act/workflows/pipr-local-full.yml"

mkdir -p "$worktree/.github/workflows" "$worktree/scripts" "$worktree/test/fixtures/act/project"
cp "$source_root/scripts/assert-act-fixture-helpers.mjs" "$worktree/scripts/assert-act-fixture-helpers.mjs"
cp "$source_root/scripts/assert-act-full-fixture.mjs" "$worktree/scripts/assert-act-full-fixture.mjs"
cp "$source_root/test/fixtures/act/fake-pi" "$worktree/test/fixtures/act/fake-pi"
cp \
  "$source_root/test/fixtures/act/workflows/pipr-local-full.yml" \
  "$worktree/.github/workflows/pipr-local-full.yml"
chmod +x "$worktree/test/fixtures/act/fake-pi"
pipr_prepare_act_workflow "$worktree" "$worktree/.github/workflows/pipr-local-full.yml"

cat >"$worktree/packages/runtime/distribution/official-minimal/.pipr/config.yaml" <<'EOF'
apiVersion: pipr.dev/v1
kind: Config
providers:
  - id: deepseek
    provider: deepseek
    model: deepseek-v4-pro
    apiKeyEnv: DEEPSEEK_API_KEY
    thinking: high
workflows:
  - pipr/review
  - pipr/full-duplicate-review
  - pipr/full-secondary-section
  - pipr/docs-only
limits:
  timeoutSeconds: 300
EOF

cat >"$worktree/packages/runtime/distribution/official-minimal/.pipr/workflows/review.yaml" <<'EOF'
apiVersion: pipr.dev/v1
kind: Workflow
id: pipr/review
description: Default Pi pull request review workflow.
paths:
  include:
    - test/fixtures/act/project/**
on:
  events:
    - pull_request.opened
steps:
  - id: review
    uses: core/run-agent
    with:
      agent: pipr/reviewer
  - id: main-comment
    uses: core/main-comment
    with:
      review: ${{ steps.review.outputs.result }}
      template: pipr/main
      merge: append
      priority: 100
  - id: inline-comments
    uses: core/inline-comments
    with:
      review: ${{ steps.review.outputs.result }}
EOF

cat >"$worktree/packages/runtime/distribution/official-minimal/.pipr/workflows/full-duplicate-review.yaml" <<'EOF'
apiVersion: pipr.dev/v1
kind: Workflow
id: pipr/full-duplicate-review
paths:
  include:
    - test/fixtures/act/project/**
on:
  events:
    - pull_request.opened
steps:
  - id: review
    uses: core/run-agent
    with:
      agent: pipr/reviewer
  - id: main-comment
    uses: core/main-comment
    with:
      review: ${{ steps.review.outputs.result }}
      template: pipr/main
      merge: append
      priority: 90
  - id: inline-comments
    uses: core/inline-comments
    with:
      review: ${{ steps.review.outputs.result }}
EOF

cat >"$worktree/packages/runtime/distribution/official-minimal/.pipr/workflows/full-secondary-section.yaml" <<'EOF'
apiVersion: pipr.dev/v1
kind: Workflow
id: pipr/full-secondary-section
paths:
  include:
    - test/fixtures/act/project/**
on:
  events:
    - pull_request.opened
steps:
  - id: review
    uses: core/run-agent
    with:
      agent: pipr/reviewer
  - id: main-comment
    uses: core/main-comment
    with:
      sectionId: summary
      value: Full fixture secondary section
      template: pipr/main
      merge: append
      priority: 80
  - id: inline-comments
    uses: core/inline-comments
    with:
      review: ${{ steps.review.outputs.result }}
EOF

cat >"$worktree/packages/runtime/distribution/official-minimal/.pipr/workflows/docs-only.yaml" <<'EOF'
apiVersion: pipr.dev/v1
kind: Workflow
id: pipr/docs-only
paths:
  include:
    - docs/**
on:
  events:
    - pull_request.opened
steps:
  - id: review
    uses: core/run-agent
    with:
      agent: pipr/reviewer
  - id: main-comment
    uses: core/main-comment
    with:
      review: ${{ steps.review.outputs.result }}
      template: pipr/main
      merge: append
  - id: inline-comments
    uses: core/inline-comments
    with:
      review: ${{ steps.review.outputs.result }}
EOF

cat >"$worktree/test/fixtures/act/project/sample.ts" <<'EOF'
export function reviewTarget(value: string): string {
  return value.trim();
}
EOF

git -C "$worktree" add -f .github/act/action.yml
git -C "$worktree" add \
  .github/workflows/pipr-local-full.yml \
  packages/runtime/distribution/official-minimal/.pipr/config.yaml \
  packages/runtime/distribution/official-minimal/.pipr/workflows/docs-only.yaml \
  packages/runtime/distribution/official-minimal/.pipr/workflows/full-duplicate-review.yaml \
  packages/runtime/distribution/official-minimal/.pipr/workflows/full-secondary-section.yaml \
  packages/runtime/distribution/official-minimal/.pipr/workflows/review.yaml \
  scripts/assert-act-fixture-helpers.mjs \
  scripts/assert-act-full-fixture.mjs \
  test/fixtures/act/fake-pi \
  test/fixtures/act/project/sample.ts
git -C "$worktree" commit -m "test: prepare full act fixture base" >/dev/null
base_sha="$(git -C "$worktree" rev-parse HEAD)"

cat >"$worktree/test/fixtures/act/project/sample.ts" <<'EOF'
export function reviewTarget(value: string): string {
  const normalized = value.trim();
  return normalized || "fallback";
}
EOF

git -C "$worktree" add test/fixtures/act/project/sample.ts
git -C "$worktree" commit -m "test: prepare full act fixture head" >/dev/null
head_sha="$(git -C "$worktree" rev-parse HEAD)"

cat >"$worktree/test/fixtures/act/pull_request_full.json" <<EOF
{
  "action": "opened",
  "number": 1,
  "pull_request": {
    "number": 1,
    "base": {
      "sha": "$base_sha",
      "ref": "main",
      "repo": {
        "full_name": "local/pipr"
      }
    },
    "head": {
      "sha": "$head_sha",
      "ref": "feature",
      "repo": {
        "full_name": "local/pipr"
      }
    }
  },
  "repository": {
    "full_name": "local/pipr"
  }
}
EOF

pipr_run_act_pull_request \
  "$worktree" \
  ".github/workflows/pipr-local-full.yml" \
  "test/fixtures/act/pull_request_full.json" \
  "$runner_image" \
  "$container_architecture"
