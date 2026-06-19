#!/usr/bin/env bash
set -euo pipefail

case "$(uname -m)" in
  arm64 | aarch64) container_architecture="linux/arm64" ;;
  *) container_architecture="linux/amd64" ;;
esac

source_root="$(git rev-parse --show-toplevel)"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/pipr-act-condensed.XXXXXX")"
worktree="$tmp_root/worktree"

cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

git clone --quiet "$source_root" "$worktree"

overlay_current_worktree() {
  local allowed_untracked_paths=(
    "packages/runtime/src/pi/runtime-tools.ts"
    "packages/runtime/src/pi/tests/runtime-tools.test.ts"
    "packages/runtime/src/review/manifest-payload.ts"
    "packages/runtime/src/review/tests/manifest-payload.test.ts"
    "scripts/assert-act-condensed-fixture.mjs"
    "test/fixtures/act/fake-pi-condensed"
    "test/fixtures/act/workflows/pipr-local-condensed.yml"
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
cp "$source_root/scripts/assert-act-condensed-fixture.mjs" "$worktree/scripts/assert-act-condensed-fixture.mjs"
cp "$source_root/test/fixtures/act/fake-pi-condensed" "$worktree/test/fixtures/act/fake-pi-condensed"
cp \
  "$source_root/test/fixtures/act/workflows/pipr-local-condensed.yml" \
  "$worktree/.github/workflows/pipr-local-condensed.yml"
chmod +x "$worktree/test/fixtures/act/fake-pi-condensed"

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
limits:
  timeoutSeconds: 300
  diffManifest:
    fullMaxBytes: 1
    fullMaxEstimatedTokens: 1
    condensedMaxBytes: 262144
    condensedMaxEstimatedTokens: 65536
    toolResponseMaxBytes: 4096
EOF

cat >"$worktree/test/fixtures/act/project/sample.ts" <<'EOF'
export function reviewTarget(value: string): string {
  const legacy = value.toLowerCase();
  return legacy.trim();
}
EOF

git -C "$worktree" add -A
git -C "$worktree" commit -m "test: prepare condensed act fixture base" >/dev/null
base_sha="$(git -C "$worktree" rev-parse HEAD)"

cat >"$worktree/test/fixtures/act/project/sample.ts" <<'EOF'
export function reviewTarget(value: string): string {
  const normalized = value.trim();
  return normalized || "fallback";
}
EOF

git -C "$worktree" add test/fixtures/act/project/sample.ts
git -C "$worktree" commit -m "test: prepare condensed act fixture head" >/dev/null
head_sha="$(git -C "$worktree" rev-parse HEAD)"

cat >"$worktree/test/fixtures/act/pull_request_condensed.json" <<EOF
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

(
  cd "$worktree"
  act pull_request \
    -W .github/workflows/pipr-local-condensed.yml \
    -e test/fixtures/act/pull_request_condensed.json \
    -P ubuntu-latest=catthehacker/ubuntu:act-latest \
    --container-architecture "$container_architecture"
)
