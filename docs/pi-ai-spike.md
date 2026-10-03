# Spike — pi-ai as REFUGIO's model layer, and Claude through Claude Code

**Status:** spike, on a branch · **Date:** 2026-10-03 · **Question:** can
[pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) replace the
hand-rolled Ollama client, so that REFUGIO can offer cloud models (Claude
first) without owning a client per provider?

**Short answer:** for local models and for Claude **with an API key**, yes —
the seam is two functions and everything above it was untouched. For Claude
**with a Pro/Max subscription**, not through pi-ai: Anthropic's terms forbid it
(§4). There is a permitted subscription route, and it is not pi-ai.

---

## 1. What was built

| File | What it is |
|---|---|
| `chat/engine.js` | `chatStream` and `complete`, with the signatures and return shapes of `chat/ollama.js`. `anthropic/<id>` goes to Anthropic through pi-ai; any other name is local. Local models stay on the native client unless `REFUGIO_ENGINE_LIB=pi`. |
| `chat/server.js` | One import changed. Nothing else. |
| `test/engine.test.js` | 11 tests against a fake Ollama `/v1`: translation, streaming, thinking, tool rounds, `length`, aborts — and the real `chat/server.js` spawned on the pi-ai path for a plain turn, a coaching mode, the turn ceiling and a closed tab. |
| `scripts/engine-probe.mjs` | The same tool round through both paths against real models, side by side. |

The turn runner keeps building Ollama-shaped messages and `engine.js`
translates them per call. That is why the history store, the tool budget, the
modes and the crisis floor needed no change: none of them know which engine ran.

## 2. What was measured

On this machine (Ollama 0.34.4), one reminders tool round and an answer:

| Model | Native | pi-ai |
|---|---|---|
| qwen2.5:3b | tool called, answered · prompt 158/214 | same call, same answer · prompt 158/214 |
| qwen2.5:7b | tool called, answered · prompt 158/211 | identical |
| qwen3:4b (thinking) | tool called, answered · thinking streamed | same · thinking streamed |

Warm-model timing is a wash (≈3.0 s vs ≈2.9 s for qwen2.5:3b). The first runs
looked 5–6× faster on pi-ai; that was model load landing on whichever path ran
first, not the library.

The full suite passes with the swap in place: **387/387**, native as default.
`test/engine.test.js` was run six times; one early run failed to start the
spawned server within 10 s and did not reproduce in five runs after it.

## 3. What pi-ai got wrong, and what was done about it

1. **A keyless local server is refused.** The README's Ollama example
   (`auth: {}`) fails on 1.0.1 with `No API key for provider: ollama` — the
   OpenAI-compatible client insists on a key. A placeholder key fixes it;
   Ollama ignores it.
2. **Prompt tokens exclude the cached part.** pi-ai's `usage.input` is the
   prompt minus what the server answered from its cache, and Ollama reuses its
   KV cache across rounds, so `input` read **1** and **3** where native read
   158 and 205. The eval and the round log use this number to tell whether a
   turn ran out of room, so `engine.js` reports `input + cacheRead +
   cacheWrite`. Pinned by a test.
3. **Stop reasons are pi-ai's, not Ollama's.** A tool round is `toolUse` there
   and `stop` in Ollama; `engine.js` maps it back so the log line compares
   across engines. `length` survives as `length`.

Things that worked without help: streamed tool-call arguments arrive whole;
`reasoning_content` streams as thinking and never as text; no tools offered
means no `tools` field sent (what a coaching mode relies on); an abort closes
the upstream request, from the signal, the turn ceiling and a closed tab alike.

## 4. Claude with a subscription: not through pi-ai

