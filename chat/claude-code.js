// Claude, through the person's own Claude Code — the subscription route.
//
// Anthropic's terms do not let a third-party app offer Claude.ai login or hold
// its tokens (docs/pi-ai-spike.md §4). They do allow a person to sign in to the
// unmodified Claude Code binary with their own subscription. So this engine
// never signs anyone in and never sees a token: it runs the `claude` the person
// installed and signed in to themselves, and reads what it prints.
//
// Claude Code is used as a MODEL, not as an agent:
//   - its built-in tools are blocked (`--disallowedTools`, checked against the
//     init event every turn) and denied if offered anyway (`dontAsk`), so it
//     cannot read files, run commands, browse or schedule; the only tools it
//     can use are the ones REFUGIO offered for this turn, through
//     chat/claude-code-bridge.mjs
//   - every tool call comes back out of chatStream() as a tool call, exactly as
//     Ollama's do, and REFUGIO's turn runner runs it — runTool, the web arming
//     check, the mode check, the tool budget. The result goes back to Claude
//     Code on the next chatStream() call for the same turn
//   - its system prompt is REFUGIO's (`--system-prompt` replaces Claude Code's),
//     and the person's own Claude Code settings, hooks, skills and MCP servers
//     are not loaded (`--setting-sources ""`, `--strict-mcp-config`)
//   - nothing is saved as a Claude Code session (`--no-session-persistence`)
//
// One process per turn. The turn runner calls chatStream() once per round with
// the same `messages` array, pushing the assistant's tool calls and then one
// `tool` message per result; that array is the key that finds the live process.
// The turn's AbortSignal fires when the response closes — normally or not — and
// that is what ends the process.
//
// What is said goes over stdin, never on the command line: argv is readable by
// every user on the machine through `ps`, and a conversation is not.

import { spawn, execFileSync } from "child_process";
import http from "http";
import { randomBytes } from "crypto";
import { existsSync, mkdtempSync, rmSync, realpathSync } from "fs";
import { tmpdir, homedir } from "os";
import { join, dirname, delimiter } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, "claude-code-bridge.mjs");
const PREFIX = "claude-code/";
const MCP_PREFIX = "mcp__refugio__";

/**
 * Claude Code's own tools, every name seen in any version REFUGIO was run
 * against, all blocked. A name a version does not have is ignored.
 *
 * A list will always lag Claude Code, so it is not the only guard. Every turn
 * reads the init event's tool list (checkInit): anything there that is not
 * REFUGIO's is logged and joins the list for the next turn — the first turn of
 * a new version is the only one that can be offered something new. And on that
 * turn it still cannot run: --permission-mode dontAsk denies every tool that
 * --allowedTools did not name, and that names only REFUGIO's.
 */
const BUILTIN_TOOLS = [
  "Task", "Agent", "TaskOutput", "TaskStop", "Bash", "BashOutput", "KillShell", "Glob", "Grep", "LS",
  "Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "NotebookRead", "WebFetch", "WebSearch",
  "TodoWrite", "TodoRead", "Skill", "SlashCommand", "ToolSearch", "ExitPlanMode", "EnterPlanMode",
  "AskUserQuestion", "LSP", "CronCreate", "CronDelete", "CronList", "EnterWorktree", "ExitWorktree",
  "Monitor", "RemoteTrigger", "ScheduleWakeup",
];
const learned = new Set();

export function blockedTools() {
  return [...new Set([...BUILTIN_TOOLS, ...learned])];
}

/** The init event's tools that are not REFUGIO's. Learned, so the next turn
 *  blocks them; returned, so the caller can say so. */
export function checkInit(evt, log = (m) => console.warn(`[claude-code] ${m}`), offeredTools = false) {
  const bridge = (evt.mcp_servers ?? []).find((s) => s.name === "refugio");
  if (offeredTools && bridge?.status !== "connected") {
    log(`the tool bridge was "${bridge?.status ?? "absent"}" when Claude Code started this turn; the model may not see REFUGIO's tools`);
  }
  const extra = (evt.tools ?? []).filter((t) => !String(t).startsWith(MCP_PREFIX));
  const fresh = extra.filter((t) => !learned.has(t));
  for (const t of fresh) learned.add(t);
  if (fresh.length) log(`Claude Code offered tools REFUGIO did not block: ${fresh.join(", ")} — blocked from the next turn; denied on this one`);
  return extra;
}

/** The models offered. Aliases, so "sonnet" is whatever Claude Code calls the
 *  current Sonnet — REFUGIO does not track Anthropic's model ids. */
