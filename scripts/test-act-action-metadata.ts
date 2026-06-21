#!/usr/bin/env bun
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { renderActActionMetadata } from "./write-act-action-metadata";

const source = readFileSync("action.yml", "utf8");
const image = "pipr-action:test";
const rendered = renderActActionMetadata(source, image);
const expected = source.replace(/^(\s*)image:\s*Dockerfile\s*$/m, `$1image: docker://${image}`);
const fixtureRendered = renderActActionMetadata(source, image, {
  entrypointScript: "/opt/pipr/scripts/act-action-fixture.ts",
});

assert.equal(rendered, expected);
assert(rendered.includes("image: docker://pipr-action:test"));
assert(!rendered.includes("image: Dockerfile"));
assert(rendered.includes("inputs:"));
assert(rendered.includes("outputs:"));
assert(rendered.includes("args:"));
assert(fixtureRendered.includes("entrypoint: /usr/local/bin/bun"));
assert(fixtureRendered.includes("    - /opt/pipr/scripts/act-action-fixture.ts"));
assert(fixtureRendered.includes("    - action"));

console.log("act action metadata test ok");
