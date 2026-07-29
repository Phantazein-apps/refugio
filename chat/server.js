#!/usr/bin/env node
// REFUGIO chat server — the local chat UI, served by Node.
//
// Replaces Open WebUI on the default path. OWUI needs `uv` + a Python venv and
// loads PyTorch (~1-1.5 GB) just to boot; when `uv` is missing the installer
// silently skips it and REFUGIO starts with no interface at all. This serves an
// equivalent single-user chat window with zero extra dependencies.
//
// Usage: node chat/server.js [--port 8090]
// Env:   REFUGIO_CHAT_PORT, REFUGIO_CHAT_MODEL, OLLAMA_BASE_URL, REFUGIO_DATA_DIR

import http from "http";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, extname, normalize } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { homedir } from "os";

import * as store from "./store.js";
import { McpPool } from "./mcp.js";
import { listModels, isUp, chatStream, complete, OLLAMA_BASE } from "./ollama.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, "static");

const argPort = (() => {
  const i = process.argv.indexOf("--port");
  return i > -1 ? parseInt(process.argv[i + 1], 10) : null;
})();
const PORT = argPort || parseInt(process.env.REFUGIO_CHAT_PORT || "8090", 10);

const DATA_DIR = process.env.REFUGIO_DATA_DIR || join(homedir(), ".refugio-data");
const DB_PATH = join(DATA_DIR, "chat.db");

const SYSTEM_PROMPT =
  process.env.REFUGIO_SYSTEM_PROMPT ||
  "You are REFUGIO, a helpful assistant running entirely on the user's own computer. " +
  "Be concise and direct. If you don't know something, say so.";

/** Tell the model, in prose, that it has tools.
 *
 *  Handing a model a `tools` array is not the same as telling it to use them.
 *  Asked to "summarize my WhatsApp messages", a small model will happily reply
 *  "please paste your messages" — it pattern-matches the request as needing
 *  information it lacks rather than as a tool call. Naming the connectors and
 *  forbidding the ask-the-user escape hatch is what closes that gap; larger
 *  models don't need it, and it costs them nothing. */
function toolPreamble(tools) {
  if (!tools.length) return "";
  const servers = [...new Set(tools.map((t) => t.function.name.split("__")[0]))];
  return "\n\nYou have tools that read the user's own data on this machine" +
    ` (${servers.join(", ")}). When a question is about that data, call the` +
    " relevant tool instead of answering from memory. Never ask the user to" +
    " paste in data you can fetch yourself — call the tool and use the result.";
}

const log = (m) => console.log(`[chat] ${m}`);

// Tool capability comes from the same ladder the installer and supervisor use,
// so the UI can't disagree with them about what the running model can do.
// Loaded lazily and tolerantly: the chat UI must still start if scripts/ is
// missing (a bare checkout, a future split of this directory).
let _memFit;
function modelSupportsTools(tag) {
  if (!tag) return null;
  if (_memFit === undefined) {
    try {
      _memFit = createRequire(import.meta.url)(join(dirname(__dirname), "scripts", "mem-fit.cjs"));
    } catch { _memFit = null; }
  }
  // Bare tag ("qwen2.5:3b") vs. an Ollama name that may carry a digest suffix.
  return _memFit ? _memFit.supportsTools(tag.split("@")[0]) : null;
}

// Tool limits. A large tool surface degrades model accuracy — they pick wrong
// or loop — so the count is capped and the agentic loop is bounded. Both are
// overridable.
//
// 24 was too low to be safe. A stock install is Hermeneia (18) + reminders (7)
// + Things (10) = 35, and capping there cut half of WhatsApp — including
// list_chats, which "summarise my chats" needs. Losing the tool the user is
// asking for is worse than offering a few too many, and the cap now falls
// evenly across servers rather than truncating whichever connected last.
const TOOL_LIMIT = parseInt(process.env.REFUGIO_TOOL_LIMIT || "40", 10);
const MAX_TOOL_ROUNDS = parseInt(process.env.REFUGIO_MAX_TOOL_ROUNDS || "5", 10);
const MCP_CONFIG = process.env.REFUGIO_MCPO_CONFIG ||
  join(dirname(__dirname), "mcpo-config.json");

/** @type {McpPool|null} */
let mcp = null;
// False until the first connect sweep finishes. Distinguishes "nothing is
// configured" from "we haven't looked yet" — the difference between telling
// someone to re-run the installer and telling them to wait five seconds.
let connectorsSettled = false;

