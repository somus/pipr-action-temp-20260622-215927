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

git clone --quiet "$source_root" "$worktree"
git -C "$worktree" config user.email "pipr-act@example.invalid"
git -C "$worktree" config user.name "pipr act fixture"
git -C "$worktree" config commit.gpgsign false

copy_source_file() {
  local file="$1"
  mkdir -p "$worktree/$(dirname "$file")"
  cp -p "$source_root/$file" "$worktree/$file"
}

while IFS=$'\t' read -r status first second; do
  case "$status" in
    D)
      rm -f "$worktree/$first"
      ;;
    R*)
      rm -f "$worktree/$first"
      copy_source_file "$second"
      ;;
    *)
      copy_source_file "$first"
      ;;
  esac
done < <(git -C "$source_root" diff --name-status HEAD --)

mkdir -p "$worktree/.github/workflows" "$worktree/test/fixtures/act"
cp "$source_root/.github/workflows/pipr-local.yml" "$worktree/.github/workflows/pipr-local.yml"
cp "$source_root/test/fixtures/act/pull_request.json" "$worktree/test/fixtures/act/pull_request.json"
pipr_prepare_act_workflow "$worktree" "$worktree/.github/workflows/pipr-local.yml"
git -C "$worktree" add -f .github/act/action.yml
git -C "$worktree" add .github/workflows/pipr-local.yml test/fixtures/act/pull_request.json
git -C "$worktree" commit -m "test: prepare dry-run act fixture" >/dev/null
pipr_ensure_act_runner_image "$container_architecture"

(
  cd "$worktree"
  act pull_request \
    -W .github/workflows/pipr-local.yml \
    -e test/fixtures/act/pull_request.json \
    -P "ubuntu-latest=$runner_image" \
    --container-architecture "$container_architecture" \
    --pull=false
)
