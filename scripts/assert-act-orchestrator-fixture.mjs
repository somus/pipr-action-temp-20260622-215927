#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { assert, assertEqual, readOnlyMainComment } from "./assert-act-fixture-helpers.mjs";

if (import.meta.url === `file://${process.argv[1]}`) {
  const [fixturePath] = process.argv.slice(2);
  if (!fixturePath) {
    throw new Error("usage: assert-act-orchestrator-fixture.mjs <fixture-path>");
  }
  assertActOrchestratorFixture(JSON.parse(await readFile(fixturePath, "utf8")));
}

export function assertActOrchestratorFixture(fixture) {
  const mainComment = readOnlyMainComment(fixture);
  assert(mainComment.includes("<!-- pipr:main-comment pr=1 -->"), "main comment marker missing");
  assert(
    mainComment.includes(
      "Orchestrated review combined correctness, security, and tests specialist outputs.",
    ),
    "orchestrated summary missing",
  );
  assertEqual((fixture.reviewCommentPayloads ?? []).length, 0, "unexpected inline payloads");
}
