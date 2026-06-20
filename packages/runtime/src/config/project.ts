import { createRuntimeRegistry } from "../registry/registry.js";
import type {
  ProviderConfig,
  RegistryEntry,
  ResolvedConfig,
  RuntimeModuleSet,
  RuntimeRegistry,
  SourceMap,
  WorkflowStep,
} from "../types.js";
import { parseProviderConfig, parseResolvedConfig } from "../types.js";
import { loadMaterializedProject, type MaterializedProject } from "./config.js";
import type {
  AgentComponent,
  BlockComponent,
  CommentTemplateComponent,
  ProviderProfile,
  SchemaComponent,
  WorkflowComponent,
} from "./schema.js";

const defaultMinConfidence = 0.75;

export type LoadRuntimeProjectOptions = {
  rootDir: string;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  requireProviderEnv?: boolean;
};

export type LoadedRuntimeProject = {
  kind: "materialized";
  project: MaterializedProject;
  resolved: ResolvedConfig;
  registry: RuntimeRegistry;
};

export type ValidateProjectOptions = LoadRuntimeProjectOptions;

export async function loadRuntimeProject(
  options: LoadRuntimeProjectOptions,
): Promise<LoadedRuntimeProject> {
  const project = await loadMaterializedProject(options);
  const resolved = materializedProjectToResolvedConfig(project, options);
  return {
    kind: "materialized",
    project,
    resolved,
    registry: createRuntimeRegistry(resolved),
  };
}

export async function loadRuntimeConfig(
  options: LoadRuntimeProjectOptions,
): Promise<ResolvedConfig> {
  return (await loadRuntimeProject(options)).resolved;
}

export async function validateProject(
  options: ValidateProjectOptions,
): Promise<LoadedRuntimeProject> {
  const project = await loadRuntimeProject(options);
  return project;
}

function materializedProjectToResolvedConfig(
  project: MaterializedProject,
  options: Pick<LoadRuntimeProjectOptions, "env" | "requireProviderEnv">,
): ResolvedConfig {
  const defaultProvider = project.config.providers[0];
  if (!defaultProvider) {
    throw new Error(`${project.sources.config}: providers must include at least one provider`);
  }
  assertRequiredProviderEnv(project, options);
  const modules = materializedProjectToRuntimeModules(project);
  const moduleSources = materializedProjectToModuleSources(project);

  return parseResolvedConfig({
    config: {
      defaultProvider: defaultProvider.id,
      providers: project.config.providers.map(toRuntimeProvider),
      publication: {
        maxInlineComments: project.config.publication?.maxInlineComments,
        minConfidence: defaultMinConfidence,
      },
      limits: project.config.limits,
    },
    source: project.sources.config,
    sources: {
      config: project.sources.config,
      fields: {
        apiVersion: `${project.sources.config}#apiVersion`,
        kind: `${project.sources.config}#kind`,
        defaultProvider: `${project.sources.config}#providers.0.id`,
        providers: `${project.sources.config}#providers`,
        publication: `${project.sources.config}#publication`,
        limits: `${project.sources.config}#limits`,
      },
      modules: moduleSources,
    },
    modules,
    warnings: [],
  });
}

function materializedProjectToRuntimeModules(project: MaterializedProject): RuntimeModuleSet {
  const workflows = enabledWorkflowComponents(project);
  return {
    workflows: workflows.map((workflow) => ({
      id: workflow.id,
      description: workflow.description ?? workflow.id,
      source: sourceFor(project, workflow.id),
      inputs: workflow.inputs,
      paths: workflow.paths,
      events: workflow.on?.events ?? [],
      commands: workflow.on?.commands ?? [],
      failurePolicy: workflow.failurePolicy,
      steps: workflow.steps.map(toRuntimeStep),
    })),
    blocks: project.components.filter(isBlock).map((block) => ({
      id: block.id,
      description: block.description ?? block.id,
      source: sourceFor(project, block.id),
      inputs: block.inputs,
      outputs: block.outputs,
      steps: block.steps?.map(toRuntimeStep),
      output: block.output,
      failurePolicy: block.failurePolicy,
    })),
    agents: project.components.filter(isAgent).map((agent) => registryEntry(project, agent.id)),
    schemas: project.components.filter(isSchema).map((schema) => registryEntry(project, schema.id)),
    comments: project.components
      .filter(isCommentTemplate)
      .map((comment) => registryEntry(project, comment.id)),
  };
}

