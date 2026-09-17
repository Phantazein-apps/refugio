// The eval set, guarded.
//
// W9's instrument is only worth what its integrity is worth. Three things can
// quietly ruin it and none of them announces itself:
//
//   1. A task file that half-parses. The hand-rolled YAML subset exists because
//      house rule 7 forbids a dependency, so the reader must REFUSE what it
//      cannot read rather than guess at it — a mis-read rubric turns a
//      measurement back into an opinion.
//   2. A task requiring a tool nobody will ever provide. Such a task skips
//      forever, and a scorecard with a permanent blank in it reads as complete.
//      So every required tool is either one a shipped server really exposes, or
//      it names the workstream that owes it.
//   3. A runner that flatters the model. Band 3 is a person's judgement; a
//      runner that awards it makes the scorecard useless as a decision input.
//
// Plus principle 3: REFUGIO Listener is handed none of this, and that is
// enforced here rather than remembered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const evalRunner = createRequire(import.meta.url)(join(root, "scripts", "eval.cjs"));
const {
  parseYaml, YamlError, readTasks, validateTask, WORKLOADS, RUBRIC_BANDS,
  planTask, refuseListener, runTask, readStream, autoScore, AUTO_CEILING,
  resultPaths, scorecard, summarise, parseArgs, slug,
} = evalRunner;

const TASK_DIR = join(root, "eval", "tasks");

// ── The set itself ─────────────────────────────────────────────────────────

test("twenty tasks, two per workload, exactly as the plan specifies", () => {
  const tasks = readTasks(TASK_DIR);
  assert.equal(tasks.length, 20);
  for (const w of WORKLOADS) {
    const mine = tasks.filter((t) => t.workload === w);
    assert.equal(mine.length, 2, `workload ${w} has ${mine.length} task(s), expected 2`);
  }
});

test("every task file is named for its id, so a scorecard row is findable", () => {
  const files = readdirSync(TASK_DIR).filter((f) => f.endsWith(".yaml"));
  assert.equal(files.length, 20);
  const tasks = readTasks(TASK_DIR);
  for (const t of tasks) assert.ok(files.includes(`${t.id}.yaml`), `no file for ${t.id}`);
});

test("every task carries all four rubric bands", () => {
  for (const t of readTasks(TASK_DIR)) {
    for (const band of RUBRIC_BANDS) {
      assert.equal(typeof t.rubric[band], "string", `${t.id} band ${band}`);
      assert.ok(t.rubric[band].trim().length > 10, `${t.id} band ${band} is too thin to score against`);
    }
  }
});

/**
 * Which qualified tool names exist in this tree right now.
 *
 * Read from servers/ rather than listed here, because a list here would be a
 * second source of truth that drifts the first time a connector gains a tool.
 * The set is a superset — it also picks up each server's own name — which is
 * fine: the check below is looking for an invented NAMESPACE or a tool that was
 * never written, not for a typo inside a name that exists.
 */
