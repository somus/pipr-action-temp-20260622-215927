import {
  type InitOfficialMinimalProjectResult,
  initOfficialMinimalProject,
} from "../config/init.js";
import { loadRuntimeConfig, loadRuntimeProject, validateProject } from "../config/project.js";
import { renderRegistryGraph } from "../registry/registry.js";
import { type ReviewRuntimeResult, runReviewRuntime } from "../review/runtime.js";
import type {
  PiprConfig,
  ProviderConfig,
  PullRequestEventContext,
  RegistryCollectionName,
  RegistryEntry,
  ResolvedConfig,
  RuntimeRegistry,
} from "../types.js";
import { parsePiprConfig, parseProviderConfig } from "../types.js";
import { loadPullRequestEventContext } from "./event.js";
import { loadRuntimeProjectFromGitCommit } from "./git-project.js";

const defaultActionProvider: ProviderConfig = {
  id: "deepseek",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  thinking: "high",
};

export type RuntimeCommandOptions = {
  rootDir: string;
  configDir: string;
  env?: NodeJS.ProcessEnv;
  requireProviderEnv?: boolean;
};

export type InitCommandOptions = RuntimeCommandOptions & {
  force: boolean;
};

export type DryRunCommandOptions = RuntimeCommandOptions & {
  eventPath: string;
};

export type ActionCommandOptions = RuntimeCommandOptions & {
  eventPath: string;
  dryRun: boolean;
  piExecutable?: string;
  trustedProvider?: {
    providerId?: string;
    provider?: string;
    model?: string;
    apiKeyEnv?: string;
  };
};

export type DryRunCommandResult = {
  configSource: string;
  event: PullRequestEventContext;
  registry: RuntimeRegistry;
};

export type ActionCommandResult =
  | {
      kind: "dry-run";
      event: PullRequestEventContext;
      configSource: string;
    }
  | {
      kind: "review";
      event: PullRequestEventContext;
      configSource: string;
      review: ReviewRuntimeResult;
    };

export async function runInitCommand(
  options: InitCommandOptions,
): Promise<InitOfficialMinimalProjectResult> {
  return await initOfficialMinimalProject({
    rootDir: options.rootDir,
    configDir: options.configDir,
    force: options.force,
  });
}

export async function runValidateCommand(options: RuntimeCommandOptions): Promise<ResolvedConfig> {
  return (
    await validateProject({
      ...options,
      requireProviderEnv: options.requireProviderEnv ?? false,
    })
  ).resolved;
}

export async function runExplainConfigCommand(
  options: RuntimeCommandOptions,
): Promise<ResolvedConfig> {
  return await loadRuntimeConfig({
    ...options,
    requireProviderEnv: options.requireProviderEnv ?? false,
  });
}

export async function runDryRunCommand(
  options: DryRunCommandOptions,
): Promise<DryRunCommandResult> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  const event = await loadPullRequestEventContext(options.eventPath, {
    ...options.env,
    GITHUB_WORKSPACE: options.rootDir,
    GITHUB_EVENT_NAME: "pull_request",
  });
  return {
    configSource: runtime.resolved.source,
    event,
    registry: runtime.registry,
  };
}

export async function runGraphCommand(options: RuntimeCommandOptions): Promise<string> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  return renderRegistryGraph(runtime.registry);
}

export async function runListCommand(
  options: RuntimeCommandOptions,
  collection: Extract<
    RegistryCollectionName,
    "blocks" | "tools" | "agents" | "presets" | "commands"
  >,
): Promise<RegistryEntry[]> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  return runtime.registry[collection];
}

export async function runActionCommand(
  options: ActionCommandOptions,
): Promise<ActionCommandResult> {
  const event = await loadPullRequestEventContext(options.eventPath, options.env ?? process.env);
  if (options.dryRun) {
    const runtime = await loadRuntimeProject({
      rootDir: options.rootDir,
      configDir: options.configDir,
      env: options.env,
      requireProviderEnv: false,
    });
    return {
      kind: "dry-run",
      event,
      configSource: runtime.resolved.source,
    };
  }
  const trustedRuntime = await loadRuntimeProjectFromGitCommit({
    rootDir: options.rootDir,
    configDir: options.configDir,
    commitSha: event.baseSha,
    env: options.env,
  });
  const provider = trustedActionProvider(options, trustedRuntime.resolved.config);

  return {
    kind: "review",
    event,
    configSource: trustedRuntime.resolved.source,
    review: await runReviewRuntime({
      workspace: options.rootDir,
      config: trustedActionConfig(trustedRuntime.resolved.config, options, provider),
      event,
      env: options.env,
      project: trustedRuntime.project,
      registry: trustedRuntime.registry,
      providerOverride: provider,
      piExecutable: options.piExecutable,
    }),
  };
}

function trustedActionConfig(
  trustedConfig: PiprConfig,
  options: ActionCommandOptions,
  provider: ProviderConfig,
): PiprConfig {
  const env = actionEnv(options);
  if (!env[provider.apiKeyEnv]) {
    throw new Error(`Missing provider env vars: ${provider.apiKeyEnv}`);
  }
  return parsePiprConfig({
    ...trustedConfig,
    defaultProvider: provider.id,
    providers: [provider],
  });
}

function trustedActionProvider(
  options: ActionCommandOptions,
  trustedConfig: PiprConfig,
): ProviderConfig {
  const providerId = readTrustedProviderOption(
    options,
    "providerId",
    "provider-id",
    defaultActionProvider.id,
  );
  return parseProviderConfig({
    id: providerId,
    provider: readTrustedProviderOption(
      options,
      "provider",
      "provider",
      defaultActionProvider.provider,
    ),
    model: readTrustedProviderOption(options, "model", "model", defaultActionProvider.model),
    apiKeyEnv: readTrustedProviderOption(
      options,
      "apiKeyEnv",
      "api-key-env",
      defaultActionProvider.apiKeyEnv,
    ),
    thinking: trustedConfig.providers.find((provider) => provider.id === providerId)?.thinking,
  });
}

function readTrustedProviderOption(
  options: ActionCommandOptions,
  optionKey: keyof NonNullable<ActionCommandOptions["trustedProvider"]>,
  inputName: string,
  fallback: string,
): string {
  return firstNonEmptyString([
    trustedProviderOptions(options)[optionKey],
    readActionInput(actionEnv(options), inputName),
    fallback,
  ]);
}

function trustedProviderOptions(
  options: ActionCommandOptions,
): NonNullable<ActionCommandOptions["trustedProvider"]> {
  return options.trustedProvider ?? {};
}

function actionEnv(options: ActionCommandOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function firstNonEmptyString(values: Array<string | undefined>): string {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return "";
}

function readActionInput(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const key of actionInputEnvKeys(name)) {
    const value = env[key];
    if (value) {
      return value;
    }
  }
  return undefined;
}

function actionInputEnvKeys(name: string): string[] {
  return [
    `INPUT_${name}`,
    `INPUT_${name.toUpperCase()}`,
    `INPUT_${name.replaceAll("-", "_").toUpperCase()}`,
  ];
}
