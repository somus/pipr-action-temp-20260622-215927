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
  ".pipr/tsconfig.json" \
  ".pipr/types/pipr-sdk.d.ts" \
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

cat >"$worktree/.pipr/config.ts" <<'EOF'
import { definePipr } from "@pipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", {
    name: "deepseek",
    apiKey: pipr.secret("DEEPSEEK_API_KEY"),
    options: { thinking: "high" },
  });
  const reviewer = pipr.agent({
    name: "review",
    model,
    instructions: "Review the act fixture change.",
    output: pipr.schemas.review,
    tools: pipr.tools.readOnly,
    prompt: (input) => pipr.prompt`Review this change.\n${pipr.compactManifest(input.manifest)}`,
  });
  const addReviewTask = (name, priority, secondary = false) => {
    const task = pipr.task(name, async (ctx) => {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const result = await ctx.pi.run(reviewer, { manifest });
      if (secondary) {
        ctx.output.summary("Full fixture secondary section", {
          key: name,
          merge: "append",
          priority,
        });
      } else {
        ctx.output.summary(result.summary, { key: name, merge: "append", priority });
        ctx.output.findings(result.inlineFindings);
      }
    });
    pipr.on.changeRequest(["opened"], task);
  };

  addReviewTask("pipr/review", 100);
  addReviewTask("pipr/full-duplicate-review", 90);
  addReviewTask("pipr/full-secondary-section", 80, true);
});
EOF

cat >"$worktree/test/fixtures/act/project/sample.ts" <<'EOF'
export function reviewTarget(value: string): string {
  return value.trim();
}
EOF

git -C "$worktree" add -f .github/act/action.yml
git -C "$worktree" add \
  .github/workflows/pipr-local-full.yml \
  .pipr/config.ts \
  .pipr/tsconfig.json \
  .pipr/types/pipr-sdk.d.ts \
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
