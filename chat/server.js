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
import { homedir } from "os";

import * as store from "./store.js";
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

const log = (m) => console.log(`[chat] ${m}`);

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

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
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

  try {
    await chatStream(
      { model, messages, signal: ac.signal },
      (piece) => { acc += piece; send("token", { t: piece }); }
    );

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

  if (p === "/api/chat/status") {
    const up = await isUp();
    const models = up ? await listModels() : [];
    const model = await resolveModel();
    return sendJson(res, 200, {
      available: up && !!model,
      model,
      models: models.map((m) => m.name),
      ollama: OLLAMA_BASE,
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

// Bind to loopback only. This serves the user's private conversations with no
// authentication — it must never be reachable from the network.
server.listen(PORT, "127.0.0.1", async () => {
  log(`REFUGIO chat → http://127.0.0.1:${PORT}`);
  log(`store: ${DB_PATH}`);
  const model = await resolveModel();
  log(model ? `model: ${model}` : `no model yet (Ollama at ${OLLAMA_BASE})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("shutting down");
    server.close();
    store.closeStore();
    process.exit(0);
  });
}
