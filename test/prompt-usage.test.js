// How full was the context, and why did generation stop?
//
// Three models once stopped mid-turn with nothing written, and nothing on the
// machine could say whether they had run out of room: REFUGIO sends Ollama no
// context option, so every model runs at Ollama's default, and one memory
// search returns about 5,000 characters. Ollama reports the counts on the final
// message of each round and REFUGIO used to discard them. These tests cover
// keeping them: out of Ollama, into the log and the stream, into the eval's
// scorecards, and into a note a reviewer can act on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chatStream } from "../chat/ollama.js";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { readStream, autoScore, readTasks } = require(join(root, "scripts", "eval.cjs"));
const TASK_DIR = join(root, "eval", "tasks");

/** An Ollama /api/chat body: newline-delimited JSON, chunked unhelpfully. */
function ndjson(objects, chunk = 7) {
  const text = objects.map((o) => JSON.stringify(o) + "\n").join("");
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < text.length; i += chunk) c.enqueue(new TextEncoder().encode(text.slice(i, i + chunk)));
      c.close();
    },
  });
}

async function withFetch(body, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, body });
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test("the counts Ollama reports on the last message survive the stream", async () => {
  const out = await withFetch(
    ndjson([
      { message: { content: "Look" }, done: false },
      { message: { content: "ing." }, done: false },
      { message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 3914, eval_count: 42 },
    ]),
    () => chatStream({ model: "m:1b", messages: [] }, () => {}),
  );
  assert.equal(out.text, "Looking.");
  assert.deepEqual(out.usage, { promptTokens: 3914, evalTokens: 42, doneReason: "stop" });
});

test('a turn that stopped for lack of room says so, in Ollama\'s own word', async () => {
  const out = await withFetch(
    ndjson([{ message: { content: "" }, done: true, done_reason: "length", prompt_eval_count: 4021, eval_count: 0 }]),
    () => chatStream({ model: "m:1b", messages: [] }, () => {}),
  );
  assert.equal(out.usage.doneReason, "length");
  assert.equal(out.usage.promptTokens, 4021);
  assert.equal(out.text, "");
});

test("an Ollama that reports no counts leaves them null rather than zero", async () => {
  // Zero prompt tokens would read as "the context was empty", which is a claim
  // about the turn. Absent has to stay absent.
  const out = await withFetch(
    ndjson([{ message: { content: "hi" }, done: true }]),
    () => chatStream({ model: "m:1b", messages: [] }, () => {}),
  );
  assert.deepEqual(out.usage, { promptTokens: null, evalTokens: null, doneReason: null });
});

// ── the eval's side ─────────────────────────────────────────

const frames = (...evts) => evts.map((e) => `event: ${e[0]}\ndata: ${JSON.stringify(e[1])}\n\n`).join("");
const chunked = (text, size) => (async function* () {
  for (let i = 0; i < text.length; i += size) yield Buffer.from(text.slice(i, i + size));
})();

test("the eval keeps one usage record per round, in order", async () => {
  const body = frames(
    ["usage", { round: 1, promptTokens: 1200, evalTokens: 30, doneReason: "stop", toolsOffered: 5 }],
    ["usage", { round: 2, promptTokens: 2600, evalTokens: 28, doneReason: "stop", toolsOffered: 5 }],
    ["done", { conversation_id: "c" }],
  );
  for (const size of [1, 13, 4096]) {
    const out = await readStream({ body: chunked(body, size) });
    assert.deepEqual(out.usage.map((u) => u.promptTokens), [1200, 2600], `chunk ${size}`);
    assert.equal(out.usage[1].round, 2);
  }
});

test("running out of context is reported to the reviewer without moving the band", async () => {
  const task = readTasks(TASK_DIR).find((t) => t.id === "b2-voice-from-memory");
  const result = {
    answer: "No, the work is not ready. The month after works.",
    toolCalls: [{ name: "memory__memory_search", ok: true, resultChars: 5200 }],
    usage: [
      { round: 1, promptTokens: 1400, doneReason: "stop" },
      { round: 2, promptTokens: 4021, doneReason: "length" },
    ],
  };
  const s = autoScore(task, result);
  assert.equal(s.band, 2, "a diagnosis, not a penalty");
  assert.match(s.notes.join(" "), /ran out of context: round 2 ended done=length at 4021 prompt tokens/);
});

test("a turn that never ran out says nothing about context", async () => {
  const task = readTasks(TASK_DIR).find((t) => t.id === "b2-voice-from-memory");
  const s = autoScore(task, {
    answer: "No, the work is not ready. The month after works.",
    toolCalls: [{ name: "memory__memory_search", ok: true }],
    usage: [{ round: 1, promptTokens: 1400, doneReason: "stop" }],
  });
  assert.doesNotMatch(s.notes.join(" "), /ran out of context/);
});
