#!/usr/bin/env bun
import { dirname, join } from "node:path";
import { renderActActionMetadata } from "./action-metadata.ts";

type ScenarioName = "dry-run" | "full" | "condensed" | "orchestrator";

type Scenario = {
  name: ScenarioName;
  title: string;
  workflowFile: string;
  eventFile: string;
  publicationFixture?: string;
  assertion?: "full" | "condensed" | "orchestrator";
  config?: string;
  baseSample?: string;
  headPath: string;
  headContent: string;
  telemetryDir?: string;
};
type TrackedChange = {
  status: string;
  firstPath: string;
  secondPath?: string;
};

const packageRootPath = "packages/e2e";
const fixtureRootPath = `${packageRootPath}/fixtures/act`;
const actionFixtureScript = `${packageRootPath}/action-fixture.ts`;
const fakePiScript = `${packageRootPath}/fake-pi`;
const sourceRoot = gitOutput(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
const actionImage = envValue("PIPR_ACTION_IMAGE") ?? "pipr-action:act";
const runnerImage = envValue("PIPR_ACT_RUNNER_IMAGE") ?? "catthehacker/ubuntu:act-latest";
const containerArchitecture = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
const githubToken = githubExpression("github.token");
const githubWorkspace = githubExpression("github.workspace");
const githubHeadSha = githubExpression("github.event.pull_request.head.sha");
let scenario: Scenario;
let tmpRoot = "";
let worktree = "";

async function main(): Promise<void> {
  try {
    await prepareWorktree();
    const baseSha = gitOutput(worktree, ["rev-parse", "HEAD"]).trim();
    await writeWorktreeFile(scenario.headPath, scenario.headContent);
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", `test: prepare ${scenario.name} act fixture head`]);
    const headSha = gitOutput(worktree, ["rev-parse", "HEAD"]).trim();
    await writePullRequestEvent(baseSha, headSha);
    ensureActRunnerImage();
    run(
      "act",
      [
        "pull_request",
        "-W",
        `.github/workflows/${scenario.workflowFile}`,
        "-e",
        scenario.eventFile,
        "-P",
        `ubuntu-latest=${runnerImage}`,
        "--container-architecture",
        containerArchitecture,
        "--pull=false",
      ],
      worktree,
    );
  } finally {
    removePath(tmpRoot);
  }
}

async function prepareWorktree(): Promise<void> {
  run("git", ["clone", "--no-hardlinks", "--quiet", sourceRoot, worktree], sourceRoot);
  git(worktree, ["config", "user.email", "pipr-act@example.invalid"]);
  git(worktree, ["config", "user.name", "pipr act fixture"]);
  git(worktree, ["config", "commit.gpgsign", "false"]);
  git(worktree, ["config", "gc.auto", "0"]);
  git(worktree, ["config", "maintenance.auto", "false"]);

  await overlayTrackedChanges();
  await copySourcePath(packageRootPath);
  await writeActionMetadata();
  await writeWorkflow();
  run("chmod", ["755", join(worktree, fakePiScript)], sourceRoot);
  if (scenario.config) {
    await writeWorktreeFile(".pipr/config.ts", scenario.config);
  }
  if (scenario.baseSample) {
    await writeWorktreeFile(scenario.headPath, scenario.baseSample);
  }
  git(worktree, ["add", "-f", ".github/act/action.yml"]);
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-m", `test: prepare ${scenario.name} act fixture base`]);
}

async function overlayTrackedChanges(): Promise<void> {
  for (const change of trackedChanges()) {
    await overlayTrackedChange(change);
  }
}

function trackedChanges(): TrackedChange[] {
  const changes = gitOutput(sourceRoot, ["diff", "--name-status", "HEAD", "--"]).trim();
  return changes ? changes.split("\n").map(parseTrackedChange) : [];
}

function parseTrackedChange(line: string): TrackedChange {
  const [status, firstPath, secondPath] = line.split("\t");
  if (!status || !firstPath) {
    throw new Error(`Unexpected git diff --name-status line '${line}'`);
  }
  return { status, firstPath, secondPath };
}

async function overlayTrackedChange(change: TrackedChange): Promise<void> {
  if (change.status === "D") {
    removePath(join(worktree, change.firstPath));
    return;
  }
  if (change.status.startsWith("R")) {
    removePath(join(worktree, change.firstPath));
    await copySourcePath(requiredRenamedPath(change));
    return;
  }
  await copySourcePath(change.firstPath);
}

function requiredRenamedPath(change: TrackedChange): string {
  if (!change.secondPath) {
    throw new Error(`Rename diff for '${change.firstPath}' is missing destination path`);
  }
  return change.secondPath;
}

async function copySourcePath(relativePath: string): Promise<void> {
  const source = join(sourceRoot, relativePath);
  if (!pathExists(source)) {
    return;
  }
  const target = join(worktree, relativePath);
  run("mkdir", ["-p", dirname(target)], sourceRoot);
  removePath(target);
  run("cp", ["-pR", source, target], sourceRoot);
}

async function writeWorktreeFile(relativePath: string, content: string): Promise<void> {
  const target = join(worktree, relativePath);
  run("mkdir", ["-p", dirname(target)], sourceRoot);
  await Bun.write(target, content);
}

async function writeActionMetadata(): Promise<void> {
  const source = await Bun.file(join(worktree, "action.yml")).text();
  const entrypointScript = scenario.assertion ? `/opt/pipr/${actionFixtureScript}` : undefined;
  await Bun.write(
    join(worktree, ".github/act/action.yml"),
    renderActActionMetadata(source, actionImage, { entrypointScript }),
  );
}

async function writeWorkflow(): Promise<void> {
  await Bun.write(
    join(worktree, ".github/workflows", scenario.workflowFile),
    workflowFor(scenario),
  );
}

async function writePullRequestEvent(baseSha: string, headSha: string): Promise<void> {
  await writeWorktreeFile(
    scenario.eventFile,
    `${JSON.stringify(
      {
        action: "opened",
        number: 1,
        pull_request: {
          number: 1,
          base: { sha: baseSha, ref: "main", repo: { full_name: "local/pipr" } },
          head: { sha: headSha, ref: "feature", repo: { full_name: "local/pipr" } },
        },
        repository: { full_name: "local/pipr" },
      },
      null,
      2,
    )}\n`,
  );
}

function workflowFor(item: Scenario): string {
  if (!item.publicationFixture || !item.assertion) {
    return dryRunWorkflow(item);
  }
  return fixtureWorkflow(item);
}

function dryRunWorkflow(item: Scenario): string {
  return [
    `name: ${item.title}`,
    "",
    "on:",
    "  pull_request:",
    "  issue_comment:",
    "    types: [created]",
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "  issues: write",
    "",
    "jobs:",
    "  pipr:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v6",
    "        with:",
    "          fetch-depth: 0",
    "      - name: Prepare act workspace permissions",
    "        shell: bash",
    '        run: chmod -R a+rX "$GITHUB_WORKSPACE"',
    "      - uses: ./.github/act",
    "        env:",
    "          DEEPSEEK_API_KEY: local-fixture-key",
    `          GITHUB_TOKEN: ${githubToken}`,
    '          PIPR_DRY_RUN: "1"',
    "        with:",
    "          config-dir: .pipr",
    "",
  ].join("\n");
}

function fixtureWorkflow(item: Scenario): string {
  return [
    `name: ${item.title}`,
    "",
    "on:",
    "  pull_request:",
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "  issues: write",
    "",
    "jobs:",
    "  pipr:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v6",
    "        with:",
    "          fetch-depth: 0",
    "      - name: Prepare act workspace permissions",
    "        shell: bash",
    '        run: chmod -R a+rX "$GITHUB_WORKSPACE"',
    "      - name: Prepare fake GitHub fixture",
    "        shell: bash",
    "        run: |",
    `          mkdir -p ${fixtureRootPath}`,
    `          cat > ${fixtureRootPath}/${item.publicationFixture} <<JSON`,
    "          {",
    '            "ownerLogin": "github-actions[bot]",',
    `            "headSha": "${githubHeadSha}",`,
    '            "issueComments": [],',
    '            "reviewComments": [],',
    '            "reviewCommentPayloads": []',
    "          }",
    "          JSON",
    `          chmod 666 ${fixtureRootPath}/${item.publicationFixture}`,
    ...telemetrySetupLines(item),
    "      - uses: ./.github/act",
    "        env:",
    `          DEEPSEEK_API_KEY: ${apiKeyFor(item)}`,
    "          GITHUB_TOKEN: local-fixture-token",
    '          GIT_CONFIG_COUNT: "1"',
    "          GIT_CONFIG_KEY_0: safe.directory",
    `          GIT_CONFIG_VALUE_0: ${githubWorkspace}`,
    `          PIPR_ACT_GITHUB_FIXTURE_PATH: ${githubWorkspace}/${fixtureRootPath}/${item.publicationFixture}`,
    `          PIPR_ACT_PI_EXECUTABLE: ${githubWorkspace}/${fakePiScript}`,
    `          PIPR_ACT_ASSERTION: ${item.assertion}`,
    ...fixtureAssertionEnvLines(item),
    "        with:",
    "          config-dir: .pipr",
    "",
  ].join("\n");
}

function telemetrySetupLines(item: Scenario): string[] {
  if (!item.telemetryDir) {
    return [];
  }
  return [
    `          mkdir -p ${fixtureRootPath}/${item.telemetryDir}`,
    `          chmod 777 ${fixtureRootPath}/${item.telemetryDir}`,
  ];
}

function apiKeyFor(item: Scenario): string {
  return item.telemetryDir
    ? `${githubWorkspace}/${fixtureRootPath}/${item.telemetryDir}`
    : "local-fixture-key";
}

function fixtureAssertionEnvLines(item: Scenario): string[] {
  return item.telemetryDir
    ? [
        `          PIPR_ACT_TELEMETRY_PATH: ${githubWorkspace}/${fixtureRootPath}/${item.telemetryDir}`,
      ]
    : [];
}

function ensureActRunnerImage(): void {
  const inspected = Bun.spawnSync(["docker", "image", "inspect", runnerImage], {
    stderr: "ignore",
    stdout: "ignore",
  });
  if (inspected.exitCode !== 0) {
    run("docker", ["pull", "--platform", containerArchitecture, runnerImage], sourceRoot);
  }
}

function git(cwd: string, args: string[]): void {
  run("git", args, cwd);
}

function gitOutput(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed with exit ${result.exitCode}`);
  }
  return result.stdout.toString();
}

function run(command: string, args: string[], cwd: string): void {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: Bun.env,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.exitCode}`);
  }
}