pi-ai ships a Claude Pro/Max OAuth login (`models.login('anthropic', 'oauth')`).
Building it into REFUGIO would break Anthropic's terms. From
[Claude Code — Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
*Authentication and credential use*:

- third-party developers may not "offer Claude.ai login into their own
  applications", nor "route requests through Free, Pro, or Max plan credentials
  on behalf of their users";
- developers "may not collect, store, or intermediate Claude.ai credentials or
  session tokens — sign-in to a Claude account must complete through
  Anthropic's own flow";
- Anthropic "may [enforce these restrictions] without prior notice".

pi-ai's flow does exactly the first two and stores the token. For a product
installed on other people's machines, the risk is their accounts, not ours.
**Not built.**

What the same page leaves open: an end user "signing in to the unmodified
Claude Code binary with their own Claude subscription". So the subscription
route is a third engine behind the same seam — REFUGIO spawns the person's own
`claude` (`-p`, streaming JSON output, its built-in tools switched off,
REFUGIO's connectors handed over as MCP config) and never sees a token.
Usage limits for Pro/Max "assume ordinary, individual usage", which a personal
chat window is, but this is worth confirming with Anthropic before it ships to
a fleet. It does not use pi-ai at all.

## 5. The Claude Code engine (built)

`chat/claude-code.js` runs the person's own signed-in `claude` as a model.
Pick it with a model name of `claude-code/sonnet`, `claude-code/opus` or
`claude-code/haiku` (per request, or as `REFUGIO_CHAT_MODEL`).

**What Claude Code is allowed to do.** Nothing of its own. Its built-in tools are
blocked by name (`--disallowedTools`), the init event is checked every turn for
anything the list missed, and anything offered anyway is denied (`--permission-mode
dontAsk`, with only `mcp__refugio` allowed); REFUGIO's system prompt replaces its own; the person's
Claude Code settings, hooks, skills and MCP servers are not loaded
(`--setting-sources ""`, `--strict-mcp-config`); it runs in an empty folder, so
no `CLAUDE.md` is read; nothing is saved as a session. Its only tools are the
ones REFUGIO offered for this turn, through `chat/claude-code-bridge.mjs`.

**Who runs the tools.** REFUGIO does. The bridge does not execute anything: a
tool call comes back out of `chatStream()` as a tool call, the turn runner runs
it — `runTool`, the web arming check, the mode check, the tool budget, the
Sources panel — and the result goes back to Claude Code on the next round.
Claude Code is the model; REFUGIO stays the agent.

**What leaves the machine, and how.** The conversation goes to Anthropic, under
the person's own subscription. It goes to `claude` over stdin, never on the
command line, because argv is readable by every user through `ps`. REFUGIO
never sees, stores or asks for a Claude credential.

**Consent.**
- Off until `REFUGIO_CLAUDE_CODE=1`. A refused turn stores nothing.
- Never in a discussion mode, switched on or not: a mode promises the
  conversation stays on this computer.
- Both rules are enforced in `streamTurn` before anything is written, and are
  tested through the real server.

**Signed out.** Claude Code 2.1.20, signed out or expired, retries the 401 for
about twenty seconds and then ends with "Invalid API key · Please run /login"
as an error result. The engine turns that — or sixty seconds of silence
(`REFUGIO_CLAUDE_FIRST_EVENT_MS`) — into "open Terminal, run `claude`, and sign
in". REFUGIO never offers the sign-in itself.

**Verified, signed in, on Claude Code 2.1.104.** A full turn as REFUGIO runs
it, no overrides: Sonnet called `reminders__list`, the call came out to the
turn runner, the result went back, and the answer used it — 692 prompt
tokens, about 6–12 s, no process left behind. The init event listed exactly one
tool, `mcp__refugio__reminders__list`. 17 tests against a fake `claude` that
speaks real MCP to the bridge cover the rest (flags, stdin-only prompt, both
event orders, sign-in message, errors, abort, an abandoned turn, the server's
consent rules).

**What getting there found** — each now handled and tested:

| Finding | Fix |
|---|---|
| Any `--tools` flag (even `""`, even naming the MCP tool) also hides MCP tools from the model. It answered "I don't have access to any tools". | Built-ins blocked by name with `--disallowedTools`, not `--tools`. |
| A hand-written block list missed eight 2.1.104 tools, among them `CronCreate`, `RemoteTrigger`, `ScheduleWakeup` (5,934 prompt tokens). | List extended; the init event is checked every turn and any unblocked tool is logged and blocked from the next turn; `dontAsk` denies it on the first. |
| Claude Code connects MCP servers in the background and does not wait before its first request: bridge "pending", model sees no tools. Being asked for the tool list was not enough either. | The message is written only after the bridge is asked for its tools, plus a 500 ms settle (`REFUGIO_CLAUDE_MCP_SETTLE_MS`). 300 ms and 1,500 ms both gave "connected" every time. A bridge not connected at init is logged. |
| 2.1.20 starts the bridge and lists its tools, but never offers them to the model. `~/.local/bin` held 2.1.20 ahead of `/usr/local/bin`'s 2.1.104 on `PATH`. | `findClaude` checks every install and takes the newest; older than 2.1.104 is logged with "run `claude update`". |
| Started from inside the Claude desktop app, the child inherited the host session's `ANTHROPIC_BASE_URL`, OAuth switches and `CLAUDE_CODE_*` ids, and sent the login there (401). | A parent session's variables are removed when `CLAUDECODE` says they were inherited; a gateway the person set is kept. |
| An expired login still looks signed in when `claude` opens; Claude Code retries the 401 for about 20 s, then "Invalid API key · Please run /login". | The window says the login may have expired and to sign in with `/login`. |

**Cost of the wait.** Every turn that offers tools pays for the bridge to start
and settle, about 0.7 s, before the model is asked anything.

**Not built.** A Settings switch (with the web-search-style warning) in place
of the environment variable; the models in the picker; anything for the MDM
packages. Claude Code is a per-user install and sign-in, so a managed fleet
would need its own answer.

## 6. Cost of going further

| Item | Cost |
|---|---|
| Dependency | `@earendil-works/pi-ai` 1.0.1, **63 packages, 88 MB** on disk (the OpenAI, Anthropic, Google, Mistral and AWS SDKs come whether used or not). Provider SDKs load lazily, so RAM is not the issue; the install size is, against a pitch of "~50 MB". Node ≥ 22.19. |
| Churn | The package moved scope this year (`@mariozechner/pi-ai` is deprecated); 1.0.1 published today. Pin exact, read changelogs. |
| Telemetry | It depends on `@earendil-works/pi-telemetry`. The installed build contains no network calls (contracts and a no-op), but a privacy product should re-check on every bump. |
| Product work | A key field in Settings (stored like the Notion token), a model picker that lists cloud models apart from local ones, and the same consent shape as web search: off by default, a warning that says what leaves the machine, and a mode never sends to the cloud. None of it is in this spike. |
| LM Studio | Falls out almost free: it is an OpenAI-compatible server, so it is the Ollama `/v1` path with a different base URL. Closes `docs/gaps.md` §9. |

## 7. Recommendation

Keep pi-ai **for API-key cloud models and LM Studio**, behind `engine.js`, with
local Ollama staying on the native client until the eval has been rerun on the
pi-ai path. If the main reason for cloud models is using a Claude
subscription, the Claude Code engine (§5) is the only permitted route, and it
does not need pi-ai. If the subscription is the reason, pi-ai can wait until an
API-key or LM Studio user asks for it.
