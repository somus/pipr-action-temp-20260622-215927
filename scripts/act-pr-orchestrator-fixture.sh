#!/usr/bin/env bash
set -euo pipefail

source_root="$(git rev-parse --show-toplevel)"
source "$source_root/scripts/act-helpers.sh"

container_architecture="$(pipr_container_architecture)"
runner_image="$(pipr_act_runner_image)"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/pipr-act-orchestrator.XXXXXX")"
worktree="$tmp_root/worktree"

cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

git clone --quiet "$source_root" "$worktree"

overlay_current_worktree() {
  local allowed_untracked_paths=(
    "packages/runtime/src/diff/path-filter.ts"
    "packages/runtime/src/diff/tests/path-filter.test.ts"
    "packages/runtime/src/review/agent-template.ts"
    "packages/runtime/src/shared/json.ts"
    "scripts/assert-act-fixture-helpers.mjs"
    "scripts/assert-act-orchestrator-fixture.mjs"
    "test/fixtures/act/fake-pi"
    "test/fixtures/act/workflows/pipr-local-orchestrator.yml"
  )

  while IFS=$'\t' read -r status first second; do
    case "$status" in
      D)
        rm -f "$worktree/$first"
        ;;
      R*)
        rm -f "$worktree/$first"
        mkdir -p "$worktree/$(dirname "$second")"
        cp -p "$source_root/$second" "$worktree/$second"
        ;;
      *)
        copy_source_file "$first"
        ;;
    esac
  done < <(git -C "$source_root" diff --name-status HEAD --)

  for file in "${allowed_untracked_paths[@]}"; do
    if [[ -e "$source_root/$file" ]]; then
      copy_source_file "$file"
    fi
  done
}

copy_source_file() {
  local file="$1"
  mkdir -p "$worktree/$(dirname "$file")"
  cp -p "$source_root/$file" "$worktree/$file"
}

overlay_current_worktree

git -C "$worktree" config user.email "pipr-act@example.invalid"
git -C "$worktree" config user.name "pipr act fixture"
git -C "$worktree" config commit.gpgsign false

mkdir -p "$worktree/.github/workflows" "$worktree/scripts" "$worktree/test/fixtures/act/project"
cp "$source_root/scripts/assert-act-fixture-helpers.mjs" "$worktree/scripts/assert-act-fixture-helpers.mjs"
cp "$source_root/scripts/assert-act-orchestrator-fixture.mjs" "$worktree/scripts/assert-act-orchestrator-fixture.mjs"
cp "$source_root/test/fixtures/act/fake-pi" "$worktree/test/fixtures/act/fake-pi"
cp \
  "$source_root/test/fixtures/act/workflows/pipr-local-orchestrator.yml" \
  "$worktree/.github/workflows/pipr-local-orchestrator.yml"
chmod +x "$worktree/test/fixtures/act/fake-pi"
pipr_prepare_act_workflow "$worktree" "$worktree/.github/workflows/pipr-local-orchestrator.yml"

cat >"$worktree/packages/runtime/distribution/official-minimal/.pipr/agents/specialist.md" <<'EOF'
---
apiVersion: pipr.dev/v1
kind: Agent
id: pipr/specialist-reviewer
inputs:
  focus:
    type: string
    required: true
    enum: [correctness, security, tests]
provider: deepseek
output:
  schema: core/pr-review
---

Focus: ${{ inputs.focus }}
Return a focused specialist review.
EOF

cat >"$worktree/packages/runtime/distribution/official-minimal/.pipr/agents/orchestrator.md" <<'EOF'
---
apiVersion: pipr.dev/v1
kind: Agent
id: pipr/review-orchestrator
inputs:
  reviews:
    type: json
    required: true
provider: deepseek
output:
  schema: core/pr-review
---

Specialist reviews:
${{ inputs.reviews }}
EOF

cat >"$worktree/packages/runtime/distribution/official-minimal/.pipr/workflows/review.yaml" <<'EOF'
apiVersion: pipr.dev/v1
kind: Workflow
id: pipr/review
description: Three specialist reviewers plus orchestrator fixture.
on:
  events:
    - pull_request.opened
steps:
  - id: correctness
    uses: core/run-agent
    with:
      agent: pipr/specialist-reviewer
      inputs:
        focus: correctness
  - id: security
    uses: core/run-agent
    with:
      agent: pipr/specialist-reviewer
      inputs:
        focus: security
  - id: tests
    uses: core/run-agent
    with:
      agent: pipr/specialist-reviewer
      inputs:
        focus: tests
  - id: review
    uses: core/run-agent
    with:
      agent: pipr/review-orchestrator
      inputs:
        reviews:
          correctness: ${{ steps.correctness.outputs.result }}
          security: ${{ steps.security.outputs.result }}
          tests: ${{ steps.tests.outputs.result }}
  - id: main-comment
    uses: core/main-comment
    with:
      review: ${{ steps.review.outputs.result }}
      template: pipr/main
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
git -C "$worktree" add -A
git -C "$worktree" commit -m "test: prepare orchestrator act fixture base" >/dev/null
base_sha="$(git -C "$worktree" rev-parse HEAD)"

cat >"$worktree/test/fixtures/act/project/sample.ts" <<'EOF'
export function reviewTarget(value: string): string {
  const normalized = value.trim();
  return normalized || "fallback";
}
EOF

git -C "$worktree" add test/fixtures/act/project/sample.ts
git -C "$worktree" commit -m "test: prepare orchestrator act fixture head" >/dev/null
head_sha="$(git -C "$worktree" rev-parse HEAD)"

cat >"$worktree/test/fixtures/act/pull_request_orchestrator.json" <<EOF
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

pipr_ensure_act_runner_image "$container_architecture"

(
  cd "$worktree"
  act pull_request \
    -W .github/workflows/pipr-local-orchestrator.yml \
    -e test/fixtures/act/pull_request_orchestrator.json \
    -P "ubuntu-latest=$runner_image" \
    --container-architecture "$container_architecture" \
    --pull=false
)
