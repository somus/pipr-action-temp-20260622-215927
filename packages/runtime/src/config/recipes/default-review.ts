import type { OfficialInitRecipe } from "./types.js";

export const defaultReviewRecipe = {
  id: "default-review",
  title: "Default Review",
  description: "General pull request review with bounded inline comments.",
  sourceTools: ["pipr"],
  configTs: `import { definePipr } from "@pipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  pipr.review({
    id: "review",
    model,
    instructions: \`
      Review the pull request diff for correctness, security,
      maintainability, and test coverage.
      Return only actionable findings that target valid diff ranges.
    \`,
    inlineComments: { max: 5 },
    timeout: "5m",
  });
});
`,
} as const satisfies OfficialInitRecipe;
