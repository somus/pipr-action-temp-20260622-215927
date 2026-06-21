# Docker Action with read-only Pi workspace

pipr ships first as a Docker Action so the runtime can control Bun, Pi, git, ripgrep, fd, and local action testing consistently. Pi reviews run against a read-only workspace copy because pull request code, comments, and model output are untrusted, and Core MVP must not allow the review agent to modify files or run arbitrary project code.

The Docker Action also treats PR-authored `.pipr/` changes as untrusted for runtime authority. Provider backend, model, and API-key env come from trusted Action inputs; provider thinking level and task topology come from base-commit `.pipr/config.ts` and its local imports. Runtime-owned review code owns deterministic diff creation, Pi execution, and review validation before publication contributions are reduced. `config-dir` must resolve inside the repository root.

pipr starts Pi with only read-only built-in tools inside the read-only workspace copy: `read`, `grep`, `find`, and `ls`. pipr custom tools are not executable in the MVP runtime; if an agent declares one, the runtime fails closed instead of silently omitting it.

For condensed Diff Manifest runs, pipr passes an explicit trusted Pi extension while keeping project extension discovery disabled. That extension can expose only bounded read helpers over runtime-owned diff data and base/head file snapshots; it cannot provide shell, write, GitHub API, or publishing access.
