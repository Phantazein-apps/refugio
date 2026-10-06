// The Claude Code engine (chat/claude-code.js), against a fake `claude` that
// prints Claude Code's stream-json and speaks MCP to the bridge for real.
//
// Pinned: what Claude Code is allowed to do (no built-in tools, none of the
// person's settings, REFUGIO's system prompt); that what is said never goes on
// the command line; that tool calls come back out to the turn runner and their
// results go back in; that a silent Claude Code — the expired-login case — is
// explained instead of waited on; that aborting ends the process; and, through
// the real chat/server.js, that a cloud model is off until switched on and is
// never used in a discussion mode.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { spawn } from "child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, delimiter } from "path";
import { fileURLToPath } from "url";
import {
  toPrompt, chatStream, findClaude, isClaudeCodeModel, ownSessionEnv, checkInit, blockedTools, compareVersions,
  startClaudeInstall, claudeInstallState, verifyAnthropicSignature,
} from "../chat/claude-code.js";
import { cloudRefusal, isCloudModel } from "../chat/engine.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FAKE = join(ROOT, "test", "fixtures", "fake-claude.mjs");

// The fake and the bridge both need the MCP SDK; CI runs without npm install.
let sdk = true;
try { await import("@modelcontextprotocol/sdk/client/index.js"); } catch { sdk = false; }

const REMINDERS = { type: "function", function: {
  name: "reminders__list", description: "List reminders",
  parameters: { type: "object", properties: { list: { type: "string" } } } } };

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the system prompt is REFUGIO's, and earlier turns travel as a transcript", () => {
  assert.deepEqual(toPrompt([
    { role: "system", content: "A" }, { role: "system", content: "B" }, { role: "user", content: "hi" },
  ]), { system: "A\n\nB", prompt: "hi" });

  const { prompt } = toPrompt([
    { role: "system", content: "S" },
    { role: "user", content: "first" }, { role: "assistant", content: "reply" },
    { role: "user", content: "second" },
  ]);
  assert.match(prompt, /^<conversation_so_far>\nPerson: first\n\nYou: reply\n<\/conversation_so_far>\n\nsecond$/);
});

test("a Claude Code model is a cloud model, and is refused until switched on", () => {
  assert.equal(isClaudeCodeModel("claude-code/sonnet"), true);
  assert.equal(isCloudModel("claude-code/sonnet"), true);
  assert.equal(cloudRefusal({ model: "qwen3:4b" }), null);
  assert.match(cloudRefusal({ model: "claude-code/sonnet" }), /switched off in Settings/);
  assert.equal(cloudRefusal({ model: "claude-code/sonnet", claudeEnabled: true }), null);
});

test("a discussion mode never uses a cloud model, switched on or not", () => {
  for (const model of ["claude-code/sonnet", "anthropic/claude-haiku-4-5"]) {
    assert.match(cloudRefusal({ model, mode: "nvc", claudeEnabled: true }), /Modes only use the model on this computer/);
  }
  assert.equal(cloudRefusal({ model: "qwen3:4b", mode: "nvc" }), null);
});

test("a parent Claude Code session's plumbing is not handed to the child", () => {
  // Found by running REFUGIO from inside the Claude desktop app: the child sent
  // the person's login to the host's endpoint and was refused, every turn.
  const parent = {
    PATH: "/bin", HOME: "/h", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "x", CLAUDE_CODE_SESSION_ID: "s",
    CLAUDE_AGENT_SDK_VERSION: "1", CLAUDE_PID: "1", USE_STAGING_OAUTH: "1", USE_LOCAL_OAUTH: "1",
    ANTHROPIC_BASE_URL: "http://host-proxy", REFUGIO_EDITION: "listener",
  };
  assert.deepEqual(ownSessionEnv(parent), { PATH: "/bin", HOME: "/h", REFUGIO_EDITION: "listener" });
  // A gateway the person set themselves, with no parent session, is theirs.
  assert.equal(ownSessionEnv({ ANTHROPIC_BASE_URL: "https://gateway.example" }).ANTHROPIC_BASE_URL, "https://gateway.example");
});

