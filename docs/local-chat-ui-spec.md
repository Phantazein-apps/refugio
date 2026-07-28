# Spec — REFUGIO local chat UI (replacing Open WebUI)

**Status:** proposal · **Author:** drafted with Claude Code · **Target:** REFUGIO

Replace Open WebUI as the default REFUGIO interface with a lightweight chat UI
served by REFUGIO's own Node process, reusing the SHERPA/PHANTAZEIN chat
frontend (`thefactremains/Portal`, mirrored at `Phantazein-apps/demos`).

---

## 1. Why

Open WebUI works, but it is the single heaviest and most fragile part of
REFUGIO:

| Problem | Detail |
|---|---|
| **Install fragility** | OWUI needs `uv` + a Python venv. When `uv` is absent the installer **silently skips it**, and REFUGIO then starts with no chat interface at all — a supervisor that reports "running" while being unusable. This is the single most common install failure. |
| **RAM floor** | OWUI loads PyTorch + sentence-transformers (~1–1.5 GB) just to boot. `start-refugio.cjs` already carries a `RAG_EMBEDDING_ENGINE=ollama` low-RAM workaround because of it. On an 8 GB machine this competes directly with the model. |
| **Browser dependency** | OWUI is reached via the system browser, blocking the "native app, no terminal, no browser" goal. |
| **Indirection** | MCPO exists *only* to translate MCP → OpenAPI because that is what OWUI consumes. REFUGIO already depends on `@modelcontextprotocol/sdk` (`^1.26.0`) and can speak MCP natively. |

Serving the UI from Node lets us delete **Python, `uv`, the venv, Open WebUI,
PyTorch, and (optionally) MCPO** from the default path.

**Non-goal:** removing Open WebUI entirely. It stays as an opt-in advanced
mode (§6) — already working, just no longer the default and no longer
invested in.

---

## 2. What we reuse, and what we don't

SHERPA is **not** a general chat app — it is a demand-intelligence workspace
(Flask, deployed to Fly.io, backed by the **Anthropic cloud API**). We reuse
its **frontend only**:

| Reuse | Do **not** reuse |
|---|---|
| `static/chat-v2.js` (2,456 lines) | `server.py` (9,305 lines, Flask) |
| `static/chat-v2.css` (1,870 lines) | Anthropic cloud client / Bedrock |
| `static/ask.html`, `components.css`, `header.css` | Evidence/theme/citation domain model |
| `static/i18n/` + `i18n.js` (ES/EN already done) | Auth, spend caps, Fly.io deploy |

The frontend is **vanilla JS/CSS with no build step** — it can be copied in
and served statically.

> **Key finding:** the SHERPA frontend is **not streaming** — zero occurrences
> of `EventSource`, `ReadableStream`, or `text/event-stream`. It is plain
> request/response. This makes Milestone 1 substantially cheaper (no SSE
> plumbing), but streaming becomes important once a slow local model is
> answering — see M3.

---

## 3. Architecture

```
REFUGIO supervisor (start-refugio.cjs)
  ├─ Ollama                 :11434   (unchanged)
  ├─ chat server (NEW)      :8090    Node — serves UI + /api/chat/*
  │    ├─ static/           SHERPA frontend (de-domained)
  │    ├─ Ollama client     POST /api/chat
  │    ├─ MCP client pool   @modelcontextprotocol/sdk → stdio servers
  │    └─ SQLite store      conversations + messages
  └─ Open WebUI             :8080    (advanced opt-in only)
```

**Placement.** New module `chat/` in the REFUGIO repo. `server.js` already
imports `@modelcontextprotocol/sdk` and runs `http.createServer`, so the
patterns exist; keep the chat server as its own process under the supervisor
so a crash can't take the MCP layer down.

**Storage.** `node:sqlite` (Node 22.5+, zero dependency). REFUGIO declares no
`engines` today — add `"node": ">=22.5"`, or fall back to `better-sqlite3` if
older Node must be supported.

**Tools.** Spawn MCP servers directly with `Client` +
`StdioClientTransport` from the SDK REFUGIO already depends on. This is what
makes MCPO droppable — no OpenAPI translation layer.

---

## 4. Endpoint mapping