export const CLAUDE_CODE_MODELS = ["claude-code/sonnet", "claude-code/opus", "claude-code/haiku"];

/** What the picker shows for each. The label is Anthropic's model family; the
 *  route is said once, in the section heading, not on every row. */
export const CLAUDE_CODE_LABELS = {
  "claude-code/sonnet": "Claude Sonnet",
  "claude-code/opus": "Claude Opus",
  "claude-code/haiku": "Claude Haiku",
};

/** The Settings copy, from here so the switch and the engine cannot disagree
 *  about what the engine does. Shaped like WEB_SEARCH_UI. */
export const CLAUDE_CODE_UI = {
  label: "Offer Claude in the model picker",
  hint:
    "Uses Claude Code, signed in with your own Claude account, as a model. REFUGIO never " +
    "sees your Claude login and never asks for it.",
  warning:
    "When you choose a Claude model, the whole conversation — your messages, files you " +
    "attach, and what your connectors return to it — is sent to Anthropic. Local models " +
    "are unaffected, and no mode ever uses Claude.",
  usage:
    "It counts against your Claude plan's usage, the same as using Claude Code yourself.",
};

/** Whether Claude Code is here, and which. Cheap after the first call: the
 *  version is cached per path. */
export function claudeCodeInfo(env = process.env) {
  const path = findClaude(env);
  if (!path) return { installed: false, path: null, version: null, tested: false };
  const v = claudeVersion(path, env);
  return {
    installed: true,
    path,
    version: v ? v.join(".") : null,
    tested: !!v && compareVersions(v, TESTED_FROM) >= 0,
    testedFrom: TESTED_FROM.join("."),
  };
}

export function isClaudeCodeModel(name) {
  return String(name || "").startsWith(PREFIX);
}

/** Where `claude` is. A login item does not get the person's shell PATH, so
 *  the places the installer puts it are checked by name. Null if absent. */
