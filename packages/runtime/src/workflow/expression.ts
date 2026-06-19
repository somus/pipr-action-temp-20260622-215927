export type WorkflowExpressionRoots = {
  inputs: unknown;
  steps: Record<string, { outputs: Record<string, unknown> }>;
  context: Record<string, unknown>;
  config: unknown;
  event: unknown;
};

type TokenKind = "identifier" | "number" | "string" | "operator" | "punct" | "boolean" | "null";

type Token = {
  kind: TokenKind;
  value: string;
};

type TokenRead = {
  token?: Token;
  nextIndex: number;
};

type TokenReader = (source: string, index: number) => TokenRead | undefined;

const expressionPattern = /^\s*\$\{\{\s*([\s\S]*?)\s*\}\}\s*$/;
const unsafePathSegments = new Set(["__proto__", "prototype", "constructor"]);
const expressionRoots = new Set(["inputs", "steps", "context", "config", "event"]);
const tokenReaders: TokenReader[] = [
  readWhitespaceToken,
  readCompoundOperatorToken,
  readSingleOperatorToken,
  readPunctuationToken,
  readQuotedStringToken,
  readNumericToken,
  readNamedToken,
];

export function resolveWorkflowValue(value: unknown, roots: WorkflowExpressionRoots): unknown {
  if (typeof value === "string") {
    return resolveWorkflowString(value, roots);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveWorkflowValue(item, roots));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveWorkflowValue(item, roots)]),
    );
  }

  return value;
}

export function validateWorkflowExpressions(value: unknown): void {
  if (typeof value === "string") {
    validateWorkflowString(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      validateWorkflowExpressions(item);
    }
    return;
  }

  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      validateWorkflowExpressions(item);
    }
  }
}

function resolveWorkflowString(value: string, roots: WorkflowExpressionRoots): unknown {
  const expression = readExpression(value);
  return expression === undefined ? value : new ExpressionParser(expression, roots).parse();
}

function validateWorkflowString(value: string): void {
  const expression = readExpression(value);
  if (expression !== undefined) {
    new ExpressionParser(expression).parse();
  }
}

function readExpression(value: string): string | undefined {
  const match = expressionPattern.exec(value);
  if (match) {
    return match[1] ?? "";
  }
  if (value.includes("${{") || value.includes("}}")) {
    throw new Error("Embedded workflow expressions are not supported");
  }
  return undefined;
}

class ExpressionParser {
  private readonly tokens: Token[];
  private cursor = 0;
  private skipRefResolution = false;

  constructor(
    expression: string,
    private readonly roots?: WorkflowExpressionRoots,
  ) {
    this.tokens = tokenizeExpression(expression);
  }

  parse(): unknown {
    const value = this.parseOr();
    if (this.peek()) {
      throw new Error(`Unsupported workflow expression token '${this.peek()?.value}'`);
    }
    return value;
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.matchOperator("||")) {
      if (left) {
        this.parseWithoutRefResolution(() => this.parseAnd());
        left = true;
        continue;
      }
      left = Boolean(this.parseAnd());
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseEquality();
    while (this.matchOperator("&&")) {
      if (!left) {
        this.parseWithoutRefResolution(() => this.parseEquality());
        left = false;
        continue;
      }
      left = Boolean(this.parseEquality());
    }
    return left;
  }

  private parseEquality(): unknown {
    let left = this.parseUnary();
    while (true) {
      if (this.matchOperator("==")) {
        left = left === this.parseUnary();
        continue;
      }
      if (this.matchOperator("!=")) {
        left = left !== this.parseUnary();
        continue;
      }
      return left;
    }
  }

  private parseUnary(): unknown {
    if (this.matchOperator("!")) {
      return !this.parseUnary();
    }
    return this.parsePath();
  }

  private parsePath(): unknown {
    let value = this.parsePrimary();
    let ref = this.lastRef;

    while (true) {
      if (this.matchPunct(".")) {
        const property = this.expect("identifier").value;
        assertSafePathSegment(property);
        ref = `${ref}.${property}`;
        value = this.readProperty(value, property, ref);
        continue;
      }
      if (this.matchPunct("[")) {
        const index = this.readBracketIndex();
        this.expectValue("]");
        ref = `${ref}.${String(index)}`;
        value = this.readProperty(value, index, ref);
        continue;
      }
      return value;
    }
  }

  private lastRef = "";

  private parsePrimary(): unknown {
    const token = this.next();
    if (!token) {
      throw new Error("Unexpected end of workflow expression");
    }

    if (token.kind === "identifier") {
      if (!expressionRoots.has(token.value)) {
        throw new Error(`Unknown workflow expression root '${token.value}'`);
      }
      this.lastRef = token.value;
      return this.roots ? this.roots[token.value as keyof WorkflowExpressionRoots] : undefined;
    }
    if (token.kind === "string") {
      this.lastRef = token.value;
      return token.value;
    }
    if (token.kind === "number") {
      this.lastRef = token.value;
      return Number(token.value);
    }
    if (token.kind === "boolean") {
      this.lastRef = token.value;
      return token.value === "true";
    }
    if (token.kind === "null") {
      this.lastRef = token.value;
      return null;
    }
    throw new Error(`Unsupported workflow expression token '${token.value}'`);
  }

  private readBracketIndex(): string | number {
    const token = this.next();
    if (!token) {
      throw new Error("Unexpected end of workflow expression");
    }
    if (token.kind === "number") {
      return Number(token.value);
    }
    if (token.kind === "string") {
      assertSafePathSegment(token.value);
      return token.value;
    }
    throw new Error(`Unsupported workflow expression token '${token.value}'`);
  }

