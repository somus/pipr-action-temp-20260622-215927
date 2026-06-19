# Materialized pipr component control plane

pipr uses repository-local `.pipr/` files as the executable product control plane. Runtime loads final materialized component files directly from conventional folders such as `workflows`, `agents`, `comments`, `schemas`, and optional `blocks`.

Packs, provenance, update suggestions, and install metadata are distribution concerns owned by CLI installer commands. Runtime does not read pack metadata, perform implicit pack merges, or treat installed packs as a second execution layer.

Root `Config` enables executable components through direct arrays:

```yaml
workflows:
  - pipr/review
```

Only enabled workflows enter execution-facing registries. Workflow commands live under `Workflow.on.commands`; there is no standalone `CommandSet` registry in the MVP. Built-in `@pipr help` is runtime-owned. Component IDs are strict and duplicate IDs fail validation, including attempts to replace `core/*` entries. Behavior changes should be made by editing or materializing explicit component files and wiring them through config or workflows, not by hidden override rules.