// Human-facing names for the server ids in mcpo-config.json. Anything not
// listed falls back to its id capitalised, so a new connector reads correctly
// without a code change here.
const CONNECTOR_LABELS = {
  whatsapp: "WhatsApp", email: "Email", reminders: "Apple Reminders",
  things: "Things 3", notion: "Notion", memory: "Memory",
};
const labelFor = (id) => CONNECTOR_LABELS[id] || id.charAt(0).toUpperCase() + id.slice(1);

// describe() calls list_accounts on every connector, far too heavy for a 15s
// status poll. Cached briefly; opening the panel forces a refresh.
let connectorCache = { at: 0, rows: [] };
const CONNECTOR_TTL = 30_000;

async function connectorRows({ force = false } = {}) {
  if (!mcp) return [];
  if (!force && Date.now() - connectorCache.at < CONNECTOR_TTL) return connectorCache.rows;
  const rows = (await mcp.describe()).map((r) => ({ ...r, label: labelFor(r.id) }));
  // Don't let an incomplete answer harden into a 30s lie. A connector still
  // booting can't list its accounts yet, which undercounts — cache that only
  // briefly so the number corrects itself instead of sitting wrong.
  const settled = !rows.some((r) => r.accountsUnknown || r.state === "connecting");
  connectorCache = { at: settled ? Date.now() : Date.now() - (CONNECTOR_TTL - 3000), rows };
  return rows;
}

/** How many connectors a person would say they have.
 *
 *  Multi-account connectors count once per account — two WhatsApp numbers are
 *  two things to think about, not one. Failures are counted separately rather
 *  than folded in: a healthy-looking total while WhatsApp was silently down is
 *  the exact reassuring-but-wrong signal that hid a real outage. */
function countConnectors(rows) {
  let ready = 0, failed = 0, connecting = 0;
  for (const r of rows) {
    if (r.state === "connecting") { connecting++; continue; }
    if (!r.ok) { failed++; continue; }
    ready += Math.max(1, r.accounts.length);
  }
  return { ready, failed, connecting };
}

// Model selection: explicit override, else whatever Ollama has (first entry).
let cachedModel = process.env.REFUGIO_CHAT_MODEL || null;
async function resolveModel() {
  if (process.env.REFUGIO_CHAT_MODEL) return process.env.REFUGIO_CHAT_MODEL;
  const models = await listModels();
  if (models.length) cachedModel = models[0].name;
  return cachedModel;
}

// ── HTTP helpers ────────────────────────────────────────────

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