  private readProperty(value: unknown, key: string | number, ref: string): unknown {
    if (!this.roots || this.skipRefResolution) {
      return undefined;
    }
    if (typeof key === "number") {
      return readArrayProperty(value, key, ref);
    }
    return readObjectProperty(value, key, ref);
  }

  private parseWithoutRefResolution(parse: () => unknown): void {
    const previous = this.skipRefResolution;
    this.skipRefResolution = true;
    try {
      parse();
    } finally {
      this.skipRefResolution = previous;
    }
  }

  private matchOperator(operator: string): boolean {
    const token = this.peek();
    if (token?.kind === "operator" && token.value === operator) {
      this.cursor += 1;
      return true;
    }
    return false;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === "punct" && token.value === value) {
      this.cursor += 1;
      return true;
    }
    return false;
  }

  private expect(kind: TokenKind): Token {
    const token = this.next();
    if (!token || token.kind !== kind) {
      throw new Error(`Unsupported workflow expression token '${token?.value ?? ""}'`);
    }
    return token;
  }

  private expectValue(value: string): void {
    const token = this.next();
    if (!token || token.value !== value) {
      throw new Error(`Unsupported workflow expression token '${token?.value ?? ""}'`);
    }
  }

  private next(): Token | undefined {
    const token = this.peek();
    if (token) {
      this.cursor += 1;
    }
    return token;
  }

  private peek(): Token | undefined {
    return this.tokens[this.cursor];
  }
}

function tokenizeExpression(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const result = readNextToken(expression, index);
    if (!result) {
      throw new Error(`Unsupported workflow expression token '${expression[index] ?? ""}'`);
    }
    if (result.token) {
      tokens.push(result.token);
    }
    index = result.nextIndex;
  }
  return tokens;
}

function readNextToken(source: string, index: number): TokenRead | undefined {
  for (const reader of tokenReaders) {
    const result = reader(source, index);
    if (result) {
      return result;
    }
  }
  return undefined;
}

function readWhitespaceToken(source: string, index: number): TokenRead | undefined {
  return /\s/.test(source[index] ?? "") ? { nextIndex: index + 1 } : undefined;
}

function readCompoundOperatorToken(source: string, index: number): TokenRead | undefined {
  const value = source.slice(index, index + 2);
  return ["&&", "||", "==", "!="].includes(value)
    ? { token: { kind: "operator", value }, nextIndex: index + 2 }
    : undefined;
}

function readSingleOperatorToken(source: string, index: number): TokenRead | undefined {
  return source[index] === "!"
    ? { token: { kind: "operator", value: "!" }, nextIndex: index + 1 }
    : undefined;
}

function readPunctuationToken(source: string, index: number): TokenRead | undefined {
  const value = source[index] ?? "";
  return [".", "[", "]"].includes(value)
    ? { token: { kind: "punct", value }, nextIndex: index + 1 }
    : undefined;
}

function readQuotedStringToken(source: string, index: number): TokenRead | undefined {
  const quote = source[index];
  if (quote !== "'" && quote !== '"') {
    return undefined;
  }
  const result = readStringToken(source, index);
  return { token: { kind: "string", value: result.value }, nextIndex: result.nextIndex };
}

function readNumericToken(source: string, index: number): TokenRead | undefined {
  if (!/\d/.test(source[index] ?? "")) {
    return undefined;
  }
  const result = readNumberToken(source, index);
  return { token: { kind: "number", value: result.value }, nextIndex: result.nextIndex };
}

function readNamedToken(source: string, index: number): TokenRead | undefined {
  if (!/[A-Za-z_]/.test(source[index] ?? "")) {
    return undefined;
  }
  const result = readIdentifierToken(source, index);
  return { token: classifyIdentifier(result.value), nextIndex: result.nextIndex };
}

function readStringToken(source: string, start: number): { value: string; nextIndex: number } {
  const quote = source[start] ?? "";
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === quote) {
      return { value, nextIndex: index + 1 };
    }
    if (char === "\\") {
      const next = source[index + 1];
      if (!next) {
        throw new Error("Unterminated workflow expression string");
      }
      value += next;
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }
  throw new Error("Unterminated workflow expression string");
}

function readNumberToken(source: string, start: number): { value: string; nextIndex: number } {
  let index = start;
  while (index < source.length && /[\d.]/.test(source[index] ?? "")) {
    index += 1;
  }
  return { value: source.slice(start, index), nextIndex: index };
}

function readIdentifierToken(source: string, start: number): { value: string; nextIndex: number } {
  let index = start;
  while (index < source.length && /[A-Za-z0-9_-]/.test(source[index] ?? "")) {
    index += 1;
  }
  return { value: source.slice(start, index), nextIndex: index };
}

function classifyIdentifier(value: string): Token {
  if (value === "true" || value === "false") {
    return { kind: "boolean", value };
  }
  if (value === "null") {
    return { kind: "null", value };
  }
  return { kind: "identifier", value };
}

function assertSafePathSegment(segment: string): void {
  if (unsafePathSegments.has(segment)) {
    throw new Error(`Unsafe workflow path segment '${segment}'`);
  }
}

function readArrayProperty(value: unknown, key: number, ref: string): unknown {
  if (Array.isArray(value) && key >= 0 && key < value.length) {
    return value[key];
  }
  throwUnknownWorkflowRef(ref);
}

function readObjectProperty(value: unknown, key: string, ref: string): unknown {
  if (typeof value === "object" && value !== null && Object.hasOwn(value, key)) {
    return (value as Record<string, unknown>)[key];
  }
  throwUnknownWorkflowRef(ref);
}

function throwUnknownWorkflowRef(ref: string): never {
  throw new Error(`Unknown workflow ref '${ref}'`);
}