test("a tool Claude Code offers that REFUGIO did not block is reported, and blocked from then on", () => {
  const said = [];
  const extra = checkInit({ tools: ["mcp__refugio__reminders__list", "Bash", "BrandNewTool"] }, (m) => said.push(m));
  assert.deepEqual(extra, ["Bash", "BrandNewTool"]);
  assert.match(said.join(), /Bash, BrandNewTool/);
  assert.ok(blockedTools().includes("BrandNewTool"), "learned for the next turn");
  checkInit({ tools: ["BrandNewTool"] }, (m) => said.push(m));
  assert.equal(said.length, 1, "said once, not every turn");
});

test("a bridge that is not connected when Claude Code starts is reported", () => {
  const said = [];
  checkInit({ tools: [], mcp_servers: [{ name: "refugio", status: "pending" }] }, (m) => said.push(m), true);
  assert.match(said.join(), /"pending"/);
  checkInit({ tools: [], mcp_servers: [] }, (m) => said.push(m), false);
  assert.equal(said.length, 1, "no tools offered, nothing to report");
});

test("the newest Claude Code wins, not the first on PATH", () => {
  const a = mkdtempSync(join(tmpdir(), "refugio-cc-a-"));
  const b = mkdtempSync(join(tmpdir(), "refugio-cc-b-"));
  try {
    for (const d of [a, b]) writeFileSync(join(d, "claude"), "");
    const ver = { [join(a, "claude")]: [2, 1, 20], [join(b, "claude")]: [2, 1, 104] };
    assert.equal(findClaude({ PATH: `${a}${delimiter}${b}` }, (p) => ver[p]), join(b, "claude"));
    assert.ok(compareVersions([2, 1, 104], [2, 1, 20]) > 0, "numeric, not string, comparison");
    assert.ok(compareVersions(null, [1, 0, 0]) < 0, "an install that cannot report a version loses");
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("an explicit REFUGIO_CLAUDE_BIN that does not exist is not silently replaced", () => {
  assert.equal(findClaude({ REFUGIO_CLAUDE_BIN: "/nonexistent/claude", PATH: "" }), null);
});

describe("against a fake claude", { skip: !sdk && "@modelcontextprotocol/sdk is not installed" }, () => {
  let dir;
  let log;
  let env;
  const runs = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));

  before(() => {
    chmodSync(FAKE, 0o755);
    dir = mkdtempSync(join(tmpdir(), "refugio-cc-test-"));
    log = join(dir, "runs.jsonl");
    env = { ...process.env, REFUGIO_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, CLAUDECODE: "1", REFUGIO_CLAUDE_FIRST_EVENT_MS: "3000" };
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("an answer streams as tokens and thinking, with the context size counted whole", async () => {
    const tokens = [];
    const thoughts = [];
    const out = await chatStream({
      model: "claude-code/sonnet",
      messages: [{ role: "system", content: "You are REFUGIO." }, { role: "user", content: "my private words" }],
      tools: [],
    }, (t) => tokens.push(t), (t) => thoughts.push(t), env);

    assert.equal(out.text, "Hello from Claude. You said: my private words");
    assert.equal(tokens.join(""), out.text);
    assert.equal(thoughts.join(""), "considering ");
    assert.deepEqual(out.toolCalls, []);
    assert.deepEqual(out.usage, { promptTokens: 125, evalTokens: 9, doneReason: "stop" });
  });

  test("Claude Code runs as a model only: no tools of its own, none of the person's settings, REFUGIO's prompt", () => {
    const { argv, cwd, claudecode } = runs().at(-1);
    const val = (f) => argv[argv.indexOf(f) + 1];
    assert.ok(!argv.includes("--tools"), "any --tools flag also hides REFUGIO's MCP tools from the model");
    const blocked = val("--disallowedTools").split(",");
    for (const t of ["Bash", "Read", "Write", "WebFetch", "WebSearch", "Task", "Skill", "CronCreate", "RemoteTrigger", "ScheduleWakeup"]) {
      assert.ok(blocked.includes(t), `${t} is blocked`);
    }
    assert.equal(val("--setting-sources"), "", "the person's settings, hooks and skills are not loaded");
    assert.ok(argv.includes("--strict-mcp-config"), "the person's own MCP servers are not loaded");
    assert.ok(argv.includes("--no-session-persistence"));
    assert.equal(val("--permission-mode"), "dontAsk");
    assert.equal(val("--allowedTools"), "mcp__refugio");
    assert.equal(val("--system-prompt"), "You are REFUGIO.");
    assert.equal(val("--model"), "sonnet");
    assert.ok(!argv.includes("--mcp-config"), "no tools offered, no MCP server given");
    assert.match(cwd, /refugio-claude-/, "an empty folder, so no CLAUDE.md is read");
    assert.equal(claudecode, false, "not mistaken for a session nested in Claude Code");
  });

  test("what is said goes over stdin and never on the command line", () => {
    const { argv, stdin } = runs().at(-1);
    assert.ok(!argv.some((a) => a.includes("my private words")), "visible to every user through ps");
    assert.match(stdin, /my private words/);
  });

  test("a tool call comes out to the turn runner, and its result goes back in", async () => {
    const messages = [{ role: "system", content: "S" }, { role: "user", content: "reminders?" }];
    const first = await chatStream({ model: "claude-code/sonnet", messages, tools: [REMINDERS] }, () => {}, () => {}, env);
    assert.equal(first.text, "Let me check.");
    assert.deepEqual(first.toolCalls, [{ name: "reminders__list", args: { list: "today" } }], "REFUGIO's name, not Claude Code's");
    assert.equal(first.usage.doneReason, "stop");

    // What streamTurn does between rounds.
    messages.push({ role: "assistant", content: first.text, tool_calls: [{ function: { name: "reminders__list", arguments: { list: "today" } } }] });
    messages.push({ role: "tool", tool_name: "reminders__list", content: "dentist at 9" });
    const second = await chatStream({ model: "claude-code/sonnet", messages, tools: [REMINDERS] }, () => {}, () => {}, env);
    assert.equal(second.text, "You have: dentist at 9 (tools offered: reminders__list)");
    assert.deepEqual(second.toolCalls, []);
    assert.ok(runs().at(-1).argv.includes("--mcp-config"));
  });

  test("a tool_use block printed after message_stop is still a tool call", async () => {
    const messages = [{ role: "user", content: "reminders?" }];
    const first = await chatStream({ model: "claude-code/late", messages, tools: [REMINDERS] }, () => {}, () => {}, env);
    assert.equal(first.toolCalls.length, 1);
    messages.push({ role: "assistant", content: "", tool_calls: [] });
    messages.push({ role: "tool", tool_name: "reminders__list", content: "milk" });
    const second = await chatStream({ model: "claude-code/late", messages, tools: [REMINDERS] }, () => {}, () => {}, env);
    assert.match(second.text, /You have: milk/);
  });

  test("a Claude Code that says nothing is explained, not waited on, and stopped", async () => {
    const t0 = Date.now();
    await assert.rejects(
      chatStream({ model: "claude-code/silent", messages: [{ role: "user", content: "hi" }], tools: [] }, () => {}, () => {}, env),
      /Open Terminal, run `claude`, and sign in with \/login/);
    assert.ok(Date.now() - t0 < 8000, "the first-event limit, not the turn ceiling");
    await sleep(200);
    assert.equal(alive(runs().at(-1).pid), false, "the process was ended");
  });

  test("an error result from Claude Code reaches the window as an error", async () => {
    await assert.rejects(
      chatStream({ model: "claude-code/broken", messages: [{ role: "user", content: "hi" }], tools: [] }, () => {}, () => {}, env),
      /Claude Code: rate limited/);
  });

  test("aborting the turn ends the process", async () => {
    const ac = new AbortController();
    const run = chatStream({ model: "claude-code/silent", messages: [{ role: "user", content: "hi" }], tools: [], signal: ac.signal },
      () => {}, () => {}, { ...env, REFUGIO_CLAUDE_FIRST_EVENT_MS: "60000" });
    await sleep(500);
    const { pid } = runs().at(-1);
    assert.equal(alive(pid), true);
    ac.abort();
    await assert.rejects(run);
    await sleep(200);
    assert.equal(alive(pid), false);
  });

  test("a turn the runner abandons mid-tools is ended by the turn's signal", async () => {
    const ac = new AbortController();
    const messages = [{ role: "user", content: "reminders?" }];
    const first = await chatStream({ model: "claude-code/sonnet", messages, tools: [REMINDERS], signal: ac.signal }, () => {}, () => {}, env);
    assert.equal(first.toolCalls.length, 1);
    const { pid } = runs().at(-1);
    assert.equal(alive(pid), true, "waiting for the tool result");
    ac.abort();                       // what res.on("close") does when the turn ends at MAX_TOOL_ROUNDS
    await sleep(300);
    assert.equal(alive(pid), false);
  });
});

// ── The real server ─────────────────────────────────────────

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startChat(extraEnv) {
  const dataDir = mkdtempSync(join(tmpdir(), "refugio-cc-server-"));
  const port = await freePort();
  let output = "";
  const child = spawn(process.execPath, [join(ROOT, "chat", "server.js"), "--port", String(port)], {
    env: {
      ...process.env,
      OLLAMA_BASE_URL: "http://127.0.0.1:9",      // nothing there; no turn here uses Ollama
      REFUGIO_DATA_DIR: dataDir,
      REFUGIO_ENV_FILE: join(dataDir, "refugio.env"),
      REFUGIO_MCPO_CONFIG: join(dataDir, "no-mcp.json"),
      REFUGIO_TOOLS: "0",
      REFUGIO_CLAUDE_BIN: FAKE,
      REFUGIO_EDITION: "listener",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => { output += b; });
  child.stderr.on("data", (b) => { output += b; });
  const base = `http://127.0.0.1:${port}`;
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`chat server exited:\n${output}`);
    try { await fetch(`${base}/api/chat/status`, { signal: AbortSignal.timeout(500) }); break; } catch {}
    await sleep(100);
  }
  return { base, output: () => output, stop: () => { child.kill("SIGTERM"); rmSync(dataDir, { recursive: true, force: true }); } };
}

const events = (body) => [...body.matchAll(/^event: (\w+)\ndata: (.*)$/gm)].map(([, event, data]) => ({ event, data: JSON.parse(data) }));
async function ask(base, payload) {
  const res = await fetch(`${base}/api/chat/ask`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
  });
  return events(await res.text());
}

const setClaude = (base, enabled, headers = {}) => fetch(`${base}/api/chat/claude`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ enabled }),
});
const status = async (base) => (await fetch(`${base}/api/chat/status`)).json();