async function serveStatic(res, urlPath) {
  // normalize + prefix check keeps `..` from escaping STATIC_DIR.
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const full = normalize(join(STATIC_DIR, rel));
  if (!full.startsWith(STATIC_DIR) || !existsSync(full)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const body = await readFile(full);
  res.writeHead(200, {
    "Content-Type": MIME[extname(full)] || "application/octet-stream",
    "Content-Length": body.length,
  });
  res.end(body);
}

// ── Turn runner ─────────────────────────────────────────────

/** Ask the model for a short conversation title. Best-effort — a failure here
 *  must never break the turn the user actually asked for. */
async function maybeTitle(convoId, firstMessage, model) {
  if (store.getTitle(convoId)) return null;
  let title = firstMessage.slice(0, 60);
  try {
    const out = await complete({
      model,
      messages: [
        { role: "system", content: "Reply with a 3-6 word title for this conversation. No quotes, no punctuation at the end." },
        { role: "user", content: firstMessage.slice(0, 500) },
      ],
      signal: AbortSignal.timeout(20000),
    });
    const cleaned = out.trim().replace(/^["']|["']$/g, "").split("\n")[0];
    if (cleaned) title = cleaned.slice(0, 80);
  } catch { /* fall back to the truncated message */ }
  store.setTitle(convoId, title);
  return title;
}

/**
 * Run one turn and stream it to the client as SSE.
 * Events: `token` (incremental text), `done` (final metadata), `error`.
 */
async function streamTurn(res, { conversationId, message, model, persistUser }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  store.ensureConversation(conversationId);
  if (persistUser) store.addMessage(conversationId, "user", message);

  send("start", { conversation_id: conversationId });

  const tools = mcp ? mcp.toolDefs(TOOL_LIMIT) : [];

  const messages = [
    { role: "system", content: SYSTEM_PROMPT + toolPreamble(tools) },
    ...store.historyFor(conversationId),
  ];

  // Abort the upstream request if the browser goes away mid-stream, so a
  // closed tab doesn't leave the model generating.
  const ac = new AbortController();
  res.on("close", () => ac.abort());

  // Keep the text as it arrives. If the client disconnects (tab closed, page
  // reloaded, network blip) we still persist what was generated — otherwise
  // the answer is lost entirely and the conversation is left with a user turn
  // and no reply, which then poisons the history sent on the next turn.
  let acc = "";
  const toolsUsed = [];

  try {
    // Agentic loop: the model may call tools, read the results, and call more
    // before answering. Bounded so a model that loops on a failing tool can't
    // spin forever.
    for (let round = 0; ; round++) {
      const { text, toolCalls } = await chatStream(
        { model, messages, tools, signal: ac.signal },
        (piece) => { acc += piece; send("token", { t: piece }); }
      );

      if (!toolCalls.length) break;

      if (round >= MAX_TOOL_ROUNDS) {
        const note = `\n\n_(stopped after ${MAX_TOOL_ROUNDS} tool rounds)_`;
        acc += note; send("token", { t: note });
        break;
      }

      // Ollama needs the assistant turn that requested the calls in history,
      // then one `tool` message per result.
      messages.push({ role: "assistant", content: text, tool_calls: toolCalls.map((c) => ({
        function: { name: c.name, arguments: c.args },
      })) });

      for (const call of toolCalls) {
        send("tool", { name: call.name, args: call.args });
        const result = await mcp.call(call.name, call.args);
        toolsUsed.push(call.name);
        send("tool_result", { name: call.name, ok: !result.startsWith("Error"), preview: result.slice(0, 160) });
        messages.push({ role: "tool", content: result, tool_name: call.name });
      }
    }

    store.addMessage(conversationId, "assistant", acc, model);
    if (!res.writableEnded) {
      const first = store.historyFor(conversationId).find((m) => m.role === "user");
      const title = await maybeTitle(conversationId, first?.content ?? message, model);
      send("done", { conversation_id: conversationId, title, model });
      res.end();
    }
  } catch (err) {
    // Salvage a partial answer on disconnect or mid-stream failure.
    if (acc) store.addMessage(conversationId, "assistant", acc, model);
    if (ac.signal.aborted) { try { res.end(); } catch {} return; }
    log(`turn failed: ${err.message}`);
    send("error", { error: err.message });
    res.end();
  }
}

// ── Routes ──────────────────────────────────────────────────

async function route(req, res, url) {
  const p = url.pathname;

  // Retry one connector, or stop what's blocking it first. POST because both
  // change state. The connector id comes from the path and must exist in the
  // pool; nothing about which process gets stopped is caller-controlled.
  const fix = /^\/api\/chat\/connectors\/([A-Za-z0-9_-]{1,64})\/(retry|resolve)$/.exec(p);
  if (fix && req.method === "POST") {
    if (!mcp) return sendJson(res, 503, { error: "connectors are still starting" });
    const [, id, action] = fix;
    if (!mcp.servers.has(id)) return sendJson(res, 404, { error: `unknown connector "${id}"` });
    try {
      await (action === "resolve" ? mcp.resolveConflict(id) : mcp.reconnect(id));
    } catch (e) {
      return sendJson(res, 409, { error: e.message });
    }
    connectorCache = { at: 0, rows: [] };          // force a fresh read
    const rows = await connectorRows({ force: true });
    return sendJson(res, 200, {
      connectors: rows, starting: !connectorsSettled, ...countConnectors(rows),
    });
  }

  if (p === "/api/chat/connectors") {
    const rows = await connectorRows({ force: true });
    return sendJson(res, 200, {
      connectors: rows, starting: !connectorsSettled, ...countConnectors(rows),
    });
  }

  if (p === "/api/chat/status") {
    const up = await isUp();
    const models = up ? await listModels() : [];
    const model = await resolveModel();
    const rows = await connectorRows();
    return sendJson(res, 200, {
      connectors: countConnectors(rows),
      available: up && !!model,
      model,
      models: models.map((m) => m.name),
      ollama: OLLAMA_BASE,
      tools: mcp ? mcp.toolDefs(TOOL_LIMIT).map((t) => t.function.name) : [],
      // true / false / null-when-unrated. The UI warns only on an explicit
      // false — a model we've never rated is unknown, not incapable.
      modelTools: modelSupportsTools(model),
    });
  }

  if (p === "/api/chat/ask" && req.method === "POST") {
    const body = await readBody(req);
    const message = (body.message || "").trim();
    if (!message) return sendJson(res, 400, { error: "message is required" });
    const model = body.model || (await resolveModel());
    if (!model) {
      return sendJson(res, 503, {
        error: "No model available. Is Ollama running? Try: ollama pull llama3.2",
      });
    }
    const conversationId = (body.conversation_id || "").trim() || randomUUID().replace(/-/g, "");
    return streamTurn(res, { conversationId, message, model, persistUser: true });
  }

  // Regenerate / edit both re-run the last turn; they differ only in what the
  // caller drops first.
  if ((p === "/api/chat/regenerate" || p === "/api/chat/edit") && req.method === "POST") {
    const body = await readBody(req);
    const conversationId = (body.conversation_id || "").trim();
    if (!conversationId) return sendJson(res, 400, { error: "conversation_id is required" });
    const model = body.model || (await resolveModel());
    if (!model) return sendJson(res, 503, { error: "No model available." });

    if (p === "/api/chat/regenerate") {
      store.truncateFrom(conversationId, { lastAssistant: true });
      return streamTurn(res, { conversationId, message: "", model, persistUser: false });
    }
    const edited = (body.message || "").trim();
    if (!edited) return sendJson(res, 400, { error: "message is required" });
    store.truncateFrom(conversationId, { lastAssistant: false });
    return streamTurn(res, { conversationId, message: edited, model, persistUser: true });
  }

  if (p === "/api/chat/conversations" && req.method === "GET") {
    return sendJson(res, 200, store.listConversations());
  }

  const convoMatch = p.match(/^\/api\/chat\/conversations\/([A-Za-z0-9_-]+)$/);
  if (convoMatch) {
    const id = convoMatch[1];
    if (req.method === "GET") {
      const convo = store.getConversation(id);
      return convo
        ? sendJson(res, 200, convo)
        : sendJson(res, 404, { error: "Conversation not found" });
    }
    if (req.method === "DELETE") {
      return sendJson(res, 200, { deleted: store.deleteConversation(id) });
    }
  }

  const pinMatch = p.match(/^\/api\/chat\/conversations\/([A-Za-z0-9_-]+)\/pin$/);
  if (pinMatch && req.method === "POST") {
    const body = await readBody(req);
    store.setPinned(pinMatch[1], !!body.pinned);
    return sendJson(res, 200, { ok: true });
  }

  if (p.startsWith("/api/")) return sendJson(res, 404, { error: "Unknown endpoint" });
  return serveStatic(res, p);
}

// ── Boot ────────────────────────────────────────────────────

store.initStore(DB_PATH);

const server = http.createServer((req, res) => {
  // A malformed request-target (e.g. "//", which parses as protocol-relative)
  // makes `new URL` throw. Unhandled, that exception escapes the request scope
  // and kills the process — one bad URL would take the whole UI down.
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  } catch {
    return sendJson(res, 400, { error: "Bad request URL" });
  }
  route(req, res, url).catch((err) => {
    log(`error on ${url.pathname}: ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
    else try { res.end(); } catch {}
  });
});

// A bind failure is the one startup error worth explaining. Unhandled, it
// prints a stack trace and exits 1 — and under the supervisor, which restarts
// on exit 1, that becomes ten identical failures whose cause is one line of
// text nobody sees. Say what is wrong and stop.
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    log(`port ${PORT} is already in use — REFUGIO chat is probably already running.`);
    log(`Open http://127.0.0.1:${PORT}, or stop the other copy and start again.`);
  } else {
    log(`could not start: ${e.message}`);
  }
  process.exit(1);
});

// Bind to loopback only. This serves the user's private conversations with no
// authentication — it must never be reachable from the network.
server.listen(PORT, "127.0.0.1", async () => {
  log(`REFUGIO chat → http://127.0.0.1:${PORT}`);
  log(`store: ${DB_PATH}`);
  const model = await resolveModel();
  log(model ? `model: ${model}` : `no model yet (Ollama at ${OLLAMA_BASE})`);

  // Tools connect after the server is listening so a slow or broken connector
  // delays tool availability, never the UI itself.
  //
  // The pool is published BEFORE connecting, not after. Assigning it only on
  // completion left a 10-15s window (Hermeneia is not quick to start) in which
  // the UI could see no pool at all and say "No connectors configured — re-run
  // the installer", which is both wrong and alarming. The pool registers every
  // configured server up front, so publishing early means that window reports
  // "connecting" instead.
  if (process.env.REFUGIO_TOOLS !== "0") {
    const pool = new McpPool();
    mcp = pool;
    await pool.connectAll(MCP_CONFIG);
  }
  connectorsSettled = true;
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("shutting down");
    server.close();
    store.closeStore();
    mcp?.close();
    process.exit(0);
  });
}
