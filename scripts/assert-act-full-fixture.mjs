#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { assert, readOnlyMainComment } from "./assert-act-fixture-helpers.mjs";

if (import.meta.url === `file://${process.argv[1]}`) {
  const [fixturePath, expectedHeadSha] = process.argv.slice(2);
  if (!fixturePath || !expectedHeadSha) {
    throw new Error("usage: assert-act-full-fixture.mjs <fixture-path> <head-sha>");
  }
  assertActFullFixture(JSON.parse(await readFile(fixturePath, "utf8")), expectedHeadSha);
}

export function assertActFullFixture(fixture, expectedHeadSha) {
  assertMainComment(readOnlyMainComment(fixture));
  assertInlinePayload(readOnlyInlinePayload(fixture), expectedHeadSha);
}

function assertMainComment(body) {
  assert(body?.includes("<!-- pipr:main-comment pr=1 -->") === true, "main comment marker missing");
}

function readOnlyInlinePayload(fixture) {
  const reviewCommentPayloads = fixture.reviewCommentPayloads ?? [];
  assert(
    reviewCommentPayloads.length === 1,
    `expected 1 inline payload, got ${reviewCommentPayloads.length}`,
  );
  return reviewCommentPayloads[0];
}

function assertInlinePayload(inline, expectedHeadSha) {
  assert(inline !== undefined, "inline payload missing");
  assert(inline.path === "test/fixtures/act/project/sample.ts", "unexpected inline path");
  assert(inline.commit_id === expectedHeadSha, "unexpected inline commit_id");
  assert(inline.side === "RIGHT", "unexpected inline side");
  assertPositiveLine(inline.line);
  assertFindingMarker(inline.body);
}

function assertPositiveLine(line) {
  assert(typeof line === "number" && line > 0, "unexpected inline line");
}

function assertFindingMarker(body) {
  assert(body?.includes("<!-- pipr:finding ") === true, "inline marker missing");
}
