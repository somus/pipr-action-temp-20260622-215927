#!/usr/bin/env node
import { readFile } from "node:fs/promises";

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

function readOnlyMainComment(fixture) {
  const issueComments = fixture.issueComments ?? [];
  assert(issueComments.length === 1, `expected 1 main comment, got ${issueComments.length}`);
  return issueComments[0]?.body;
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
  assertEqual(inline.path, "test/fixtures/act/project/sample.ts", "unexpected inline path");
  assertEqual(inline.commit_id, expectedHeadSha, "unexpected inline commit_id");
  assertEqual(inline.side, "RIGHT", "unexpected inline side");
  assertPositiveLine(inline.line);
  assertFindingMarker(inline.body);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, message);
}

function assertPositiveLine(line) {
  assert(typeof line === "number" && line > 0, "unexpected inline line");
}

function assertFindingMarker(body) {
  assert(body?.includes("<!-- pipr:finding ") === true, "inline marker missing");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
