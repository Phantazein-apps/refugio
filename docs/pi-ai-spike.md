# Spike — pi-ai as REFUGIO's model layer

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

## 5. Cost of going further

| Item | Cost |
|---|---|
| Dependency | `@earendil-works/pi-ai` 1.0.1, **63 packages, 88 MB** on disk (the OpenAI, Anthropic, Google, Mistral and AWS SDKs come whether used or not). Provider SDKs load lazily, so RAM is not the issue; the install size is, against a pitch of "~50 MB". Node ≥ 22.19. |
| Churn | The package moved scope this year (`@mariozechner/pi-ai` is deprecated); 1.0.1 published today. Pin exact, read changelogs. |
| Telemetry | It depends on `@earendil-works/pi-telemetry`. The installed build contains no network calls (contracts and a no-op), but a privacy product should re-check on every bump. |
| Product work | A key field in Settings (stored like the Notion token), a model picker that lists cloud models apart from local ones, and the same consent shape as web search: off by default, a warning that says what leaves the machine, and a mode never sends to the cloud. None of it is in this spike. |
| LM Studio | Falls out almost free: it is an OpenAI-compatible server, so it is the Ollama `/v1` path with a different base URL. Closes `docs/gaps.md` §9. |

## 6. Recommendation

Keep pi-ai **for API-key cloud models and LM Studio**, behind `engine.js`, with
local Ollama staying on the native client until the eval has been rerun on the
pi-ai path. If the main reason for cloud models is using a Claude
subscription, build the Claude Code engine (§4) instead — it is the only
permitted route, and it does not need pi-ai.
