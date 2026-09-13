#!/usr/bin/env node
// The eval set's runner — W9 of the Claude Parity plan.
//
// What this is for. REFUGIO's central unresolved question is not "does the
// plumbing work" but "is the model on the other end of it good enough for this
// piece of work". models.json answers a much narrower question — can the model
// call a tool at all — and answers it with a hand-assigned boolean. Everything
// above that floor has been a feeling. This runner turns it into a number: the
// same twenty tasks, through the same route the chat window uses, against a
// named engine and model, written down with a date on it.
//
// Why it drives /api/chat/ask rather than the engine directly. The thing being
// measured is REFUGIO, not the model: the system prompt, the tool preamble, the
// forty-tool cap, the five-round loop and the mode filter are all part of what
// decides whether a task lands. An eval that spoke to Ollama directly would
// score a configuration nobody runs.
//
// Why CommonJS. House rule: ESM under chat/, CommonJS in the installer, the
// supervisor and scripts/. This sits beside mem-fit.cjs and pull-model.cjs.
//
// Why it carries its own YAML reader. No new required dependencies, and the
// base install stays Node-only. The reader below is a deliberately small
// subset — block mappings, block sequences, block scalars, plain and quoted
// scalars — and it THROWS on anything outside that rather than guessing. A
// parser that silently mis-reads a rubric would corrupt the one instrument
// this plan has for telling measurement from opinion.
//
// Usage:
//   node scripts/eval.cjs --engine ollama --model llama3.1:8b
//   node scripts/eval.cjs --dry-run                       # plan only, no server
//   node scripts/eval.cjs --engine ollama --model qwen2.5:3b --only a1,d2
//
// Writes eval/results/<engine>-<model>-<date>.json and .md. A run with --only
// writes <engine>-<model>-<date>.only-<ids>.json and .md, and leaves the day's
// full scorecard alone.

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(__dirname);
const TASK_DIR = path.join(ROOT, "eval", "tasks");
const RESULT_DIR = path.join(ROOT, "eval", "results");

// The highest band this runner will award on its own. Bands 0-2 are decidable
// from what a task declares it can check — did the required tool get called, is
// the refusal actually there, did the turn error. Band 3 is "a person would be
// happy with this", and no amount of regex reaches it. Awarding 3 automatically
// would make the scorecard flattering rather than useful, so the runner stops
// at 2 and leaves the top band to the reviewer.
const AUTO_CEILING = 2;

// ── YAML, the subset the task files are allowed to use ──────────────────────

class YamlError extends Error {}

const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => line.trim() === "" || line.trim().startsWith("#");

/**
 * Parse the subset of YAML the eval tasks use.
 *
 * Supported: block mappings, block sequences of scalars, block scalars (`|`,
 * `|-`), single- and double-quoted scalars, plain scalars, `#` comments, and
 * the scalars true/false/null plus integers. Everything else — flow
 * collections, anchors, aliases, multiple documents, tags, folded scalars —
 * raises. The point is not to be a YAML implementation; it is to refuse
 * anything it would have to guess at.
 */
function parseYaml(text, where = "<yaml>") {
  const lines = text.split(/\r?\n/);
  const st = { i: 0, lines, where };
  skipBlanks(st);
  if (st.i >= lines.length) return {};
  if (lines[st.i].trim() === "---") { st.i++; skipBlanks(st); }
  if (st.i >= lines.length) return {};
  const value = parseBlock(st, indentOf(lines[st.i]));
  skipBlanks(st);
  if (st.i < lines.length) fail(st, "unexpected content after the document");
  return value;
}

function fail(st, msg) {
  throw new YamlError(`${st.where}:${st.i + 1}: ${msg}`);
}

function skipBlanks(st) {
  while (st.i < st.lines.length && isBlank(st.lines[st.i])) st.i++;
}

