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
