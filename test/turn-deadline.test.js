// The ceiling on one chat turn. Two things are pinned: that the http.Server no
// longer hangs up on a long turn at Node's default five minutes, and that when
// REFUGIO's own ceiling is reached the window is told so in words, before the
// stream closes, instead of watching it stop.
//
// The second is tested against the real chat/server.js, spawned with a fake
// Ollama that starts an answer and never finishes it. A copy of the turn logic
// in this file would pass while the server went on closing silently.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_TURN_TIMEOUT_MS, turnTimeoutMs, configureServerTimeouts, armTurnDeadline, deadlineMessage,
} from "../chat/turn-deadline.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("the chat server's request timeout is off, not Node's 300000 ms default", () => {
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

/** A stand-in Ollama: a model list, and an /api/chat that sends one token and
 *  then holds the connection open, the way a model that will not stop does. */
function fakeOllama() {
  const held = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ models: [{ name: "fake:1b" }] }));
    }
    if (req.url === "/api/chat") {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(JSON.stringify({ message: { role: "assistant", content: "Still thinking" } }) + "\n");
      held.add(res);
      res.on("close", () => held.delete(res));
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

async function waitForServer(base, child, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`chat server exited with ${child.exitCode}`);
    try { await fetch(`${base}/api/chat/status`, { signal: AbortSignal.timeout(500) }); return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("chat server did not start");
}

// Loaded into the spawned server before chat/server.js runs. It reports the
// value on the server object at the moment that server starts listening, so
// the pin is on the http.Server the chat window actually talks to — the helper
// test above passes just as well if server.js forgets to call the helper.
const REPORT_TIMEOUT = "data:text/javascript," + encodeURIComponent(
  'import http from "node:http";' +
  "const listen = http.Server.prototype.listen;" +
  "http.Server.prototype.listen = function (...a) {" +
  '  process.stdout.write(`requestTimeout=${this.requestTimeout}\\n`);' +
  "  return listen.apply(this, a);" +
  "};"
);

const chat = { base: null, output: "" };
let stopChat = () => {};

before(async () => {
  const ollama = await fakeOllama();
  const dataDir = mkdtempSync(join(tmpdir(), "refugio-deadline-"));
  const port = await freePort();
  const child = spawn(process.execPath, [
    "--import", REPORT_TIMEOUT, join(ROOT, "chat", "server.js"), "--port", String(port),
  ], {
    env: {
      ...process.env,
      OLLAMA_BASE_URL: ollama.base,
      REFUGIO_DATA_DIR: dataDir,
      REFUGIO_ENV_FILE: join(dataDir, "refugio.env"),
      REFUGIO_MCPO_CONFIG: join(dataDir, "no-mcp.json"),
      REFUGIO_TOOLS: "0",
      REFUGIO_TURN_TIMEOUT_MS: "400",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => { chat.output += b; });
  child.stderr.on("data", (b) => { chat.output += b; });
  stopChat = () => { child.kill("SIGTERM"); ollama.close(); rmSync(dataDir, { recursive: true, force: true }); };

  chat.base = `http://127.0.0.1:${port}`;
  await waitForServer(chat.base, child);
});

after(() => stopChat());

test("the running chat server's http.Server has no request timeout", () => {
  const reported = [...chat.output.matchAll(/^requestTimeout=(\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(reported, [0], chat.output);
});

test("a turn that reaches the ceiling ends with an error event, not a silent close", async () => {
  const { base, output } = chat;
  const res = await fetch(`${base}/api/chat/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Find the bug", model: "fake:1b" }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(res.status, 200, output);
  const body = await res.text();

  const events = [...body.matchAll(/^event: (\w+)\ndata: (.*)$/gm)].map(([, event, data]) => ({ event, data: JSON.parse(data) }));
  const names = events.map((e) => e.event);
  assert.deepEqual(names.filter((n) => n !== "token"), ["start", "error"], body);
  assert.equal(names.at(-1), "error", "the error is the last thing on the stream");
  assert.equal(events.at(-1).data.error, deadlineMessage(400));
});
