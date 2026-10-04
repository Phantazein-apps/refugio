#!/usr/bin/env node
// The only MCP server Claude Code is given when it is REFUGIO's engine.
//
// Claude Code spawns this over stdio (see chat/claude-code.js). It runs
// nothing itself: it lists the tools REFUGIO offered for this turn and, when
// Claude calls one, asks REFUGIO over loopback and waits for the answer. The
// tool is run by REFUGIO's own turn runner — runTool, the web arming check, the
// mode check, the tool budget, the Sources panel — exactly as for a local
// model. Claude Code is the model here, not the agent.
//
// REFUGIO_BRIDGE_URL and REFUGIO_BRIDGE_TOKEN come from the engine, per turn.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync } from "fs";

const URL_BASE = process.env.REFUGIO_BRIDGE_URL;
const TOKEN = process.env.REFUGIO_BRIDGE_TOKEN;
if (!URL_BASE || !TOKEN) {
  process.stderr.write("claude-code-bridge: REFUGIO_BRIDGE_URL and REFUGIO_BRIDGE_TOKEN are required\n");
  process.exit(2);
}

// Diagnostics only: with REFUGIO_BRIDGE_TRACE set to a file, each request
// Claude Code makes is recorded by kind (never its arguments or results).
const trace = (what) => {
  if (!process.env.REFUGIO_BRIDGE_TRACE) return;
  try { appendFileSync(process.env.REFUGIO_BRIDGE_TRACE, `${new Date().toISOString()} ${what}\n`); } catch {}
};
trace("started");

async function ask(path, body) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`REFUGIO refused (${res.status})`);
  return res.json();
}

const server = new Server({ name: "refugio", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await ask("/tools");
  trace(`listed ${tools.length} tools`);
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  // Held open until REFUGIO's turn runner has run the tool, which may be a
  // while: a WhatsApp history read is not instant.
  trace(`call ${req.params.name}`);
  const { text, isError } = await ask("/call", { name: req.params.name, args: req.params.arguments ?? {} });
  return { content: [{ type: "text", text }], isError: !!isError };
});

await server.connect(new StdioServerTransport());
