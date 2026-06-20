#!/usr/bin/env node
// REFUGIO lean memory — a thin MCP server that exposes just TWO tools
// (memory_search, memory_save) backed by MemPalace.
//
// Why: MemPalace publishes 33 tools. Injecting all of them into every chat
// (~8k tokens) overflows small local models and makes them call the wrong tool.
// This wrapper re-exposes only the two a chat actually needs, so memory can be
// ON by default and still work reliably on a 3b model.
//
// It connects to `mempalace-mcp` as an MCP client and forwards calls.

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { homedir } from "os"
import { join } from "path"

const isWin = process.platform === "win32"
const mempalaceBin = isWin
  ? join(homedir(), ".local", "bin", "mempalace-mcp.exe")
  : join(homedir(), ".local", "bin", "mempalace-mcp")

// ── Upstream MemPalace connection (lazy, kept alive) ─────────
let upstream = null
let searchName = null
let saveName = null

async function ensureUpstream() {
  if (upstream) return upstream
  const transport = new StdioClientTransport({ command: mempalaceBin, args: [] })
  const client = new Client({ name: "refugio-memory-lite", version: "1.0.0" }, { capabilities: {} })
  await client.connect(transport)
  const { tools } = await client.listTools()
  // Resolve the real tool names (MemPalace prefixes vary by version)
  searchName = (tools.find(t => /(^|_)search$/.test(t.name)) || tools.find(t => t.name.includes("search")) || {}).name
  saveName = (tools.find(t => t.name.includes("add_drawer")) || {}).name
  upstream = client
  return client
}

// ── Tools exposed to Open WebUI (only two) ──────────────────
const TOOLS = [
  {
    name: "memory_search",
    description: "Search your long-term memory for relevant notes, facts, and past context. Use when the user asks what you know, refers to earlier context, or asks about their preferences.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or a question (max ~250 chars)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_save",
    description: 'Save a fact or note to long-term memory. Use when the user says "remember this", "save this", or shares lasting preferences or context.',
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The exact text to remember (verbatim, not summarized)" },
        topic: { type: "string", description: 'Short category, e.g. "preferences" or "project". Optional.' },
      },
      required: ["content"],
    },
  },
]

const server = new Server({ name: "refugio-memory", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  try {
    const client = await ensureUpstream()
    let result
    if (name === "memory_search") {
      if (!searchName) throw new Error("memory search is unavailable")
      result = await client.callTool({
        name: searchName,
        arguments: { query: String(args.query || "").slice(0, 250), limit: 5 },
      })
    } else if (name === "memory_save") {
      if (!saveName) throw new Error("memory save is unavailable")
      result = await client.callTool({
        name: saveName,
        arguments: {
          wing: "chat",
          room: (args.topic && String(args.topic).trim()) || "general",
          content: String(args.content || ""),
          added_by: "refugio",
        },
      })
    } else {
      throw new Error(`Unknown tool: ${name}`)
    }
    return { content: result.content || [{ type: "text", text: "Done." }] }
  } catch (e) {
    return { content: [{ type: "text", text: `Memory error: ${e.message}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error("refugio-memory (lean MemPalace wrapper, 2 tools) — running on stdio")
