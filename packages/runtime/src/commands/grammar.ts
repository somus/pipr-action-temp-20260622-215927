export type CommandDefinitionLike = {
  aliases?: string[];
  pattern?: string;
};

export type CommandPatternParseResult =
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: string };

const piprCommandPrefix = "@pipr";
export const piprHelpCommandLine = "@pipr help";

export function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

export function isPiprCommandLine(line: string): boolean {
  return line === piprCommandPrefix || line.startsWith(`${piprCommandPrefix} `);
}

export function isPiprCommandTrigger(value: string): boolean {
  return tokenize(value)[0] === piprCommandPrefix;
}

export function commandLabels(command: CommandDefinitionLike): string[] {
  return [command.pattern, ...(command.aliases ?? [])].filter(
    (value): value is string => value !== undefined,
  );
}

export function parseCommandPattern(pattern: string, line: string): CommandPatternParseResult {
  const patternParts = patternPartsFor(pattern);
  const lineTokens = tokenize(line);
  const captures: Record<string, string> = {};
  let index = 0;
  for (const part of patternParts) {
    if (isOptionalPart(part)) {
      const nextIndex = parseOptionalPatternPart(part.slice(1, -1), lineTokens, index, captures);
      if (nextIndex !== undefined) {
        index = nextIndex;
      }
      continue;
    }
    const nextIndex = parsePatternToken(part, lineTokens, index, captures);
    if (nextIndex === undefined) {
      return { ok: false, error: `Expected '${part}'` };
    }
    index = nextIndex;
  }
  if (index !== lineTokens.length) {
    return { ok: false, error: `Unexpected argument '${lineTokens[index]}'` };
  }
  return { ok: true, value: captures };
}

export function commandPatternPrefixMatches(pattern: string, line: string): boolean {
  const patternTokens = patternPartsFor(pattern);
  const lineTokens = tokenize(line);
  let index = 0;
  for (const token of patternTokens) {
    if (isCaptureToken(token) || isOptionalPart(token)) {
      return true;
    }
    if (lineTokens[index] !== token) {
      return false;
    }
    index += 1;
  }
  return true;
}

export function commandPatternInputIds(pattern: string): string[] {
  return patternPartsFor(pattern).flatMap((part) =>
    tokenize(isOptionalPart(part) ? part.slice(1, -1) : part)
      .filter(isCaptureToken)
      .map((token) => token.slice(1, -1)),
  );
}

function parseOptionalPatternPart(
  pattern: string,
  lineTokens: string[],
  startIndex: number,
  captures: Record<string, string>,
): number | undefined {
  const patternTokens = tokenize(pattern);
  if (patternTokens.length === 0 || lineTokens[startIndex] !== patternTokens[0]) {
    return undefined;
  }
  const snapshot = { ...captures };
  let index = startIndex;
  for (const token of patternTokens) {
    const nextIndex = parsePatternToken(token, lineTokens, index, captures);
    if (nextIndex === undefined) {
      replaceRecord(captures, snapshot);
      return undefined;
    }
    index = nextIndex;
  }
  return index;
}

function parsePatternToken(
  patternToken: string,
  lineTokens: string[],
  index: number,
  captures: Record<string, string>,
): number | undefined {
  if (isCaptureToken(patternToken)) {
    const value = lineTokens[index];
    if (!value) {
      return undefined;
    }
    captures[patternToken.slice(1, -1)] = value;
    return index + 1;
  }
  return lineTokens[index] === patternToken ? index + 1 : undefined;
}

function patternPartsFor(pattern: string): string[] {
  return pattern.match(/\[[^\]]+\]|[^\s]+/g) ?? [];
}

function isOptionalPart(value: string): boolean {
  return value.startsWith("[") && value.endsWith("]");
}

function isCaptureToken(value: string): boolean {
  return /^<[a-z0-9-]+>$/.test(value);
}

function tokenize(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

function replaceRecord(target: Record<string, string>, source: Record<string, string>): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}