export function findClaude(env = process.env, versionOf = claudeVersion) {
  if (env.REFUGIO_CLAUDE_BIN) return existsSync(env.REFUGIO_CLAUDE_BIN) ? env.REFUGIO_CLAUDE_BIN : null;
  const dirs = [
    ...(env.PATH || "").split(delimiter),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  // Every install, not the first on PATH, and the newest wins. Found on a real
  // Mac: ~/.local/bin held 2.1.20 ahead of /usr/local/bin's 2.1.104, and 2.1.20
  // starts the bridge but never offers its tools to the model.
  const seen = new Set();
  let best = null;
  for (const d of dirs) {
    if (!d) continue;
    const p = join(d, process.platform === "win32" ? "claude.exe" : "claude");
    if (!existsSync(p)) continue;
    let real;
    try { real = realpathSync(p); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    const v = versionOf(p, env);
    if (!best || compareVersions(v, best.v) > 0) best = { p, v };
  }
  if (best && best.v && compareVersions(best.v, TESTED_FROM) < 0 && !warnedOld) {
    warnedOld = true;
    console.warn(`[claude-code] using Claude Code ${best.v.join(".")} at ${best.p}; tool calls are tested from ${TESTED_FROM.join(".")} — 2.1.20 does not offer REFUGIO's tools to the model. Run \`claude update\`.`);
  }
  return best?.p ?? null;
}

/** The oldest version a full tool round trip was seen working on. */
const TESTED_FROM = [2, 1, 104];
let warnedOld = false;

const versions = new Map();
/** `claude --version`, parsed, cached per path. Null if it will not say. */
function claudeVersion(p, env) {
  if (versions.has(p)) return versions.get(p);
  let v = null;
  try {
    const out = execFileSync(p, ["--version"], { env: ownSessionEnv(env), timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).toString();
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    if (m) v = m.slice(1).map(Number);
  } catch { /* an install that cannot report a version loses to one that can */ }
  versions.set(p, v);
  return v;
}

export function compareVersions(a, b) {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** How long to wait for Claude Code's first word before saying why. A Claude
 *  Code whose login has expired retries a 401 in silence — about twenty
 *  seconds on 2.1.20, then an error result — and a hung one never answers;
 *  either way the turn should not sit at the thirty-minute ceiling. */
function firstEventMs(env = process.env) {
  const n = Number(env.REFUGIO_CLAUDE_FIRST_EVENT_MS);
  return Number.isFinite(n) && n > 0 ? n : 60000;
}

function mcpWaitMs(env = process.env) {
  const n = Number(env.REFUGIO_CLAUDE_MCP_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15000;
}

function settleMs(env = process.env) {
  const n = Number(env.REFUGIO_CLAUDE_MCP_SETTLE_MS);
  return Number.isFinite(n) && n >= 0 && env.REFUGIO_CLAUDE_MCP_SETTLE_MS !== "" && env.REFUGIO_CLAUDE_MCP_SETTLE_MS != null ? n : 500;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

const NOT_SIGNED_IN =
  "Claude Code did not answer — its sign-in may have expired. Open Terminal, run `claude`, " +
  "and sign in with /login (opening it is not enough: an expired login still looks signed in). " +
  "REFUGIO never asks for your Claude account.";

/**
 * The environment `claude` runs in: REFUGIO's, minus anything a PARENT Claude
 * Code session put there.
 *
 * When REFUGIO is started from inside Claude Code — a terminal in the desktop
 * app, a dev session — it inherits that session's plumbing: CLAUDECODE, a set
 * of CLAUDE_CODE_* session ids and sockets, OAuth switches, and an
 * ANTHROPIC_BASE_URL pointing at the host's own endpoint. The child then sends
 * the person's login there and is refused with a 401 it retries in silence.
 * Found exactly that way: signed in, and every turn failed.
 *
 * ANTHROPIC_BASE_URL is only removed when CLAUDECODE says it was inherited. Set
 * by the person themselves — a company gateway — it is theirs and stays.
 */
export function ownSessionEnv(env) {
  const out = { ...env };
  const inherited = "CLAUDECODE" in env;
  for (const k of Object.keys(out)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k.startsWith("CLAUDE_AGENT_SDK")
      || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT" || k.startsWith("CLAUDE_PREVIEW_")
      || k === "USE_LOCAL_OAUTH" || k === "USE_STAGING_OAUTH"
      || (inherited && k === "ANTHROPIC_BASE_URL")) {
      delete out[k];
    }
  }
  return out;
}

// ── Prompt ──────────────────────────────────────────────────

/** Split the runner's messages into REFUGIO's system prompt and the one user
 *  message Claude Code is sent. Earlier turns are text (the store keeps no
 *  tool calls), so they travel as a transcript inside that message. */
export function toPrompt(messages) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const last = turns.length - 1 - [...turns].reverse().findIndex((m) => m.role === "user");
  const latest = turns[last]?.content ?? "";
  const before = turns.slice(0, Math.max(0, last));
  if (!before.length) return { system, prompt: latest };
  const transcript = before
    .map((m) => `${m.role === "user" ? "Person" : "You"}: ${m.content}`)
    .join("\n\n");
  return {
    system,
    prompt: `<conversation_so_far>\n${transcript}\n</conversation_so_far>\n\n${latest}`,
  };
}

// ── The bridge's other end ──────────────────────────────────

/** A loopback endpoint the bridge calls: the turn's tool list, and tool calls
 *  that wait until the turn runner has a result. Bearer token per turn, so
 *  another local process cannot feed this turn tool results. */
function openBridge(tools) {
  const token = randomBytes(24).toString("hex");
  const waiting = [];          // calls from Claude Code with no result yet
  let markListed;
  const listed = new Promise((r) => { markListed = r; });
  const results = [];          // results from the runner with no call yet
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end(); }
    if (req.method === "GET" && req.url === "/tools") {
      markListed();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        tools: tools.map((t) => ({
          name: t.function.name,
          description: t.function.description ?? "",
          inputSchema: t.function.parameters ?? { type: "object", properties: {} },
        })),
      }));
    }
    if (req.method === "POST" && req.url === "/call") {
      let raw = "";
      req.on("data", (b) => { raw += b; });
      req.on("end", () => {
        const reply = (r) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(r));
        };
        if (results.length) return reply(results.shift());
        waiting.push(reply);
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  // Results are matched to calls by order: Claude Code runs a round's tools in
  // the order it asked for them, and the runner answers in the same order.
  const answer = (r) => (waiting.length ? waiting.shift()(r) : results.push(r));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    answer,
    listed,
    close: () => { for (const w of waiting.splice(0)) w({ text: "Error: the turn ended", isError: true }); server.close(); },
  })));
}

// ── One turn ────────────────────────────────────────────────

const sessions = new WeakMap();

class Turn {
  constructor({ bin, model, messages, tools, signal, env }) {
    this.events = [];
    this.wake = null;
    this.exited = false;
    this.stderr = "";
    this.seen = 0;
    this.env = env;
    this.ready = this.#start({ bin, model, messages, tools, signal, env });
  }

