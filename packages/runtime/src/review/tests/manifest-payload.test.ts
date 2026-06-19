import { describe, expect, it } from "vitest";
import {
  condenseDiffManifest,
  measureDiffManifestPrompt,
  prepareDiffManifestPrompt,
} from "../manifest-payload.js";
import { reviewTestManifest } from "./fixtures.js";

describe("Diff Manifest prompt payload", () => {
  it("keeps small manifests full and unchanged", () => {
    const manifest = reviewTestManifest();

    const prepared = prepareDiffManifestPrompt(manifest, undefined);

    expect(prepared.mode).toBe("full");
    expect(prepared.manifest).toBe(manifest);
    expect(prepared.metrics.full).toEqual(measureDiffManifestPrompt(manifest));
  });

  it("condenses when byte limits are exceeded and preserves mapping fields", () => {
    const manifest = largeContextManifest();

    const prepared = prepareDiffManifestPrompt(manifest, {
      fullMaxBytes: 128,
      fullMaxEstimatedTokens: 100_000,
      condensedMaxBytes: 100_000,
      condensedMaxEstimatedTokens: 100_000,
    });

    expect(prepared.mode).toBe("condensed");
    expect(prepared.manifest.files[0]).toMatchObject({
      path: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      hunks: [
        {
          hunkIndex: 1,
          header: "@@ -9,1 +10,3 @@",
          contentHash: "deadbeefcafe",
        },
      ],
      commentableRanges: [
        {
          id: "range-1",
          path: "src/a.ts",
          side: "RIGHT",
          startLine: 10,
          endLine: 12,
          kind: "added",
          hunkHeader: "@@ -9,1 +10,3 @@",
          hunkContentHash: "deadbeefcafe",
        },
        {
          id: "range-2",
        },
      ],
    });
    expect(JSON.stringify(prepared.manifest)).not.toContain("large preview");
    expect(JSON.stringify(prepared.manifest)).not.toContain("large signal");
    expect(JSON.stringify(prepared.manifest)).not.toContain("changedSymbol");
  });

  it("condenses when estimated token limits are exceeded", () => {
    const prepared = prepareDiffManifestPrompt(reviewTestManifest(), {
      fullMaxBytes: 100_000,
      fullMaxEstimatedTokens: 1,
      condensedMaxBytes: 100_000,
      condensedMaxEstimatedTokens: 100_000,
    });

    expect(prepared.mode).toBe("condensed");
  });

  it("fails before Pi when the condensed payload still exceeds limits", () => {
    expect(() =>
      prepareDiffManifestPrompt(reviewTestManifest(), {
        fullMaxBytes: 1,
        fullMaxEstimatedTokens: 1,
        condensedMaxBytes: 1,
        condensedMaxEstimatedTokens: 1,
      }),
    ).toThrow("exceeds condensed limit before Pi execution");
  });

  it("does not mutate the source manifest while condensing", () => {
    const manifest = largeContextManifest();

    condenseDiffManifest(manifest);

    expect(manifest.files[0]?.commentableRanges[0]?.preview).toContain("large preview");
    expect(manifest.files[0]?.signals).toEqual(["large signal"]);
  });
});

function largeContextManifest() {
  const manifest = reviewTestManifest();
  return {
    ...manifest,
    files: manifest.files.map((file) => ({
      ...file,
      signals: ["large signal"],
      changedSymbols: ["changedSymbol"],
      commentableRanges: file.commentableRanges.map((range) => ({
        ...range,
        summary: "large summary ".repeat(100),
        preview: `large preview ${range.preview ?? ""}`.repeat(100),
      })),
    })),
  };
}
