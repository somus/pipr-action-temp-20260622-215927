#!/usr/bin/env bun
import { strict as assert } from "node:assert";
import { assertActFullFixture } from "./assert-act-full-fixture.mjs";

const headSha = "head-sha";

assert.doesNotThrow(() => assertActFullFixture(validFixture(), headSha));

expectFailure("main comment marker missing", {
  ...validFixture(),
  issueComments: [{ body: "manual comment" }],
});

expectFailure("expected 1 inline payload, got 0", {
  ...validFixture(),
  reviewCommentPayloads: [],
});

expectFailure("unexpected inline commit_id", {
  ...validFixture(),
  reviewCommentPayloads: [{ ...validInlinePayload(), commit_id: "stale-head" }],
});

expectFailure("inline marker missing", {
  ...validFixture(),
  reviewCommentPayloads: [{ ...validInlinePayload(), body: "missing marker" }],
});

console.log("act full fixture assertion tests ok");

function expectFailure(message: string, fixture: PublicationFixture): void {
  assert.throws(() => assertActFullFixture(fixture, headSha), { message });
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
};

function validFixture(): PublicationFixture {
  return {
    issueComments: [{ body: "<!-- pipr:main-comment pr=1 -->\n\n# pipr Review" }],
    reviewCommentPayloads: [validInlinePayload()],
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
