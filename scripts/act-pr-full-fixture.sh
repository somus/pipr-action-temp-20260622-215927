#!/usr/bin/env bash
set -euo pipefail

case "$(uname -m)" in
  arm64 | aarch64) container_architecture="linux/arm64" ;;
  *) container_architecture="linux/amd64" ;;
esac

source_root="$(git rev-parse --show-toplevel)"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/pipr-act-full.XXXXXX")"
worktree="$tmp_root/worktree"

cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

git clone --quiet "$source_root" "$worktree"
git -C "$worktree" config user.email "pipr-act@example.invalid"
git -C "$worktree" config user.name "pipr act fixture"

mkdir -p "$worktree/.github/workflows" "$worktree/scripts" "$worktree/test/fixtures/act/project"
cp "$source_root/scripts/assert-act-full-fixture.mjs" "$worktree/scripts/assert-act-full-fixture.mjs"
cp "$source_root/test/fixtures/act/fake-pi" "$worktree/test/fixtures/act/fake-pi"
cp \
  "$source_root/test/fixtures/act/workflows/pipr-local-full.yml" \
  "$worktree/.github/workflows/pipr-local-full.yml"
chmod +x "$worktree/test/fixtures/act/fake-pi"

cat >"$worktree/test/fixtures/act/project/sample.ts" <<'EOF'
export function reviewTarget(value: string): string {
  return value.trim();
}
EOF

git -C "$worktree" add \
  .github/workflows/pipr-local-full.yml \
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

(
  cd "$worktree"
  act pull_request \
    -W .github/workflows/pipr-local-full.yml \
    -e test/fixtures/act/pull_request_full.json \
    -P ubuntu-latest=catthehacker/ubuntu:act-latest \
    --container-architecture "$container_architecture"
)
