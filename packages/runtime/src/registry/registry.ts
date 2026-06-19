import type {
  BlockRegistryEntry,
  CommandSetRegistryEntry,
  RegistryCollectionName,
  RegistryEntry,
  ResolvedConfig,
  RuntimeModuleSet,
  RuntimeRegistry,
  WorkflowRegistryEntry,
  WorkflowStep,
} from "../types.js";
import { parseRuntimeRegistry } from "../types.js";
import { validateWorkflowExpressions } from "../workflow/expression.js";

const registryCollections: RegistryCollectionName[] = [
  "presets",
  "workflows",
  "blocks",
  "agents",
  "schemas",
  "comments",
  "commands",
  "tools",
];

export function createCoreRegistry(): RuntimeRegistry {
  const source = "runtime:core";
  return {
    presets: [{ id: "core/default", description: "Default single-reviewer PR workflow", source }],
    workflows: [],
    blocks: [
      { id: "core/run-agent", description: "Build diff and run one validated Pi review", source },
      { id: "core/main-comment", description: "Create or update main review comment", source },
      { id: "core/inline-comments", description: "Publish validated inline comments", source },
      { id: "core/show-help", description: "Render command help", source },
    ],
    agents: [],
    schemas: [],
    comments: [],
    commands: [],
    tools: [],
  };
}

export function createRuntimeRegistry(resolved?: Pick<ResolvedConfig, "modules">): RuntimeRegistry {
  const registry = parseRuntimeRegistry(
    mergeModules(createCoreRegistry(), resolved?.modules ?? {}),
  );
  validateRegistry(registry);
  return registry;
}

export function renderRegistryGraph(registry: RuntimeRegistry): string {
  return [
    renderSimpleSection("Presets", registry.presets, "  - "),
    renderWorkflowSection(registry.workflows),
    renderBlockSection(registry.blocks),
    renderSimpleSection("Agents", registry.agents),
    renderSimpleSection("Schemas", registry.schemas),
    renderSimpleSection("Comments", registry.comments),
    renderCommandSection(registry.commands),
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
  return [
    `  ${block.id}`,
    ...(block.steps ?? []).map((step) => renderStep(step, "    ")),
    ...Object.values(block.output ?? {}).map((value) => `    output ${String(value)}`),
  ];
}

function renderStep(step: WorkflowStep, prefix: string): string {
  const template = readTemplateId(step.with);
  return `${prefix}${step.id} -> ${step.block}${template ? ` template ${template}` : ""}`;
}

function renderCommandSection(commands: CommandSetRegistryEntry[]): string {
  return [sectionTitle("Commands"), ...commands.flatMap(renderCommandSet)].join("\n");
}

function renderCommandSet(commandSet: CommandSetRegistryEntry): string[] {
  return [
    `  ${commandSet.id}`,
    ...commandSet.commands.flatMap((command) => {
      const targets = command.run.workflows?.map((workflow) => `workflow ${workflow}`) ?? [
        `block ${command.run.block}`,
      ];
      return command.aliases.map((alias) => `    ${alias} -> ${targets.join(", ")}`);
    }),
  ];
}

function readTemplateId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const template = (value as Record<string, unknown>).template;
  return typeof template === "string" ? template : undefined;
}

function sectionTitle(title: string): string {
  return `${title}:`;
}

function mergeModules(base: RuntimeRegistry, modules: RuntimeModuleSet): RuntimeRegistry {
  return {
    presets: mergeCollection(base.presets, modules.presets),
    workflows: mergeCollection(base.workflows, modules.workflows),
    blocks: mergeCollection(base.blocks, modules.blocks),
    agents: mergeCollection(base.agents, modules.agents),
    schemas: mergeCollection(base.schemas, modules.schemas),
    comments: mergeCollection(base.comments, modules.comments),
    commands: mergeCollection(base.commands, modules.commands),
    tools: mergeCollection(base.tools, modules.tools),
  };
}

function mergeCollection<T extends RegistryEntry>(base: T[], overrides: T[] | undefined): T[] {
  if (!overrides || overrides.length === 0) {
    return base;
  }

  return [...base, ...overrides];
}

function validateRegistry(registry: RuntimeRegistry): void {
  for (const collection of registryCollections) {
    assertNoDuplicateIds(collection, registry[collection]);
  }

  const blockIds = new Set(registry.blocks.map((block) => block.id));
  for (const workflow of registry.workflows) {
    for (const step of workflow.steps) {
      assertKnownBlock(blockIds, `workflow '${workflow.id}'`, step.block, workflow.source);
      assertSafeStep(`workflow '${workflow.id}'`, step, workflow.source);
    }
  }

  for (const block of registry.blocks) {
    assertSafeExpressions(`block '${block.id}' output`, block.output, block.source);
    for (const step of block.steps ?? []) {
      assertKnownBlock(blockIds, `block '${block.id}'`, step.block, block.source);
      assertSafeStep(`block '${block.id}'`, step, block.source);
    }
  }

  assertKnownCommandTargets(registry);
  assertNoDeclarativeBlockCycles(registry);
}

function assertNoDuplicateIds(collection: RegistryCollectionName, entries: RegistryEntry[]): void {
  const seen = new Map<string, RegistryEntry>();
  for (const entry of entries) {
    const existing = seen.get(entry.id);
    if (existing) {
      throw new Error(
        `Duplicate ${collection} id '${entry.id}' from ${existing.source} and ${entry.source}`,
      );
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

function assertSafeStep(owner: string, step: WorkflowStep, source: string): void {
  assertSafeExpressions(`${owner} step '${step.id}' input`, step.with, source);
}

function assertSafeExpressions(owner: string, value: unknown, source: string): void {
  try {
    validateWorkflowExpressions(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${source}: ${owner} has invalid expression: ${message}`);
  }
}

function assertKnownCommandTargets(registry: RuntimeRegistry): void {
  const workflowIds = new Set(registry.workflows.map((workflow) => workflow.id));
  const blockIds = new Set(registry.blocks.map((block) => block.id));
  for (const commandSet of registry.commands) {
    for (const command of commandSet.commands) {
      for (const workflowId of command.run.workflows ?? []) {
        if (!workflowIds.has(workflowId)) {
          throw new Error(
            `${commandSet.source}: command '${commandSet.id}/${command.id}' references unknown workflow '${workflowId}'`,
          );
        }
      }
      if (command.run.block && !blockIds.has(command.run.block)) {
        throw new Error(
          `${commandSet.source}: command '${commandSet.id}/${command.id}' references unknown block '${command.run.block}'`,
        );
      }
    }
  }
}

function assertNoDeclarativeBlockCycles(registry: RuntimeRegistry): void {
  const blocks = new Map(registry.blocks.map((block) => [block.id, block]));
  const visited = new Set<string>();
  const stack: string[] = [];

  for (const block of registry.blocks) {
    assertUniqueStepIds(`block '${block.id}'`, block.steps ?? [], block.source);
    visitDeclarativeBlock(block, { blocks, visited, stack });
  }
  for (const workflow of registry.workflows) {
    assertUniqueStepIds(`workflow '${workflow.id}'`, workflow.steps, workflow.source);
  }
}

function assertUniqueStepIds(owner: string, steps: WorkflowStep[], source: string): void {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new Error(`${source}: ${owner} has duplicate step id '${step.id}'`);
    }
    seen.add(step.id);
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
