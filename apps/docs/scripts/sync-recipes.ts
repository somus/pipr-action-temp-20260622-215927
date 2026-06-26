import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listOfficialInitRecipes } from "../../../packages/runtime/src/config/recipes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(here, "../content/docs/recipes");
const mode = process.argv.includes("--check") ? "check" : "sync";

function starterWorkflow(recipeId: string): string {
  const lines = [
    "name: pipr",
    "",
    "on:",
    "  pull_request:",
    "  issue_comment:",
    "    types: [created]",
    "  pull_request_review_comment:",
    "    types: [created]",
    "",
    "permissions:",
    "  contents: write",
    "  pull-requests: write",
    "  issues: write",
    "  checks: write",
    "",
    "jobs:",
    "  review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v6",
    "        with:",
    "          fetch-depth: 0",
    "      - uses: somus/pipr@main",
    "        env:",
    `          DEEPSEEK_API_KEY: ${githubExpression("secrets.DEEPSEEK_API_KEY")}`,
    `          GITHUB_TOKEN: ${githubExpression("github.token")}`,
  ];

  if (recipeId === "plugin-tool-review") {
    lines.push(
      `          PIPR_R2_MEMORY_BUCKET: ${githubExpression("secrets.PIPR_R2_MEMORY_BUCKET")}`,
      `          PIPR_R2_MEMORY_ENDPOINT: ${githubExpression("secrets.PIPR_R2_MEMORY_ENDPOINT")}`,
      `          PIPR_R2_MEMORY_ACCESS_KEY_ID: ${githubExpression("secrets.PIPR_R2_MEMORY_ACCESS_KEY_ID")}`,
      `          PIPR_R2_MEMORY_SECRET_ACCESS_KEY: ${githubExpression("secrets.PIPR_R2_MEMORY_SECRET_ACCESS_KEY")}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

const recipes = listOfficialInitRecipes();
const expected = new Map<string, string>();
const recipeDescriptions = new Map([
  [
    "default-review",
    "Start with one general pull request reviewer that runs from change request events, `@pipr review`, and local review commands while keeping inline comments bounded.",
  ],
  [
    "bug-hunter",
    "Focus Pipr on correctness defects, edge cases, race conditions, regressions, and missing tests with a reviewer tuned for actionable bug reports.",
  ],
  [
    "multi-agent-review",
    "Run specialist security, test, and maintainability agents, then merge their output through an aggregator into one concise pull request review.",
  ],
  [
    "pr-briefing",
    "Generate a PR-Agent describe-style overview that summarizes intent, changed areas, reviewer risks, and walkthrough notes as a main comment.",
  ],
  [
    "security-sast",
    "Review pull request changes for concrete security risks, severity, category, and attack path before publishing validated inline findings.",
  ],
  [
    "quality-gate",
    "Turn Pipr review output into a required quality check that fails when blocking correctness or test coverage risks are found.",
  ],
  [
    "diff-diagnostics",
    "Convert reviewdog-style diagnostics into Pipr inline findings so model output maps back to validated diff ranges.",
  ],
  [
    "pr-hygiene",
    "Check pull requests for operational hygiene such as tests, documentation updates, lockfile changes, generated files, and change size.",
  ],
  [
    "dependency-risk",
    "Review dependency manifest and lockfile changes for supply chain, versioning, licensing, and upgrade-risk signals.",
  ],
  [
    "ci-triage-command",
    "Add a command-only workflow that lets maintainers paste CI failure logs and get targeted triage without publishing normal review comments.",
  ],
  [
    "interactive-ask",
    "Add a free-form `@pipr` command that answers maintainer questions using the diff, prior Pipr review state, and bounded repository context.",
  ],
  [
    "plugin-tool-review",
    "Define a typed Pipr plugin with R2-backed memory search and store tools, then let reviewer agents recall durable project context across reviews.",
  ],
  [
    "changelog-draft",
    "Draft release-note style changelog entries from pull request changes and publish them as a command response comment.",
  ],
] satisfies Array<[string, string]>);

expected.set("index.mdx", renderIndex());
for (const recipe of recipes) {
  expected.set(`${recipe.id}.mdx`, renderRecipe(recipe));
}

await mkdir(docsDir, { recursive: true });

const existing = new Set((await readdir(docsDir)).filter((file) => file.endsWith(".mdx")));
let hasDrift = false;

for (const [file, content] of expected) {
  const target = path.join(docsDir, file);
  let current = "";
  try {
    current = await readFile(target, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  if (current !== content) {
    if (mode === "check") {
      console.error(`Recipe docs drift: ${path.relative(process.cwd(), target)}`);
      hasDrift = true;
    } else {
      await writeFile(target, content);
    }
  }
  existing.delete(file);
}

for (const file of existing) {
  const target = path.join(docsDir, file);
  if (mode === "check") {
    console.error(`Unexpected recipe doc: ${path.relative(process.cwd(), target)}`);
    hasDrift = true;
  } else {
    await unlink(target);
  }
}

if (hasDrift) {
  console.error("Run `bun run --cwd apps/docs recipes:sync`.");
  process.exitCode = 1;
}

function renderIndex(): string {
  const cards = recipes
    .map(
      (recipe) =>
        `<Card title="${escapeAttribute(recipe.title)}" description="${escapeAttribute(
          recipeDescription(recipe),
        )}" href="/docs/recipes/${recipe.id}" />`,
    )
    .join("\n");

  return `---
title: "Recipes"
description: "Canonical starter configs generated by \`pipr init --recipe\`."
---

{/* This file is generated by apps/docs/scripts/sync-recipes.ts. */}

Recipes are checked-in starter configs for common review workflows. They are generated from Pipr's official runtime recipe registry, so the code shown here matches what \`pipr init\` writes.

\`\`\`bash
pipr init --recipe security-sast
pipr check
\`\`\`

Use \`pipr init\` without \`--recipe\` for the default review setup.

<Cards>
${cards}
</Cards>
`;
}

