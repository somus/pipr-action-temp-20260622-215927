#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { assert, readOnlyMainComment } from "./assert-act-fixture-helpers.mjs";

if (import.meta.url === `file://${process.argv[1]}`) {
  const [fixturePath, expectedHeadSha, telemetryPath] = process.argv.slice(2);
  if (!fixturePath || !expectedHeadSha) {
    throw new Error(
      "usage: assert-act-full-fixture.mjs <fixture-path> <head-sha> [telemetry-path]",
    );
  }
  assertActFullFixture(
    JSON.parse(await readFile(fixturePath, "utf8")),
    expectedHeadSha,
    telemetryPath,
  );
}

export function assertActFullFixture(fixture, expectedHeadSha, telemetryPath) {
  assertMainComment(readOnlyMainComment(fixture));
  assertInlinePayload(readOnlyInlinePayload(fixture), expectedHeadSha);
  if (telemetryPath) {
    assertParallelPiCalls(telemetryPath);
  }
}

function assertMainComment(body) {
  assert(body?.includes("<!-- pipr:main-comment pr=1 -->") === true, "main comment marker missing");
  assert(body.includes("Full fixture secondary section"), "secondary section missing");
  assert(
    body.includes(
      "Selected tasks: `pipr/review, pipr/full-duplicate-review, pipr/full-secondary-section`",
    ),
    "unexpected selected tasks",
  );
  assert(!body.includes("pipr/docs-only"), "path-missed task was selected");
  assert(
    countOccurrences(body, "Full-flow act reached inline publication.") === 1,
    "duplicate findings were not deduped in main comment",
  );
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

function assertParallelPiCalls(telemetryPath) {
  const events = readdirSync(telemetryPath)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) =>
      readFileSync(`${telemetryPath}/${file}`, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  const fullStarts = events.filter(
    (event) => event.phase === "start" && event.promptKind === "full",
  );
  assert(fullStarts.length >= 3, `expected at least 3 full Pi calls, got ${fullStarts.length}`);
  assert(maxActiveCalls(events) >= 2, "task Pi calls did not overlap");
}

function maxActiveCalls(events) {
  let active = 0;
  let maxActive = 0;
  for (const event of events.toSorted(compareTelemetryEvents)) {
    if (event.phase === "start") {
      active += 1;
      maxActive = Math.max(maxActive, active);
    }
    if (event.phase === "end") {
      active -= 1;
    }
  }
  return maxActive;
}

function compareTelemetryEvents(left, right) {
  return left.time - right.time || phaseOrder(left.phase) - phaseOrder(right.phase);
}

function phaseOrder(phase) {
  return phase === "start" ? 0 : 1;
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}
