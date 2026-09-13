// The ceiling on one chat turn. Two things are pinned: that the http.Server no
// longer hangs up on a long turn at Node's default five minutes, and that when
// REFUGIO's own ceiling is reached the window is told so in words, before the
// stream closes, instead of watching it stop.
//
// Both are tested against the real chat/server.js, spawned with a fake Ollama
// that starts an answer and never finishes it. A copy of the turn logic in this
// file would pass while the server went on closing silently.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";
import {
  DEFAULT_TURN_TIMEOUT_MS, turnTimeoutMs, configureServerTimeouts, armTurnDeadline, deadlineMessage,
  DEFAULT_HEARTBEAT_MS, HEARTBEAT, heartbeatMs, armHeartbeat, thoughtWithoutAnswerMessage,
} from "../chat/turn-deadline.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("configureServerTimeouts takes Node's 300000 ms request timeout off a server", () => {
  const server = http.createServer();
  assert.equal(server.requestTimeout, 300000, "if Node's default moved, re-read why this exists");
  configureServerTimeouts(server);
  assert.equal(server.requestTimeout, 0);
});

test("the turn ceiling defaults to thirty minutes and REFUGIO_TURN_TIMEOUT_MS overrides it", () => {
  assert.equal(DEFAULT_TURN_TIMEOUT_MS, 1800000);
  assert.equal(turnTimeoutMs({}), 1800000);
  assert.equal(turnTimeoutMs({ REFUGIO_TURN_TIMEOUT_MS: "600000" }), 600000);
  assert.equal(turnTimeoutMs({ REFUGIO_TURN_TIMEOUT_MS: "0" }), 0);
});

test("a malformed ceiling falls back to the default rather than to no ceiling", () => {
  for (const bad of ["", "  ", "ten minutes", "-1", "NaN"]) {
    assert.equal(turnTimeoutMs({ REFUGIO_TURN_TIMEOUT_MS: bad }), DEFAULT_TURN_TIMEOUT_MS, bad);
  }
});

test("an expired deadline aborts the turn and says so; a cleared one does neither", async () => {
  const fired = new AbortController();
  const d1 = armTurnDeadline(fired, 10);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fired.signal.aborted, true);
  assert.equal(d1.expired, true);

  const cleared = new AbortController();
  const d2 = armTurnDeadline(cleared, 10);
  d2.clear();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(cleared.signal.aborted, false);
  assert.equal(d2.expired, false);

  // 0 is "no ceiling", not "expire immediately".
  const none = new AbortController();
  armTurnDeadline(none, 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(none.signal.aborted, false);
});

test("the message names the limit in words a person reads", () => {
  assert.match(deadlineMessage(1800000), /30 minutes/);
  assert.match(deadlineMessage(60000), /1 minute\b/);
  assert.match(deadlineMessage(5000), /5 seconds/);
  assert.doesNotMatch(deadlineMessage(1800000), /REFUGIO_TURN_TIMEOUT_MS/);
});

test("the heartbeat defaults to fifteen seconds and REFUGIO_HEARTBEAT_MS overrides it", () => {
  assert.equal(DEFAULT_HEARTBEAT_MS, 15000);
  assert.ok(DEFAULT_HEARTBEAT_MS < 300000 / 4, "well inside undici's 300 s body timeout");
  assert.equal(heartbeatMs({}), 15000);
  assert.equal(heartbeatMs({ REFUGIO_HEARTBEAT_MS: "250" }), 250);
  assert.equal(heartbeatMs({ REFUGIO_HEARTBEAT_MS: "0" }), 0);
  for (const bad of ["", "soon", "-5"]) assert.equal(heartbeatMs({ REFUGIO_HEARTBEAT_MS: bad }), 15000, bad);
  // A comment line: no `event:`, no `data:`, so every SSE reader skips it.
  assert.match(HEARTBEAT, /^:[^\n]*\n\n$/);
});

/** Enough of a ServerResponse to count writes and be closed. */
function fakeResponse() {
  const res = new EventEmitter();
  res.writes = [];
  res.writableEnded = false;
  res.destroyed = false;
  res.write = (s) => { res.writes.push(s); return true; };
  return res;
}