function parseBlock(st, indent) {
  const line = st.lines[st.i];
  const body = line.slice(indentOf(line));
  return body === "-" || body.startsWith("- ")
    ? parseSequence(st, indent)
    : parseMapping(st, indent);
}

const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*|"[^"]*"|'[^']*'):(?:[ \t]+(.*))?$/;

function parseMapping(st, indent) {
  const out = {};
  for (;;) {
    skipBlanks(st);
    if (st.i >= st.lines.length) break;
    const line = st.lines[st.i];
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) fail(st, `unexpected indentation (expected ${indent} spaces)`);
    const body = line.slice(ind);
    if (body.startsWith("- ")) fail(st, "a list item where a key was expected");
    const m = KEY_RE.exec(body);
    if (!m) fail(st, `not a "key: value" line`);
    const key = unquote(m[1]);
    if (Object.prototype.hasOwnProperty.call(out, key)) fail(st, `duplicate key "${key}"`);
    const rest = (m[2] || "").trim();
    st.i++;
    out[key] = parseValue(st, indent, rest);
  }
  return out;
}

function parseSequence(st, indent) {
  const out = [];
  for (;;) {
    skipBlanks(st);
    if (st.i >= st.lines.length) break;
    const line = st.lines[st.i];
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) fail(st, `unexpected indentation (expected ${indent} spaces)`);
    const body = line.slice(ind);
    if (!body.startsWith("- ") && body !== "-") break;
    const rest = body === "-" ? "" : body.slice(2).trim();
    // A list of mappings would need the item's keys to align against the dash,
    // which is the one shape of this subset most likely to be mis-read. The
    // tasks have no use for it, so it is refused rather than half-implemented.
    if (KEY_RE.test(rest)) fail(st, "a list of mappings is not supported here");
    if (rest === "") fail(st, "an empty list item");
    st.i++;
    out.push(scalar(st, rest));
  }
  return out;
}

/** The value side of `key:` — a block scalar, a nested block, or a scalar. */
function parseValue(st, indent, rest) {
  if (rest === "|" || rest === "|-") return blockScalar(st, indent, rest === "|");
  if (rest === ">" || rest === ">-") fail(st, "folded scalars (>) are not supported");
  if (rest !== "") return scalar(st, rest);

  // Nothing on the line: either a nested block indented further, or a null.
  const save = st.i;
  skipBlanks(st);
  if (st.i >= st.lines.length) { st.i = save; return null; }
  if (indentOf(st.lines[st.i]) <= indent) { st.i = save; return null; }
  return parseBlock(st, indentOf(st.lines[st.i]));
}

/**
 * A `|` block scalar. Keeps every line verbatim, including blank lines and
 * anything that looks like a comment — a prompt is the one place where a `#`
 * is a `#`.
 */
