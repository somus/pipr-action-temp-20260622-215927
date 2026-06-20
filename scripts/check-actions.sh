#!/usr/bin/env bash
set -euo pipefail

pipr_action_image="${PIPR_ACTION_IMAGE:-pipr-action:act}"

if [[ "${PIPR_SKIP_ACTION_IMAGE_BUILD:-0}" != "1" ]]; then
  docker build -t "$pipr_action_image" .
fi

bun scripts/check-pi-contract.ts --image "$pipr_action_image"
bun run test:act-fixture
bun run act:pr
bun run act:pr-full
bun run act:pr-condensed
bun run act:pr-orchestrator