function removePath(path: string): void {
  run("rm", ["-rf", path], sourceRoot);
}

function pathExists(path: string): boolean {
  return (
    Bun.spawnSync(["test", "-e", path], {
      stderr: "ignore",
      stdout: "ignore",
    }).exitCode === 0
  );
}

function mktemp(prefix: string): string {
  const result = Bun.spawnSync(["mktemp", "-d", `/tmp/${prefix}.XXXXXX`], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`mktemp failed with exit ${result.exitCode}`);
  }
  return result.stdout.toString().trim();
}

const fullConfig = `import { definePipr } from "@pipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", {
    name: "deepseek",
    apiKey: pipr.secret("DEEPSEEK_API_KEY"),
    options: { thinking: "high" },
  });
  const reviewer = pipr.agent({
    name: "review",
    model,
    instructions: "Review the act fixture change.",
    output: pipr.schemas.review,
    tools: pipr.tools.readOnly,
    prompt: (input) => pipr.prompt\`Review this change.\\n\${pipr.compactManifest(input.manifest)}\`,
  });
  const addReviewTask = (name, priority, secondary = false) => {
    const task = pipr.task(name, async (ctx) => {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const result = await ctx.pi.run(reviewer, { manifest });
      if (secondary) {
        ctx.output.summary("Full fixture secondary section", {
          key: name,
          merge: "append",
          priority,
        });
      } else {
        ctx.output.summary(result.summary, { key: name, merge: "append", priority });
        ctx.output.findings(result.inlineFindings);
      }
    });
    pipr.on.changeRequest(["opened"], task);
  };

  addReviewTask("pipr/review", 100);
  addReviewTask("pipr/full-duplicate-review", 90);
  addReviewTask("pipr/full-secondary-section", 80, true);
});
`;

