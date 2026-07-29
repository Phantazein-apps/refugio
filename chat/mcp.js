// MCP tool pool — connects directly to REFUGIO's MCP servers.
//
// Open WebUI can't speak MCP, so REFUGIO runs MCPO to translate MCP → OpenAPI
// for it. Nothing here needs that: the SDK REFUGIO already depends on speaks
// MCP natively, so the chat UI talks to the servers directly and MCPO becomes
// optional for this path.
//
// Config is read from the same mcpo-config.json the supervisor already writes,
// so there is exactly one place that defines which servers exist.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, existsSync } from "fs";

const log = (m) => console.log(`[chat:mcp] ${m}`);

// A model sees a flat tool list, but two servers may both expose `search`.
// Namespace on the way out and strip it on the way back in. `-` and `.` are
// avoided because some models mangle them in generated tool names.
const SEP = "__";

// How much of a tool's output the model is shown.
//
// This is a latency setting, not a memory one. Everything here is prompt the
// model must read before emitting its first word, and on a local 3B model that
// processing dominates the wait: 24k characters is ~6k tokens, which is tens of
// seconds on an 8 GB laptop before anything appears on screen. `list_messages`
// returns 50 messages by default and fills that easily.
//
// 6k characters is ~1.5k tokens — still dozens of messages, enough to summarise
// a day, and it gets the first token out several times sooner. Raise it for a
// bigger model, where the tradeoff reverses.
const RESULT_CHARS = parseInt(process.env.REFUGIO_TOOL_RESULT_CHARS || "6000", 10);
const qualify = (server, tool) => `${server}${SEP}${tool}`;
const unqualify = (name) => {
  const i = name.indexOf(SEP);
  return i === -1 ? [null, name] : [name.slice(0, i), name.slice(i + SEP.length)];
};

/** JSON-Schema cleanup: Ollama rejects some drafts' extras, and small models
 *  cope badly with deep schemas. Keep the shape it documents. */
function toOllamaTool(server, tool) {
  const schema = tool.inputSchema || { type: "object", properties: {} };
  return {
    type: "function",
    function: {
      name: qualify(server, tool.name),
      description: (tool.description || tool.name).slice(0, 1024),
      parameters: {
        type: "object",
        properties: schema.properties || {},
        ...(Array.isArray(schema.required) && schema.required.length
          ? { required: schema.required }
          : {}),
      },
    },
  };
}

/** Pull the one line of a child's stderr worth showing.
 *
 *  The tail is the wrong choice: a Node crash ends with "requireStack: []",
 *  "}", "Node.js v22.x" — three lines that say nothing — while the line that
 *  names the missing module sits above the stack trace. Prefer the first line
 *  that states a cause, and fall back to the first non-blank line. */
function firstCause(stderr) {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const named = lines.find((l) =>
    /cannot find|no such file|enoent|eacces|permission denied|not found|refused|unauthorized|already running|exiting cleanly|^[A-Za-z]*Error[:,]| error: /i.test(l));
  return (named || lines[0] || "").slice(0, 300);
}

// A server saying "I don't have that tool" is a definite answer. Anything else
// (timeout, closed connection) means we don't know yet and must not be cached.
const UNSUPPORTED_TOOL =
  /unknown tool|no such tool|tool not found|not found|method not found|-3260[12]/i;

export class McpPool {
  constructor() {
    this.clients = new Map();   // server name -> Client
    this.tools = [];            // Ollama-shaped tool defs
    this.byName = new Map();    // qualified name -> { server, tool }
    // Every configured server, connected or not. A connector that FAILED is
    // the thing a user most needs to see, so it must survive here with its
    // reason rather than simply be absent.
    this.servers = new Map();   // server name -> { name, tools, ok, error }
  }

