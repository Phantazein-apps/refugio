// The pi-ai path through chat/engine.js (REFUGIO_ENGINE_LIB=pi), against a fake
// Ollama that speaks only the OpenAI-compatible /v1 API — the one pi-ai uses.
//
// Three things are pinned. The translation from the turn runner's Ollama-shaped
// messages; the stream, as the runner sees it (tokens, thinking, tool calls,
// usage, aborts); and the real chat/server.js on that path, because a mode that
// strips every tool and a ceiling that stops a turn are enforced in the server,
// and a copy of either here would pass while the server did something else.
//
// The native path is unchanged and is what every other test exercises.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// pi-ai is a real dependency of this path, not a stand-in. Where it is not
// installed (CI runs the unit tests without `npm install`) the whole file is
// skipped rather than failed: the native path does not need it.
let piInstalled = true;
try { await import("@earendil-works/pi-ai"); } catch { piInstalled = false; }

/** One SSE frame in the shape OpenAI-compatible servers send. */
const frame = (delta, extra = {}) =>
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m",
    choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
const finish = (reason, usage) =>
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m",
    choices: [{ index: 0, delta: {}, finish_reason: reason }], usage })}\n\ndata: [DONE]\n\n`;

/**
 * A fake Ollama /v1. The model name picks the script:
 *   talker   — thinks twice, says "Hello there", 200 prompt tokens of which 150 cached
 *   caller   — asks for reminders__list({list:"today"}), then answers once it has a result
 *   longwind — stops for length
 *   staller  — starts an answer and never finishes it
 * Every request body is kept, so a test can say what was sent.
 */
function fakeOllamaV1() {
  const bodies = [];
  const held = new Set();
  let closedEarly = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ models: [{ name: "talker" }, { name: "staller" }] }));
    }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404); return res.end(); }
    let raw = "";
    req.on("data", (b) => { raw += b; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      held.add(res);
      res.on("close", () => { held.delete(res); if (!res.writableEnded) closedEarly++; });
      const usage = { prompt_tokens: 200, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 150 } };

      if (body.model === "talker") {
        res.write(frame({ role: "assistant", reasoning_content: "hmm " }));
        res.write(frame({ reasoning_content: "ok " }));
        res.write(frame({ content: "Hello" }));
        res.write(frame({ content: " there" }));
        return res.end(finish("stop", usage));
      }
      if (body.model === "caller") {
        const answered = body.messages.some((m) => m.role === "tool");
        if (answered) {
          res.write(frame({ role: "assistant", content: "You have one." }));
          return res.end(finish("stop", usage));
        }
        res.write(frame({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function",
          function: { name: "reminders__list", arguments: "" } }] }));
        res.write(frame({ tool_calls: [{ index: 0, function: { arguments: '{"list":' } }] }));
        res.write(frame({ tool_calls: [{ index: 0, function: { arguments: '"today"}' } }] }));
        return res.end(finish("tool_calls", usage));
      }
      if (body.model === "longwind") {
        res.write(frame({ role: "assistant", content: "and then" }));
        return res.end(finish("length", usage));
      }
      // staller
      res.write(frame({ role: "assistant", content: "Still thinking" }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    bodies,
    closedEarly: () => closedEarly,
    close: () => { for (const r of held) r.destroy(); server.close(); },
  })));
}

const REMINDERS = { type: "function", function: {
  name: "reminders__list", description: "List reminders",
  parameters: { type: "object", properties: { list: { type: "string" } } } } };

describe("engine.js on the pi-ai path", { skip: !piInstalled && "@earendil-works/pi-ai is not installed" }, () => {
  let fake;
  let engine;

  before(async () => {
    fake = await fakeOllamaV1();
    // Read once, at import, by chat/ollama.js — so set before the first import.
    process.env.OLLAMA_BASE_URL = fake.base;
    process.env.REFUGIO_ENGINE_LIB = "pi";
    engine = await import("../chat/engine.js");
  });
  after(() => { fake.close(); delete process.env.REFUGIO_ENGINE_LIB; });

  test("tool calls and their results are paired by position, and tools keep their schema", () => {
    const ctx = engine.toContext([
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [
        { function: { name: "x__one", arguments: { a: 1 } } },
        { function: { name: "x__two", arguments: {} } },
      ] },
      { role: "tool", tool_name: "x__one", content: "first" },
      { role: "tool", tool_name: "x__two", content: "Error: second" },
    ], [REMINDERS], { api: "openai-completions", provider: "ollama", id: "m" });

    assert.equal(ctx.systemPrompt, "A\n\nB");
    const [, asst, r1, r2] = ctx.messages;
    const ids = asst.content.filter((b) => b.type === "toolCall").map((b) => b.id);
    assert.deepEqual([r1.toolCallId, r2.toolCallId], ids);
    assert.equal(r1.isError, false);
    assert.equal(r2.isError, true, "REFUGIO marks a failed tool by its text");
    assert.deepEqual(ctx.tools, [{ name: "reminders__list", description: "List reminders",
      parameters: REMINDERS.function.parameters }]);
  });

  test("tokens and thinking stream separately, and the prompt count includes the cached part", async () => {
    const tokens = [];
    const thoughts = [];
    const out = await engine.chatStream({ model: "talker", messages: [{ role: "user", content: "hi" }], tools: [] },
      (t) => tokens.push(t), (t) => thoughts.push(t));
    assert.equal(out.text, "Hello there");
    assert.deepEqual(tokens, ["Hello", " there"]);
    assert.equal(thoughts.join(""), "hmm ok ", "reasoning is reported, and not as text");
    assert.deepEqual(out.toolCalls, []);
    assert.deepEqual(out.usage, { promptTokens: 200, evalTokens: 7, doneReason: "stop" });
  });

  test("no tools offered means no tools sent — what a coaching mode relies on", async () => {
    const before = fake.bodies.length;
    await engine.chatStream({ model: "talker", messages: [{ role: "user", content: "hi" }], tools: [] }, () => {});
    const sent = fake.bodies[before];
    assert.ok(!sent.tools || sent.tools.length === 0, JSON.stringify(sent.tools));
  });

  test("a streamed tool call arrives whole, and a second round carries its result", async () => {
    const messages = [{ role: "user", content: "reminders?" }];
    const first = await engine.chatStream({ model: "caller", messages, tools: [REMINDERS] }, () => {});
    assert.deepEqual(first.toolCalls, [{ name: "reminders__list", args: { list: "today" } }]);
    assert.equal(first.usage.doneReason, "stop", "a tool round reads as Ollama's 'stop' in the log");

    messages.push({ role: "assistant", content: "", tool_calls: first.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) });
    messages.push({ role: "tool", tool_name: "reminders__list", content: "- dentist" });
    const second = await engine.chatStream({ model: "caller", messages, tools: [REMINDERS] }, () => {});
    assert.equal(second.text, "You have one.");

    const sent = fake.bodies.at(-1).messages;
    const call = sent.find((m) => m.role === "assistant")?.tool_calls?.[0];
    const result = sent.find((m) => m.role === "tool");
    assert.equal(result.tool_call_id, call.id, "the result answers the call that asked for it");
  });

  test("running out of room says 'length', the one stop the eval looks for", async () => {
    const out = await engine.chatStream({ model: "longwind", messages: [{ role: "user", content: "go" }], tools: [] }, () => {});
    assert.equal(out.usage.doneReason, "length");
  });

  test("an abort ends the stream with an error and hangs up on Ollama", async () => {
    const ac = new AbortController();
    const closedBefore = fake.closedEarly();
    const run = engine.chatStream({ model: "staller", messages: [{ role: "user", content: "go" }], tools: [], signal: ac.signal },
      () => ac.abort());
    await assert.rejects(run, (e) => e.name === "AbortError");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fake.closedEarly(), closedBefore + 1, "the upstream request was closed, not left generating");
  });

  test("a cloud model name is recognised, and an unknown one is refused by name", async () => {
    assert.equal(engine.isCloudModel("anthropic/claude-haiku-4-5"), true);
    assert.equal(engine.isCloudModel("qwen3:4b"), false);
    await assert.rejects(engine.chatStream({ model: "anthropic/no-such-model", messages: [], tools: [] }, () => {}),
      /Unknown model anthropic\/no-such-model/);
  });
});

// ── The real server on the pi-ai path ───────────────────────

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitForServer(base, child, output, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`chat server exited with ${child.exitCode}:\n${output()}`);
    try { await fetch(`${base}/api/chat/status`, { signal: AbortSignal.timeout(500) }); return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`chat server did not start:\n${output()}`);
}

function parseEvents(body) {
  return [...body.matchAll(/^event: (\w+)\ndata: (.*)$/gm)].map(([, event, data]) => ({ event, data: JSON.parse(data) }));
}

async function ask(base, payload, ms = 10000) {
  const res = await fetch(`${base}/api/chat/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(ms),
  });
  return { status: res.status, body: await res.text() };
}