test("the heartbeat writes on its interval and stops when the response closes", async () => {
  const res = fakeResponse();
  armHeartbeat(res, 10);
  await new Promise((r) => setTimeout(r, 55));
  const beforeClose = res.writes.length;
  assert.ok(beforeClose >= 3, `wrote ${beforeClose}`);
  assert.ok(res.writes.every((w) => w === HEARTBEAT));

  // The tab goes away while the turn is still awaiting something. Nothing may
  // be written after that, and the close listener goes with the timer.
  res.destroyed = true;
  res.emit("close");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(res.writes.length, beforeClose);
  assert.equal(res.listenerCount("close"), 0);
});

test("a cleared heartbeat writes nothing more, and 0 never arms one", async () => {
  const res = fakeResponse();
  const hb = armHeartbeat(res, 10);
  hb.clear();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(res.writes.length, 0);
  assert.equal(res.listenerCount("close"), 0);

  const off = fakeResponse();
  armHeartbeat(off, 0).clear();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(off.writes.length, 0);
  assert.equal(off.listenerCount("close"), 0);
});

test("thinking without an answer is explained, with the count", () => {
  const msg = thoughtWithoutAnswerMessage(3411);
  assert.match(msg, /3,411 tokens/);
  assert.match(msg, /before it wrote an answer/);
  assert.doesNotMatch(msg, /REFUGIO_/);
});

const THINK_MS = 700;

/** A stand-in Ollama: a model list, and an /api/chat that does one of two
 *  things by model. `fake:1b` sends one token and then holds the connection
 *  open, the way a model that will not stop does. `thinker:4b` streams only
 *  `thinking` for THINK_MS and then finishes with no content, the way qwen3:4b
 *  did on an 8 GB machine. */
function fakeOllama() {
  const held = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ models: [{ name: "fake:1b" }, { name: "thinker:4b" }] }));
    }
    if (req.url === "/api/chat") {
      let raw = "";
      req.on("data", (b) => { raw += b; });
      req.on("end", () => {
        const { model } = JSON.parse(raw);
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        held.add(res);
        res.on("close", () => held.delete(res));
        if (model !== "thinker:4b") {
          res.write(JSON.stringify({ message: { role: "assistant", content: "Still thinking" } }) + "\n");
          return;
        }
        const until = Date.now() + THINK_MS;
        const tick = setInterval(() => {
          if (res.destroyed) return clearInterval(tick);
          if (Date.now() < until) {
            res.write(JSON.stringify({ message: { role: "assistant", content: "", thinking: "hmm " } }) + "\n");
            return;
          }
          clearInterval(tick);
          res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n");
        }, 20);
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => { for (const r of held) r.destroy(); server.close(); },
  })));
}

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

// CI runs these tests without `npm install` — the unit tests are meant to need
// nothing — and server.js imports chat/mcp.js, which imports the MCP SDK. The
// spawned server runs with REFUGIO_TOOLS=0, so the SDK is loaded but never
// used; when it is not installed, the import resolves to an empty stand-in
// instead of failing. Where it is installed, the real package loads.
//
// This is a workaround, not the design. ci.yml asks for a seam instead: once
// chat/mcp.js loads the SDK only when a connector starts, the server boots
// without it and SDK_STUB, RESOLVE_HOOKS and the register() call below go.
// https://github.com/Phantazein-apps/refugio/issues/38
const SDK_STUB = "data:text/javascript," + encodeURIComponent(
  "export class Client {} export class StdioClientTransport {}"
);
const RESOLVE_HOOKS = "data:text/javascript," + encodeURIComponent(
  "export async function resolve(specifier, context, next) {" +
  "  try { return await next(specifier, context); } catch (e) {" +
  '    if (e?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith("@modelcontextprotocol/sdk/")) throw e;' +
  `    return { url: ${JSON.stringify(SDK_STUB)}, shortCircuit: true };` +
  "  }" +
  "}"
);

// Loaded into the spawned server before chat/server.js runs. Besides the hook
// above, it reports the value on the server object at the moment that server
// starts listening, so the pin is on the http.Server the chat window actually
// talks to — the helper test above passes just as well if server.js forgets to
// call the helper.
const PRELOAD = "data:text/javascript," + encodeURIComponent(
  'import http from "node:http";' +
  'import { register } from "node:module";' +
  `register(${JSON.stringify(RESOLVE_HOOKS)});` +
  "const listen = http.Server.prototype.listen;" +
  "http.Server.prototype.listen = function (...a) {" +
  '  process.stdout.write(`requestTimeout=${this.requestTimeout}\\n`);' +
  "  return listen.apply(this, a);" +
  "};"
);

