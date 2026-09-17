#!/usr/bin/env node
// Ask REFUGIO's memory a question the way a chat turn does, without a model.
//
// Why this exists. The eval's memory tasks (b2-voice-from-memory,
// f1-memory-recall) can only score well if memory holds something to find. On
// 2026-09-16 three models were scored against a machine whose MemPalace had
// never been initialised: every search came back empty, every score was capped,
// and nobody knew until the scorecards were read. This checks the store first,
// in seconds, for no model time and no tokens.
//
// Why it goes through servers/memory-lite.js rather than the mempalace CLI.
// memory-lite.js is what REFUGIO actually spawns, and it is not a transparent
// pipe: it launches `mempalace-mcp` with only HOME, LOGNAME, PATH, SHELL, TERM
// and USER in its environment (the MCP SDK's default), so a palace the CLI can
// see is not necessarily one REFUGIO can. A probe that skipped the wrapper
// could pass while every chat turn failed.
//
// Usage:
//   node scripts/memory-probe.cjs                    # the two eval questions
//   node scripts/memory-probe.cjs "how I write" ...  # your own queries
//
// Exits 0 when every query returns something that is not an error, 1 otherwise.

const path = require("path")

const WRAPPER = path.join(__dirname, "..", "servers", "memory-lite.js")

// The queries the models actually sent on 2026-09-16, one per task, so a pass
// here means those same turns would have found the fixture.
const DEFAULT_QUERIES = ["how I write", "default engine decision for REFUGIO and why"]

// One result block's text, or "" if the call returned nothing usable.
function textOf(result) {
  return (result?.content || [])
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim()
}

// Longest result still read as MemPalace's no-palace message. The real one
// was 95 characters on 2026-09-16; a real hit on the eval fixture ran about
// 5,200. The bound is what stops a genuine hit on a stored note that merely
// QUOTES the message — REFUGIO's own gap register does — from being scored as
// an empty memory.
const NO_PALACE_MAX_CHARS = 300

/**
 * Is this tool result MemPalace saying no palace exists? It arrives as
 * ordinary text with ok: true, not as an error, which is how an uninitialised
 * memory earned passing auto bands on 2026-09-16. Shared with scripts/eval.cjs
 * so the probe and the runner cannot disagree about what a miss is.
 */
function isNoPalace(text) {
  return typeof text === "string" && text.length <= NO_PALACE_MAX_CHARS && /no palace found/i.test(text)
}

// A search "found something" only if it is neither an error nor empty, nor
// MemPalace's no-palace message.
function verdict(result) {
  const text = textOf(result)
  if (result?.isError) return { ok: false, why: "error", text }
  if (!text) return { ok: false, why: "empty", text }
  if (isNoPalace(text)) return { ok: false, why: "no palace", text }
  return { ok: true, why: "found", text }
}

async function main(queries) {
  // Required here, not at the top: CI runs the unit tests without installing
  // dependencies, and verdict() above must be testable there. Only an actual
  // probe needs the SDK, and REFUGIO's own install always has it.
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")
  const client = new Client({ name: "refugio-memory-probe", version: "1.0.0" }, { capabilities: {} })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [WRAPPER], stderr: "ignore" }))
  let failed = 0
  try {
    for (const q of queries) {
      const v = verdict(await client.callTool({ name: "memory_search", arguments: { query: q } }))
      if (!v.ok) failed++
      console.log(`\n${v.ok ? "FOUND" : "MISS "}  "${q}"  (${v.why})`)
      console.log((v.text || "(no text)").split("\n").slice(0, 12).map((l) => "   " + l).join("\n"))
    }
  } finally {
    await client.close().catch(() => {})
  }
  console.log(`\n${queries.length - failed}/${queries.length} queries found something.`)
  if (failed) console.log("Memory is not ready for the eval's memory tasks — see eval/README.md, \"Memory fixture\".")
  return failed ? 1 : 0
}

module.exports = { verdict, textOf, isNoPalace, NO_PALACE_MAX_CHARS, DEFAULT_QUERIES }

if (require.main === module) {
  const args = process.argv.slice(2)
  main(args.length ? args : DEFAULT_QUERIES).then(
    (code) => process.exit(code),
    (err) => { console.error(`probe failed: ${err.message}`); process.exit(1) },
  )
}