function blockScalar(st, indent, keepTrailingNewline) {
  const body = [];
  let blockIndent = null;
  while (st.i < st.lines.length) {
    const line = st.lines[st.i];
    if (line.trim() === "") { body.push(""); st.i++; continue; }
    const ind = indentOf(line);
    if (ind <= indent) break;
    if (blockIndent === null) blockIndent = ind;
    if (ind < blockIndent) break;
    body.push(line.slice(blockIndent));
    st.i++;
  }
  if (blockIndent === null) fail(st, "an empty block scalar");
  while (body.length && body[body.length - 1] === "") body.pop();
  return body.join("\n") + (keepTrailingNewline ? "\n" : "");
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** A single-line scalar, with its trailing comment removed and true/false/null
 *  and integers coerced. Quoted scalars stay strings — that is what quoting is
 *  for, and a rubric band keyed "0" must not become the number zero twice. */
function scalar(st, rest) {
  if (rest.startsWith("[") || rest.startsWith("{")) fail(st, "flow collections ([] {}) are not supported");
  if (rest.startsWith("&") || rest.startsWith("*") || rest.startsWith("!")) {
    fail(st, "anchors, aliases and tags are not supported");
  }
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const q = rest[0];
    const end = rest.indexOf(q, 1);
    if (end === -1) fail(st, "unterminated quoted string");
    const tail = rest.slice(end + 1).trim();
    if (tail !== "" && !tail.startsWith("#")) fail(st, "trailing content after a quoted string");
    return rest.slice(1, end);
  }
  const cut = rest.indexOf(" #");
  const text = (cut === -1 ? rest : rest.slice(0, cut)).trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

// ── Tasks ──────────────────────────────────────────────────────────────────

/** The ten workloads of §3 of the plan. G-mobile is not here: it is a
 *  transport property of the UI, not something a model can be scored on, and
 *  folding it into G is what keeps this twenty tasks and not twenty-two. */
const WORKLOADS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

const RUBRIC_BANDS = ["0", "1", "2", "3"];

/**
 * Read and validate every task file.
 *
 * Validation is strict and it throws. A task set that half-loads is worse than
 * one that does not load: the scorecard would be missing a workload and still
 * look complete.
 */
function readTasks(dir = TASK_DIR) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  const tasks = files.map((f) => {
    const where = path.join("eval", "tasks", f);
    const task = parseYaml(fs.readFileSync(path.join(dir, f), "utf-8"), where);
    validateTask(task, where, f);
    return task;
  });
  const seen = new Set();
  for (const t of tasks) {
    if (seen.has(t.id)) throw new YamlError(`duplicate task id "${t.id}"`);
    seen.add(t.id);
  }
  return tasks;
}

