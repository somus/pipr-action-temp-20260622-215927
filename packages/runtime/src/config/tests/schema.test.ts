import { describe, expect, it } from "vitest";
import {
  validateComponentDocument,
  validateMaterializedProject,
  validatePiprConfigDocument,
} from "../schema.js";

const config = {
  apiVersion: "pipr.dev/v1",
  kind: "Config",
  providers: [
    {
      id: "primary",
      provider: "anthropic",
      model: "claude-sonnet",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    },
    {
      id: "fallback",
      provider: "openai",
      model: "gpt-model",
      apiKeyEnv: "OPENAI_API_KEY",
    },
  ],
  workflows: ["pipr/review"],
  commands: ["pipr/default-commands"],
  publication: {
    maxInlineComments: 5,
  },
  limits: {
    timeoutSeconds: 300,
  },
};

describe("pipr.dev/v1 schemas", () => {
  it("validates v1 component envelopes", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", config);
    const components = [
      validateComponentDocument(".pipr/workflows/review.yaml", {
        apiVersion: "pipr.dev/v1",
        kind: "Workflow",
        id: "pipr/review",
        on: ["pull_request.opened"],
        steps: [
          { id: "review", uses: "core/run-agent", with: { agent: "pipr/reviewer" } },
          {
            id: "main-comment",
            uses: "core/main-comment",
            with: { review: expr("steps.review.outputs.result"), template: "pipr/main" },
          },
        ],
      }),
      validateComponentDocument(".pipr/blocks/custom-block.yaml", {
        apiVersion: "pipr.dev/v1",
        kind: "Block",
        id: "pipr/custom-block",
        steps: [{ id: "review", uses: "core/run-agent" }],
      }),
      validateComponentDocument(".pipr/agents/reviewer.md", {
        apiVersion: "pipr.dev/v1",
        kind: "Agent",
        id: "pipr/reviewer",
        provider: "primary",
        tools: ["plugin/custom-review-tool"],
        output: { schema: "pipr/pr-review" },
      }),
      validateComponentDocument(".pipr/comments/main.yaml", {
        apiVersion: "pipr.dev/v1",
        kind: "CommentTemplate",
        id: "pipr/main",
        marker: "pipr:main-comment",
        heading: "Pi PR Review",
        sections: [{ id: "summary", title: "Summary", order: 10 }],
      }),
      validateComponentDocument(".pipr/commands/default.yaml", {
        apiVersion: "pipr.dev/v1",
        kind: "CommandSet",
        id: "pipr/default-commands",
        commands: [
          {
            id: "review",
            aliases: ["@pipr review"],
            run: { workflows: ["pipr/review"] },
          },
        ],
      }),
      validateComponentDocument(".pipr/schemas/pr-review.schema.json", {
        apiVersion: "pipr.dev/v1",
        kind: "Schema",
        id: "pipr/pr-review",
        schema: { type: "object" },
      }),
    ];

    expect(() =>
      validateMaterializedProject({
        config: parsedConfig,
        components,
        pluginToolIds: ["plugin/custom-review-tool"],
      }),
    ).not.toThrow();
  });

  it("rejects component IDs outside namespace/name format", () => {
    expect(() =>
      validateComponentDocument(".pipr/workflows/review.yaml", {
        apiVersion: "pipr.dev/v1",
        kind: "Workflow",
        id: "review",
        steps: [],
      }),
    ).toThrow("must match pattern");
  });

  it("rejects materialized components in the reserved core namespace", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", configWithoutRefs());
    const workflow = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "core/review",
      steps: [],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [workflow] }),
    ).toThrow("Component id 'core/review' uses reserved namespace 'core/'");
  });

  it("caps configured inline comments at the runtime maximum", () => {
    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...configWithoutRefs(),
        publication: {
          maxInlineComments: 51,
        },
      }),
    ).toThrow("50");
  });

  it("rejects unknown fields", () => {
    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...config,
        unexpected: true,
      }),
    ).toThrow("Unrecognized key");
  });

  it("requires unique provider IDs", () => {
    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...config,
        providers: [config.providers[0], config.providers[0]],
      }),
    ).toThrow("Duplicate provider id 'primary'");
  });

  it("requires agent provider refs to resolve", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", configWithoutRefs());
    const agent = validateComponentDocument(".pipr/agents/reviewer.md", {
      apiVersion: "pipr.dev/v1",
      kind: "Agent",
      id: "pipr/reviewer",
      provider: "missing",
      output: { schema: "pipr/pr-review" },
    });
    const schema = validateComponentDocument(".pipr/schemas/pr-review.schema.json", {
      apiVersion: "pipr.dev/v1",
      kind: "Schema",
      id: "pipr/pr-review",
      schema: { type: "object" },
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [agent, schema] }),
    ).toThrow("unknown provider 'missing'");
  });

  it("requires agent tool refs to resolve to plugin tools", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", configWithoutRefs());
    const agent = validateComponentDocument(".pipr/agents/reviewer.md", {
      apiVersion: "pipr.dev/v1",
      kind: "Agent",
      id: "pipr/reviewer",
      provider: "primary",
      tools: ["plugin/missing-tool"],
      output: { schema: "pipr/pr-review" },
    });
    const schema = validateComponentDocument(".pipr/schemas/pr-review.schema.json", {
      apiVersion: "pipr.dev/v1",
      kind: "Schema",
      id: "pipr/pr-review",
      schema: { type: "object" },
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [agent, schema] }),
    ).toThrow("Agent 'pipr/reviewer' references unknown tool 'plugin/missing-tool'");
  });

  it("rejects built-in Pi tools in Agent tool refs", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", configWithoutRefs());
    const agent = validateComponentDocument(".pipr/agents/reviewer.md", {
      apiVersion: "pipr.dev/v1",
      kind: "Agent",
      id: "pipr/reviewer",
      provider: "primary",
      tools: ["core/read"],
      output: { schema: "pipr/pr-review" },
    });
    const schema = validateComponentDocument(".pipr/schemas/pr-review.schema.json", {
      apiVersion: "pipr.dev/v1",
      kind: "Schema",
      id: "pipr/pr-review",
      schema: { type: "object" },
    });

    expect(() =>
      validateMaterializedProject({
        config: parsedConfig,
        components: [agent, schema],
        pluginToolIds: ["core/read"],
      }),
    ).toThrow("Pi built-in tools are attached by pipr, not Agent tools");
  });

  it("rejects unimplemented agent fallback chains", () => {
    expect(() =>
      validateComponentDocument(".pipr/agents/reviewer.md", {
        apiVersion: "pipr.dev/v1",
        kind: "Agent",
        id: "pipr/reviewer",
        provider: "primary",
        fallbacks: ["fallback"],
        output: { schema: "pipr/pr-review" },
      }),
    ).toThrow("Unrecognized key");
  });

  it("rejects duplicate component IDs", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", configWithoutRefs());
    const first = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "pipr/review",
      steps: [],
    });
    const second = validateComponentDocument(".pipr/workflows/other.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "pipr/review",
      steps: [],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [first, second] }),
    ).toThrow("Duplicate component id 'pipr/review'");
  });

  it("requires config component refs to exist with the expected kind", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", {
      ...configWithoutRefs(),
      workflows: ["pipr/main"],
    });
    const comment = validateComponentDocument(".pipr/comments/main.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "CommentTemplate",
      id: "pipr/main",
      marker: "pipr:main-comment",
      heading: "Pi PR Review",
      sections: [{ id: "summary", title: "Summary", order: 10 }],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [comment] }),
    ).toThrow("Config workflows references CommentTemplate 'pipr/main', expected Workflow");
  });

  it("rejects missing config component refs", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", {
      ...configWithoutRefs(),
      workflows: ["pipr/missing"],
    });

    expect(() => validateMaterializedProject({ config: parsedConfig, components: [] })).toThrow(
      "Config workflows references missing Workflow 'pipr/missing'",
    );
  });

  it("rejects Main Review Comment templates in config", () => {
    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...configWithoutRefs(),
        publication: { mainCommentTemplate: "pipr/main" },
      }),
    ).toThrow("Unrecognized key");
  });

  it("requires workflow Main Review Comment template refs to exist with the expected kind", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", configWithoutRefs());
    const missingTemplateWorkflow = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "pipr/review",
      steps: [
        {
          id: "main-comment",
          uses: "core/main-comment",
          with: { review: expr("steps.review.outputs.result"), template: "pipr/missing" },
        },
      ],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [missingTemplateWorkflow] }),
    ).toThrow(
      "Workflow 'pipr/review' step 'main-comment' template references missing CommentTemplate 'pipr/missing'",
    );

    const workflow = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "pipr/review",
      steps: [
        {
          id: "main-comment",
          uses: "core/main-comment",
          with: { review: expr("steps.review.outputs.result"), template: "pipr/other-review" },
        },
      ],
    });
    const wrongKindWorkflow = validateComponentDocument(".pipr/workflows/other.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "pipr/other-review",
      steps: [],
    });

    expect(() =>
      validateMaterializedProject({
        config: parsedConfig,
        components: [workflow, wrongKindWorkflow],
      }),
    ).toThrow(
      "Workflow 'pipr/review' step 'main-comment' template references Workflow 'pipr/other-review', expected CommentTemplate",
    );
  });

  it("rejects unsupported Main Review Comment section IDs", () => {
    expect(() =>
      validateComponentDocument(".pipr/comments/main.yaml", {
        apiVersion: "pipr.dev/v1",
        kind: "CommentTemplate",
        id: "pipr/main",
        marker: "pipr:main-comment",
        heading: "Pi PR Review",
        sections: [{ id: "custom", title: "Custom", order: 10 }],
      }),
    ).toThrow("Invalid option");
  });

  it("requires agent output schema refs to resolve", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", configWithoutRefs());
    const agent = validateComponentDocument(".pipr/agents/reviewer.md", {
      apiVersion: "pipr.dev/v1",
      kind: "Agent",
      id: "pipr/reviewer",
      provider: "primary",
      output: { schema: "pipr/missing" },
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [agent] }),
    ).toThrow("Agent 'pipr/reviewer' output.schema references missing Schema 'pipr/missing'");
  });

  it("requires step refs to resolve with expected kinds", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", configWithoutRefs());
    const workflow = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "pipr/review",
      steps: [{ id: "review", uses: "pipr/main" }],
    });
    const comment = validateComponentDocument(".pipr/comments/main.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "CommentTemplate",
      id: "pipr/main",
      marker: "pipr:main-comment",
      heading: "Pi PR Review",
      sections: [{ id: "summary", title: "Summary", order: 10 }],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [workflow, comment] }),
    ).toThrow("Workflow 'pipr/review' step 'review' uses references CommentTemplate");
  });

  it("rejects unsafe workflow expressions in materialized steps", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", configWithoutRefs());
    const unsafeRefWorkflow = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "pipr/review",
      steps: [
        {
          id: "review",
          uses: "core/run-agent",
          with: { input: expr("steps.__proto__.outputs.result") },
        },
      ],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [unsafeRefWorkflow] }),
    ).toThrow("Unsafe workflow path segment '__proto__'");

    const functionCallWorkflow = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "pipr/review",
      steps: [
        {
          id: "review",
          uses: "core/run-agent",
          with: { input: expr("context.loadSecret()") },
        },
      ],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [functionCallWorkflow] }),
    ).toThrow("Unsupported workflow expression token '('");
  });

  it("requires enabled CommandSet refs and command targets to resolve", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", {
      ...configWithoutRefs(),
      workflows: ["pipr/review"],
      commands: ["pipr/default-commands"],
    });
    const workflow = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "pipr/review",
      steps: [],
    });
    const disabledWorkflow = validateComponentDocument(".pipr/workflows/disabled.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "pipr/disabled",
      steps: [],
    });
    const commandSet = validateComponentDocument(".pipr/commands/default.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "CommandSet",
      id: "pipr/default-commands",
      commands: [
        {
          id: "review",
          aliases: ["@pipr review"],
          run: { workflows: ["pipr/disabled"] },
        },
      ],
    });

    expect(() =>
      validateMaterializedProject({
        config: parsedConfig,
        components: [workflow, disabledWorkflow, commandSet],
      }),
    ).toThrow(
      "CommandSet 'pipr/default-commands' command 'review' references disabled Workflow 'pipr/disabled'",
    );
  });

  it("does not validate disabled CommandSet targets", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", {
      ...configWithoutRefs(),
      workflows: ["pipr/review"],
      commands: ["pipr/default-commands"],
    });
    const workflow = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "pipr/review",
      steps: [],
    });
    const commandSet = validateComponentDocument(".pipr/commands/default.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "CommandSet",
      id: "pipr/default-commands",
      commands: [
        {
          id: "review",
          aliases: ["@pipr review"],
          run: { workflows: ["pipr/review"] },
        },
      ],
    });
    const disabledCommandSet = validateComponentDocument(".pipr/commands/extra.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "CommandSet",
      id: "pipr/extra-commands",
      commands: [
        {
          id: "experiment",
          aliases: ["@pipr experiment"],
          run: { workflows: ["pipr/experimental"] },
        },
      ],
    });

    expect(() =>
      validateMaterializedProject({
        config: parsedConfig,
        components: [workflow, commandSet, disabledCommandSet],
      }),
    ).not.toThrow();
  });

  it("rejects CommandSet refs to missing workflows", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", {
      ...configWithoutRefs(),
      workflows: ["pipr/review"],
      commands: ["pipr/default-commands"],
    });
    const workflow = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "pipr/review",
      steps: [],
    });
    const commandSet = validateComponentDocument(".pipr/commands/default.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "CommandSet",
      id: "pipr/default-commands",
      commands: [
        {
          id: "review",
          aliases: ["@pipr review"],
          run: { workflows: ["pipr/missing"] },
        },
      ],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [workflow, commandSet] }),
    ).toThrow(
      "CommandSet 'pipr/default-commands' command 'review' references missing Workflow 'pipr/missing'",
    );
  });

  it("rejects CommandSet refs to missing blocks", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", {
      ...configWithoutRefs(),
      commands: ["pipr/default-commands"],
    });
    const commandSet = validateComponentDocument(".pipr/commands/default.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "CommandSet",
      id: "pipr/default-commands",
      commands: [
        {
          id: "help",
          aliases: ["@pipr help"],
          run: { block: "pipr/missing" },
        },
      ],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [commandSet] }),
    ).toThrow(
      "CommandSet 'pipr/default-commands' command 'help' block references missing Block 'pipr/missing'",
    );
  });

  it("rejects invalid JSON Schema components", () => {
    expect(() =>
      validateComponentDocument(".pipr/schemas/pr-review.schema.json", {
        apiVersion: "pipr.dev/v1",
        kind: "Schema",
        id: "pipr/pr-review",
        schema: { type: 42 },
      }),
    ).toThrow("Invalid JSON Schema");
  });

  it("rejects nested invalid JSON Schema components", () => {
    expect(() =>
      validateComponentDocument(".pipr/schemas/pr-review.schema.json", {
        apiVersion: "pipr.dev/v1",
        kind: "Schema",
        id: "pipr/pr-review",
        schema: {
          type: "object",
          properties: {
            summary: { type: 42 },
          },
        },
      }),
    ).toThrow("Invalid JSON Schema");
  });

  it("allows secret-like env var names in apiKeyEnv", () => {
    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...configWithoutRefs(),
        providers: [
          {
            id: "primary",
            provider: "anthropic",
            model: "claude-sonnet",
            apiKeyEnv: "SECRET_TOKEN_VALUE",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("validates Pi-native provider thinking levels", () => {
    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...configWithoutRefs(),
        providers: [
          {
            id: "primary",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            apiKeyEnv: "DEEPSEEK_API_KEY",
            thinking: "xhigh",
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...configWithoutRefs(),
        providers: [
          {
            id: "primary",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            apiKeyEnv: "DEEPSEEK_API_KEY",
            thinking: "maybe",
          },
        ],
      }),
    ).toThrow("Invalid option");
  });

  it("rejects old provider options bags and reasoning effort fields", () => {
    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...configWithoutRefs(),
        providers: [
          {
            id: "primary",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            apiKeyEnv: "DEEPSEEK_API_KEY",
            options: {
              thinking: "high",
              reasoning_effort: "high",
            },
          },
        ],
      }),
    ).toThrow("Unrecognized key");

    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...configWithoutRefs(),
        providers: [
          {
            id: "primary",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            apiKeyEnv: "DEEPSEEK_API_KEY",
            thinking: "high",
            reasoning_effort: "high",
          },
        ],
      }),
    ).toThrow("Unrecognized key");
  });

  it("rejects raw secret-looking values", () => {
    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...configWithoutRefs(),
        providers: [
          {
            id: "primary",
            provider: "anthropic",
            model: "sk-secret00000000",
            apiKeyEnv: "ANTHROPIC_API_KEY",
          },
        ],
      }),
    ).toThrow("Raw secret-looking value");
  });

  it("rejects default-only config fields", () => {
    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...configWithoutRefs(),
        artifacts: { enabled: false },
      }),
    ).toThrow("Unrecognized key");
  });

  it("validates timeout limits explicitly", () => {
    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...configWithoutRefs(),
        limits: { timeoutSeconds: 0 },
      }),
    ).toThrow("Too small");
  });
});

function configWithoutRefs() {
  return {
    apiVersion: config.apiVersion,
    kind: config.kind,
    providers: config.providers,
  };
}

function expr(source: string): string {
  return ["$", "{{ ", source, " }}"].join("");
}