The frontend calls **seven** paths. Verified response fields consumed by
`chat-v2.js`: `reply`, `citations`, `conversation_id`, `title`, `error`,
`cost_usd`, `spend_usd`, `cap_usd`.

| # | Endpoint | Method | Node handler | Notes |
|---|---|---|---|---|
| 1 | `/api/chat/ask` | POST | `askHandler` | Core turn. In: `{message, conversation_id?}`. Mint `conversation_id` if absent. Persist user turn → run model (+ tool loop) → persist assistant turn → return. |
| 2 | `/api/chat/regenerate` | POST | `regenerateHandler` | Caller already deleted the last assistant turn; re-run from history. Shares the turn-runner with #1. |
| 3 | `/api/chat/edit` | POST | `editHandler` | Caller deleted the edited user turn and everything after; re-run. Shares the turn-runner. |
| 4 | `/api/chat/conversations` | GET | `listConversations` | Sidebar rail: `[{id, title, updated_at, pinned}]`. |
| 5 | `/api/chat/conversations/:id` | GET | `getConversation` | Full message list for one conversation. |
| 6 | `/api/chat/conversations/:id` | DELETE | `deleteConversation` | |
| 7 | `/api/chat/status` | GET | `statusHandler` | Health probe. Return `{available, model}`; the UI hides chat when unavailable. Use it to report **Ollama reachable + model loaded** — a genuine improvement over OWUI, which gives no such signal. |

Also present upstream, **drop for M1**: `/export`, `/share`, `/pin`.
`/pin` is worth keeping later (41 references in the frontend); `/share` is
cloud-only and should go.

### Response shape (`/api/chat/ask`)

```jsonc
{
  "conversation_id": "hex",
  "reply": "assistant text",
  "title": "auto-generated on first turn",   // rail renders without a refetch
  "citations": [],                            // keep key, always empty (§5)
  "error": null
}
```

Keep `citations` as an always-empty array in M1 rather than ripping it out of
the frontend on day one — smaller diff, and it becomes the natural carrier for
**tool-call provenance** in M2 ("this answer used `whatsapp.list_messages`").
That reuses ~54 lines of existing citation rendering instead of deleting them.

### Turn runner (shared by #1–#3)

```
loadHistory(conversation_id)
  → POST http://127.0.0.1:11434/api/chat  { model, messages, tools? }
  → while (response.tool_calls):            // M2 only
        callMcpTool(name, args)
        append tool result; re-POST
  → persist assistant turn
  → maybeGenerateTitle()                    // first turn only, cheap prompt
```

---

## 5. Frontend changes

Copy `static/` in, then remove what is cloud- or domain-specific.

| Symbol | Refs in `chat-v2.js` | Action |
|---|---|---|
| `cost_usd`, `spend_usd`, `cap_usd` | 3 / 5 / 5 | **Remove.** Local inference is free; a spend meter is nonsense. Small, contained diff. |
| `share` | 10 | **Remove.** Cloud sharing has no local equivalent. |
| `export` | 8 | **Defer** — cheap to keep later. |
| `pin` | 41 | **Keep** — purely local, already works. |
| `citation` | 54 | **Keep the rendering, empty the data** (§4). Repurpose for tool provenance in M2. |
| `evidence` | 41 | **Remove/rename** — demand-intelligence domain. Largest single chunk of de-domaining. |
| auth / sign-in | — | **Remove.** `/api/chat/ask` returns 401 without a session upstream; local is single-user. Deleting this also removes the auto-login token dance `configure-owui.cjs` currently performs. |
| i18n | — | **Keep as-is.** ES/EN already done. |

Rebrand: strip PHANTAZEIN naming, reuse REFUGIO's existing `branding/` assets.

---

## 6. Milestones

**M1 — Chat with Ollama, no tools.** *The proof point.*
- `chat/` server on :8090, serves the de-domained frontend.
- Endpoints 1, 4, 5, 6, 7 (skip regenerate/edit initially).
- SQLite persistence; auto-title on first turn.
- Supervisor starts it; the launch banner's `Open REFUGIO:` line points here.
- **Done when:** a fresh machine with *no Python and no `uv`* installs REFUGIO
  and holds a conversation with a local model.