const condensedConfig = `import { definePipr } from "@pipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", {
    name: "deepseek",
    apiKey: pipr.secret("DEEPSEEK_API_KEY"),
    options: { thinking: "high" },
  });
  pipr.limits({
    timeoutSeconds: 300,
    diffManifest: {
      fullMaxBytes: 1,
      fullMaxEstimatedTokens: 1,
      condensedMaxBytes: 262144,
      condensedMaxEstimatedTokens: 65536,
      toolResponseMaxBytes: 4096,
    },
  });
  pipr.review({
    model,
    instructions: "Review the condensed act fixture.",
    inlineComments: { max: 5 },
  });
});
`;

const orchestratorConfig = `import { definePipr } from "@pipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", {
    name: "deepseek",
    apiKey: pipr.secret("DEEPSEEK_API_KEY"),
    options: { thinking: "high" },
  });
  const specialist = pipr.agent({
    name: "specialist-reviewer",
    model,
    instructions: "Return a focused specialist review.",
    output: pipr.schemas.review,
    prompt: (input) => pipr.prompt\`Focus: \${input.focus}\\n\${pipr.compactManifest(input.manifest)}\`,
  });
  const orchestrator = pipr.agent({
    name: "review-orchestrator",
    model,
    instructions: "Merge specialist reviews into one final review.",
    output: pipr.schemas.review,
    prompt: (input) => pipr.prompt\`Specialist reviews:\\n\${pipr.json(input.reviews)}\`,
  });
  const task = pipr.task("review", async (ctx) => {
    const manifest = await ctx.change.diffManifest({ compressed: true });
    const [correctness, security, tests] = await Promise.all([
      ctx.pi.run(specialist, { manifest, focus: "correctness" }),
      ctx.pi.run(specialist, { manifest, focus: "security" }),
      ctx.pi.run(specialist, { manifest, focus: "tests" }),
    ]);
    const result = await ctx.pi.run(orchestrator, {
      manifest,
      reviews: { correctness, security, tests },
    });
    ctx.output.summary(result.summary);
    ctx.output.findings(result.inlineFindings);
  });
  pipr.on.changeRequest(["opened"], task);
});
`;