describe("the chat server, spawned on the pi-ai path", { skip: !piInstalled && "@earendil-works/pi-ai is not installed" }, () => {
  const chat = { base: null, output: "" };
  let fake;
  let stop = () => {};
  let modeId = null;

  before(async () => {
    fake = await fakeOllamaV1();
    const dataDir = mkdtempSync(join(tmpdir(), "refugio-engine-"));
    const port = await freePort();
    const child = spawn(process.execPath, [join(ROOT, "chat", "server.js"), "--port", String(port)], {
      env: {
        ...process.env,
        REFUGIO_ENGINE_LIB: "pi",
        OLLAMA_BASE_URL: fake.base,
        // The coaching modes ship in the listener edition; the standard one
        // offers only the WhatsApp mode, which needs a connector.
        REFUGIO_EDITION: "listener",
        REFUGIO_DATA_DIR: dataDir,
        REFUGIO_ENV_FILE: join(dataDir, "refugio.env"),
        REFUGIO_MCPO_CONFIG: join(dataDir, "no-mcp.json"),
        REFUGIO_TOOLS: "0",
        REFUGIO_TURN_TIMEOUT_MS: "1500",
        REFUGIO_HEARTBEAT_MS: "100",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b) => { chat.output += b; });
    child.stderr.on("data", (b) => { chat.output += b; });
    stop = () => { child.kill("SIGTERM"); fake.close(); rmSync(dataDir, { recursive: true, force: true }); };
    chat.base = `http://127.0.0.1:${port}`;
    await waitForServer(chat.base, child, () => chat.output);

    // Whichever coaching mode the listener edition offers that needs no connector.
    const { modeDef, modeOffered } = await import("../chat/modes.js");
    for (const id of ["nvc", "styles", "career", "life", "listener", "spanish"]) {
      if (!modeOffered(id, "listener") || modeDef(id)?.requiresConnector) continue;
      const r = await fetch(`${chat.base}/api/chat/modes`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: id, enabled: true }),
      });
      if (r.ok) { modeId = id; break; }
    }
  });

  after(() => stop());

  test("a plain turn streams through pi-ai and is stored", async () => {
    const { status, body } = await ask(chat.base, { message: "hi", model: "talker" });
    assert.equal(status, 200, chat.output);
    const events = parseEvents(body);
    const text = events.filter((e) => e.event === "token").map((e) => e.data.t).join("");
    assert.equal(text, "Hello there", body);
    assert.ok(events.some((e) => e.event === "thinking"), "reasoning shows as thinking, as on the native path");
    assert.equal(events.find((e) => e.event === "usage")?.data.promptTokens, 200);
    assert.doesNotMatch(body, /hmm/, "the reasoning itself never reaches the stream");
  });

  test("a turn in a discussion mode sends the mode's prompt and no tools", async (t) => {
    if (!modeId) return t.skip("no coaching mode is offered in this edition");
    const before = fake.bodies.length;
    const { status, body } = await ask(chat.base, { message: "I am upset with my sister", model: "talker", mode: modeId, web: true });
    assert.equal(status, 200, body);
    const sent = fake.bodies[before];
    assert.ok(!sent.tools || sent.tools.length === 0, `mode ${modeId} was offered tools: ${JSON.stringify(sent.tools)}`);
    const system = sent.messages.find((m) => m.role === "system")?.content ?? "";
    const plain = fake.bodies.find((b) => b.messages.every((m) => !String(m.content).includes("upset")));
    assert.notEqual(system, plain?.messages.find((m) => m.role === "system")?.content, "the mode added its preamble");
  });

  test("a turn that reaches the ceiling ends with the deadline error and hangs up on Ollama", async () => {
    const closedBefore = fake.closedEarly();
    const { status, body } = await ask(chat.base, { message: "go", model: "staller" });
    assert.equal(status, 200, chat.output);
    const names = parseEvents(body).map((e) => e.event).filter((n) => n !== "token");
    assert.deepEqual(names, ["start", "error"], body);
    assert.match(parseEvents(body).at(-1).data.error, /2 seconds|1\.5 seconds|seconds/);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fake.closedEarly(), closedBefore + 1, "the stalled upstream request was closed");
  });

  test("closing the tab mid-answer hangs up on Ollama", async () => {
    const closedBefore = fake.closedEarly();
    const ac = new AbortController();
    const res = await fetch(`${chat.base}/api/chat/ask`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "go", model: "staller" }), signal: ac.signal,
    });
    const reader = res.body.getReader();
    await reader.read();               // the turn has started
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fake.closedEarly(), closedBefore + 1, "the upstream request was closed with the tab");
  });
});