function shippedTools() {
  const byFile = { "memory-lite.js": "memory" };
  const names = new Set(["web__search"]);       // chat/websearch.js, not a server
  for (const file of readdirSync(join(root, "servers"))) {
    if (!file.endsWith(".js") || file === "shared.js") continue;
    const server = byFile[file] || file.replace(/\.js$/, "");
    const src = readFileSync(join(root, "servers", file), "utf-8");
    for (const m of src.matchAll(/\bname:\s*['"]([a-z0-9_]+)['"]/g)) {
      names.add(`${server}__${m[1]}`);
    }
  }
  return names;
}

test("a required tool either exists today or names the workstream that owes it", () => {
  const shipped = shippedTools();
  // Sanity: if this comes back empty the check above would pass vacuously.
  assert.ok(shipped.has("slack__search_messages"), "servers/slack.js was not read");
  for (const t of readTasks(TASK_DIR)) {
    if (t.requires === "none") continue;
    for (const tool of t.requires.tools || []) {
      if (shipped.has(tool)) continue;
      assert.ok(
        t.requires.blocked_by,
        `${t.id} requires ${tool}, which no shipped server exposes, and names no workstream`,
      );
    }
  }
});

test("the tasks that need nothing are the ones that can run on a bare install", () => {
  // Six of twenty run with no connector at all. If this number drops the set
  // has quietly become unrunnable until Phase 2, which would make Phase 0's
  // first scorecard empty.
  const tasks = readTasks(TASK_DIR);
  const bare = tasks.filter((t) => t.requires === "none");
  assert.ok(bare.length >= 6, `only ${bare.length} task(s) run without a connector`);
  // And every workload that is Ready or Build-small in §3 has at least one.
  for (const w of ["B", "D", "E", "G", "I", "J"]) {
    assert.ok(bare.some((t) => t.workload === w), `workload ${w} has nothing runnable bare`);
  }
});

// ── The YAML subset ────────────────────────────────────────────────────────

test("the reader handles the shapes the task files actually use", () => {
  const doc = parseYaml([
    "id: x-thing",
    "workload: A",
    "prompt: |",
    "  first line",
    "    indented more",
    "  # this is prompt text, not a comment",
    "",
    "  after a blank line",
    "requires:",
    "  tools:",
    "    - slack__search_messages",
    "  web: true",
    "rubric:",
    "  0: nothing",
  ].join("\n"), "inline");
  assert.equal(doc.id, "x-thing");
  assert.equal(doc.requires.web, true);
  assert.deepEqual(doc.requires.tools, ["slack__search_messages"]);
  assert.equal(doc.rubric["0"], "nothing");
  // Verbatim, including the hash and the blank line. A prompt is the one place
  // a `#` is a `#`.
  assert.equal(
    doc.prompt,
    "first line\n  indented more\n# this is prompt text, not a comment\n\nafter a blank line\n",
  );
});

test("the reader refuses what it would have to guess at", () => {
  const refuses = [
    ["tools: [a, b]", "flow sequence"],
    ["tools: {a: 1}", "flow mapping"],
    ["base: &anchor x", "anchor"],
    ["prompt: >", "folded scalar"],
    ["id: a\nid: b", "duplicate key"],
    ["id: a\n  stray: b", "over-indentation"],
    ["notakeyline", "not a key"],
    ["id:value", "no space after the colon"],
  ];
  for (const [text, what] of refuses) {
    assert.throws(() => parseYaml(text, "inline"), YamlError, `${what} was accepted`);
  }
});

test("true, false, null and integers are read as themselves; quotes keep strings", () => {
  const d = parseYaml(['a: true', 'b: false', 'c: null', 'd: 42', 'e: "42"', "f: 'true'"].join("\n"));
  assert.equal(d.a, true);
  assert.equal(d.b, false);
  assert.equal(d.c, null);
  assert.equal(d.d, 42);
  assert.equal(d.e, "42");
  assert.equal(d.f, "true");
});

test("validation rejects a task the scorecard could not use", () => {
  const ok = {
    id: "z-ok", workload: "A", title: "t", prompt: "p", expect: "e",
    requires: "none", rubric: { 0: "a", 1: "b", 2: "c", 3: "d" },
  };
  assert.doesNotThrow(() => validateTask({ ...ok }, "inline"));
  const broken = [
    [{ ...ok, workload: "K" }, "unknown workload"],
    [{ ...ok, rubric: { 0: "a", 1: "b", 2: "c" } }, "a missing band"],
    [{ ...ok, rubric: { 0: "a", 1: "b", 2: "c", 3: "d", 4: "e" } }, "a band above 3"],
    [{ ...ok, id: "Z_Bad" }, "an id that is not a slug"],
    [{ ...ok, requires: { tools: ["search_messages"] } }, "an unqualified tool name"],
    [{ ...ok, requires: { nonsense: true } }, "an unknown requires key"],
    [{ ...ok, requires: { tools: ["a__b"], blocked_by: "later" } }, "a blocked_by that names no workstream"],
    [{ ...ok, checks: { answer_matches: ["("] } }, "a check that is not a regex"],
    [{ ...ok, checks: { no_tool_calls: true, calls_tools: ["a__b"] } }, "checks that contradict"],
  ];
  for (const [task, what] of broken) {
    assert.throws(() => validateTask(task, "inline"), YamlError, `${what} was accepted`);
  }
});

// ── Skipping, not failing ──────────────────────────────────────────────────

test("a missing connector skips with a reason that names the tool", () => {
  const task = readTasks(TASK_DIR).find((t) => t.id === "a1-slack-decision-trail");
  const plan = planTask(task, { tools: [], webEnabled: true });
  assert.equal(plan.run, false);
  assert.match(plan.reason, /slack__search_messages/);
});

test("a task blocked by an unbuilt workstream says which one", () => {
  const task = readTasks(TASK_DIR).find((t) => t.id === "h1-folder-summary-write");
  const plan = planTask(task, { tools: [], webEnabled: true });
  assert.equal(plan.run, false);
  assert.match(plan.reason, /^W3 /);
});

test("web search off skips the web task rather than scoring it zero", () => {
  const task = readTasks(TASK_DIR).find((t) => t.id === "d1-web-cited-answer");
  const armed = { tools: ["web__search"], webEnabled: true };
  assert.equal(planTask(task, armed).run, true);
  const off = planTask(task, { tools: ["web__search"], webEnabled: false });
  assert.equal(off.run, false);
  assert.match(off.reason, /switched off/);
});

test("a task that needs nothing runs on a server with no tools at all", () => {
  for (const t of readTasks(TASK_DIR).filter((x) => x.requires === "none")) {
    assert.equal(planTask(t, { tools: [], webEnabled: false }).run, true, t.id);
  }
});

// ── Principle 3: Listener gets none of this ────────────────────────────────

test("the eval set refuses to run against REFUGIO Listener", () => {
  const refusal = refuseListener({ edition: "listener", product: "REFUGIO Listener" });
  assert.ok(refusal, "a Listener install was accepted");
  // The refusal has to explain itself, or the next person assumes a bug and
  // works around it with REFUGIO_EDITION.
  assert.match(refusal, /REFUGIO Listener/);
  assert.match(refusal, /no tools/);
  assert.equal(refuseListener({ edition: "standard", product: "REFUGIO" }), null);
});

test("no task asks for a discussion mode, so nothing here can reach a coaching prompt", async () => {
  let sent = null;
  const fetchImpl = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, body: (async function* () { yield Buffer.from("event: done\ndata: {}\n\n"); })() };
  };
  const task = readTasks(TASK_DIR).find((t) => t.id === "b1-voice-rewrite");
  await runTask("http://x", task, { model: "m", fetchImpl });
  assert.deepEqual(Object.keys(sent).sort(), ["message", "model", "web"]);
  assert.equal("mode" in sent, false);
});

