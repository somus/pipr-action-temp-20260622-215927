# Docker Action with read-only Pi workspace

pipr ships first as a Docker Action so the runtime can control Bun, Pi, git, ripgrep, fd, and local action testing consistently. Pi reviews run against a read-only workspace copy because pull request code, comments, and model output are untrusted, and Core MVP must not allow the review agent to modify files or run arbitrary project code.

The Docker Action also treats PR-authored `.pipr/` changes as untrusted for runtime authority. Provider backend, model, and API-key env come from trusted Action inputs; provider thinking level comes from base-commit `.pipr/config.yaml`; executable workflow, command, and optional block topology comes from the base-commit materialized `.pipr/` registry; and runtime-owned `core/run-agent` owns deterministic diff creation, Pi execution, and review validation before comment-preparation handlers run. `config-dir` must resolve inside the repository root.

pipr starts Pi with only read-only built-in tools inside the read-only workspace copy: `read`, `grep`, `find`, and `ls`. pipr custom tools are not attached by default; they are only attached when plugin-provided tool definitions exist.
