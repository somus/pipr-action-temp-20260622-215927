import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const coreFiles = [
  "review/task-runtime.ts",
  "review/review-run.ts",
  "review/comment.ts",
  "review/comment-publishing.ts",
  "config/task-selection.ts",
];

describe("code host adapter boundary", () => {
  it("keeps core review orchestration free of GitHub imports", () => {
    for (const file of coreFiles) {
      const absolutePath = path.join(import.meta.dir, "..", "..", file);
      const source = readFileSync(absolutePath, "utf8");
      expect(source).not.toContain("hosts/github");
      expect(source).not.toContain("shared/github");
      expect(source).not.toContain("review/github");
      expect(source).not.toContain("@octokit/rest");
    }
  });
});