test("web is armed only for the task that declares it", async () => {
  const bodies = [];
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, body: (async function* () { yield Buffer.from("event: done\ndata: {}\n\n"); })() };
  };
  const tasks = readTasks(TASK_DIR);
  await runTask("http://x", tasks.find((t) => t.id === "d1-web-cited-answer"), { model: "m", fetchImpl });
  await runTask("http://x", tasks.find((t) => t.id === "d2-web-off-honesty"), { model: "m", fetchImpl });
  assert.equal(bodies[0].web, true);
  assert.equal(bodies[1].web, false);
});

// ── Reading the stream ─────────────────────────────────────────────────────

/** An SSE body delivered in the worst chunking the network can produce: every
 *  boundary falls somewhere unhelpful, including inside a JSON payload. */
function chunked(frames, size) {
  const text = frames.join("");
  return (async function* () {
    for (let i = 0; i < text.length; i += size) yield Buffer.from(text.slice(i, i + size));
  })();
}

const FRAMES = [
  'event: start\ndata: {"conversation_id":"abc"}\n\n',
  'event: token\ndata: {"t":"Look"}\n\n',
  'event: tool\ndata: {"name":"slack__search_messages","args":{"query":"postgres 17"}}\n\n',
  'event: tool_result\ndata: {"name":"slack__search_messages","ok":true,"text":"three hits","truncated":false}\n\n',
  'event: token\ndata: {"t":"ing it up."}\n\n',
  'event: done\ndata: {"conversation_id":"abc","title":"T"}\n\n',
];

test("the answer and its tool calls survive any chunk boundary", async () => {
  for (const size of [1, 3, 17, 4096]) {
    const out = await readStream({ body: chunked(FRAMES, size) });
    assert.equal(out.answer, "Looking it up.", `chunk size ${size}`);
    assert.equal(out.conversationId, "abc");
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, "slack__search_messages");
    assert.deepEqual(out.toolCalls[0].args, { query: "postgres 17" });
    assert.equal(out.toolCalls[0].ok, true);
    assert.equal(out.toolCalls[0].resultChars, "three hits".length);
    assert.equal(out.error, null);
  }
});

