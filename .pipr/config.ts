import { definePipr } from "@pipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  const reviewer = pipr.reviewer({
    name: "reviewer",
    model,
    instructions: `
      Review the pull request diff for correctness, security,
      maintainability, and test coverage.
      Return only actionable findings that target valid diff ranges.
    `,
  });

  const askAgent = pipr.agent({
    name: "ask",
    model,
    instructions: `
      Answer questions about this pull request using the Diff Manifest,
      prior review context, and read-only repository tools.
      Be concise. Do not invent facts not supported by the repository or diff.
    `,
    output: pipr.schemas.summary,
    tools: pipr.tools.readOnly,
    prompt: (input: { question: string; manifest: unknown; prior: unknown }) => pipr.prompt`
      Question:
      ${input.question}

      ${pipr.section("Diff Manifest", input.manifest)}

      ${pipr.section("Prior Review", input.prior)}
    `,
  });

  const ask = pipr.task<{ question: string }>({
    name: "ask",
    async run(ctx, input) {
      if (!ctx.command) {
        throw new Error("ask task must be run from an @pipr command");
      }
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const prior = await ctx.review.prior();
      const answer = await ctx.pi.run(askAgent, {
        question: input.question,
        manifest,
        prior,
      });
      await ctx.command.reply(answer.body);
    },
  });

  pipr.review({
    id: "review",
    reviewer,
    entrypoints: {
      changeRequest: ["opened", "updated", "reopened", "ready"],
      command: { pattern: "@pipr review", permission: "write" },
    },
    inlineComments: { max: 5 },
    timeout: "5m",
    comment: (result, context) => ({
      main:
        context.platform.id === "local"
          ? [
              "## Summary",
              "",
              result.summary.body,
              "",
              "## Inline Findings",
              "",
              result.inlineFindings.length === 0
                ? "No inline findings."
                : result.inlineFindings.map((finding) => `- ${finding.body}`).join("\n"),
            ].join("\n")
          : result.summary.body,
      inlineFindings: result.inlineFindings,
    }),
  });

  pipr.command({
    pattern: "@pipr ask <question...>",
    permission: "read",
    description: "Ask a question about this pull request.",
    task: ask,
  });
});
