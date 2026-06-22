export type ActAssertionMode = "full" | "condensed" | "orchestrator";

type ReviewCommentPayload = {
  path?: string;
  commit_id?: string;
  line?: number;
  side?: string;
  body?: string;
};

type PublicationFixture = {
  headSha?: string;
  issueComments?: Array<{ body?: string }>;
  reviewCommentPayloads?: ReviewCommentPayload[];
  reviewComments?: ReviewCommentPayload[];
};

type TelemetryEvent = {
  phase?: string;
  promptKind?: string;
  time: number;
};

export async function assertActFixture(options: {
  fixturePath: string;
  mode: ActAssertionMode;
  telemetryPath?: string;
}): Promise<void> {
  const fixture = (await Bun.file(options.fixturePath).json()) as PublicationFixture;
  if (options.mode === "full") {
    assert(typeof fixture.headSha === "string", "full assertion requires expected head SHA");
    await assertActFullFixture(fixture, fixture.headSha, options.telemetryPath);
    return;
  }
  if (options.mode === "condensed") {
    assertActCondensedFixture(fixture);
    return;
  }
  assertActOrchestratorFixture(fixture);
}

export async function assertActFullFixture(
  fixture: PublicationFixture,
  expectedHeadSha: string,
  telemetryPath?: string,
): Promise<void> {
  assertFullMainComment(readOnlyMainComment(fixture));
  assertInlinePayload(readOnlyInlinePayload(fixture), expectedHeadSha);
  if (telemetryPath) {
    await assertParallelPiCalls(telemetryPath);
  }
}

export function assertActCondensedFixture(fixture: PublicationFixture): void {
  const mainComment = readOnlyMainComment(fixture);
  assert(mainComment.includes("<!-- pipr:main-comment pr=1 -->"), "main comment marker missing");
  assert(
    mainComment.includes("Condensed act fixture reached Pi after runtime tools passed."),
    "condensed summary missing",
  );
  assertEqual((fixture.reviewCommentPayloads ?? []).length, 0, "unexpected inline payloads");
  assertEqual((fixture.reviewComments ?? []).length, 0, "unexpected inline comments");
}

export function assertActOrchestratorFixture(fixture: PublicationFixture): void {
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

function readOnlyMainComment(fixture: PublicationFixture): string {
  const issueComments = fixture.issueComments ?? [];
  assertEqual(issueComments.length, 1, "unexpected main comment count");
  const body = issueComments[0]?.body;
  assert(typeof body === "string", "main comment body missing");
  return body;
}

function assertFullMainComment(body: string): void {
  assert(body.includes("<!-- pipr:main-comment pr=1 -->"), "main comment marker missing");
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

function readOnlyInlinePayload(fixture: PublicationFixture): ReviewCommentPayload {
  const reviewCommentPayloads = fixture.reviewCommentPayloads ?? [];
  assert(
    reviewCommentPayloads.length === 1,
    `expected 1 inline payload, got ${reviewCommentPayloads.length}`,
  );
  const inline = reviewCommentPayloads[0];
  assert(inline !== undefined, "inline payload missing");
  return inline;
}

function assertInlinePayload(inline: ReviewCommentPayload, expectedHeadSha: string): void {
  assert(inline.path === "packages/e2e/fixtures/act/project/sample.ts", "unexpected inline path");
  assert(inline.commit_id === expectedHeadSha, "unexpected inline commit_id");
  assert(inline.side === "RIGHT", "unexpected inline side");
  assert(typeof inline.line === "number" && inline.line > 0, "unexpected inline line");
  assert(inline.body?.includes("<!-- pipr:finding ") === true, "inline marker missing");
}

async function assertParallelPiCalls(telemetryPath: string): Promise<void> {
  const events = (
    await Promise.all(
      [...new Bun.Glob("*.jsonl").scanSync({ cwd: telemetryPath })].map(async (file) =>
        readTelemetryFile(`${telemetryPath}/${file}`),
      ),
    )
  ).flat();
  const fullStarts = events.filter(
    (event) => event.phase === "start" && event.promptKind === "full",
  );
  assert(fullStarts.length >= 3, `expected at least 3 full Pi calls, got ${fullStarts.length}`);
  assert(maxActiveCalls(events) >= 2, "task Pi calls did not overlap");
}

async function readTelemetryFile(path: string): Promise<TelemetryEvent[]> {
  return (await Bun.file(path).text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TelemetryEvent);
}

function maxActiveCalls(events: TelemetryEvent[]): number {
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

function compareTelemetryEvents(left: TelemetryEvent, right: TelemetryEvent): number {
  return left.time - right.time || phaseOrder(left.phase) - phaseOrder(right.phase);
}

function phaseOrder(phase: TelemetryEvent["phase"]): number {
  return phase === "start" ? 0 : 1;
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message}: expected ${expected}, got ${actual}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
