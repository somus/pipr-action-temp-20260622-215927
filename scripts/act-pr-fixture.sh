#!/usr/bin/env bash
set -euo pipefail

source_root="$(git rev-parse --show-toplevel)"
source "$source_root/scripts/act-helpers.sh"

container_architecture="$(pipr_container_architecture)"
runner_image="$(pipr_act_runner_image)"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/pipr-act-dry-run.XXXXXX")"
worktree="$tmp_root/worktree"

cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

pipr_clone_fixture_worktree "$source_root" "$worktree"
pipr_overlay_current_worktree "$source_root" "$worktree"

mkdir -p "$worktree/.github/workflows" "$worktree/test/fixtures/act"
cp "$source_root/.github/workflows/pipr-local.yml" "$worktree/.github/workflows/pipr-local.yml"
cp "$source_root/test/fixtures/act/pull_request.json" "$worktree/test/fixtures/act/pull_request.json"
pipr_prepare_act_workflow "$worktree" "$worktree/.github/workflows/pipr-local.yml"
git -C "$worktree" add -f .github/act/action.yml
git -C "$worktree" add .github/workflows/pipr-local.yml test/fixtures/act/pull_request.json
git -C "$worktree" commit -m "test: prepare dry-run act fixture" >/dev/null
pipr_run_act_pull_request \
  "$worktree" \
  ".github/workflows/pipr-local.yml" \
  "test/fixtures/act/pull_request.json" \
  "$runner_image" \
  "$container_architecture"