  async #start({ bin, model, messages, tools, signal, env }) {
    this.hasTools = tools.length > 0;
    this.bridge = await openBridge(tools);
    this.dir = mkdtempSync(join(tmpdir(), "refugio-claude-"));
    const { system, prompt } = toPrompt(messages);

    const mcpConfig = {
      mcpServers: {
        refugio: {
          command: process.execPath,
          args: [BRIDGE],
          env: {
            REFUGIO_BRIDGE_URL: this.bridge.url,
            REFUGIO_BRIDGE_TOKEN: this.bridge.token,
            ...(env.REFUGIO_BRIDGE_TRACE ? { REFUGIO_BRIDGE_TRACE: env.REFUGIO_BRIDGE_TRACE } : {}),
          },
        },
      },
    };
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--model", model.slice(PREFIX.length),
      // Not `--tools ""`: on 2.1.20 and 2.1.104 any --tools flag also hides MCP
      // tools from the model, so REFUGIO's never reach it. Claude Code's own
      // tools are blocked by name instead, and the init event is checked.
      "--disallowedTools", blockedTools().join(","),
      "--system-prompt", system,
      "--setting-sources", "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--disable-slash-commands",
      // REFUGIO's tools are allowed without a prompt and nothing else is: there
      // is no one at a terminal to answer one.
      "--permission-mode", "dontAsk",
      "--allowedTools", "mcp__refugio",
      ...(tools.length ? ["--mcp-config", JSON.stringify(mcpConfig)] : []),
    ];

    const childEnv = ownSessionEnv(env);
    // A tool call is held open while REFUGIO runs it; Claude Code must not give
    // up on it first.
    childEnv.MCP_TOOL_TIMEOUT ||= "600000";

    this.proc = spawn(bin, args, { cwd: this.dir, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    // Not yet. Claude Code connects MCP servers in the background and does not
    // wait for them before its first request, so a message written now goes to
    // the model with no tools — the bridge "pending" in the init event, and the
    // model saying it has no access to anything. Measured on 2.1.104.
    //
    // Two waits. First for the bridge to be asked for its tool list, which is
    // when Claude Code has connected. That alone was not enough: the list had
    // been served and the init event still said "pending". Then a short settle,
    // which on 2.1.104 made it "connected" every time at 300 ms and 1500 ms;
    // 500 is the default for margin. Both bounded, so a Claude Code that never
    // connects still answers — without tools, and logged by checkInit.
    if (tools.length) {
      const waitMs = mcpWaitMs(env);
      const ok = await Promise.race([this.bridge.listed.then(() => true), sleep(waitMs).then(() => false)]);
      if (ok) await sleep(settleMs(env));
      else console.warn(`[claude-code] the tool bridge was not connected after ${waitMs} ms; sending without tools`);
    }
    if (!this.closed) {
      this.proc.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
    }

    let buf = "";
    this.proc.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { this.#push(JSON.parse(line)); } catch { /* not ours to interpret */ }
      }
    });
    this.proc.stderr.on("data", (d) => { this.stderr = (this.stderr + d).slice(-2000); });
    this.proc.on("error", (e) => this.#push({ type: "_exit", error: e.message }));
    this.proc.on("close", (code) => { this.exited = true; this.#push({ type: "_exit", code }); });

    const stop = () => this.close();
    if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
  }

  #push(evt) {
    this.events.push(evt);
    const w = this.wake; this.wake = null; w?.();
  }

  async #next(deadlineMs) {
    while (!this.events.length) {
      let timer;
      const woke = new Promise((r) => { this.wake = r; });
      const timeout = deadlineMs ? new Promise((r) => { timer = setTimeout(() => r("timeout"), deadlineMs); }) : null;
      const why = await (timeout ? Promise.race([woke, timeout]) : woke);
      clearTimeout(timer);
      if (why === "timeout") return { type: "_timeout" };
    }
    return this.events.shift();
  }

  /** Read until the model finishes a message that asks for tools, or the run
   *  ends. One call per round of the turn runner. */
  async round(onToken, onThinking, signal) {
    await this.ready;
    let text = "";
    const toolCalls = [];
    let usage = { promptTokens: null, evalTokens: null, doneReason: null };
    let heard = this.heardAnything;

    while (true) {
      const evt = await this.#next(heard ? 0 : firstEventMs(this.env));
      if (signal?.aborted) throw abortError(signal);
      if (evt.type === "_timeout") { this.close(); throw new Error(NOT_SIGNED_IN); }
      if (evt.type === "system" && evt.subtype === "init") { this.offered = checkInit(evt, undefined, this.hasTools); continue; }
      if (evt.type !== "system") { heard = this.heardAnything = true; }

      if (evt.type === "stream_event") {
        const e = evt.event ?? {};
        if (e.type === "message_start") {
          const u = e.message?.usage ?? {};
          usage.promptTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        } else if (e.type === "content_block_delta") {
          if (e.delta?.type === "text_delta" && e.delta.text) { text += e.delta.text; onToken(e.delta.text); }
          else if (e.delta?.type === "thinking_delta" && e.delta.thinking) onThinking(e.delta.thinking);
        } else if (e.type === "message_delta") {
          if (Number.isFinite(e.usage?.output_tokens)) usage.evalTokens = e.usage.output_tokens;
          const stop = e.delta?.stop_reason;
          if (stop) usage.doneReason = stop === "max_tokens" ? "length" : "stop";
          if (stop === "tool_use") this.expectTools = true;
        } else if (e.type === "message_stop" && this.expectTools) {
          this.expectTools = false;
          // The tool_use blocks arrive as `assistant` events, which may come
          // before or after this. Return with every call the message made, or
          // wait for the first of them.
          if (this.calls?.length) return { text, toolCalls: this.takeCalls(), usage };
          this.awaitCalls = true;
        }
        continue;
      }

      if (evt.type === "assistant") {
        for (const b of evt.message?.content ?? []) {
          if (b.type === "tool_use" && String(b.name).startsWith(MCP_PREFIX)) {
            (this.calls ??= []).push({ name: b.name.slice(MCP_PREFIX.length), args: b.input ?? {} });
          }
        }
        if (this.awaitCalls && this.calls?.length) {
          this.awaitCalls = false;
          return { text, toolCalls: this.takeCalls(), usage };
        }
        continue;
      }

      if (evt.type === "result") {
        // Signed out (or expired), Claude Code retries for about twenty seconds
        // and then ends with this — as an error result with "success" as its
        // subtype, after a synthetic assistant message saying the same.
        if (evt.is_error && /run \/login|Invalid API key/i.test(evt.result || "")) throw new Error(NOT_SIGNED_IN);
        if (evt.is_error) throw new Error(`Claude Code: ${evt.result || evt.subtype || "the request failed"}`);
        return { text, toolCalls: [], usage };
      }

      if (evt.type === "_exit") {
        if (evt.error) throw new Error(`Could not start Claude Code: ${evt.error}`);
        throw new Error(`Claude Code stopped (exit ${evt.code})${this.stderr ? `: ${this.stderr.trim().split("\n").at(-1)}` : ""}`);
      }
    }
  }

  takeCalls() {
    const out = this.calls ?? [];
    this.calls = [];
    return out;
  }

  /** Hand the runner's tool results to the calls Claude Code is waiting on. */
  feed(messages) {
    for (const m of messages.slice(this.seen)) {
      if (m.role === "tool") {
        const text = String(m.content ?? "");
        this.bridge.answer({ text, isError: text.startsWith("Error") });
      }
    }
    this.seen = messages.length;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { if (!this.exited) this.proc?.kill("SIGTERM"); } catch {}
    this.bridge?.close();
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Same contract as chat/ollama.js chatStream. */
export async function chatStream({ model, messages, tools = [], signal }, onToken, onThinking = () => {}, env = process.env) {
  let turn = sessions.get(messages);
  if (!turn) {
    const bin = findClaude(env);
    if (!bin) throw new Error("Claude Code is not installed on this computer, so Claude models are unavailable.");
    turn = new Turn({ bin, model, messages, tools, signal, env });
    sessions.set(messages, turn);
  } else {
    turn.feed(messages);
  }
  try {
    const out = await turn.round(onToken, onThinking, signal);
    turn.seen = messages.length;
    if (!out.toolCalls.length) { turn.close(); sessions.delete(messages); }
    return out;
  } catch (e) {
    turn.close();
    sessions.delete(messages);
    throw e;
  }
}

/** One-shot completion (conversation titles). No tools, no stream to the UI. */
export async function complete({ model, messages, signal }, env = process.env) {
  const { text } = await chatStream({ model, messages: [...messages], tools: [], signal }, () => {}, () => {}, env);
  return text;
}

function abortError(signal) {
  const e = new Error(signal?.reason?.message || "aborted");
  e.name = "AbortError";
  return e;
}
