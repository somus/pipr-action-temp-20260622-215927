#!/usr/bin/env bun
import { strict as assert } from "node:assert";
import { assertActCondensedFixture } from "./assert-act-condensed-fixture.mjs";
import { assertActFullFixture } from "./assert-act-full-fixture.mjs";

const headSha = "head-sha";

assert.doesNotThrow(() => assertActFullFixture(validFullFixture(), headSha));
assert.doesNotThrow(() => assertActCondensedFixture(validCondensedFixture()));

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

expectCondensedFailure("condensed summary missing", {
  ...validCondensedFixture(),
  issueComments: [{ body: "<!-- pipr:main-comment pr=1 -->" }],
});

expectCondensedFailure("unexpected inline payloads: expected 0, got 1", {
  ...validCondensedFixture(),
  reviewCommentPayloads: [validInlinePayload()],
});

console.log("act fixture assertion tests ok");

function expectFailure(message: string, fixture: PublicationFixture): void {
  assert.throws(() => assertActFullFixture(fixture, headSha), { message });
}

function expectCondensedFailure(message: string, fixture: PublicationFixture): void {
  assert.throws(() => assertActCondensedFixture(fixture), { message });
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
    issueComments: [{ body: "<!-- pipr:main-comment pr=1 -->\n\n# pipr Review" }],
    reviewCommentPayloads: [validInlinePayload()],
  };
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

function validInlinePayload(): NonNullable<PublicationFixture["reviewCommentPayloads"]>[number] {
  return {
    path: "test/fixtures/act/project/sample.ts",
    commit_id: headSha,
    line: 2,
    side: "RIGHT",
    body: "<!-- pipr:finding fingerprint=0123456789abcdef head=head-sha -->",
  };
}