describe("the chat server where Claude Code is not installed", { skip: !sdk && "@modelcontextprotocol/sdk is not installed" }, () => {
  let chat;
  before(async () => { chat = await startChat({ REFUGIO_CLAUDE_BIN: "/nonexistent/claude" }); });
  after(() => chat.stop());

  test("Settings is told so, and the switch cannot be turned on", async () => {
    const s = await status(chat.base);
    assert.equal(s.claude.installed, false);
    assert.equal(s.claude.enabled, false);
    assert.deepEqual(s.cloudModels, []);
    const res = await setClaude(chat.base, true);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not installed/);
  });
});

// ── Installing Claude Code ──────────────────────────────────

const INSTALLER = join(ROOT, "test", "fixtures", "fake-claude-installer.sh");

test("a failed install says why, and installs nothing", async () => {
  chmodSync(INSTALLER, 0o755);
  const target = join(mkdtempSync(join(tmpdir(), "refugio-cc-inst-")), "bin", "claude");
  const env = { ...process.env, REFUGIO_CLAUDE_BIN: target, REFUGIO_CLAUDE_INSTALLER: INSTALLER,
    FAKE_INSTALL_TARGET: target, FAKE_INSTALL_FAIL: "1" };
  assert.equal(startClaudeInstall(env).started, true);
  for (let i = 0; i < 50 && claudeInstallState().state === "installing"; i++) await sleep(100);
  const st = claudeInstallState();
  assert.equal(st.state, "failed");
  assert.match(st.error, /exit 3.*could not reach downloads\.claude\.ai/);
  assert.equal(existsSync(target), false);
});

