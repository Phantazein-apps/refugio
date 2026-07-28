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

export class McpPool {
  constructor() {
    this.clients = new Map();   // server name -> Client
    this.tools = [];            // Ollama-shaped tool defs
    this.byName = new Map();    // qualified name -> { server, tool }
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

    await Promise.all(servers.map(([name, spec]) =>
      this.#connectOne(name, spec, timeoutMs).catch((e) =>
        log(`"${name}" unavailable: ${e.message}`))
    ));

    log(`${this.tools.length} tools from ${this.clients.size}/${servers.length} server(s)`);
    return this;
  }

  async #connectOne(name, spec, timeoutMs) {
    if (!spec?.command) throw new Error("not a stdio server");

    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args || [],
      env: { ...process.env, ...(spec.env || {}) },
      stderr: "ignore",
    });
    const client = new Client({ name: "refugio-chat", version: "1.0.0" }, { capabilities: {} });

    // A connector that hangs on startup would otherwise stall the whole chat.
    await withTimeout(client.connect(transport), timeoutMs, `${name} connect`);
    const { tools = [] } = await withTimeout(client.listTools(), timeoutMs, `${name} listTools`);

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
  // Cap: a chatty tool can otherwise evict the conversation from context.
  return text.length > 24000 ? text.slice(0, 24000) + "\n…(truncated)" : text;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}
