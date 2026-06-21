#!/usr/bin/env bash
set -euo pipefail

source_root="$(git rev-parse --show-toplevel)"
source "$source_root/scripts/act-helpers.sh"

container_architecture="$(pipr_container_architecture)"
runner_image="$(pipr_act_runner_image)"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/pipr-act-condensed.XXXXXX")"
worktree="$tmp_root/worktree"

cleanup() {
  pipr_remove_act_tmp_root "$tmp_root"
}
trap cleanup EXIT

pipr_clone_fixture_worktree "$source_root" "$worktree"
pipr_overlay_current_worktree \
  "$source_root" \
  "$worktree" \
  "packages/runtime/src/pi/runtime-tools.ts" \
  "packages/runtime/src/pi/tests/runtime-tools.test.ts" \
  "packages/runtime/src/diff/path-filter.ts" \
  "packages/runtime/src/diff/tests/path-filter.test.ts" \
  "packages/runtime/src/review/manifest-payload.ts" \
  "packages/runtime/src/review/tests/manifest-payload.test.ts" \
  "packages/runtime/src/review/task-runtime.ts" \
  ".pipr/tsconfig.json" \
  ".pipr/types/pipr-sdk.d.ts" \
  "scripts/assert-act-fixture-helpers.mjs" \
  "scripts/assert-act-condensed-fixture.mjs" \
  "test/fixtures/act/fake-pi" \
  "test/fixtures/act/workflows/pipr-local-condensed.yml"

mkdir -p "$worktree/.github/workflows" "$worktree/scripts" "$worktree/test/fixtures/act/project"
cp "$source_root/scripts/assert-act-fixture-helpers.mjs" "$worktree/scripts/assert-act-fixture-helpers.mjs"
cp "$source_root/scripts/assert-act-condensed-fixture.mjs" "$worktree/scripts/assert-act-condensed-fixture.mjs"
cp "$source_root/test/fixtures/act/fake-pi" "$worktree/test/fixtures/act/fake-pi"
cp \
  "$source_root/test/fixtures/act/workflows/pipr-local-condensed.yml" \
  "$worktree/.github/workflows/pipr-local-condensed.yml"
chmod +x "$worktree/test/fixtures/act/fake-pi"
pipr_prepare_act_workflow "$worktree" "$worktree/.github/workflows/pipr-local-condensed.yml" fixture

cat >"$worktree/.pipr/config.ts" <<'EOF'
import { definePipr } from "@pipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", {
    name: "deepseek",
    apiKey: pipr.secret("DEEPSEEK_API_KEY"),
    options: { thinking: "high" },
  });
  pipr.limits({
    timeoutSeconds: 300,
    diffManifest: {
      fullMaxBytes: 1,
      fullMaxEstimatedTokens: 1,
      condensedMaxBytes: 262144,
      condensedMaxEstimatedTokens: 65536,
      toolResponseMaxBytes: 4096,
    },
  });
  pipr.review({
    model,
    instructions: "Review the condensed act fixture.",
    inlineComments: { max: 5 },
  });
});
EOF

cat >"$worktree/test/fixtures/act/project/sample.ts" <<'EOF'
export function reviewTarget(value: string): string {
  const legacy = value.toLowerCase();
  return legacy.trim();
}
EOF

git -C "$worktree" add -f .github/act/action.yml
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

pipr_run_act_pull_request \
  "$worktree" \
  ".github/workflows/pipr-local-condensed.yml" \
  "test/fixtures/act/pull_request_condensed.json" \
  "$runner_image" \
  "$container_architecture"