test("the same tool called twice is two calls, each with its own outcome", async () => {
  const frames = [
    'event: tool\ndata: {"name":"web__search","args":{"query":"a"}}\n\n',
    'event: tool_result\ndata: {"name":"web__search","ok":true,"text":"x"}\n\n',
    'event: tool\ndata: {"name":"web__search","args":{"query":"b"}}\n\n',
    'event: tool_result\ndata: {"name":"web__search","ok":false,"text":"Error"}\n\n',
  ];
  const out = await readStream({ body: chunked(frames, 5) });
  assert.equal(out.toolCalls.length, 2);
  assert.deepEqual(out.toolCalls.map((c) => c.ok), [true, false]);
  assert.deepEqual(out.toolCalls.map((c) => c.args.query), ["a", "b"]);
});

// What MemPalace said on 2026-09-16 when no palace existed, in the form
// muse-glimmer:30b quoted it — delivered with ok: true, as ordinary text.
const NO_PALACE = "No palace found — hint: Run: mempalace init <dir> && mempalace mine <dir>";
const toolResult = (name, text, ok = true) =>
  `event: tool\ndata: ${JSON.stringify({ name, args: { query: "how I write" } })}\n\n` +
  `event: tool_result\ndata: ${JSON.stringify({ name, ok, text, truncated: false })}\n\n`;

test("MemPalace's no-palace reply is recorded as a miss, though the server said ok", async () => {
  const out = await readStream({ body: chunked([toolResult("memory__memory_search", NO_PALACE)], 7) });
  assert.equal(out.toolCalls[0].ok, false);
  assert.equal(out.toolCalls[0].miss, "no palace");
  assert.equal(out.toolCalls[0].resultChars, NO_PALACE.length);
});

test("a real memory hit that quotes the no-palace message is still a hit", async () => {
  // A stored note can quote the message — REFUGIO's gap register does. On the
  // eval fixture a real hit ran about 5,200 characters; the error ran 95.
  const note = "# Gaps §12\n\nEvery call returned the same No palace found message.\n" + "x".repeat(5000);
  const out = await readStream({ body: chunked([toolResult("memory__memory_search", note)], 4096) });
  assert.equal(out.toolCalls[0].ok, true);
  assert.equal(out.toolCalls[0].miss, undefined);
});

test("heartbeats are skipped and the thinking count is kept, at any chunk boundary", async () => {
  const frames = [
    'event: start\ndata: {"conversation_id":"t"}\n\n',
    ": keep-alive\n\n",
    'event: thinking\ndata: {"tokens":1}\n\n',
    ": keep-alive\n\n",
    ": keep-alive\n\n",
    'event: thinking\ndata: {"tokens":3411}\n\n',
    ": keep-alive\n\n",
    'event: error\ndata: {"error":"The model spent this turn thinking"}\n\n',
  ];
  for (const size of [1, 4, 4096]) {
    const out = await readStream({ body: chunked(frames, size) });
    assert.equal(out.answer, "", `chunk size ${size}`);
    assert.equal(out.thinkingTokens, 3411);
    assert.equal(out.conversationId, "t");
    assert.match(out.error, /thinking/);
  }
});

test("a mid-stream error is carried, not swallowed", async () => {
  const out = await readStream({
    body: chunked(['event: token\ndata: {"t":"part"}\n\n', 'event: error\ndata: {"error":"model went away"}\n\n'], 7),
  });
  assert.equal(out.answer, "part");
  assert.equal(out.error, "model went away");
});

test("a stream the server cuts off is scored 0, and the partial turn is kept", async () => {
  // What undici does when chat/server.js's requestTimeout closes the socket
  // mid-answer: the body iterator throws `terminated`. Before this was caught it
  // escaped to main and the run exited with no results written at all.
  const fetchImpl = async () => ({
    ok: true,
    body: (async function* () {
      yield Buffer.from('event: start\ndata: {"conversation_id":"cut"}\n\n');
      yield Buffer.from('event: token\ndata: {"t":"Half "}\n\n');
      yield Buffer.from('event: tool\ndata: {"name":"slack__search_messages","args":{"query":"q"}}\n\n');
      yield Buffer.from('event: token\ndata: {"t":"an answer"}\n\n');
      throw new TypeError("terminated");
    })(),
  });
  const task = readTasks(TASK_DIR).find((t) => t.id === "b1-voice-rewrite");
  const out = await runTask("http://x", task, { model: "m", fetchImpl });
  assert.equal(out.error, "stream ended early: terminated");
  assert.equal(out.answer, "Half an answer");
  assert.equal(out.conversationId, "cut");
  assert.deepEqual(out.toolCalls.map((c) => c.name), ["slack__search_messages"]);
  assert.equal(typeof out.ms, "number");
  assert.deepEqual(autoScore(task, out), { band: 0, notes: ["stream ended early: terminated"] });
});

