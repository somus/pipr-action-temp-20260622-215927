import type {
  BlockRegistryEntry,
  RegistryCollectionName,
  RegistryEntry,
  ResolvedConfig,
  RuntimeModuleSet,
  RuntimeRegistry,
  WorkflowRegistryEntry,
  WorkflowStep,
} from "./types.js";
import { isRefValue, validateWorkflowPath } from "./workflow.js";

const registryCollections: RegistryCollectionName[] = [
  "presets",
  "workflows",
  "blocks",
  "agents",
  "schemas",
  "comments",
  "tools",
];

export function createBuiltinRegistry(): RuntimeRegistry {
  const source = "builtin:minimal";
  return {
    presets: [
      { id: "builtin:minimal", description: "Default single-reviewer PR workflow", source },
    ],
    workflows: [
      {
        id: "review",
        description: "Run default review and publish comments",
        source,
        events: ["pull_request.opened", "pull_request.synchronize", "pull_request.reopened"],
        steps: [
          { block: "review.default", output: "validated_review" },
          {
            block: "publish.main_comment",
            with: { review: { from: "validated_review" } },
            output: "main_comment",
          },
          {
            block: "publish.inline_comments",
            with: { review: { from: "validated_review" } },
            output: "inline_comments",
          },
        ],
      },
    ],
    blocks: [
      { id: "context.diff_manifest", description: "Build changed-file manifest", source },
      { id: "agent.run", description: "Run one Pi-backed reviewer agent", source },
      { id: "validate.pr_review", description: "Validate structured review output", source },
      { id: "publish.main_comment", description: "Create or update main review comment", source },
      { id: "publish.inline_comments", description: "Publish validated inline comments", source },
      {
        id: "review.default",
        description: "Default single-reviewer block composition",
        source,
        steps: [
          { block: "context.diff_manifest", output: "diff_manifest" },
          {
            block: "agent.run",
            with: { input: { from: "diff_manifest" } },
            output: "review_result",
          },
          {
            block: "validate.pr_review",
            with: {
              review: { from: "review_result" },
              manifest: { from: "diff_manifest" },
            },
            output: "validated_review",
          },
        ],
      },
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

export function createRuntimeRegistry(resolved?: Pick<ResolvedConfig, "modules">): RuntimeRegistry {
  const registry = mergeModules(createBuiltinRegistry(), resolved?.modules ?? {});
  validateRegistry(registry);
  return registry;
}

export function renderRegistryGraph(registry: RuntimeRegistry): string {
  return [
    renderSimpleSection("Presets", registry.presets, "  - "),
    renderWorkflowSection(registry.workflows),
    renderBlockSection(registry.blocks),
    renderSimpleSection("Agents", registry.agents),
    renderSimpleSection("Tools", registry.tools),
  ].join("\n\n");
}

function renderSimpleSection(title: string, entries: RegistryEntry[], prefix = "  "): string {
  return [sectionTitle(title), ...entries.map((entry) => `${prefix}${entry.id}`)].join("\n");
}

function renderWorkflowSection(workflows: WorkflowRegistryEntry[]): string {
  return [sectionTitle("Workflows"), ...workflows.flatMap(renderWorkflow)].join("\n");
}

function renderWorkflow(workflow: WorkflowRegistryEntry): string[] {
  return [
    `  ${workflow.id}`,
    ...workflow.events.map((event) => `    ${event}`),
    ...workflow.steps.map((step) => renderStep(step, "      ")),
  ];
}

function renderBlockSection(blocks: BlockRegistryEntry[]): string {
  return [sectionTitle("Blocks"), ...blocks.flatMap(renderBlock)].join("\n");
}

function renderBlock(block: BlockRegistryEntry): string[] {
  return [`  ${block.id}`, ...(block.steps ?? []).map((step) => renderStep(step, "    "))];
}

function renderStep(step: WorkflowStep, prefix: string): string {
  const output = step.output ? ` as ${step.output}` : "";
  return `${prefix}-> ${step.block}${output}`;
}

function sectionTitle(title: string): string {
  return `${title}:`;
}

function mergeModules(base: RuntimeRegistry, modules: RuntimeModuleSet): RuntimeRegistry {
  return {
    presets: mergeCollection("presets", base.presets, modules.presets),
    workflows: mergeCollection("workflows", base.workflows, modules.workflows),
    blocks: mergeCollection("blocks", base.blocks, modules.blocks),
    agents: mergeCollection("agents", base.agents, modules.agents),
    schemas: mergeCollection("schemas", base.schemas, modules.schemas),
    comments: mergeCollection("comments", base.comments, modules.comments),
    tools: mergeCollection("tools", base.tools, modules.tools),
  };
}

function mergeCollection<T extends RegistryEntry>(
  collection: RegistryCollectionName,
  base: T[],
  overrides: T[] | undefined,
): T[] {
  if (!overrides || overrides.length === 0) {
    return base;
  }

  assertNoDuplicateIds(collection, overrides);
  const byId = new Map(base.map((entry) => [entry.id, entry]));
  for (const override of overrides) {
    byId.set(override.id, override);
  }
  return [...byId.values()];
}

function validateRegistry(registry: RuntimeRegistry): void {
  for (const collection of registryCollections) {
    assertNoDuplicateIds(collection, registry[collection]);
  }

  const blockIds = new Set(registry.blocks.map((block) => block.id));
  for (const workflow of registry.workflows) {
    for (const step of workflow.steps) {
      assertKnownBlock(blockIds, `workflow '${workflow.id}'`, step.block, workflow.source);
      assertSafeStepPaths(`workflow '${workflow.id}'`, step, workflow.source);
    }
  }

  for (const block of registry.blocks) {
    for (const step of block.steps ?? []) {
      assertKnownBlock(blockIds, `block '${block.id}'`, step.block, block.source);
      assertSafeStepPaths(`block '${block.id}'`, step, block.source);
    }
  }

  assertNoDeclarativeBlockCycles(registry);
}

function assertNoDuplicateIds(collection: RegistryCollectionName, entries: RegistryEntry[]): void {
  const seen = new Map<string, RegistryEntry>();
  for (const entry of entries) {
    const existing = seen.get(entry.id);
    if (existing && existing.source === entry.source) {
      throw new Error(`Duplicate ${collection} id '${entry.id}' in ${entry.source}`);
    }
    seen.set(entry.id, entry);
  }
}

function assertKnownBlock(
  blockIds: Set<string>,
  owner: string,
  blockId: string,
  source: string,
): void {
  if (!blockIds.has(blockId)) {
    throw new Error(`${source}: ${owner} references unknown block '${blockId}'`);
  }
}

function assertSafeStepPaths(owner: string, step: WorkflowStep, source: string): void {
  if (step.output) {
    assertSafeWorkflowPath(owner, "output", step.output, source);
  }
  assertSafeRefs(owner, step.with, source);
}

function assertSafeRefs(owner: string, value: unknown, source: string): void {
  if (isRefValue(value)) {
    assertSafeWorkflowPath(owner, "ref", value.from, source);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      assertSafeRefs(owner, item, source);
    }
    return;
  }

  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      assertSafeRefs(owner, item, source);
    }
  }
}

