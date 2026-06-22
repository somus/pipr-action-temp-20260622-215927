import { describe, expect, it } from "bun:test";
import {
  commandPatternPrefixMatches,
  firstNonEmptyLine,
  isPiprCommandLine,
  parseCommandPattern,
} from "../grammar.js";

describe("command grammar", () => {
  it("recognizes pipr command lines and triggers by token", () => {
    expect(firstNonEmptyLine("\n  @pipr review\n  ignored")).toBe("@pipr review");
    expect(isPiprCommandLine("@pipr")).toBe(true);
    expect(isPiprCommandLine("@pipr review")).toBe(true);
    expect(isPiprCommandLine("@piprbot review")).toBe(false);
  });

  it("parses required positional and optional named arguments", () => {
    expect(
      parseCommandPattern("@pipr explain <finding> [--scope <scope>]", "@pipr explain FND-1"),
    ).toEqual({
      ok: true,
      value: { finding: "FND-1" },
    });
    expect(
      parseCommandPattern(
        "@pipr explain <finding> [--scope <scope>]",
        "@pipr explain FND-1 --scope full",
      ),
    ).toEqual({
      ok: true,
      value: { finding: "FND-1", scope: "full" },
    });
    expect(
      parseCommandPattern("@pipr explain <finding> [--scope <scope>]", "@pipr explain"),
    ).toEqual({
      ok: false,
      error: "Expected '<finding>'",
    });
    expect(
      parseCommandPattern(
        "@pipr explain <finding> [--scope <scope>]",
        "@pipr explain FND-1 trailing",
      ),
    ).toEqual({
      ok: false,
      error: "Unexpected argument 'trailing'",
    });
  });

  it("matches static prefixes before validating full patterns", () => {
    expect(commandPatternPrefixMatches("@pipr explain <finding>", "@pipr explain FND-1")).toBe(
      true,
    );
    expect(commandPatternPrefixMatches("@pipr explain <finding>", "@pipr review")).toBe(false);
  });
});