function materializedProjectToModuleSources(project: MaterializedProject): SourceMap["modules"] {
  const workflows = enabledWorkflowComponents(project);
  return {
    workflows: sourceMapFor(
      project,
      workflows.map((item) => item.id),
    ),
    blocks: sourceMapFor(
      project,
      project.components.filter(isBlock).map((item) => item.id),
    ),
    agents: sourceMapFor(
      project,
      project.components.filter(isAgent).map((item) => item.id),
    ),
    schemas: sourceMapFor(
      project,
      project.components.filter(isSchema).map((item) => item.id),
    ),
    comments: sourceMapFor(
      project,
      project.components.filter(isCommentTemplate).map((item) => item.id),
    ),
  };
}

function enabledWorkflowComponents(project: MaterializedProject): WorkflowComponent[] {
  const workflowById = new Map(
    project.components.filter(isWorkflow).map((workflow) => [workflow.id, workflow]),
  );
  return (project.config.workflows ?? []).map((workflowId) => {
    const workflow = workflowById.get(workflowId);
    if (!workflow) {
      throw new Error(`Config workflows references missing Workflow '${workflowId}'`);
    }
    return workflow;
  });
}

function registryEntry(project: MaterializedProject, id: string): RegistryEntry {
  return {
    id,
    description: id,
    source: sourceFor(project, id),
  };
}

function sourceMapFor(project: MaterializedProject, ids: string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, sourceFor(project, id)]));
}

function sourceFor(project: MaterializedProject, id: string): string {
  return project.sources.components[id] ?? project.sources.config;
}

function toRuntimeStep(step: {
  id: string;
  uses: string;
  with?: unknown;
  failurePolicy?: WorkflowStep["failurePolicy"];
}): WorkflowStep {
  return {
    id: step.id,
    block: step.uses,
    with: step.with,
    failurePolicy: step.failurePolicy,
  };
}

function isWorkflow(
  component: MaterializedProject["components"][number],
): component is WorkflowComponent {
  return component.kind === "Workflow";
}

function isBlock(
  component: MaterializedProject["components"][number],
): component is BlockComponent {
  return component.kind === "Block";
}

function isAgent(
  component: MaterializedProject["components"][number],
): component is AgentComponent {
  return component.kind === "Agent";
}

function isSchema(
  component: MaterializedProject["components"][number],
): component is SchemaComponent {
  return component.kind === "Schema";
}

function isCommentTemplate(
  component: MaterializedProject["components"][number],
): component is CommentTemplateComponent {
  return component.kind === "CommentTemplate";
}

function assertRequiredProviderEnv(
  project: MaterializedProject,
  options: Pick<LoadRuntimeProjectOptions, "env" | "requireProviderEnv">,
): void {
  if (!options.requireProviderEnv) {
    return;
  }
  const env = options.env ?? process.env;
  const missing = project.config.providers.filter((provider) => !env[provider.apiKeyEnv]);
  if (missing.length > 0) {
    throw new Error(
      `Missing provider env vars: ${missing.map((provider) => provider.apiKeyEnv).join(", ")}`,
    );
  }
}

function toRuntimeProvider(profile: ProviderProfile): ProviderConfig {
  return parseProviderConfig({
    id: profile.id,
    provider: profile.provider,
    model: profile.model,
    apiKeyEnv: profile.apiKeyEnv,
    thinking: profile.thinking,
  });
}
