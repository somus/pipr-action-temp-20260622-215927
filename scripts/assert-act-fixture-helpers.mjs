export function readOnlyMainComment(fixture) {
  const issueComments = fixture.issueComments ?? [];
  assertEqual(issueComments.length, 1, "unexpected main comment count");
  const body = issueComments[0]?.body;
  assert(typeof body === "string", "main comment body missing");
  return body;
}

export function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message}: expected ${expected}, got ${actual}`);
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
