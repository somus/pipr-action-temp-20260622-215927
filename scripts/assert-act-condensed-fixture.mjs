#!/usr/bin/env node
import { readFile } from "node:fs/promises";

if (import.meta.url === `file://${process.argv[1]}`) {
  const [fixturePath] = process.argv.slice(2);
  if (!fixturePath) {
    throw new Error("usage: assert-act-condensed-fixture.mjs <fixture-path>");
  }
  assertActCondensedFixture(JSON.parse(await readFile(fixturePath, "utf8")));
}

export function assertActCondensedFixture(fixture) {
  const mainComment = readOnlyMainComment(fixture);
  assert(mainComment.includes("<!-- pipr:main-comment pr=1 -->"), "main comment marker missing");
  assert(
    mainComment.includes("Condensed act fixture reached Pi after runtime tools passed."),
    "condensed summary missing",
  );
  assertEqual((fixture.reviewCommentPayloads ?? []).length, 0, "unexpected inline payloads");
  assertEqual((fixture.reviewComments ?? []).length, 0, "unexpected inline comments");
}

function readOnlyMainComment(fixture) {
  const issueComments = fixture.issueComments ?? [];
  assertEqual(issueComments.length, 1, "unexpected main comment count");
  const body = issueComments[0]?.body;
  assert(typeof body === "string", "main comment body missing");
  return body;
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message}: expected ${expected}, got ${actual}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