  /**
   * Connect to every stdio server in mcpo-config.json.
   *
   * Servers are connected in parallel and failures are isolated: one broken
   * connector must not cost the user every other tool. Anything non-stdio
   * (mcp-remote wrappers etc.) is skipped for now.
   */
  async connectAll(configPath, { timeoutMs = 20000, only = null } = {}) {
    if (!existsSync(configPath)) {
      log(`no config at ${configPath} — tools disabled`);
      return this;
    }
    let config;
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (e) {
      log(`config unreadable: ${e.message}`);
      return this;
    }

    const servers = Object.entries(config.mcpServers || {})
      .filter(([name]) => !only || only.includes(name));

    for (const [name] of servers) {
      this.servers.set(name, { name, tools: 0, ok: false, error: null });
    }

    await Promise.all(servers.map(([name, spec]) =>
      this.#connectOne(name, spec, timeoutMs).catch((e) => {
        this.servers.get(name).error = e.message;
        log(`"${name}" unavailable: ${e.message}`);
      })
    ));

    log(`${this.tools.length} tools from ${this.clients.size}/${servers.length} server(s)`);
    return this;
  }

  async #connectOne(name, spec, timeoutMs) {
    if (!spec?.command) throw new Error("not a stdio server");

    // Keep the child's stderr. Discarding it ("ignore") makes a failing
    // connector undebuggable: the pool reports "0 tools" and the model then
    // truthfully says it has no WhatsApp tools, with nothing anywhere naming
    // the missing file or the crash that caused it. The child's own error
    // message is almost always the whole answer, so hold the tail of it.
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args || [],
      env: { ...process.env, ...(spec.env || {}) },
      stderr: "pipe",
    });
    const client = new Client({ name: "refugio-chat", version: "1.0.0" }, { capabilities: {} });

    let errTail = "";
    const keepStderr = (chunk) => {
      errTail = (errTail + chunk.toString()).slice(-2000);
    };

    try {
      // A connector that hangs on startup would otherwise stall the whole chat.
      await withTimeout(client.connect(transport), timeoutMs, `${name} connect`);
      transport.stderr?.on("data", keepStderr);
      const { tools = [] } = await withTimeout(client.listTools(), timeoutMs, `${name} listTools`);
      return this.#register(name, client, tools);
    } catch (e) {
      // connect() spawns the child, so stderr only exists from that point on —
      // attach late and drain whatever the child managed to say before dying.
      transport.stderr?.on("data", keepStderr);
      await new Promise((r) => setTimeout(r, 150));
      throw new Error(errTail ? `${e.message} — ${firstCause(errTail)}` : e.message);
    }
  }

  #register(name, client, tools) {
    const entry = this.servers.get(name);
    if (entry) { entry.ok = true; entry.tools = tools.length; entry.error = null; }

    this.clients.set(name, client);
    for (const t of tools) {
      const qualified = qualify(name, t.name);
      this.byName.set(qualified, { server: name, tool: t.name });
      this.tools.push(toOllamaTool(name, t));
    }
    log(`"${name}" → ${tools.length} tools`);
  }

  /** Tool definitions for Ollama, optionally capped.
   *
   *  Small local models degrade badly when handed dozens of tools — they pick
   *  wrong or loop. Callers can cap; 0 means "no tools".
   *
   *  The cap is spread round-robin across servers rather than sliced off the
   *  flat list. A flat slice hands every slot to whichever servers connected
   *  first, so a second connector can vanish entirely — and the symptom is a
   *  model calmly explaining it has no WhatsApp tools while the UI reports 24,
   *  which reads as a bug anywhere but here. */
  /**
   * Describe the connectors for a human, not for the model.
   *
   * "35 tools" is an implementation detail; "WhatsApp, Reminders, Things" is
   * what someone actually installed. A connector that FAILED matters most —
   * during the outage that motivated this, the only signal anywhere was a tool
   * count that looked perfectly plausible.
   *
   * Per-account rows come from a `list_accounts` tool, treated as a convention
   * any connector may implement. Note it is called even when the connector
   * hides it from the model (Hermeneia's `minimal` profile does): a profile
   * filters what the MODEL is offered, not what the host may ask for. That is
   * what lets WhatsApp count as one connector per account without spending a
   * slot in the model's tool list.
   */
  async describe({ timeoutMs = 5000 } = {}) {
    return Promise.all([...this.servers.values()].map(async (s) => {
      const row = { id: s.name, tools: s.tools, ok: s.ok, error: s.error,
                    accounts: [], accountsUnknown: false };
      if (!s.ok) return row;
      let raw;
      try {
        raw = await withTimeout(
          this.clients.get(s.name).callTool({ name: "list_accounts", arguments: {} }),
          timeoutMs, `${s.name} list_accounts`);
      } catch (e) {
        // Distinguish "this connector has no such tool" — a definite answer,
        // meaning single-account — from every other failure, which means we
        // simply don't know yet. Timeouts (still booting) and dropped
        // connections both land here, and reporting either as "no accounts"
        // UNDERCOUNTS, which the caller would then cache as though settled.
        row.accountsUnknown = !UNSUPPORTED_TOOL.test(e.message || "");
        return row;
      }

      // The call answered. If the payload isn't an account array the connector
      // simply doesn't implement this convention (some servers reply to any
      // tool name) — a definite single-account answer, not an unknown one.
      try {
        const text = raw?.content?.find((b) => b.type === "text")?.text;
        const parsed = text ? JSON.parse(text) : null;
        if (Array.isArray(parsed)) {
          row.accounts = parsed.map((a) => ({
            id: a.id ?? null,
            phone: a.phone ?? null,
            connected: !!(a.connected ?? a.authenticated),
          }));
        }
      } catch { /* not JSON — not an accounts connector */ }
      return row;
    }));
  }

  toolDefs(limit = 0) {
    if (limit <= 0) return this.tools;
    if (this.tools.length <= limit) return this.tools;

    const queues = new Map();
    for (const t of this.tools) {
      const server = t.function.name.split(SEP)[0];
      if (!queues.has(server)) queues.set(server, []);
      queues.get(server).push(t);
    }

    const out = [];
    while (out.length < limit) {
      let took = false;
      for (const q of queues.values()) {
        if (!q.length) continue;
        out.push(q.shift());
        took = true;
        if (out.length === limit) break;
      }
      if (!took) break;
    }

    // Once, not on every status poll.
    if (!this._cappedWarned) {
      this._cappedWarned = true;
      log(`capped at ${limit} of ${this.tools.length} tools across ` +
          `${queues.size} server(s) — raise REFUGIO_TOOL_LIMIT to offer more`);
    }
    return out;
  }

  has(qualifiedName) {
    return this.byName.has(qualifiedName);
  }

  /**
   * Invoke a tool. Always resolves to a string — a tool failure is information
   * for the model ("that call failed, try something else"), not a reason to
   * abort the user's turn.
   */
  async call(qualifiedName, args, { timeoutMs = 60000 } = {}) {
    const entry = this.byName.get(qualifiedName);
    if (!entry) {
      const [, bare] = unqualify(qualifiedName);
      return `Error: no such tool "${qualifiedName}" (did you mean one of the ${this.tools.length} available? closest bare name: ${bare})`;
    }
    const client = this.clients.get(entry.server);
    if (!client) return `Error: server "${entry.server}" is not connected`;

    try {
      const res = await withTimeout(
        client.callTool({ name: entry.tool, arguments: args || {} }),
        timeoutMs,
        `${qualifiedName}`
      );
      return flattenContent(res);
    } catch (e) {
      return `Error calling ${qualifiedName}: ${e.message}`;
    }
  }

  async close() {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    this.clients.clear();
  }
}

/** MCP returns content blocks; the model needs one string. */
function flattenContent(result) {
  const blocks = result?.content;
  if (!Array.isArray(blocks)) return JSON.stringify(result ?? {});
  const parts = blocks.map((b) => {
    if (b.type === "text") return b.text;
    // Never inline base64 image payloads — they would blow the context window.
    if (b.type === "image") return `[image: ${b.mimeType || "unknown"}]`;
    if (b.type === "resource") return `[resource: ${b.resource?.uri || "unknown"}]`;
    return `[${b.type}]`;
  });
  const text = parts.join("\n").trim();
  if (!text) return "(the tool returned no output)";
  return text.length > RESULT_CHARS
    ? text.slice(0, RESULT_CHARS) + "\n…(truncated — ask for a narrower range for more detail)"
    : text;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}
