#!/usr/bin/env bash
set -euo pipefail

docker build -t pipr-action:contract .
bun scripts/check-pi-contract.ts --image pipr-action:contract
bun run test:act-fixture
bun run act:pr
bun run act:pr-full