function renderRecipe(recipe: (typeof recipes)[number]): string {
  const command = recipe.id === "default-review" ? "pipr init" : `pipr init --recipe ${recipe.id}`;
  const files = recipeFiles(recipe);
  const fileTree = files.map((file) => ({ path: file.path }));
  const filePanes = files.map(renderRecipeFilePane).join("\n");
  const description = recipeDescription(recipe);
  const details = recipeDetails(recipe);

  return `---
title: "${escapeFrontmatter(recipe.title)}"
description: "${escapeFrontmatter(description)}"
---

{/* This file is generated by apps/docs/scripts/sync-recipes.ts. */}

## Install

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/somus/pipr/main/install.sh | sh
${command}
pipr check
\`\`\`

## Files

<RecipeFileExplorer files={${JSON.stringify(fileTree, null, 2)}}>
${filePanes}
</RecipeFileExplorer>

Use \`${command} --adapters none\` when you only want the \`.pipr\` config files.

## Local type support

\`pipr init\` also writes \`.pipr/tsconfig.json\` and \`.pipr/types/**\` for editor IntelliSense. These files are optional for CI and the GitHub Action; \`pipr check\` can synthesize the same type support when they are missing. Use \`${command} --no-types\` to skip them, then run \`pipr init --types-only\` later to add local types.

Pipr config and plugin files execute in Bun, so \`.pipr/*.ts\` files can use the Bun API directly, including imports such as \`import { S3Client } from "bun"\`.

${details}
## Tuning

- Change the model provider and \`apiKey\` secret name before committing the config.
- Adjust reviewer instructions before changing runtime limits.
- Run \`pipr inspect\` after edits to confirm the loaded runtime plan.
- Use a local run before opening a pull request when the recipe adds custom commands or tasks.
`;
}

function recipeDescription(recipe: (typeof recipes)[number]): string {
  return recipeDescriptions.get(recipe.id) ?? recipe.description;
}

function recipeDetails(recipe: (typeof recipes)[number]): string {
  if (recipe.id !== "plugin-tool-review") {
    return "";
  }

  return `## Memory service

This recipe uses Bun's S3-compatible client against Cloudflare R2. R2 credentials are declared with \`pipr.secret(...)\`, then resolved inside tool execution with \`ctx.secret(...)\`. The generated GitHub workflow maps \`PIPR_R2_MEMORY_BUCKET\`, \`PIPR_R2_MEMORY_ENDPOINT\`, \`PIPR_R2_MEMORY_ACCESS_KEY_ID\`, and \`PIPR_R2_MEMORY_SECRET_ACCESS_KEY\` repository secrets into matching runtime environment variables.

R2 is object storage, not a search index. The sample lists recent JSON memory objects under the configured prefix and filters them locally, which is enough for small reviewer-memory sets. Change \`prefix\` in \`.pipr/config.ts\` when multiple repositories share one bucket.

`;
}

function renderRecipeFilePane(file: { code: string; lang: string; path: string }): string {
  const fence = fenceFor(file.code);

  return `<RecipeFilePane path="${escapeAttribute(file.path)}">

${fence}${file.lang} title="${escapeAttribute(file.path)}"
${file.code.trimEnd()}
${fence}

</RecipeFilePane>`;
}

function fenceFor(value: string): string {
  const longest = Math.max(...[...value.matchAll(/`+/g)].map((match) => match[0].length), 2);
  return "`".repeat(longest + 1);
}

function recipeFiles(
  recipe: (typeof recipes)[number],
): Array<{ code: string; lang: string; path: string }> {
  return [
    { code: recipe.configTs, lang: "ts", path: ".pipr/config.ts" },
    ...(recipe.files ?? []).map((file) => ({
      code: file.contents,
      lang: recipeFileLanguage(file.relativePath),
      path: path.posix.join(".pipr", file.relativePath),
    })),
    { code: starterWorkflow(recipe.id), lang: "yaml", path: ".github/workflows/pipr.yml" },
  ];
}

function recipeFileLanguage(filePath: string): string {
  const extension = path.extname(filePath);
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".yaml" || extension === ".yml") {
    return "yaml";
  }
  return "ts";
}

function githubExpression(expression: string): string {
  return `$${["{{ ", expression, " }}"].join("")}`;
}

function escapeFrontmatter(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeAttribute(value: string): string {
  return escapeFrontmatter(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}