// Scoped to its own block so that a server which will not start fails these
// two tests, and not the ones above that never needed it.
describe("the chat server, spawned", () => {
  const chat = { base: null, output: "" };
  let stopChat = () => {};

  before(async () => {
    const ollama = await fakeOllama();
    const dataDir = mkdtempSync(join(tmpdir(), "refugio-deadline-"));
    const port = await freePort();
    const child = spawn(process.execPath, [
      "--import", PRELOAD, join(ROOT, "chat", "server.js"), "--port", String(port),
    ], {
      env: {
        ...process.env,
        OLLAMA_BASE_URL: ollama.base,
        REFUGIO_DATA_DIR: dataDir,
        REFUGIO_ENV_FILE: join(dataDir, "refugio.env"),
        REFUGIO_MCPO_CONFIG: join(dataDir, "no-mcp.json"),
        REFUGIO_TOOLS: "0",
        // Longer than the thinker takes, so that turn ends on its own.
        REFUGIO_TURN_TIMEOUT_MS: "1500",
        REFUGIO_HEARTBEAT_MS: "100",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b) => { chat.output += b; });
    child.stderr.on("data", (b) => { chat.output += b; });
    stopChat = () => { child.kill("SIGTERM"); ollama.close(); rmSync(dataDir, { recursive: true, force: true }); };

    chat.base = `http://127.0.0.1:${port}`;
    await waitForServer(chat.base, child, () => chat.output);
  });

  after(() => stopChat());

  test("its http.Server has no request timeout", () => {
    const reported = [...chat.output.matchAll(/^requestTimeout=(\d+)$/gm)].map((m) => Number(m[1]));
    assert.deepEqual(reported, [0], chat.output);
  });

  test("a turn that reaches the ceiling ends with an error event, not a silent close", async () => {
    const res = await fetch(`${chat.base}/api/chat/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Find the bug", model: "fake:1b" }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(res.status, 200, chat.output);
    const body = await res.text();

    const events = parseEvents(body);
    const names = events.map((e) => e.event);
    assert.deepEqual(names.filter((n) => n !== "token"), ["start", "error"], body);
    assert.equal(names.at(-1), "error", "the error is the last thing on the stream");
    assert.equal(events.at(-1).data.error, deadlineMessage(1500));
  });

  test("a turn that only thinks keeps its connection alive and ends with a reason", async () => {
    // A client with an idle timer shorter than the thinker's silence, which is
    // what undici's 300 s body timeout was to the eval runner. The first
    // `thinking` event is sent at once and the next is not due for a second, so
    // for the rest of THINK_MS the only bytes on the wire are heartbeats. Without
    // them this request times out.
    const IDLE_MS = 300;
    const { body, gaps } = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ message: "Find the bug", model: "thinker:4b" });
      const req = http.request(`${chat.base}/api/chat/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      }, (res) => {
        let text = "";
        let last = Date.now();
        const gaps = [];
        res.setEncoding("utf8");
        res.on("data", (s) => { const now = Date.now(); gaps.push(now - last); last = now; text += s; });
        res.on("end", () => resolve({ body: text, gaps }));
        res.on("error", reject);
      });
      req.setTimeout(IDLE_MS, () => req.destroy(new Error(`idle for ${IDLE_MS} ms: the stream went quiet`)));
      req.on("error", reject);
      req.end(payload);
    });

    const beats = body.split("\n\n").filter((f) => f === ": keep-alive").length;
    assert.ok(beats >= 3, `expected heartbeats across ${THINK_MS} ms, saw ${beats}:\n${body}`);
    assert.ok(Math.max(...gaps) < IDLE_MS, `longest silence ${Math.max(...gaps)} ms`);

    const events = parseEvents(body);
    assert.deepEqual(events.map((e) => e.event), ["start", "thinking", "error"], body);
    assert.equal(events[1].data.tokens, 1);
    assert.match(events[2].data.error, /spent this turn thinking/);
    assert.doesNotMatch(body, /hmm/, "the reasoning itself never reaches the stream");

    // And nothing was stored as an answer.
    const cid = events[0].data.conversation_id;
    const convo = await (await fetch(`${chat.base}/api/chat/conversations/${cid}`)).json();
    assert.deepEqual(convo.messages.map((m) => m.role), ["user"], JSON.stringify(convo));
  });
});

function parseEvents(body) {
  return [...body.matchAll(/^event: (\w+)\ndata: (.*)$/gm)].map(([, event, data]) => ({ event, data: JSON.parse(data) }));
}