function validateTask(task, where, file) {
  const bad = (msg) => { throw new YamlError(`${where}: ${msg}`); };
  if (!task || typeof task !== "object" || Array.isArray(task)) bad("not a mapping");

  for (const key of ["id", "workload", "title", "prompt", "expect"]) {
    if (typeof task[key] !== "string" || !task[key].trim()) bad(`${key} is required`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(task.id)) bad(`id "${task.id}" must be lower-case and hyphenated`);
  if (file && path.basename(file, ".yaml") !== task.id) bad(`filename must match the id "${task.id}"`);
  if (!WORKLOADS.includes(task.workload)) bad(`workload must be one of ${WORKLOADS.join(", ")}`);

  // The rubric is the whole point of a task file. A task without four bands is
  // a prompt, and a prompt produces an anecdote.
  const r = task.rubric;
  if (!r || typeof r !== "object" || Array.isArray(r)) bad("rubric is required");
  for (const band of RUBRIC_BANDS) {
    if (typeof r[band] !== "string" || !r[band].trim()) bad(`rubric band ${band} is required`);
  }
  for (const band of Object.keys(r)) {
    if (!RUBRIC_BANDS.includes(band)) bad(`rubric band "${band}" is not 0-3`);
  }

  const req = task.requires;
  if (req !== "none" && (!req || typeof req !== "object" || Array.isArray(req))) {
    bad('requires must be a mapping, or the word "none"');
  }
  if (req !== "none") {
    for (const key of Object.keys(req)) {
      if (!["tools", "web", "blocked_by"].includes(key)) bad(`unknown requires key "${key}"`);
    }
    if (req.tools !== undefined && (!Array.isArray(req.tools) || !req.tools.length)) {
      bad("requires.tools must be a non-empty list");
    }
    for (const t of req.tools || []) {
      // Qualified names only. The tool router namespaces everything as
      // `server__tool` (chat/mcp.js), and a bare name in a task file would
      // silently never match.
      if (typeof t !== "string" || !t.includes("__")) bad(`requires.tools entry "${t}" must be server__tool`);
    }
    if (req.web !== undefined && typeof req.web !== "boolean") bad("requires.web must be true or false");
    if (req.blocked_by !== undefined && !/^W\d[a-z]?$/.test(String(req.blocked_by))) {
      bad(`requires.blocked_by "${req.blocked_by}" must name a workstream, e.g. W3`);
    }
  }

  const c = task.checks;
  if (c !== undefined) {
    if (!c || typeof c !== "object" || Array.isArray(c)) bad("checks must be a mapping");
    for (const key of Object.keys(c)) {
      if (!["calls_tools", "no_tool_calls", "answer_matches", "answer_excludes"].includes(key)) {
        bad(`unknown checks key "${key}"`);
      }
    }
    for (const key of ["calls_tools", "answer_matches", "answer_excludes"]) {
      if (c[key] !== undefined && (!Array.isArray(c[key]) || !c[key].length)) {
        bad(`checks.${key} must be a non-empty list`);
      }
    }
    for (const pattern of [...(c.answer_matches || []), ...(c.answer_excludes || [])]) {
      try { new RegExp(pattern, "i"); } catch (e) { bad(`checks pattern /${pattern}/ is not a regex: ${e.message}`); }
    }
    if (c.no_tool_calls !== undefined && typeof c.no_tool_calls !== "boolean") {
      bad("checks.no_tool_calls must be true or false");
    }
    if (c.no_tool_calls && c.calls_tools) bad("checks cannot both forbid and require tool calls");
  }
  return task;
}

// ── What the server can actually do right now ──────────────────────────────

/**
 * Decide whether a task can run against this server, and if not, why.
 *
 * A skip is a first-class outcome, not a failure. Most of the twenty tasks
 * need something a later phase builds — workspaces, a Python workbench, chat
 * search, schedules — and a runner that scored those zero would report the
 * plan's own roadmap as a model deficiency, which is precisely the confusion
 * this instrument exists to prevent.
 */
function planTask(task, capability) {
  const req = task.requires;
  if (req === "none") return { run: true };

  const have = new Set(capability.tools || []);
  const missing = (req.tools || []).filter((t) => !have.has(t));
  if (missing.length) {
    const why = req.blocked_by
      ? `${req.blocked_by} has not landed: no ${missing.join(", ")}`
      : `connector not running: no ${missing.join(", ")}`;
    return { run: false, reason: why };
  }
  if (req.web && !capability.webEnabled) {
    return { run: false, reason: "web search is switched off in Settings" };
  }
  return { run: true };
}

/** Ask the chat server what it is and what it has. */
async function capabilities(base, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const res = await fetchImpl(`${base}/api/chat/status`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${base}/api/chat/status returned ${res.status}`);
  const s = await res.json();
  return {
    edition: s.modes?.edition || "standard",
    product: s.modes?.product || "REFUGIO",
    engineUp: !!s.ollamaUp,
    model: s.model || null,
    models: (s.models || []).map((m) => (typeof m === "string" ? m : m.name)).filter(Boolean),
    tools: s.tools || [],
    webEnabled: !!s.web?.enabled,
    version: s.version || null,
  };
}

/**
 * REFUGIO Listener is handed none of this.
 *
 * Principle 3 of the plan, enforced rather than remembered. Listener's
 * coaching modes receive no tools at all, so every connected-data task would
 * score zero and the scorecard would read as a model that cannot call a tool.
 * Worse, the tasks send ordinary work prompts into a product whose whole
 * premise is that it is not for ordinary work. Refusing outright is the only
 * honest behaviour.
 */
function refuseListener(capability) {
  if (capability.edition === "listener") {
    return `The eval set does not run against ${capability.product}. It scores REFUGIO's ` +
      "tool use, and Listener is handed no tools by design — every task would score zero " +
      "for a reason that has nothing to do with the model. Point --base at a REFUGIO install.";
  }
  return null;
}

// ── Running one task ───────────────────────────────────────────────────────

/**
 * Send one task's prompt and read the SSE stream back.
 *
 * Everything interesting is already on the wire: `tool` and `tool_result`
 * carry the name, the arguments and whether the call succeeded, which is the
 * provenance the scorecard needs and the thing docs/gaps.md §3 notes the
 * product itself throws away after rendering.
 */
async function runTask(base, task, { model, web = false, timeoutMs = 300000, fetchImpl = fetch } = {}) {
  const started = Date.now();
  const body = {
    message: task.prompt,
    model,
    web: web || (task.requires !== "none" && !!task.requires.web),
  };
  let res;
  try {
    res = await fetchImpl(`${base}/api/chat/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { error: `request failed: ${e.message}`, answer: "", toolCalls: [], ms: Date.now() - started };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = JSON.parse(detail); } catch { /* not JSON; the text will do */ }
    return {
      error: `ask returned ${res.status}: ${parsed?.error || detail.slice(0, 300)}`,
      answer: "", toolCalls: [], ms: Date.now() - started,
    };
  }
  // A stream can end without a `done` or an `error`: the server's own
  // requestTimeout closes the socket, and undici throws `terminated` out of the
  // iterator. Uncaught, that reaches main and the whole run exits unwritten,
  // taking every task that did finish with it. So it becomes this task's error,
  // and whatever arrived before the cut stays on the record.
  const out = { answer: "", toolCalls: [], conversationId: null, error: null };
  try {
    await readStream(res, out);
  } catch (e) {
    return { ...out, error: `stream ended early: ${e.message}`, ms: Date.now() - started };
  }
  return { ...out, ms: Date.now() - started };
}

/** Accumulate one SSE response into an answer, the tool calls behind it, and
 *  the conversation id — so a surprising score can be reopened in the window
 *  rather than argued about from a transcript. Writes into `out` as it goes,
 *  so a caller that catches a broken stream still holds the partial turn. */
async function readStream(res, out = { answer: "", toolCalls: [], conversationId: null, error: null }) {
  const { toolCalls } = out;

  for await (const evt of sseEvents(res.body)) {
    if (evt.event === "token") out.answer += evt.data?.t || "";
    else if (evt.event === "start") out.conversationId = evt.data?.conversation_id || null;
    else if (evt.event === "tool") toolCalls.push({ name: evt.data?.name, args: evt.data?.args ?? null, ok: null });
    else if (evt.event === "tool_result") {
      // The `tool` event that opened this call is the one to complete; a model
      // may call the same tool twice in a turn, so match the last open one.
      const open = [...toolCalls].reverse().find((c) => c.name === evt.data?.name && c.ok === null);
      const rec = open || { name: evt.data?.name, args: evt.data?.args ?? null };
      rec.ok = !!evt.data?.ok;
      rec.resultChars = (evt.data?.text || "").length;
      rec.truncated = !!evt.data?.truncated;
      if (!open) toolCalls.push(rec);
    } else if (evt.event === "error") out.error = evt.data?.error || "the turn failed";
    else if (evt.event === "done") out.conversationId = evt.data?.conversation_id || out.conversationId;
  }
  return out;
}

/** Parse an SSE body into events. Written out rather than pulled in because a
 *  chunk boundary can fall anywhere, including inside a JSON payload, and a
 *  naive split on "\n\n" per chunk loses exactly the long tool results that
 *  matter most. */
async function* sseEvents(stream) {
  if (!stream) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), { stream: true });
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const parsed = parseFrame(frame);
      if (parsed) yield parsed;
    }
  }
  const last = parseFrame(buffer);
  if (last) yield last;
}

function parseFrame(frame) {
  let event = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  let data = null;
  try { data = JSON.parse(dataLines.join("\n")); } catch { return null; }
  return { event, data };
}

// ── Scoring ────────────────────────────────────────────────────────────────

/**
 * The band this runner is willing to defend, and the reasons for it.
 *
 * Every failure carries its own sentence. A scorecard that says "1" and
 * nothing else gets re-litigated; one that says "1 — never called
 * slack__search_messages" gets acted on.
 */
function autoScore(task, result) {
  const notes = [];
  const checks = task.checks || {};
  const names = (result.toolCalls || []).map((c) => c.name);

  if (result.error) return { band: 0, notes: [result.error] };
  if (!(result.answer || "").trim()) return { band: 0, notes: ["empty answer"] };

  let band = AUTO_CEILING;

  for (const want of checks.calls_tools || []) {
    if (!names.includes(want)) { notes.push(`never called ${want}`); band = 0; }
  }
  if (checks.no_tool_calls && names.length) {
    notes.push(`called ${names.join(", ")} when the task expects no tool use`);
    band = 0;
  }
  if (band > 0) {
    for (const pattern of checks.answer_matches || []) {
      if (!new RegExp(pattern, "i").test(result.answer)) {
        notes.push(`the answer never matches /${pattern}/`);
        band = Math.min(band, 1);
      }
    }
    for (const pattern of checks.answer_excludes || []) {
      if (new RegExp(pattern, "i").test(result.answer)) {
        notes.push(`the answer matches /${pattern}/, which it should not`);
        band = Math.min(band, 1);
      }
    }
    const failed = (result.toolCalls || []).filter((c) => c.ok === false).map((c) => c.name);
    if (failed.length) { notes.push(`tool errors from ${failed.join(", ")}`); band = Math.min(band, 1); }
  }
  if (!notes.length) notes.push(`the declared checks pass; band 3 needs a person`);
  return { band, notes };
}

// ── Output ─────────────────────────────────────────────────────────────────

/** A model tag carries `:` and sometimes `/`; a date carries none. Both go in
 *  a filename, so the tag is flattened and the flattening is documented rather
 *  than discovered when a result file fails to write on Windows. */
const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";

/** The longest `only-<ids>` part spelled out in full. Past it the ids become a
 *  count and a hash: the file still says it is partial and which subset it is,
 *  and the name stays well inside every filesystem's limit. */
const ONLY_SPELLED_MAX = 80;

/** Where a run's two files go. A partial run (`only`) gets a name of its own.
 *  It used to share the full run's, so re-running one task to check a fix
 *  replaced the day's twenty-task scorecard with a one-row one — and a scorecard
 *  that quietly shrinks is worse than none, because it still reads as the day's
 *  result. The ids are sorted so that `--only a,b` and `--only b,a` are the same
 *  subset and the same file; running that subset again the same day replaces
 *  only its own file. */
function resultPaths({ engine, model, date, only = null, dir = RESULT_DIR }) {
  let stem = `${slug(engine)}-${slug(model)}-${date}`;
  if (only?.length) {
    const ids = [...new Set(only)].sort();
    const spelled = ids.map(slug).join("+");
    stem += spelled.length <= ONLY_SPELLED_MAX
      ? `.only-${spelled}`
      : `.only-${ids.length}-tasks-${crypto.createHash("sha1").update(ids.join("\n")).digest("hex").slice(0, 8)}`;
  }
  return { json: path.join(dir, `${stem}.json`), md: path.join(dir, `${stem}.md`) };
}

function summarise(rows) {
  const ran = rows.filter((r) => r.status === "ran");
  const scored = ran.filter((r) => typeof r.auto?.band === "number");
  return {
    total: rows.length,
    ran: ran.length,
    skipped: rows.filter((r) => r.status === "skipped").length,
    autoTotal: scored.reduce((n, r) => n + r.auto.band, 0),
    autoMax: scored.length * AUTO_CEILING,
  };
}

function scorecard({ engine, model, date, base, capability, rows, only = null }) {
  const s = summarise(rows);
  const L = [];
  L.push(`# Eval scorecard — ${engine} / ${model}`);
  L.push("");
  L.push(`- Run: ${date}`);
  // Said in the card as well as in the filename, because a card gets pasted and
  // forwarded without its filename, and its totals are then read as the day's.
  if (only?.length) L.push(`- Partial run: \`--only ${[...new Set(only)].sort().join(",")}\` — not the full set, so these totals are not the day's`);
  L.push(`- Server: ${base} (${capability.product}, v${capability.version || "unknown"})`);
  L.push(`- Tasks: ${s.total} · ran ${s.ran} · skipped ${s.skipped}`);
  L.push(`- Auto band total: **${s.autoTotal} / ${s.autoMax}** across the ${s.ran} that ran`);
  L.push("");
  L.push(`Auto bands stop at ${AUTO_CEILING} of 3 by design: bands 0-${AUTO_CEILING} follow from each`);
  L.push("task's declared checks, and band 3 is a person's judgement. Fill the **Score**");
  L.push("column in by hand against the rubric in the task file; that column, not the auto");
  L.push("band, is what feeds `verified` and `rank` in `models.json`.");
  L.push("");
  L.push("| Task | W | Status | Auto | Score | Tools called | Why |");
  L.push("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const tools = (r.toolCalls || []).map((c) => c.name).join(", ") || "—";
    const why = r.status === "skipped" ? r.reason : (r.auto?.notes || []).join("; ");
    // The Score cell is blank only where there is something to score. A skipped
    // task with an inviting underscore in it is how a scorecard acquires a made-up
    // number for a task that never ran.
    const band = r.status === "ran" ? String(r.auto.band) : "—";
    const score = r.status === "ran" ? "_" : "—";
    L.push(`| \`${r.id}\` | ${r.workload} | ${r.status} | ${band} | ${score} | ${tools} | ${cell(why)} |`);
  }
  L.push("");
  L.push("## Skipped, and what would un-skip it");
  const skipped = rows.filter((r) => r.status === "skipped");
  if (!skipped.length) L.push("Nothing skipped — every task had what it needed.");
  for (const r of skipped) L.push(`- \`${r.id}\` (${r.workload}) — ${r.reason}`);
  L.push("");
  L.push("## Answers");
  for (const r of rows.filter((x) => x.status === "ran")) {
    L.push("");
    L.push(`### \`${r.id}\` — ${r.title}`);
    L.push("");
    L.push(`Expected: ${r.expect.trim().replace(/\n+/g, " ")}`);
    L.push("");
    L.push("```");
    L.push((r.answer || "").trim() || "(nothing)");
    L.push("```");
  }
  return L.join("\n") + "\n";
}

/** Markdown tables break on a pipe and on a newline. Both turn up in a tool
 *  error message, which is exactly the cell a reader most wants intact. */
const cell = (s) => String(s || "—").replace(/\|/g, "\\|").replace(/\n+/g, " ");

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { base: null, engine: null, model: null, only: null, timeoutMs: 300000, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--base") out.base = next().replace(/\/$/, "");
    else if (a === "--engine") out.engine = next();
    else if (a === "--model") out.model = next();
    else if (a === "--only") out.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--timeout") out.timeoutMs = Math.max(1, parseInt(next(), 10)) * 1000;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const USAGE = `
REFUGIO eval set — twenty tasks, two per workload, through /api/chat/ask.

  node scripts/eval.cjs --engine ollama --model llama3.1:8b
  node scripts/eval.cjs --dry-run
  node scripts/eval.cjs --engine ollama --model qwen2.5:3b --only a1,d2

  --engine NAME   Engine label recorded in the scorecard (ollama, lmstudio, ...)
  --model TAG     Model to ask. Defaults to whatever the server is running.
  --base URL      Chat server. Defaults to REFUGIO_CHAT_BASE or http://127.0.0.1:8090
  --only IDS      Comma-separated task ids.
  --timeout SECS  Per task. Default 300.
  --dry-run       Validate the task set and print the plan. Touches no server.
`.trim();

async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`${e.message}\n\n${USAGE}`); return 2; }
  if (args.help) { console.log(USAGE); return 0; }

  let tasks;
  try { tasks = readTasks(); } catch (e) { console.error(`eval set is not loadable — ${e.message}`); return 1; }

  if (args.only) {
    const known = new Set(tasks.map((t) => t.id));
    const unknown = args.only.filter((id) => !known.has(id));
    if (unknown.length) { console.error(`unknown task id(s): ${unknown.join(", ")}`); return 2; }
    tasks = tasks.filter((t) => args.only.includes(t.id));
  }

  if (args.dryRun) {
    console.log(`${tasks.length} task(s) load and validate.`);
    for (const t of tasks) {
      const req = t.requires === "none" ? "no tools" : [
        ...(t.requires.tools || []),
        ...(t.requires.web ? ["web search armed"] : []),
      ].join(", ");
      console.log(`  ${t.workload}  ${t.id.padEnd(28)} ${req}`);
    }
    return 0;
  }

  const base = args.base || process.env.REFUGIO_CHAT_BASE || "http://127.0.0.1:8090";
  let capability;
  try { capability = await capabilities(base); }
  catch (e) { console.error(`cannot reach ${base} — ${e.message}\nIs REFUGIO running?`); return 1; }

  const refusal = refuseListener(capability);
  if (refusal) { console.error(refusal); return 1; }

  const model = args.model || capability.model;
  if (!model) { console.error(`${base} has no model available — nothing to evaluate.`); return 1; }
  const engine = args.engine || "ollama";
  const date = new Date().toISOString().slice(0, 10);

  console.log(`${engine} / ${model} via ${base} — ${tasks.length} task(s)`);
  const rows = [];
  for (const task of tasks) {
    const plan = planTask(task, capability);
    const common = { id: task.id, workload: task.workload, title: task.title, expect: task.expect };
    if (!plan.run) {
      console.log(`  skip  ${task.id.padEnd(28)} ${plan.reason}`);
      rows.push({ ...common, status: "skipped", reason: plan.reason, toolCalls: [] });
      continue;
    }
    const result = await runTask(base, task, { model, timeoutMs: args.timeoutMs });
    const auto = autoScore(task, result);
    console.log(`  ${String(auto.band)}/${AUTO_CEILING}   ${task.id.padEnd(28)} ${auto.notes.join("; ")}`);
    rows.push({
      ...common, status: "ran", auto,
      answer: result.answer, toolCalls: result.toolCalls, error: result.error || null,
      conversationId: result.conversationId || null, ms: result.ms,
    });
  }

  fs.mkdirSync(RESULT_DIR, { recursive: true });
  const only = args.only?.length ? [...new Set(args.only)].sort() : null;
  const out = resultPaths({ engine, model, date, only });
  fs.writeFileSync(out.json, JSON.stringify({
    engine, model, date, base,
    // null for a full run. Present so a file read without its name still says
    // which subset it is.
    only,
    server: { product: capability.product, edition: capability.edition, version: capability.version },
    capability: { tools: capability.tools, webEnabled: capability.webEnabled, models: capability.models },
    autoCeiling: AUTO_CEILING,
    summary: summarise(rows),
    tasks: rows,
  }, null, 2) + "\n");
  fs.writeFileSync(out.md, scorecard({ engine, model, date, base, capability, rows, only }));

  const s = summarise(rows);
  console.log(`\n${s.autoTotal}/${s.autoMax} auto across ${s.ran} task(s), ${s.skipped} skipped`);
  console.log(`→ ${path.relative(ROOT, out.json)}`);
  console.log(`→ ${path.relative(ROOT, out.md)}`);
  return 0;
}

module.exports = {
  parseYaml, YamlError, readTasks, validateTask, WORKLOADS, RUBRIC_BANDS,
  planTask, capabilities, refuseListener, runTask, readStream, sseEvents,
  autoScore, AUTO_CEILING, resultPaths, scorecard, summarise, parseArgs, slug, main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(e?.stack || String(e));
    process.exit(1);
  });
}