const scenarios: Record<ScenarioName, Scenario> = {
  "dry-run": {
    name: "dry-run",
    title: "pipr local fixture",
    workflowFile: "pipr-local.yml",
    eventFile: `${fixtureRootPath}/pull_request.json`,
    headPath: `${fixtureRootPath}/dry-run-head.txt`,
    headContent: "dry-run head fixture\n",
  },
  full: {
    name: "full",
    title: "pipr local full-flow fixture",
    workflowFile: "pipr-local-full.yml",
    eventFile: `${fixtureRootPath}/pull_request_full.json`,
    publicationFixture: "github-publication-full.json",
    assertion: "full",
    config: fullConfig,
    baseSample: `export function reviewTarget(value: string): string {
  return value.trim();
}
`,
    headPath: `${fixtureRootPath}/project/sample.ts`,
    headContent: `export function reviewTarget(value: string): string {
  const normalized = value.trim();
  return normalized || "fallback";
}
`,
    telemetryDir: "pi-calls-full",
  },
  condensed: {
    name: "condensed",
    title: "pipr local condensed-flow fixture",
    workflowFile: "pipr-local-condensed.yml",
    eventFile: `${fixtureRootPath}/pull_request_condensed.json`,
    publicationFixture: "github-publication-condensed.json",
    assertion: "condensed",
    config: condensedConfig,
    baseSample: `export function reviewTarget(value: string): string {
  const legacy = value.toLowerCase();
  return legacy.trim();
}
`,
    headPath: `${fixtureRootPath}/project/sample.ts`,
    headContent: `export function reviewTarget(value: string): string {
  const normalized = value.trim();
  return normalized || "fallback";
}
`,
  },
  orchestrator: {
    name: "orchestrator",
    title: "pipr local orchestrator fixture",
    workflowFile: "pipr-local-orchestrator.yml",
    eventFile: `${fixtureRootPath}/pull_request_orchestrator.json`,
    publicationFixture: "github-publication-orchestrator.json",
    assertion: "orchestrator",
    config: orchestratorConfig,
    baseSample: `export function reviewTarget(value: string): string {
  return value.trim();
}
`,
    headPath: `${fixtureRootPath}/project/sample.ts`,
    headContent: `export function reviewTarget(value: string): string {
  const normalized = value.trim();
  return normalized || "fallback";
}
`,
  },
};

function envValue(name: string): string | undefined {
  const value = Bun.env[name];
  return value ? value : undefined;
}

function githubExpression(value: string): string {
  return "$".concat(`{{ ${value} }}`);
}

const scenarioArg = process.argv[2] as ScenarioName | undefined;
const selectedScenario = scenarioArg ? scenarios[scenarioArg] : undefined;
if (!selectedScenario) {
  throw new Error("usage: bun packages/e2e/run.ts <dry-run|full|condensed|orchestrator>");
}
scenario = selectedScenario;
tmpRoot = mktemp(`pipr-act-${scenario.name}`);
worktree = join(tmpRoot, "worktree");
await main();
