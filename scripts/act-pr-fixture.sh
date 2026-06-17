#!/usr/bin/env bash
set -euo pipefail

case "$(uname -m)" in
  arm64 | aarch64) container_architecture="linux/arm64" ;;
  *) container_architecture="linux/amd64" ;;
esac

act pull_request \
  -W .github/workflows/pipr-local.yml \
  -e test/fixtures/act/pull_request.json \
  -P ubuntu-latest=catthehacker/ubuntu:act-latest \
  --container-architecture "$container_architecture"
