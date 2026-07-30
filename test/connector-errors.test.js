// What the settings page says when a connector fails.
//
// The rule under test is the one the design states twice: name the thing that
// refused and what was not read, and NEVER invent a cause. The second half is
// the one worth a test — a translator that guesses is worse than none, because
// it sends someone to fix a thing that isn't broken.

import { test } from "node:test";
import assert from "node:assert/strict";
import { explain, outputLines } from "../chat/connector-errors.js";

test("connection refused names the address that refused", () => {
  const ex = explain({
    label: "Email",
    error: "Email connect failed — connect ECONNREFUSED 127.0.0.1:3003",
  });
  assert.match(ex.headline, /127\.0\.0\.1:3003/);
  assert.match(ex.headline, /Nothing is listening/i);
  // "what was not read" is the half people forget. It has to be said.
  assert.match(ex.body, /[Nn]othing was read/);
  assert.ok(ex.advice.length > 0);
  assert.equal(ex.summary, "did not start");
});

test("a missing module is named, not summarised", () => {
  const ex = explain({
    label: "Things 3",
    error: "Things 3 connect failed",
    output: "Error: Cannot find module '/opt/things/index.js'\n    at Module._resolveFilename",
  });
  assert.match(ex.headline, /\/opt\/things\/index\.js/);
});

test("a held single-instance session reports the holder's PID", () => {
  const ex = explain({ label: "WhatsApp", error: "already running (PID 41208)" });
  assert.match(ex.headline, /already holding WhatsApp/i);
  assert.match(ex.body, /41208/);
  assert.equal(ex.summary, "is held by another program");
});

test("permission refusals are attributed to the system, not the connector", () => {
  const ex = explain({ label: "Apple Reminders", error: "EACCES: permission denied" });
  assert.match(ex.headline, /macOS refused/);
  assert.match(ex.summary, /refused permission/);
});

test("an unrecognised failure invents nothing", () => {
  // The whole point. A cause we cannot justify from the text must come back
  // null so the UI falls through to quoting the connector verbatim.
  const ex = explain({
    label: "Notion",
    error: "Notion connect failed",
    output: "glorp: whimsy exhausted at layer 7\nabort()",
  });
  assert.equal(ex.headline, null);
  assert.equal(ex.body, null);
  assert.deepEqual(ex.advice, []);
});

test("a healthy-looking string does not match a rule by accident", () => {
  // "not found" appears in plenty of benign text; the rules must key on the
  // failure vocabulary, not on any word that happens to sound bad.
  const ex = explain({ label: "Memory", error: "connector closed the connection" });
  assert.equal(ex.headline, null);
});

test("output is quoted as distinct, non-blank, numbered lines", () => {
  const lines = outputLines({
    output: "  first\n\n  first\nsecond\n\n\nthird  \n",
  });
  assert.deepEqual(lines, ["first", "second", "third"]);
});

test("output falls back to the composed error when stderr was empty", () => {
  // A connector that dies before writing anything must not render an empty
  // frame implying it said nothing — we still know what the pool observed.
  const lines = outputLines({ output: "", error: "spawn ENOENT" });
  assert.deepEqual(lines, ["spawn ENOENT"]);
});

test("output is capped rather than paginated", () => {
  const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(outputLines({ output: many }).length, 12);
  assert.equal(outputLines({ output: many }, 3).length, 3);
});

test("no output and no error yields no quotation at all", () => {
  assert.deepEqual(outputLines({}), []);
  assert.deepEqual(outputLines({ output: "   \n\n " }), []);
});
