#!/usr/bin/env bash
set -euo pipefail

docker build -t pipr-action:contract .
bun scripts/check-pi-contract.ts --image pipr-action:contract
bun run act:pr
