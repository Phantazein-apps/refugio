#!/usr/bin/env node
// A stand-in for the `claude` binary, for test/claude-code.test.js.
//
// It prints the stream-json events Claude Code prints, and when it is given an
// MCP config it does what Claude Code does with one: spawns the server, lists
// its tools and calls them over MCP. So the bridge is exercised for real; only
// the model is scripted. The --model alias picks the script:
//
//   sonnet  — no tools: answers. With tools: asks for the first one, then
//             answers with what it got back
//   late    — as sonnet, but prints the tool_use block after message_stop
//   silent  — prints init and then nothing, like a Claude Code whose login has
//             expired and is retrying a 401
//   broken  — ends with an error result
//
// FAKE_CLAUDE_LOG, if set, receives one JSON line: argv, stdin, cwd, and
// whether CLAUDECODE was in the environment.

import { appendFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const model = flag("--model");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const ev = (event) => out({ type: "stream_event", event });

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const prompt = JSON.parse(stdin.trim().split("\n")[0]).message.content;

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    argv, stdin, cwd: process.cwd(), claudecode: "CLAUDECODE" in process.env, pid: process.pid,
  }) + "\n");
}

out({ type: "system", subtype: "init", tools: [], model, apiKeySource: "none" });
// A timer, because a promise alone does not keep Node running: it would exit 13.
if (model === "silent") await new Promise(() => setInterval(() => {}, 1000));
if (model === "broken") { out({ type: "result", subtype: "error_during_execution", is_error: true, result: "rate limited" }); process.exit(1); }

function say(text, stop, usage = { input_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }) {
  ev({ type: "message_start", message: { usage } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "considering " } });
  ev({ type: "content_block_start", index: 1, content_block: { type: "text" } });
  for (const piece of text.match(/.{1,6}/gs) ?? []) ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: piece } });
  return () => {
    ev({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 9 } });
    ev({ type: "message_stop" });
  };
}

const config = flag("--mcp-config");
if (!config) {
  say(`Hello from Claude. You said: ${prompt}`, "end_turn")();
  out({ type: "result", subtype: "success", is_error: false, result: "ok" });
  process.exit(0);
}

const { command, args, env } = JSON.parse(config).mcpServers.refugio;
const client = new Client({ name: "fake-claude", version: "0" });
await client.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...env } }));
const { tools } = await client.listTools();
const tool = tools[0];
const use = { type: "tool_use", id: "toolu_1", name: `mcp__refugio__${tool.name}`, input: { list: "today" } };

const end = say("Let me check.", "tool_use");
if (model === "late") { end(); out({ type: "assistant", message: { content: [use] } }); }
else { out({ type: "assistant", message: { content: [use] } }); end(); }

const result = await client.callTool({ name: tool.name, arguments: use.input });
const got = result.content.map((c) => c.text).join("");
say(`You have: ${got} (tools offered: ${tools.map((t) => t.name).join(",")})`, "end_turn")();
out({ type: "result", subtype: "success", is_error: false, result: "ok" });
await client.close();
process.exit(0);