function assertSafeWorkflowPath(
  owner: string,
  kind: "output" | "ref",
  value: string,
  source: string,
): void {
  try {
    validateWorkflowPath(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${source}: ${owner} has invalid ${kind} '${value}': ${message}`);
  }
}

function assertNoDeclarativeBlockCycles(registry: RuntimeRegistry): void {
  const blocks = new Map(registry.blocks.map((block) => [block.id, block]));
  const visited = new Set<string>();
  const stack: string[] = [];

  for (const block of registry.blocks) {
    visitDeclarativeBlock(block, { blocks, visited, stack });
  }
}

function visitDeclarativeBlock(
  block: BlockRegistryEntry,
  state: {
    blocks: Map<string, BlockRegistryEntry>;
    visited: Set<string>;
    stack: string[];
  },
): void {
  if (!block.steps?.length || state.visited.has(block.id)) {
    return;
  }

  const cycleStart = state.stack.indexOf(block.id);
  if (cycleStart >= 0) {
    const cycle = [...state.stack.slice(cycleStart), block.id].join(" -> ");
    throw new Error(`${block.source}: declarative block cycle '${cycle}'`);
  }

  state.stack.push(block.id);
  for (const step of block.steps) {
    const child = state.blocks.get(step.block);
    if (child?.steps?.length) {
      visitDeclarativeBlock(child, state);
    }
  }
  state.stack.pop();
  state.visited.add(block.id);
}