test("a claude that Anthropic did not sign is refused", (t) => {
  if (process.platform !== "darwin") return t.skip("codesign is macOS");
  // Node is signed, and not by Anthropic — or not signed for this
  // architecture. Either way it must not pass for Claude Code.
  assert.throws(() => verifyAnthropicSignature(process.execPath), /not Anthropic|did not verify/);
});

describe("the chat server, installing Claude Code on request", { skip: !sdk && "@modelcontextprotocol/sdk is not installed" }, () => {
  let chat;
  const target = join(mkdtempSync(join(tmpdir(), "refugio-cc-inst-srv-")), "bin", "claude");
  before(async () => {
    chmodSync(INSTALLER, 0o755);
    chat = await startChat({
      REFUGIO_CLAUDE_BIN: target, REFUGIO_CLAUDE_INSTALLER: INSTALLER,
      FAKE_INSTALL_TARGET: target, FAKE_CLAUDE_SCRIPT: FAKE,
    });
  });
  after(() => chat.stop());

  test("another page cannot start an install", async () => {
    const res = await fetch(`${chat.base}/api/chat/claude/install`, { method: "POST", headers: { Origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.equal(existsSync(target), false);
  });

  test("not installed → install → installed, with its version, and not switched on by it", async () => {
    let c = await (await fetch(`${chat.base}/api/chat/claude`)).json();
    assert.equal(c.installed, false);
    assert.equal(c.install.state, "idle");

    const r = await (await fetch(`${chat.base}/api/chat/claude/install`, { method: "POST" })).json();
    assert.equal(r.started, true);
    for (let i = 0; i < 100; i++) {
      c = await (await fetch(`${chat.base}/api/chat/claude`)).json();
      if (c.install.state !== "installing") break;
      await sleep(100);
    }
    assert.equal(c.install.state, "installed", JSON.stringify(c.install));
    assert.equal(c.installed, true);
    assert.equal(c.version, "2.1.104", JSON.stringify(c));
    assert.equal(c.enabled, false, "installing is not consent to send anything to Anthropic");

    const again = await (await fetch(`${chat.base}/api/chat/claude/install`, { method: "POST" })).json();
    assert.deepEqual(again, { started: false, installed: true }, "already there is a success, not a second install");
  });
});

describe("the chat server, Claude switched off (the default)", { skip: !sdk && "@modelcontextprotocol/sdk is not installed" }, () => {
  let chat;
  const authFile = join(mkdtempSync(join(tmpdir(), "refugio-cc-auth-")), "signed-in");
  before(async () => { chmodSync(FAKE, 0o755); chat = await startChat({ FAKE_CLAUDE_AUTH: authFile }); });
  after(() => chat.stop());

  test("signing in is Claude Code's own: REFUGIO starts it, then reads whether it worked", async () => {
    let c = await (await fetch(`${chat.base}/api/chat/claude`)).json();
    assert.equal(c.installed, true);
    assert.equal(c.signedIn, false);
    assert.equal(c.email, null, "nothing about an account that is not signed in");

    const res = await fetch(`${chat.base}/api/chat/claude/login`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).started, true);
    await sleep(800);                       // the fake signs in at once; the real one waits on a browser

    c = await (await fetch(`${chat.base}/api/chat/claude?fresh=1`)).json();
    assert.equal(c.signedIn, true);
    assert.equal(c.plan, "pro");
    assert.equal(c.enabled, false, "signing in does not switch Claude on — that stays the person's choice");
  });

  test("another page cannot start a sign-in", async () => {
    const res = await fetch(`${chat.base}/api/chat/claude/login`, { method: "POST", headers: { Origin: "https://evil.example" } });
    assert.equal(res.status, 403);
  });

  test("off by default: no Claude in the picker, and Settings knows Claude Code is here", async () => {
    const s = await status(chat.base);
    assert.equal(s.claude.enabled, false);
    assert.equal(s.claude.installed, true);
    assert.equal(s.claude.version, "2.1.104");
    assert.match(s.claude.warning, /sent to Anthropic/);
    assert.deepEqual(s.cloudModels, []);
  });

  test("a Claude Code turn is refused, and nothing is stored", async () => {
    const ev = await ask(chat.base, { message: "hello", model: "claude-code/sonnet", conversation_id: "offconvo" });
    assert.deepEqual(ev.map((e) => e.event), ["error"], JSON.stringify(ev));
    assert.match(ev[0].data.error, /switched off in Settings/);
    const res = await fetch(`${chat.base}/api/chat/conversations/offconvo`);
    assert.notEqual(res.status, 200, "no conversation was created");
  });

  test("another page cannot switch it on", async () => {
    const res = await setClaude(chat.base, true, { Origin: "https://evil.example" });
    assert.equal(res.status, 403);
    assert.equal((await status(chat.base)).claude.enabled, false);
  });
});

describe("the chat server, Claude switched on in Settings", { skip: !sdk && "@modelcontextprotocol/sdk is not installed" }, () => {
  let chat;
  let modeId = null;
  // The fake writes its argv here; the server passes its environment through.
  const log = join(mkdtempSync(join(tmpdir(), "refugio-cc-sys-")), "runs.jsonl");
  before(async () => {
    chmodSync(FAKE, 0o755);
    chat = await startChat({ FAKE_CLAUDE_LOG: log });
    const res = await setClaude(chat.base, true);
    assert.equal(res.status, 200, chat.output());
    const { modeDef, modeOffered } = await import("../chat/modes.js");
    for (const id of ["nvc", "styles", "career", "life", "listener", "spanish"]) {
      if (!modeOffered(id, "listener") || modeDef(id)?.requiresConnector) continue;
      const r = await fetch(`${chat.base}/api/chat/modes`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: id, enabled: true }),
      });
      if (r.ok) { modeId = id; break; }
    }
  });
  after(() => chat.stop());

  test("the picker is offered Claude, apart from the local models", async () => {
    const s = await status(chat.base);
    assert.equal(s.claude.enabled, true);
    assert.deepEqual(s.cloudModels.map((m) => [m.name, m.label, m.cloud]), [
      ["claude-code/sonnet", "Claude Sonnet", true],
      ["claude-code/opus", "Claude Opus", true],
      ["claude-code/haiku", "Claude Haiku", true],
    ]);
    assert.ok(!s.models.some((m) => m.name.startsWith("claude-code/")), "not mixed into the local list");
    assert.equal(s.available, true, "Claude can answer with Ollama down");
  });

  test("a turn streams from Claude Code, the answer is stored, and no Claude run is spent on the title", async () => {
    const ev = await ask(chat.base, { message: "hello there friend", model: "claude-code/haiku" });
    const text = ev.filter((e) => e.event === "token").map((e) => e.data.t).join("");
    assert.match(text, /^Hello from Claude\. You said: hello/, chat.output());
    assert.equal(ev.at(-1).event, "done");
    assert.equal(ev.at(-1).data.title, "hello there friend");
    const cid = ev[0].data.conversation_id;
    const convo = await (await fetch(`${chat.base}/api/chat/conversations/${cid}`)).json();
    assert.deepEqual(convo.messages.map((m) => [m.role, m.model]), [["user", null], ["assistant", "claude-code/haiku"]]);
  });

  test("Claude is told it is not on this computer, so it never says it is", async () => {
    await ask(chat.base, { message: "where am I?", model: "claude-code/sonnet" });
    const { argv } = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
    const system = argv[argv.indexOf("--system-prompt") + 1];
    assert.match(system, /not running on the user's computer/);
    assert.match(system, /sent to Anthropic/);
    assert.doesNotMatch(system, /running entirely on the user's own computer/);
  });

  test("a discussion mode refuses Claude even when it is switched on", async (t) => {
    if (!modeId) return t.skip("no coaching mode offered");
    const ev = await ask(chat.base, { message: "I am upset", model: "claude-code/sonnet", mode: modeId });
    assert.deepEqual(ev.map((e) => e.event), ["error"]);
    assert.match(ev[0].data.error, /Modes only use the model on this computer/);
  });

  test("switched back off, the picker loses Claude and turns are refused again", async () => {
    assert.equal((await setClaude(chat.base, false)).status, 200);
    assert.deepEqual((await status(chat.base)).cloudModels, []);
    const ev = await ask(chat.base, { message: "hello", model: "claude-code/sonnet" });
    assert.deepEqual(ev.map((e) => e.event), ["error"]);
  });
});
