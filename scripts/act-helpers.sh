#!/usr/bin/env bash
set -euo pipefail

pipr_act_helper_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pipr_container_architecture() {
  case "$(uname -m)" in
    arm64 | aarch64) printf "%s\n" "linux/arm64" ;;
    *) printf "%s\n" "linux/amd64" ;;
  esac
}

pipr_action_image() {
  printf "%s\n" "${PIPR_ACTION_IMAGE:-pipr-action:act}"
}

pipr_act_runner_image() {
  printf "%s\n" "${PIPR_ACT_RUNNER_IMAGE:-catthehacker/ubuntu:act-latest}"
}

pipr_ensure_act_runner_image() {
  local platform="$1"
  local image
  image="$(pipr_act_runner_image)"
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    docker pull --platform "$platform" "$image"
  fi
}

pipr_clone_fixture_worktree() {
  local source_root="$1"
  local worktree="$2"
  git clone --no-hardlinks --quiet "$source_root" "$worktree"
  git -C "$worktree" config user.email "pipr-act@example.invalid"
  git -C "$worktree" config user.name "pipr act fixture"
  git -C "$worktree" config commit.gpgsign false
  git -C "$worktree" config gc.auto 0
  git -C "$worktree" config maintenance.auto false
}

pipr_copy_source_file() {
  local source_root="$1"
  local worktree="$2"
  local file="$3"
  mkdir -p "$worktree/$(dirname "$file")"
  cp -p "$source_root/$file" "$worktree/$file"
}

pipr_overlay_current_worktree() {
  local source_root="$1"
  local worktree="$2"
  shift 2
  local allowed_untracked_paths=("$@")

  while IFS=$'\t' read -r status first second; do
    case "$status" in
      D)
        rm -f "$worktree/$first"
        ;;
      R*)
        rm -f "$worktree/$first"
        pipr_copy_source_file "$source_root" "$worktree" "$second"
        ;;
      *)
        pipr_copy_source_file "$source_root" "$worktree" "$first"
        ;;
    esac
  done < <(git -C "$source_root" diff --name-status HEAD --)

  for file in "${allowed_untracked_paths[@]}"; do
    if [[ -e "$source_root/$file" ]]; then
      pipr_copy_source_file "$source_root" "$worktree" "$file"
    fi
  done
}

pipr_write_act_action_metadata() {
  local root="$1"
  local image
  image="$(pipr_action_image)"
  (
    cd "$root"
    bun "$pipr_act_helper_root/scripts/write-act-action-metadata.ts" action.yml .github/act/action.yml "$image"
  )
}

pipr_prepare_act_workflow() {
  local root="$1"
  local workflow="$2"
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/pipr-act-workflow.XXXXXX")"

  pipr_write_act_action_metadata "$root"
  awk '
    /^[[:space:]]*- uses: \.\/[[:space:]]*$/ {
      sub(/\.\/[[:space:]]*$/, "./.github/act")
    }
    { print }
  ' "$workflow" >"$tmp"
  mv "$tmp" "$workflow"
}

pipr_run_act_pull_request() {
  local worktree="$1"
  local workflow="$2"
  local event="$3"
  local runner_image="$4"
  local container_architecture="$5"

  pipr_ensure_act_runner_image "$container_architecture"
  (
    cd "$worktree"
    act pull_request \
      -W "$workflow" \
      -e "$event" \
      -P "ubuntu-latest=$runner_image" \
      --container-architecture "$container_architecture" \
      --pull=false
  )
}
