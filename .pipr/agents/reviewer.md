---
apiVersion: pipr.dev/v1
kind: Agent
id: pipr/reviewer
provider: deepseek
output:
  schema: core/pr-review
---

Review the pull request diff for correctness, security, maintainability, and test risk.
Return only structured JSON that matches the configured output schema.
Inline findings must target one valid Diff Manifest range exactly.
