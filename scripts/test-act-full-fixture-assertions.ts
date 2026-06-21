#!/usr/bin/env bun
import { strict as assert } from "node:assert";
import { assertActCondensedFixture } from "./assert-act-condensed-fixture.mjs";
import { assertActFullFixture } from "./assert-act-full-fixture.mjs";
import { assertActOrchestratorFixture } from "./assert-act-orchestrator-fixture.mjs";

const headSha = "head-sha";

assert.doesNotThrow(() => assertActFullFixture(validFullFixture(), headSha));
assert.doesNotThrow(() => assertActCondensedFixture(validCondensedFixture()));
assert.doesNotThrow(() => assertActOrchestratorFixture(validOrchestratorFixture()));

expectFailure("main comment marker missing", {
  ...validFullFixture(),
  issueComments: [{ body: "manual comment" }],
});

expectFailure("expected 1 inline payload, got 0", {
  ...validFullFixture(),
  reviewCommentPayloads: [],
});

expectFailure("unexpected inline commit_id", {
  ...validFullFixture(),
  reviewCommentPayloads: [{ ...validInlinePayload(), commit_id: "stale-head" }],
});

expectFailure("inline marker missing", {
  ...validFullFixture(),
  reviewCommentPayloads: [{ ...validInlinePayload(), body: "missing marker" }],
});

expectFailure("secondary section missing", {
  ...validFullFixture(),
  issueComments: [
    {
      body: fullMainCommentBody().replace("Full fixture secondary section\n", ""),
    },
  ],
});

expectFailure("unexpected selected tasks", {
  ...validFullFixture(),
  issueComments: [
    {
      body: fullMainCommentBody().replace(
        "Selected tasks: `pipr/review, pipr/full-duplicate-review, pipr/full-secondary-section`",
        "Selected tasks: `pipr/review`",
      ),
    },
  ],
});

expectFailure("path-missed task was selected", {
  ...validFullFixture(),
  issueComments: [
    {
      body: `${fullMainCommentBody()}\npipr/docs-only`,
    },
  ],
});

expectFailure("duplicate findings were not deduped in main comment", {
  ...validFullFixture(),
  issueComments: [
    {
      body: `${fullMainCommentBody()}\nFixture inline finding`,
    },
  ],
});

expectCondensedFailure("condensed summary missing", {
  ...validCondensedFixture(),
  issueComments: [{ body: "<!-- pipr:main-comment pr=1 -->" }],
});

expectCondensedFailure("unexpected inline payloads: expected 0, got 1", {
  ...validCondensedFixture(),
  reviewCommentPayloads: [validInlinePayload()],
});

expectOrchestratorFailure("orchestrated summary missing", {
  ...validOrchestratorFixture(),
  issueComments: [{ body: "<!-- pipr:main-comment pr=1 -->" }],
});

console.log("act fixture assertion tests ok");

function expectFailure(message: string, fixture: PublicationFixture): void {
  assert.throws(() => assertActFullFixture(fixture, headSha), { message });
}

function expectCondensedFailure(message: string, fixture: PublicationFixture): void {
  assert.throws(() => assertActCondensedFixture(fixture), { message });
}

function expectOrchestratorFailure(message: string, fixture: PublicationFixture): void {
  assert.throws(() => assertActOrchestratorFixture(fixture), { message });
}

type ReviewCommentPayload = {
  path?: string;
  commit_id?: string;
  line?: number;
  side?: string;
  body?: string;
};

type PublicationFixture = {
  issueComments?: Array<{ body?: string }>;
  reviewCommentPayloads?: ReviewCommentPayload[];
  reviewComments?: ReviewCommentPayload[];
};

function validFullFixture(): PublicationFixture {
  return {
    issueComments: [{ body: fullMainCommentBody() }],
    reviewCommentPayloads: [validInlinePayload()],
  };
}

function fullMainCommentBody(): string {
  return [
    "<!-- pipr:main-comment pr=1 -->",
    "",
    "# pipr Review",
    "",
    "Full fixture secondary section",
    "",
    "- **Fixture inline finding**: Full-flow act reached inline publication.",
    "",
    "Selected tasks: `pipr/review, pipr/full-duplicate-review, pipr/full-secondary-section`",
  ].join("\n");
}

function validCondensedFixture(): PublicationFixture {
  return {
    issueComments: [
      {
        body: "<!-- pipr:main-comment pr=1 -->\n\nCondensed act fixture reached Pi after runtime tools passed.",
      },
    ],
    reviewCommentPayloads: [],
    reviewComments: [],
  };
}

function validOrchestratorFixture(): PublicationFixture {
  return {
    issueComments: [
      {
        body: "<!-- pipr:main-comment pr=1 -->\n\nOrchestrated review combined correctness, security, and tests specialist outputs.",
      },
    ],
    reviewCommentPayloads: [],
  };
}

function validInlinePayload(): NonNullable<PublicationFixture["reviewCommentPayloads"]>[number] {
  return {
    path: "test/fixtures/act/project/sample.ts",
    commit_id: headSha,
    line: 2,
    side: "RIGHT",
    body: "<!-- pipr:finding fingerprint=0123456789abcdef head=head-sha -->",
  };
}
