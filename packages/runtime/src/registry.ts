import type { RuntimeRegistry } from "./types.js";

export function createBuiltinRegistry(): RuntimeRegistry {
  const source = "builtin:minimal";
  return {
    presets: [
      { id: "builtin:minimal", description: "Default single-reviewer PR workflow", source },
    ],
    workflows: [{ id: "review", description: "Run default review and publish comments", source }],
    blocks: [
      { id: "context.diff_manifest", description: "Build changed-file manifest", source },
      { id: "agent.run", description: "Run one Pi-backed reviewer agent", source },
      { id: "validate.pr_review", description: "Validate structured review output", source },
      { id: "publish.main_comment", description: "Create or update main review comment", source },
      { id: "publish.inline_comments", description: "Publish validated inline comments", source },
      { id: "review.default", description: "Default single-reviewer block composition", source },
    ],
    agents: [{ id: "reviewer", description: "Default pull request reviewer", source }],
    schemas: [{ id: "pr-review", description: "Structured PR review schema", source }],
    comments: [{ id: "main", description: "Main pipr review comment template", source }],
    tools: [
      { id: "git.read_diff", description: "Read pull request diff context", source },
      { id: "git.read_file", description: "Read repository files", source },
      { id: "review.list_commentable_ranges", description: "List valid inline ranges", source },
    ],
  };
}

export function renderRegistryGraph(registry: RuntimeRegistry): string {
  return [
    "Presets:",
    ...registry.presets.map((entry) => `  - ${entry.id}`),
    "",
    "Workflows:",
    "  review",
    "    pull_request.opened",
    "    pull_request.synchronize",
    "      -> review.default",
    "      -> publish.main_comment",
    "      -> publish.inline_comments",
    "",
    "Blocks:",
    "  review.default",
    "    -> context.diff_manifest",
    "    -> agent.run reviewer",
    "    -> validate.pr_review",
    "",
    "Agents:",
    "  reviewer",
    "    tools:",
    ...registry.tools.map((entry) => `      - ${entry.id}`),
  ].join("\n");
}
