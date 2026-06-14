/**
 * Unit tests for the token-boundary rehydration engine.
 * Run with: node --import tsx test-rehydrate-unit.mjs
 */

import { RehydrationStream, holdPoint } from "./src/rehydrate-stream.ts";

const REAL = "AKIA5XQ2WJ8NPLR3MKVT";
const MOCK = "WYLOC_MOCK_AWS_ACCESS_KEY_14A2KD";
const mappings = [{ real: REAL, mock: MOCK, type: "aws_access_key" }];

let failed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`  ✗ ${msg}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.error(`  ✓ ${msg}`);
  }
}

console.error("── holdPoint ──────────────────────────────────────");
// A trailing partial marker prefix must be held.
eq(holdPoint("hello WYLOC_MO"), 6, "holds a trailing partial of the marker");
// A trailing complete-but-unterminated mock run must be held.
eq(holdPoint("key " + MOCK), 4, "holds a trailing unterminated mock run");
// A terminated mock (space after) need not be held.
eq(holdPoint(MOCK + " done"), (MOCK + " done").length, "flushes a terminated mock fully");
// Plain text ending in a non-marker char flushes entirely.
eq(holdPoint("just some words"), "just some words".length, "flushes plain text");

// Regression: a complete mock must never be split by a hold boundary that
// another mock's prefix would otherwise create. Here `zebra_x` starts with the
// last char of the complete mock `Class_3z`; the boundary must NOT fall inside
// `Class_3z` (which would flush `Class_3` un-rehydrated).
{
  const ms = ["Class_3z", "zebra_x"];
  eq(holdPoint("the Class_3z", ms), "the Class_3z".length, "complete mock not split by another mock's prefix");
  // A genuine trailing partial of a known mock is still held.
  eq(holdPoint("call zebra_", ms), "call ".length, "genuine trailing partial still held");
}

console.error("\n── streaming: mock split across pushes ─────────────");
{
  const s = new RehydrationStream(mappings);
  // Feed the mock in three arbitrary slices around surrounding text.
  let out = "";
  out += s.pushText("Here is your key: " + MOCK.slice(0, 4)); // "WYLO"
  out += s.pushText(MOCK.slice(4, 15));
  out += s.pushText(MOCK.slice(15) + " — keep it safe.");
  out += s.flush();
  eq(out, `Here is your key: ${REAL} — keep it safe.`, "split mock rehydrates to the real value");
  eq(out.includes(MOCK), false, "no mock token survives in output");
}

console.error("\n── streaming: mock split one char at a time ────────");
{
  const s = new RehydrationStream(mappings);
  const full = `prefix ${MOCK} suffix`;
  let out = "";
  for (const ch of full) out += s.pushText(ch);
  out += s.flush();
  eq(out, `prefix ${REAL} suffix`, "char-by-char streaming still rehydrates");
}

console.error("\n── identifier position is skipped ──────────────────");
{
  const s = new RehydrationStream(mappings);
  let out = "";
  out += s.pushText(`os.environ["${MOCK}"]`);
  out += s.flush();
  eq(out, `os.environ["${MOCK}"]`, "mock in identifier position stays a mock (no real secret as a key)");
}
{
  // identifier context split across pushes: `process.env.` then the mock.
  const s = new RehydrationStream(mappings);
  let out = "";
  out += s.pushText("const k = process.env.");
  out += s.pushText(MOCK + ";");
  out += s.flush();
  eq(out, `const k = process.env.${MOCK};`, "identifier context preserved across delta boundary");
}

console.error("\n── unknown mock passes through ─────────────────────");
{
  const s = new RehydrationStream(mappings);
  let out = "";
  out += s.pushText("WYLOC_MOCK_UNKNOWN_999999 stays");
  out += s.flush();
  eq(out, "WYLOC_MOCK_UNKNOWN_999999 stays", "unknown mock is left untouched");
}

console.error(failed ? `\n✗ ${failed} unit assertion(s) FAILED\n` : "\n✓ rehydrate-stream unit tests PASSED\n");
process.exit(failed ? 1 : 0);