test("a refused ask is reported, not thrown", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, text: async () => '{"error":"No model available."}' });
  const task = readTasks(TASK_DIR).find((t) => t.id === "b1-voice-rewrite");
  const out = await runTask("http://x", task, { model: "m", fetchImpl });
  assert.match(out.error, /503/);
  assert.match(out.error, /No model available/);
  assert.equal(out.answer, "");
});

test("the frames the runner parses are the frames the server actually sends", () => {
  // Read in the tree, not inferred. The runner's whole input is four SSE event
  // names and the field names inside them; if streamTurn renames one, every
  // scorecard silently becomes an empty answer with no tool calls, and nothing
  // anywhere errors. So the contract is asserted against the source.
  const src = readFileSync(join(root, "chat", "server.js"), "utf-8");
  const turn = src.slice(src.indexOf("async function streamTurn"), src.indexOf("// \u2500\u2500 Routes"));
  assert.match(turn, /send\("start", \{ conversation_id:/);
  assert.match(turn, /send\("token", \{ t: piece \}\)/);
  assert.match(turn, /send\("tool", \{ name: call\.name, args: call\.args \}\)/);
  assert.match(turn, /send\("tool_result", \{\s*\n\s*name: call\.name,\s*\n\s*ok:/);
  assert.match(turn, /send\("done", \{ conversation_id: conversationId, title, model \}\)/);
  assert.match(turn, /send\("error", \{ error: err\.message \}\)/);
  assert.match(turn, /send\("thinking", \{ tokens: thinkingTokens \}\)/);
  // The heartbeat is a comment frame, which parseFrame must drop, not an event.
  assert.match(turn, /armHeartbeat\(res, heartbeatMs\(\)\)/);
  const deadlineSrc = readFileSync(join(root, "chat", "turn-deadline.js"), "utf-8");
  assert.match(deadlineSrc, /export const HEARTBEAT = ": keep-alive\\n\\n";/);
  // And the frame shape itself: "event: NAME\ndata: JSON\n\n".
  assert.match(src, /event: \$\{event\}\\ndata: \$\{JSON\.stringify\(data\)\}\\n\\n/);
});

// \u2500\u2500 Scoring ────────────────────────────────────────────────────────────────

test("the runner never awards the top band", () => {
  assert.equal(AUTO_CEILING, 2);
  const task = readTasks(TASK_DIR).find((t) => t.id === "b1-voice-rewrite");
  const perfect = autoScore(task, { answer: "Q3 migration numbers by Thursday the 19th.", toolCalls: [] });
  assert.equal(perfect.band, 2);
  assert.match(perfect.notes.join(" "), /needs a person/);
});

test("a required tool that was never called is band zero, and the note says which", () => {
  const task = readTasks(TASK_DIR).find((t) => t.id === "d1-web-cited-answer");
  const s = autoScore(task, { answer: "Node 22 is LTS, see https://nodejs.org", toolCalls: [] });
  assert.equal(s.band, 0);
  assert.match(s.notes.join(" "), /never called web__search/);
});

test("an invented answer on a task that forbids tools is band zero", () => {
  const task = readTasks(TASK_DIR).find((t) => t.id === "d2-web-off-honesty");
  const s = autoScore(task, { answer: "Here are today's headlines: ...", toolCalls: [{ name: "web__search" }] });
  assert.equal(s.band, 0);
});

test("a missing admission drops the band without claiming the turn failed", () => {
  const task = readTasks(TASK_DIR).find((t) => t.id === "d2-web-off-honesty");
  const s = autoScore(task, { answer: "Percona usually writes about MySQL performance.", toolCalls: [] });
  assert.equal(s.band, 1);
  assert.match(s.notes.join(" "), /never matches/);
  const good = autoScore(task, {
    answer: "I cannot reach the web on this message. Arm web search and ask again.",
    toolCalls: [],
  });
  assert.equal(good.band, 2);
});

test("an uninitialised memory cannot pass a memory task, and the note says how to fix it", async () => {
  // The 2026-09-16 runs: the right tool, a sensible answer, and a palace that
  // did not exist. They were awarded 2. Now the machine's state caps it.
  const task = readTasks(TASK_DIR).find((t) => t.id === "b2-voice-from-memory");
  const empty = await readStream({ body: chunked([toolResult("memory__memory_search", NO_PALACE)], 4096) });
  const s = autoScore(task, { ...empty, answer: "I found no notes about how you write. Here is a neutral draft." });
  assert.equal(s.band, 1);
  assert.match(s.notes.join(" "), /memory is not initialised/);
  assert.match(s.notes.join(" "), /memory-probe/);
  assert.doesNotMatch(s.notes.join(" "), /tool errors/);

  const found = await readStream({ body: chunked([toolResult("memory__memory_search", "# How I write\n" + "rule\n".repeat(1000))], 4096) });
  assert.equal(autoScore(task, { ...found, answer: "No, the work is not ready. The month after works." }).band, 2);
});

test("a genuine tool error is still filed as one, not as a missing palace", () => {
  const task = readTasks(TASK_DIR).find((t) => t.id === "b2-voice-from-memory");
  const s = autoScore(task, {
    answer: "Memory is unreachable, so here is a neutral draft.",
    toolCalls: [{ name: "memory__memory_search", ok: false, resultChars: 40 }],
  });
  assert.equal(s.band, 1);
  assert.match(s.notes.join(" "), /tool errors from memory__memory_search/);
  assert.doesNotMatch(s.notes.join(" "), /not initialised/);
});

test("an error or an empty answer is zero, with the reason kept", () => {
  const task = readTasks(TASK_DIR).find((t) => t.id === "b1-voice-rewrite");
  assert.deepEqual(autoScore(task, { error: "timed out", answer: "" }), { band: 0, notes: ["timed out"] });
  assert.equal(autoScore(task, { answer: "   ", toolCalls: [] }).band, 0);
});

test("a tool that errored caps the band at one", () => {
  const task = readTasks(TASK_DIR).find((t) => t.id === "f1-memory-recall");
  const s = autoScore(task, {
    answer: "I could not find a note about that.",
    toolCalls: [{ name: "memory__memory_search", ok: false }],
  });
  assert.equal(s.band, 1);
  assert.match(s.notes.join(" "), /tool errors from memory__memory_search/);
});

// ── Output ─────────────────────────────────────────────────────────────────

test("a model tag becomes a filename without losing which model it was", () => {
  const { json, md } = resultPaths({ engine: "ollama", model: "qwen2.5:14b", date: "2026-09-13", dir: "/tmp" });
  assert.equal(json, "/tmp/ollama-qwen2.5-14b-2026-09-13.json");
  assert.equal(md, "/tmp/ollama-qwen2.5-14b-2026-09-13.md");
  assert.equal(slug("hf.co/org/Model-GGUF:Q4_K_M"), "hf.co-org-Model-GGUF-Q4_K_M");
});

test("an --only run never writes the day's full scorecard", () => {
  // What happened on 2026-09-13: re-running g1-diff-bug-hunt alone to check a
  // fix replaced the committed qwen3:4b scorecard with a one-row one.
  const day = { engine: "ollama", model: "qwen3:4b", date: "2026-09-13", dir: "/tmp" };
  const full = resultPaths(day);
  const one = resultPaths({ ...day, only: ["g1-diff-bug-hunt"] });
  assert.equal(one.json, "/tmp/ollama-qwen3-4b-2026-09-13.only-g1-diff-bug-hunt.json");
  assert.equal(one.md, "/tmp/ollama-qwen3-4b-2026-09-13.only-g1-diff-bug-hunt.md");
  assert.notEqual(one.json, full.json);
  assert.notEqual(one.md, full.md);

  // An empty --only is not a partial run.
  assert.deepEqual(resultPaths({ ...day, only: [] }), full);

  // The same subset in any order, or with a repeat, is the same file.
  const ab = resultPaths({ ...day, only: ["d2-web-off-honesty", "b1-voice-rewrite"] });
  assert.deepEqual(resultPaths({ ...day, only: ["b1-voice-rewrite", "d2-web-off-honesty", "b1-voice-rewrite"] }), ab);
  assert.equal(ab.json, "/tmp/ollama-qwen3-4b-2026-09-13.only-b1-voice-rewrite+d2-web-off-honesty.json");

  // A long subset still names itself as partial, stays short, and differs from
  // another long subset.
  const ids = readTasks(TASK_DIR).map((t) => t.id);
  const many = resultPaths({ ...day, only: ids });
  assert.match(many.json, new RegExp(`\\.only-${ids.length}-tasks-[0-9a-f]{8}\\.json$`));
  assert.ok(basename(many.json).length < 120, many.json);
  assert.notEqual(resultPaths({ ...day, only: ids.slice(1) }).json, many.json);
});

test("a partial scorecard says so, and main names its files by the subset", () => {
  const rows = [{ id: "g1", workload: "G", title: "t", expect: "e", status: "ran", auto: { band: 2, notes: ["fine"] }, answer: "a", toolCalls: [] }];
  const common = {
    engine: "ollama", model: "qwen3:4b", date: "2026-09-13", base: "http://127.0.0.1:8090",
    capability: { product: "REFUGIO", version: "2.0.0-beta.2" }, rows,
  };
  assert.match(scorecard({ ...common, only: ["g1"] }), /- Partial run: `--only g1`/);
  assert.doesNotMatch(scorecard(common), /Partial run/);

  // resultPaths is only half of it; main has to hand it the subset.
  const src = readFileSync(join(root, "scripts", "eval.cjs"), "utf-8");
  const body = src.slice(src.indexOf("async function main"), src.indexOf("module.exports"));
  assert.match(body, /resultPaths\(\{ engine, model, date, only \}\)/);
  assert.match(body, /scorecard\(\{ engine, model, date, base, capability, rows, only \}\)/);
  assert.match(body, /const only = args\.only\?\.length/);
});

test("the scorecard leaves the human column empty and says why", () => {
  const rows = [
    { id: "b1", workload: "B", title: "t", expect: "e", status: "ran", auto: { band: 2, notes: ["fine"] }, answer: "hello", toolCalls: [] },
    { id: "a1", workload: "A", title: "t", expect: "e", status: "skipped", reason: "connector not running: no slack__search_messages", toolCalls: [] },
  ];
  const md = scorecard({
    engine: "ollama", model: "llama3.1:8b", date: "2026-09-13", base: "http://127.0.0.1:8090",
    capability: { product: "REFUGIO", version: "2.0.0-beta.2" }, rows,
  });
  assert.match(md, /\| `b1` \| B \| ran \| 2 \| _ \|/);
  assert.match(md, /band 3 is a person's judgement/);
  assert.match(md, /## Skipped, and what would un-skip it/);
  assert.match(md, /connector not running: no slack__search_messages/);
  // The skipped task must not appear as a score of any kind.
  assert.match(md, /\| `a1` \| A \| skipped \| — \| — \|/);
  const s = summarise(rows);
  assert.deepEqual(s, { total: 2, ran: 1, skipped: 1, autoTotal: 2, autoMax: 2 });
});

test("a tool error containing a pipe does not break the table", () => {
  const rows = [{
    id: "x", workload: "A", title: "t", expect: "e", status: "ran",
    auto: { band: 1, notes: ["tool errors from slack__search: sh -c 'a | b' failed"] },
    answer: "a", toolCalls: [{ name: "slack__search" }],
  }];
  const md = scorecard({
    engine: "e", model: "m", date: "d", base: "b",
    capability: { product: "REFUGIO", version: "1" }, rows,
  });
  const row = md.split("\n").find((l) => l.startsWith("| `x`"));
  assert.equal(row.split(/(?<!\\)\|/).length - 2, 7, "the row has the wrong number of cells");
});

// ── Arguments ──────────────────────────────────────────────────────────────

test("the runner refuses an argument it does not understand", () => {
  assert.throws(() => parseArgs(["--engine"]), /needs a value/);
  assert.throws(() => parseArgs(["--wat"]), /unknown argument/);
  const a = parseArgs(["--engine", "lmstudio", "--model", "x:1b", "--only", "a1, b1", "--timeout", "30"]);
  assert.equal(a.engine, "lmstudio");
  assert.equal(a.timeoutMs, 30000);
  assert.deepEqual(a.only, ["a1", "b1"]);
});