**M2 — Tools via MCP.**
- MCP client pool; tool-call loop in the turn runner.
- Surface tool use through the citations channel.
- Endpoints 2, 3 (regenerate/edit).
- **Done when:** "summarize my unread WhatsApp" works end-to-end, and MCPO is
  no longer required for the default path.

**M3 — Polish + native.**
- **Streaming** (SSE) — matters most here, because a local model is slow and
  M1's request/response feel will be the top complaint.
- Model picker fed by REFUGIO's RAM-based selection.
- Embed in the `WKWebView` menu-bar app → no browser (see native-app plan).

**M4 — Demote Open WebUI.**
- Default path stops installing OWUI/`uv`/venv entirely.
- OWUI behind `--owui` / `REFUGIO_OWUI=1`, documented as advanced.
- **Only after M1–M3 are proven**, so there is always a working UI.

---

## 7. Risks

- **Local models are weak at tool calling.** REFUGIO already falls back to
  `qwen2.5:0.5b` on low-RAM machines, which will not reliably select among
  ~30 tools. Mitigation: expose a small curated tool subset by default, and
  warn (as the Hermeneia README already does) that small models struggle.
- **Scope creep toward rebuilding OWUI.** RAG, workspaces, voice, multi-user
  are explicitly out. If those are wanted, that is what the `--owui` escape
  hatch is for.
- **Two UIs to maintain.** Real cost. Mitigated by freezing OWUI support at
  "it still works" rather than keeping parity.
- **Upstream drift.** SHERPA's frontend keeps evolving in Portal. Copy it in
  as a hard fork, not a submodule — the de-domaining makes merges impractical.

---

## 8. Effort

Rough, excluding polish: **~800–1,500 lines of Node** for the backend
(turn runner, SQLite, MCP pool, static serving), plus de-domaining the
frontend. M1 alone is the smaller half and is the milestone that proves or
kills the approach.

---

## 9. Release strategy

This change must not be able to break people running today's REFUGIO. The
mechanism for that **already exists and is simply switched off**:

```bash
# install-refugio:114 — "Pinned to stable tag", but defaults to main
export REFUGIO_VERSION="${REFUGIO_VERSION:-main}"
```
```js
// install-node.cjs:816
run(`git clone --branch ${refugioVersion} .../refugio.git "${targetDir}"`)
```

`REFUGIO_VERSION` flows through both the bootstrap and the clone — but the
default is `main` and the repo has **zero tags**, so every install takes
whatever is on `main` at that moment and there is no known-good to fall back
to.

### Actions

1. **Tag today's working state `v1.0.0`.** This is the OWUI-based REFUGIO
   that is known to work. It becomes the fallback.
2. **Flip the installer default to that tag:**
   `REFUGIO_VERSION="${REFUGIO_VERSION:-v1.0.0}"`. Users who want the edge
   still get it with `REFUGIO_VERSION=main`.
3. **Develop the new UI on `feat/local-chat-ui`**, merged to `main` only when
   M1–M3 land. `main` stays the integration branch; nobody installs it by
   default.
4. **Ship the new UI as `v2.0.0`** and move the default. `v1.x` users are
   untouched until they re-run the installer, and can pin forever with
   `REFUGIO_VERSION=v1.0.0`.
5. Patch fixes to the old line as `v1.0.1`… so a critical fix can reach
   stable users without dragging in the new UI.

A `stable` branch is the alternative to tags, but tags are strictly better
here: immutable, precisely pinnable, and they force a deliberate "this is
good" moment.

### Related gap — REFUGIO does **not** pin Hermeneia

```js
// install-node.cjs:423 — no --branch, no tag
run(`git clone --depth 1 ${HERMENEIA_REPO} "${dir}"`)
```

REFUGIO pins its own version but clones Hermeneia from its **default branch,
unpinned**. This has already caused a live outage: Hermeneia's `master`
stopped committing the prebuilt Go bridge binary, and every new REFUGIO
install immediately lost WhatsApp — the installer cloned a `master` that no
longer carried a runnable bridge.

**Fix:** clone Hermeneia at its latest **release tag**, not the default
branch, and have `ensureHermeneiaBridge()` fetch the bridge asset from that
same release. Version the dependency the way REFUGIO versions itself.
