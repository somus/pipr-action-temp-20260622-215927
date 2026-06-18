import { describe, expect, it } from "vitest";
import {
  validateComponentDocument,
  validateMaterializedProject,
  validatePiprConfigDocument,
} from "../src/schema.js";

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
  workflows: { enabled: ["official/review"] },
  commands: { enabled: ["official/default-commands"] },
  publication: {
    mainCommentTemplate: "official/main",
    maxInlineComments: 5,
  },
  limits: { timeoutSeconds: 300 },
  artifacts: { enabled: false },
  plugins: [],
};

describe("pipr.dev/v1 schemas", () => {
  it("validates v1 component envelopes", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", config);
    const components = [
      validateComponentDocument(".pipr/workflows/review.yaml", {
        apiVersion: "pipr.dev/v1",
        kind: "Workflow",
        id: "official/review",
        on: ["pull_request.opened"],
        steps: [{ id: "review", uses: "official/review-default" }],
      }),
      validateComponentDocument(".pipr/blocks/review-default.yaml", {
        apiVersion: "pipr.dev/v1",
        kind: "Block",
        id: "official/review-default",
        steps: [{ id: "manifest", uses: "core/diff-manifest" }],
      }),
      validateComponentDocument(".pipr/agents/reviewer.md", {
        apiVersion: "pipr.dev/v1",
        kind: "Agent",
        id: "official/reviewer",
        provider: "primary",
        fallbacks: ["fallback"],
        tools: ["core/read-file", "core/submit-review"],
        output: { schema: "official/pr-review" },
      }),
      validateComponentDocument(".pipr/comments/main.yaml", {
        apiVersion: "pipr.dev/v1",
        kind: "CommentTemplate",
        id: "official/main",
        marker: "pipr:main-comment",
        heading: "Pi PR Review",
        sections: [{ id: "summary", title: "Summary", order: 10 }],
      }),
      validateComponentDocument(".pipr/commands/default.yaml", {
        apiVersion: "pipr.dev/v1",
        kind: "CommandSet",
        id: "official/default-commands",
        commands: [
          {
            id: "review",
            aliases: ["@pipr review"],
            run: { workflows: ["official/review"] },
          },
        ],
      }),
      validateComponentDocument(".pipr/schemas/pr-review.schema.json", {
        apiVersion: "pipr.dev/v1",
        kind: "Schema",
        id: "official/pr-review",
        schema: { type: "object" },
      }),
    ];

    expect(() => validateMaterializedProject({ config: parsedConfig, components })).not.toThrow();
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

  it("rejects unknown fields", () => {
    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...config,
        unexpected: true,
      }),
    ).toThrow("unexpected");
  });

  it("requires unique provider IDs", () => {
    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...config,
        providers: [config.providers[0], config.providers[0]],
      }),
    ).toThrow("Duplicate provider id 'primary'");
  });

  it("requires agent provider and fallback refs to resolve", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", configWithoutRefs());
    const agent = validateComponentDocument(".pipr/agents/reviewer.md", {
      apiVersion: "pipr.dev/v1",
      kind: "Agent",
      id: "official/reviewer",
      provider: "missing",
      fallbacks: ["also-missing"],
      output: { schema: "official/pr-review" },
    });
    const schema = validateComponentDocument(".pipr/schemas/pr-review.schema.json", {
      apiVersion: "pipr.dev/v1",
      kind: "Schema",
      id: "official/pr-review",
      schema: { type: "object" },
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [agent, schema] }),
    ).toThrow("unknown provider 'missing'");
  });

  it("rejects duplicate component IDs", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", configWithoutRefs());
    const first = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "official/review",
      steps: [],
    });
    const second = validateComponentDocument(".pipr/workflows/other.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "official/review",
      steps: [],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [first, second] }),
    ).toThrow("Duplicate component id 'official/review'");
  });

  it("requires config component refs to exist with the expected kind", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", {
      ...configWithoutRefs(),
      workflows: { enabled: ["official/main"] },
      commands: { enabled: [] },
    });
    const comment = validateComponentDocument(".pipr/comments/main.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "CommentTemplate",
      id: "official/main",
      marker: "pipr:main-comment",
      heading: "Pi PR Review",
      sections: [{ id: "summary", title: "Summary", order: 10 }],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [comment] }),
    ).toThrow(
      "Config workflows.enabled references CommentTemplate 'official/main', expected Workflow",
    );
  });

  it("rejects missing config component refs", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", {
      ...configWithoutRefs(),
      workflows: { enabled: ["official/missing"] },
      commands: { enabled: [] },
    });

    expect(() => validateMaterializedProject({ config: parsedConfig, components: [] })).toThrow(
      "Config workflows.enabled references missing Workflow 'official/missing'",
    );
  });

  it("requires command config refs to exist with the expected kind", () => {
    const missingConfig = validatePiprConfigDocument(".pipr/config.yaml", {
      ...configWithoutRefs(),
      commands: { enabled: ["official/missing"] },
    });

    expect(() => validateMaterializedProject({ config: missingConfig, components: [] })).toThrow(
      "Config commands.enabled references missing CommandSet 'official/missing'",
    );

    const wrongKindConfig = validatePiprConfigDocument(".pipr/config.yaml", {
      ...configWithoutRefs(),
      commands: { enabled: ["official/review"] },
    });
    const workflow = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "official/review",
      steps: [],
    });

    expect(() =>
      validateMaterializedProject({ config: wrongKindConfig, components: [workflow] }),
    ).toThrow("Config commands.enabled references Workflow 'official/review', expected CommandSet");
  });

  it("requires publication config refs to exist with the expected kind", () => {
    const missingConfig = validatePiprConfigDocument(".pipr/config.yaml", {
      ...configWithoutRefs(),
      publication: { mainCommentTemplate: "official/missing" },
    });

    expect(() => validateMaterializedProject({ config: missingConfig, components: [] })).toThrow(
      "Config publication.mainCommentTemplate references missing CommentTemplate 'official/missing'",
    );

    const wrongKindConfig = validatePiprConfigDocument(".pipr/config.yaml", {
      ...configWithoutRefs(),
      publication: { mainCommentTemplate: "official/review" },
    });
    const workflow = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "official/review",
      steps: [],
    });

    expect(() =>
      validateMaterializedProject({ config: wrongKindConfig, components: [workflow] }),
    ).toThrow(
      "Config publication.mainCommentTemplate references Workflow 'official/review', expected CommentTemplate",
    );
  });

  it("requires agent output schema refs to resolve", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", configWithoutRefs());
    const agent = validateComponentDocument(".pipr/agents/reviewer.md", {
      apiVersion: "pipr.dev/v1",
      kind: "Agent",
      id: "official/reviewer",
      provider: "primary",
      output: { schema: "official/missing" },
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [agent] }),
    ).toThrow(
      "Agent 'official/reviewer' output.schema references missing Schema 'official/missing'",
    );
  });

  it("requires command and step refs to resolve with expected kinds", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", configWithoutRefs());
    const workflow = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "official/review",
      steps: [{ id: "review", uses: "official/main" }],
    });
    const comment = validateComponentDocument(".pipr/comments/main.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "CommentTemplate",
      id: "official/main",
      marker: "pipr:main-comment",
      heading: "Pi PR Review",
      sections: [{ id: "summary", title: "Summary", order: 10 }],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [workflow, comment] }),
    ).toThrow("Workflow 'official/review' step 'review' uses references CommentTemplate");

    const commandSet = validateComponentDocument(".pipr/commands/default.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "CommandSet",
      id: "official/default-commands",
      commands: [
        {
          id: "review",
          aliases: ["@pipr review"],
          run: { workflows: ["official/missing"] },
        },
      ],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [commandSet] }),
    ).toThrow(
      "CommandSet 'official/default-commands' command 'review' workflows references missing Workflow",
    );
  });

  it("rejects unsafe workflow refs and output paths in materialized steps", () => {
    const parsedConfig = validatePiprConfigDocument(".pipr/config.yaml", configWithoutRefs());
    const unsafeRefWorkflow = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "official/review",
      steps: [
        { id: "review", uses: "core/diff-manifest", with: { input: { from: "__proto__.x" } } },
      ],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [unsafeRefWorkflow] }),
    ).toThrow("Unsafe workflow path segment '__proto__'");

    const unsafeOutputWorkflow = validateComponentDocument(".pipr/workflows/review.yaml", {
      apiVersion: "pipr.dev/v1",
      kind: "Workflow",
      id: "official/review",
      steps: [{ id: "review", uses: "core/diff-manifest", output: "constructor.x" }],
    });

    expect(() =>
      validateMaterializedProject({ config: parsedConfig, components: [unsafeOutputWorkflow] }),
    ).toThrow("Unsafe workflow path segment 'constructor'");
  });

  it("rejects invalid JSON Schema components", () => {
    expect(() =>
      validateComponentDocument(".pipr/schemas/pr-review.schema.json", {
        apiVersion: "pipr.dev/v1",
        kind: "Schema",
        id: "official/pr-review",
        schema: { type: 42 },
      }),
    ).toThrow("Invalid JSON Schema");
  });

  it("rejects nested invalid JSON Schema components", () => {
    expect(() =>
      validateComponentDocument(".pipr/schemas/pr-review.schema.json", {
        apiVersion: "pipr.dev/v1",
        kind: "Schema",
        id: "official/pr-review",
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

  it("does not exempt arbitrary Env-suffixed free-form fields from secret scanning", () => {
    expect(() =>
      validatePiprConfigDocument(".pipr/config.yaml", {
        ...configWithoutRefs(),
        artifacts: { tokenEnv: "sk-secret00000000" },
      }),
    ).toThrow("Raw secret-looking value");
  });
});

function configWithoutRefs() {
  return {
    apiVersion: config.apiVersion,
    kind: config.kind,
    providers: config.providers,
  };
}
