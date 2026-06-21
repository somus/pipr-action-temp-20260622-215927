import type { Agent, ModelProfile, RuntimePlan } from "@pipr/sdk";
import type { ProviderConfig, RuntimeSettings } from "../types.js";
import { parseProviderConfig, parseRuntimeSettings } from "../types.js";
import { loadTypescriptConfig } from "./ts-loader.js";

const defaultMinConfidence = 0.75;

export type LoadRuntimeProjectOptions = {
  rootDir: string;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  requireProviderEnv?: boolean;
  typecheck?: boolean;
};

export type LoadedRuntimeProject = {
  kind: "typescript";
  plan: RuntimePlan;
  settings: RuntimeSettings;
};

export type ValidateProjectOptions = LoadRuntimeProjectOptions;

export type InspectRuntimePlan = {
  source: string;
  models: string[];
  agents: string[];
  tasks: string[];
  events: Array<{ task: string; actions: string[] }>;
  commands: Array<{ pattern: string; task: string; permission: string }>;
  locals: Array<{ name: string; task: string }>;
  tools: string[];
  schemas: string[];
};

export async function loadRuntimeProject(
  options: LoadRuntimeProjectOptions,
): Promise<LoadedRuntimeProject> {
  const loaded = await loadTypescriptConfig(options);
  return {
    kind: "typescript",
    plan: loaded.plan,
    settings: planToRuntimeSettings(loaded.plan, {
      source: loaded.source,
      env: options.env,
      requireProviderEnv: options.requireProviderEnv,
    }),
  };
}

export async function loadRuntimeConfig(
  options: LoadRuntimeProjectOptions,
): Promise<RuntimeSettings> {
  return (await loadRuntimeProject(options)).settings;
}

export async function validateProject(
  options: ValidateProjectOptions,
): Promise<LoadedRuntimeProject> {
  return await loadRuntimeProject({ ...options, typecheck: true });
}

export function inspectRuntimePlan(plan: RuntimePlan, source: string): InspectRuntimePlan {
  return {
    source,
    models: plan.models.map((model) => model.name),
    agents: plan.agents.map((agent) => agentName(agent)),
    tasks: plan.tasks.map((task) => task.name),
    events: plan.changeRequestTriggers.map((trigger) => ({
      task: trigger.task.name,
      actions: [...trigger.actions],
    })),
    commands: plan.commands.map((command) => ({
      pattern: command.pattern,
      task: command.task.name,
      permission: command.permission,
    })),
    locals: plan.locals.map((local) => ({ name: local.name, task: local.task.name })),
    tools: plan.tools.map((tool) => tool.name),
    schemas: [
      "core/pr-review",
      "core/review-candidates",
      "core/consolidated-review",
      "core/summary",
    ],
  };
}

function planToRuntimeSettings(
  plan: RuntimePlan,
  options: { source: string; env?: NodeJS.ProcessEnv; requireProviderEnv?: boolean },
): RuntimeSettings {
  const providers = plan.models.map(modelToProvider);
  const defaultProvider = providers[0];
  if (!defaultProvider) {
    throw new Error(`${options.source}: at least one pipr.model() is required`);
  }
  assertUniqueProviders(providers, options.source);
  assertRequiredProviderEnv(providers, options);
  return parseRuntimeSettings({
    source: options.source,
    config: {
      defaultProvider: defaultProvider.id,
      providers,
      publication: {
        maxInlineComments: plan.publication.maxInlineComments,
        minConfidence: plan.publication.minConfidence ?? defaultMinConfidence,
      },
      limits: plan.limits,
    },
    warnings: [],
  });
}

function modelToProvider(model: ModelProfile): ProviderConfig {
  if (!model.apiKey) {
    throw new Error(`Model '${model.name}' must declare apiKey: pipr.secret("ENV_NAME")`);
  }
  return parseProviderConfig({
    id: model.name,
    provider: model.provider,
    model: model.model,
    apiKeyEnv: model.apiKey.name,
    thinking: readThinking(model),
  });
}

function readThinking(model: ModelProfile): string | undefined {
  const value = model.options?.thinking;
  return typeof value === "string" ? value : undefined;
}

function assertUniqueProviders(providers: ProviderConfig[], source: string): void {
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) {
      throw new Error(`${source}: duplicate model name '${provider.id}'`);
    }
    seen.add(provider.id);
  }
}

function assertRequiredProviderEnv(
  providers: ProviderConfig[],
  options: { env?: NodeJS.ProcessEnv; requireProviderEnv?: boolean },
): void {
  if (!options.requireProviderEnv) {
    return;
  }
  const env = options.env ?? process.env;
  const missing = providers.filter((provider) => !env[provider.apiKeyEnv]);
  if (missing.length > 0) {
    throw new Error(
      `Missing provider env vars: ${missing.map((provider) => provider.apiKeyEnv).join(", ")}`,
    );
  }
}

function agentName(agent: Agent): string {
  return agent.name ?? "anonymous-agent";
}
