# Private Discussion Modes — Implementation Plan

> **This file is a snapshot.** The living copy of this plan — the one sessions update, with its
> Dev Log sub-page — lives in Notion under the Refugio project page ("Private Discussion Modes —
> Implementation Plan"). If this file and Notion disagree, Notion wins. Update the snapshot when
> the plan changes materially, not on every session.

Plan drafted 2026-08-24 against commit `99b9ab2` (main). Every file:line reference below was
read and verified in that tree, not inferred.

---

## 1. What this feature is

**Private discussion modes** are built-in chat modes — NVC Coach, Style Coach, Spanish Tutor,
Supportive Listener, Career Coach, Life Coach, and a chat-with-your-WhatsApp mode — that a
person switches on for a conversation the way web search is armed for a message. A mode is,
mechanically, a named bundle of system-prompt layers (identity and boundaries, framework
knowledge, methodology), guardrails, UI copy, and an optional connector pairing. Most modes are
**pure prompt**: fully local, no tools at all. A few pair with a connector (WhatsApp first) to
ground coaching in real conversations.

Web search is the UX template but the **privacy polarity is inverted**: web search is the one
thing that leaves the machine, so it warns loudly and arms per message; discussion modes are the
*most* private conversations REFUGIO will hold, so the design errs the other way — fewer tools,
no web, quieter titles.

### Design principles (these bind every session)

1. **Off by default, enabled in the backend like connectors.** Each mode has a standing
   enablement switch in Settings; nothing appears in the composer until it is on. Same doctrine
   as everything else in REFUGIO: off is the default, off means the control isn't there.
2. **One mode per conversation, chosen at the start, sticky for its life.** Unlike the
   per-message `web` flag (deliberately amnesiac — `chat/server.js:1347-1352`), a mode binds to
   the conversation and survives reload. It cannot be changed once the conversation has
   messages — because the system prompt is rebuilt from scratch every turn
   (`chat/server.js:912-915`), switching modes mid-conversation would silently reframe all
   prior turns. Leaving a mode = starting a new chat.
3. **Never combined with web search — enforced server-side.** The house doctrine is that the
   tools array is not a guarantee and enforcement lives at the only place that acts
   (`chat/server.js:856-876`). Mode-active turns force `webArmed` false at the conjunction
   point (`server.js:909-910`) *and* `runTool` refuses `web__search` (`server.js:863-876`);
   the composer hides the web-arm button as a courtesy, not as the mechanism.
4. **Coaching modes get no tools at all — including memory.** The memory connector can
   persist (and in the GitHub-backed variant, upload) conversation content via `memory_save`.
   A private mode's tool list is therefore empty unless the mode explicitly declares an
   allowlist, and send-capable tools (`send_message`, `notes_create`) are never in a coaching
   mode's allowlist. Fewer tools is also strictly better for the small models REFUGIO targets.
5. **Guardrails in prompt are advisory; guarantees are enforced in code.** Crisis-escalation
   and role-boundary text lives in the prompt (that is what shapes model behaviour), but
   everything enforceable — no web, no tools, no title generation over content — is enforced at
   the call site, and every guardrail *sentence* is pinned verbatim by a test, the way
   `test/managed.test.js` pins policy and `test/websearch.test.js` pins the off-by-default
   promise.
6. **Strict prompt budgets.** History is never truncated (`store.js:96-100`), target models are
   3B–8B with ~8k contexts, and every mode token is first-token latency on every turn. Hard
   budget: **≤ 500 tokens per mode** for the full layered prompt, ≤ 350 preferred. The shared
   crisis layer (~80 tokens) counts inside the budget.
7. **Chat UI only.** The legacy Open WebUI path (`REFUGIO_CHAT=0`) bakes its prompt once in
   `scripts/configure-owui.cjs` and is being retired; modes are an explicit non-goal there.
8. **Zero new dependencies, house conventions throughout.** ESM in `chat/`, `node:test` only,
   narrative why-comments, `el()`/`textContent` rendering (never `innerHTML`), UI copy
   single-sourced from the backend module, `markWrite()` on settings writes, managed policy may
   only ever narrow.

---

## 2. Mode catalog

| # | Mode (id) | Priority | Tools | Summary |
|---|-----------|----------|-------|---------|
| 1 | NVC Coach (`nvc`) | **P0 — first to ship** | none (later: optional WhatsApp read-only) | Nonviolent Communication coaching: discuss situations, reword messages into OFNR |
| 2 | Style Coach (`styles`) | P1 | none | Communication-styles coaching from the existing StyleCoach spec |
| 3 | Chat with WhatsApp (`whatsapp`) | P1 | Hermeneia read-only | Discuss/search your own message history; requires connector |
| 4 | Spanish Tutor (`spanish`) | P1 | none | Conversation-first language tutoring |
| 5 | Career Coach (`career`) | P2 | none | Interview practice, negotiation prep, career decisions |
| 6 | Life Coach (`life`) | P2 | none | Goals, habits, accountability, values |
| 7 | Supportive Listener (`listener`) | P2 — ships **last** | none | Reflective listening, not-therapy; highest-risk, needs the proven guardrail framework |

### 2.1 NVC Coach — P0, most urgent

Marshall Rosenberg's Nonviolent Communication. The mode supports four flows:

- **Discuss a situation.** A life circumstance or relationship issue; the coach helps separate
  observations from evaluations, name feelings (and catch faux feelings — "I feel that you…"
  is a thought), surface the unmet needs underneath, and shape a request that is not a demand.
- **Reword a message (the OFNR rewrite).** Paste a draft (or, once pairing ships, pull a real
  thread); get an Observation → Feeling → Need → Request rewording with a short why, plus one
  or two register variants (softer / more direct).
- **Role-play.** The coach plays the other party for a difficult conversation, then debriefs
  what triggered evaluation language.
- **Receive empathically.** Translate a harsh message you received into the feelings and needs
  likely behind it before you reply.

Prompt layers: identity and boundaries (coach, not therapist, not an arbiter — never takes
sides); framework knowledge (the four components; feelings vs faux-feelings; a compact needs
vocabulary; requests vs demands; empathy vs advice); methodology (reflect → identify → reframe
→ offer wording → invite practice). Guardrails: the shared crisis layer; an explicit **NVC is
not for every situation** rule — where the user describes abuse, coercion or safety risk, the
coach says plainly that this is a safety situation, not a communication-technique situation,
and points at human help; an **anti-weaponization** rule — NVC used to pressure or manipulate
("how do I say this so she can't say no") gets named as against the method, gently.

### 2.2 Style Coach

The existing StyleCoach product spec (Notion: "🧠 StyleCoach") reborn as a fully local mode —
no Twilio, no Cloudflare, no WhatsApp channel needed. Four-quadrant communication-styles
framework (Driver, Expressive, Amiable, Analytical — Merrill-Reid 1981, pre-trademark; the UI
and prompt say **"communication styles"**, never the Wilson Learning "Social Styles" mark),
backup/stress behaviours, and the original deprivation/domination origin theory. Flows map
straight from the spec: conversational scenario-based assessment (8–10 questions, not a quiz);
situational coaching (identify → validate → reframe → options → practice → reflect);
style-flexing advice for a named counterpart. The spec's persistent-memory ambitions
(cross-session growth tracking) are **v2** — see Open question Q2.

### 2.3 Chat with your WhatsApp

Connector-gated data mode: only offered when the Hermeneia connector is `ok`
(`mcp.servers` / `connectorRows`, `server.js:563-593`). Summarize, search and discuss your own
history ("what did Ana and I keep arguing about last month?"). Tool allowlist is the
**minimal-profile read tools only** — the supervisor already starts Hermeneia with
`HERMENEIA_TOOL_PROFILE=minimal` (5 tools, `start-refugio.cjs:709-717`), and this mode drops
`send_message` from even that. Its value compounds with the coaching modes: NVC×WhatsApp
(section 2.1) cites real exchanges.

### 2.4 Conversational Spanish Tutor

Conversation-first tutoring: the tutor speaks Spanish at the learner's level, corrects gently
and inline, switches register (tú/usted) on request, and drills topics on demand. Correction
intensity is the mode's one option (casual ↔ thorough). The tutor template is
**language-parameterized** in the registry so French/German are later data, not code. Reality
check: 3B models are weak multilingual — the mode declares a recommended model tier (8B+) and
the UI says so when the active model is below it (same honest-labelling pattern as the model
picker). No UI i18n exists in REFUGIO and none is needed — the UI stays English; the
conversation is Spanish.

### 2.5 Career Coach

Interview practice (role-play + debrief), negotiation preparation, career decisions,
review of professional drafts. Boundaries: no legal or financial guarantees; salary numbers
framed as things to verify (the mode has no web search — say so rather than invent data).

### 2.6 Life Coach

Goal setting, habit design, accountability check-ins, values clarification. Boundaries: not
medical or mental-health advice — overlap with Supportive Listener is handled by scope copy on
both sides. Optional Reminders/Things pairing (create a task from a commitment) is **v2**, and
if added, write tools sit behind explicit per-call confirmation language.

### 2.7 Supportive Listener

Deliberately named **not** "Therapist" (Open question Q3): it is not therapy, and the name
should not claim it. Reflective listening, validation, journaling prompts, CBT-informed
reframing *questions* (never diagnosis, treatment plans, or medication comment). Strongest
disclosure banner and the strictest crisis protocol: mentions of self-harm or harm to others
pivot the reply to crisis resources and human support, and the mode never role-plays past
that pivot. Ships last, on the guardrail framework the earlier modes proved.

---

## 3. Architecture

Everything below names the exact seam in today's code. The recon that produced these
references is summarized here so implementing sessions do not need to rediscover it.

### 3.1 The mode registry — `chat/modes.js` (new)

One new module, peer of `chat/websearch.js` (the stated template: DEFAULTS + UI copy + the
definition in one exported, dependency-free, testable module). Exports:

- `MODES` — declarative table keyed by id. Each entry: `id`, `label`, `icon`, `hint` (one
  line for pickers), `disclosure` (the banner sentence), `category`
  (`coaching` / `language` / `data`), `prompt` (the layered instruction text), `starters`
  (2–3 conversation openers), `tools` (absent = none; else
  `{ server, allow: ["tool", …] }`), `requiresConnector` (optional server id),
  `recommendedTier` (optional, e.g. `8b`), `titleLabel` (what the sidebar shows instead of a
  generated title).
- `MODE_DEFAULTS` — `{ nvc: false, styles: false, … }` — flat booleans, one per id, so the
  existing settings merge keeps them with zero changes (`server.js:481-486` keeps only
  booleans for keys declared in defaults).
- `MODES_UI` — label/hint copy for the settings pane, served by the backend like
  `WEB_SEARCH_UI` so surfaces cannot drift.
- `CRISIS_LAYER` — the shared crisis-escalation text, single-sourced, appended to every
  `coaching`-category mode's prompt at build time.
- `modePreamble(mode)` — pure function returning the full system-prompt fragment.
- `modeToolFilter(mode, toolDefs)` — pure function applying the allowlist to an Ollama
  tool-def array.
- `webAllowed(mode)` — always false when a mode is active; exists so the exclusivity rule is
  one testable expression rather than scattered conditions.

Mode definitions ship as repo code (packaged installs cannot write beside the code —
`start-refugio.cjs:43-51`); nothing about modes is written at runtime except the enablement
booleans and the per-conversation column.

### 3.2 Enablement and settings

- **Storage:** a `modes` block in `~/.refugio-data/connector-settings.json`, merged into
  defaults at `server.js:476` beside `web` and `updates`. Hot — no supervisor restart, unlike
  `~/.refugio.env` keys. No env keys and no installer prompts (the codebase's explicit
  direction: no-credential switches belong in the window, `install-node.cjs:1211-1224` — and
  any env key not in `writeEnvFile`'s sections list is silently dropped on reinstall,
  `install-node.cjs:1065-1098`).
- **Route:** `POST /api/chat/modes` `{ mode, enabled }`, cloned from `POST /api/chat/web`
  (`server.js:1038-1048`): validate the id against `MODES` (unknown id → 400, the
  `CONNECTOR_OPTIONS` validator pattern at `1017-1019`), check `LOCKED.modes` **in the route**
  (403 + `MANAGED_MSG` + `managed: true`) — note `clamped()` runs only at load
  (`server.js:547`), routes enforce policy themselves — save, invalidate the connector cache,
  return the payload. Do *not* widen `POST /api/chat/connectors/settings`; its validator is
  deliberately narrow (comment at `1033-1037`).
- **Payloads:** a `modes` field beside `web` in all three places that carry it — `connectorPayload`
  (`619-627`), `GET /api/chat/status` (`1081`), `GET /api/chat/setup` (`1227`) — shaped
  `{ enabled: {id: bool}, available: [{id, label, hint, icon, requiresConnector, connectorOk}] }`
  so the composer can show/hide the picker on the existing 15s poll (`app.js:139-168`).

### 3.3 Per-conversation persistence

- **Schema:** `conversations.mode TEXT` via the sanctioned `addColumn()` ALTER migration
  (`store.js:63-67` — the pattern that added `display_content` and `attachments`; existing
  `chat.db` files must survive, `store.js:43-46`). Returned by `getConversation` /
  `listConversations`.
- **First-turn ordering:** a conversation row does not exist until the first send
  (`ensureConversation` inside `streamTurn`, `server.js:892`) and the client learns the id
  from the SSE `start` event. So the mode rides the `POST /api/chat/ask` body on the first
  turn (exactly like `web` does at `1116` → `1335`), is validated against enabled modes, and
  is persisted onto the row at creation. **Subsequent turns read the mode from the DB, never
  from the client** — which automatically covers the UI-less `regenerate`/`edit` routes
  (`1340-1358`) and makes the stored row the single source of truth.
- **Immutability:** once a conversation has messages its mode is fixed (Principle 2). No
  mode-change route in v1.

### 3.4 Prompt assembly

Single injection point, `server.js:912-915`:

```
{ role: "system", content: SYSTEM_PROMPT + modePreamble(mode) + toolPreamble(tools) }
```

- `modePreamble` slots between the base prompt and the tool preamble, one separately-worded
  section in the `toolPreamble` style (`68-90`). It must **compose with, not replace**, a
  user-overridden `REFUGIO_SYSTEM_PROMPT` (`55-58`) — mode text is written to stand alone.
- Prompt budget per Principle 6 is checked by a test that counts characters of every
  registry entry (`modePreamble(mode).length ≤ ~2000 chars ≈ 500 tokens`).
- Nothing mode-related is ever injected into *user* messages — user `content` is persisted
  verbatim forever (`store.js` two-column design), so mode text there would compound.

### 3.5 Web-search mutual exclusion (three layers)

1. `streamTurn:909` becomes `webArmed = !!web && !!connectorSettings.web?.enabled && !mode`
   — with the house-style rationale comment ("Two conditions, both required" is the template,
   `905-908`).
2. `runTool` (`863-876`) already refuses `web__search` when `webArmed` is false; layer 1
   makes that airtight for mode turns. Add the explicit refusal string for the mode case so
   the model gets an honest error.
3. Composer: while a mode is active, the web-arm button is hidden and any armed state is
   cleared (the `applyWebSetting` pattern, `app.js:496-505`) — courtesy, not mechanism.

### 3.6 Tools: subsetting and connector pairing

- **Per-turn filtering, never global mutation.** `droppedTools`/`forcedArgs` are keyed off the
  *global* pool settings (`mcp.js:131-136`); mutating them per turn would race concurrent
  conversations. Instead the tools array is shaped at its assembly point (`server.js:910`):
  no-tools modes pass `[]`; allowlisted modes pass `modeToolFilter(mode, mcp.toolDefs(...))`
  — filtered *before* the round-robin `TOOL_LIMIT` cap would dilute the paired server's share
  (`mcp.js:425-456`).
- **Execution re-check.** `runTool` refuses any tool outside the active mode's allowlist —
  same doctrine as the `droppedTools` re-check at `mcp.js:483-485`: offered-list filtering
  alone is not enforcement.
- **Pairing and degradation.** A mode with `requiresConnector` is shown but not selectable
  when the connector is not `ok`, with the connector's own state named
  (`connector-errors` honesty rule: name what refused, never invent a cause).
- **Reality constraints:** WhatsApp in the chat UI has **5 tools** (minimal profile), not the
  README's 17 — design against the minimal surface. **Slack (and every business connector) is
  unreachable from the chat UI today**: they are `streamable-http` entries in
  `mcpo-config.json` and `McpPool` only speaks stdio (`mcp.js:230` throws "not a stdio
  server"). Slack-paired modes require adding the SDK's StreamableHTTP transport to
  `chat/mcp.js` first — Session 9, stretch. An SMS connector does not exist at all (Open
  question Q4).

### 3.7 Safety framework

- **Shared crisis layer** (`CRISIS_LAYER`): recognize acute distress, self-harm or
  harm-to-others signals → acknowledge plainly, encourage immediate human support and local
  crisis services (name 988 for the US, with "or your local emergency number"), do not
  continue the coaching exercise past that point. ~80 tokens. Appended to every
  `coaching`-category mode. Pinned verbatim by tests.
- **Disclosure on entry:** the first thing a person sees in a mode conversation is a banner
  (UI element rendered from `disclosure`, re-rendered on reopen from the stored mode — the
  persisted cousin of `markWebTurn`, `app.js:88-93`) saying what the mode is and is not
  ("Coaching practice with a local model — not therapy, not a professional, nothing leaves
  this machine"). One matching sentence also lives in the prompt so the model self-describes
  honestly. Not a fake assistant message.
- **Quiet titles:** `maybeTitle()` (`server.js:836-853`) runs a completion over the user's
  first message and puts the result in the sidebar — wrong for a private mode. Mode
  conversations skip title generation entirely; the title is the registry's `titleLabel`
  plus the date ("NVC coaching — Aug 24").
- **toolGuard interplay:** the composer hard-blocks sending when the model can't call tools
  (`app.js:364-484`). Pure-prompt modes don't need tools — the guard is relaxed for them
  (a mode conversation on a tools:false model is fine, and arguably the *best* use of such a
  model). Connector-paired modes keep the guard.

### 3.8 Managed policy

One new key: `allowedModes` (list, mirroring `allowedConnectors`) — absent means all built-in
modes may be enabled; present narrows. **No key force-enables anything** (policy only ever
narrows, `managed.js:22-25`). Touching it means the full seven-surface checklist, or it is
invisible to admins: `managed.js` (`POLICY_KEYS`/`normalise`/`applyPolicy`/`describePolicy`),
`REFUGIO.admx` + `REFUGIO.adml`, `com.phantazein.refugio.settings.mobileconfig`,
`REFUGIO.wxs` (MSI property + registry component) + the `package.yml` CI assertion,
`packaging/README.md` policy table, `test/managed.test.js`. Enforced where modes are
*offered* (status payload + route 403), and settings-pane rows grey out with
`isManaged`/`managedNote` (`settings.js:69-77`).

### 3.9 UI surfaces

- **Composer:** a mode pill next to `#web-arm` (`index.html:130-132`), opening a small picker
  listing enabled modes (hand-rolled DOM, `el()` style). Visible only when ≥1 mode is enabled
  and the conversation is empty; once the conversation exists the pill becomes a static
  mode indicator. Selecting a mode shows the disclosure banner (the `#web-warn` pattern,
  `index.html:115`) and hides web arming. `openConversation` (`app.js:742-758`) restores
  indicator + banner from the conversation's stored mode; `newChat` (`912-923`) resets to
  no-mode.
- **Settings ▸ Discussion modes:** the five-edit pane recipe — nav button + `<section>` in
  `settings.html` (`52-63`, `68-148`), `renderModes()` after `renderWeb` (`899-938`), entry
  in `PANES` (`1322`), wired into `refresh()` (`1296-1316`), writes via the new route with
  `markWrite()` (`1285-1304`) or the 15s poll visibly reverts the checkbox. Per-mode row:
  checkbox, hint, connector requirement state, managed note.
- **Wizard:** **no new step in v1** — the wizard stays five screens; modes are discoverable
  in Settings. Recorded as a decision (D7), revisit if discovery proves weak.

### 3.10 Explicit non-goals (v1)

- No sampling/options passthrough — `chat/ollama.js` sends only
  `{model, messages, stream, tools}` (`75-136`); per-mode temperature is a later capability,
  not a tweak. Modes are prompt-only by design in v1.
- No cross-session mode memory (tutor vocab, style assessment results) — Q2, v2.
- No custom user-defined modes — the registry is code. (Free-text prompt via an
  unauthenticated loopback route would be a prompt-injection surface; revisit deliberately.)
- No Open WebUI support, no i18n of UI chrome, no per-conversation "don't save" toggle (Q1).

---

## 4. Decisions and open questions

### Decided (rationale in §3)

- **D1** Mode is per-conversation, immutable once messages exist; leaving = new chat.
- **D2** Enablement lives in `connector-settings.json` (hot), not env; own route
  `POST /api/chat/modes`; flat booleans keyed by mode id.
- **D3** Every mode off by default; composer control absent until something is enabled.
- **D4** Coaching modes carry an empty tool list — memory and send tools included. Paired
  modes use explicit read-only allowlists, filtered per turn and re-checked at execution.
- **D5** Web search excluded on mode turns, enforced server-side at both layers.
- **D6** Mode conversations get registry titles, never generated ones.
- **D7** No wizard step in v1.
- **D8** Modes ship chat-UI only; OWUI is an explicit non-goal.
- **D9** "Therapist" ships as **Supportive Listener**, last, pending Q3.

### Open questions (for the project owner — answer in Notion, sessions read them there)

- **Q1** Ephemeral option ("don't keep this conversation") for private modes? v1 stores
  mode chats like any other (all local); an ephemeral flag is easy to add later but changes
  the Data & reset story.
- **Q2** Mode memory (Style Coach growth tracking, tutor vocab lists): v2 as a per-mode
  local file in `DATA_DIR`? The StyleCoach spec's growth-review flow depends on it.
- **Q3** Naming: "Supportive Listener" vs something else? (Recommendation: keep the word
  "therapist" out of product copy entirely.)
- **Q4** SMS pairing was mentioned in the brief — no SMS connector exists. Separate
  connector project (Hermeneia-style), or drop from scope?
- **Q5** Spanish only at launch, or seed French/German entries from the same tutor template
  once Session 5 lands?
- **Q6** Should `allowedModes` policy ship in v1 (Session 8) or wait for demand? Cost is the
  seven-surface checklist; recommendation: ship it, the fleet story is a selling point.

---

## 5. The sessions

Each session is one focused work effort: implement, test (`npm test` + `node --check` over
touched browser modules), commit on a feature branch, push, and **write the Dev Log entry**
(§7). Sessions 1–3 are strictly ordered; 4, 5 and 6 can run in any order after 3; 7 needs 3;
8 needs 2; 9 is stretch after 6.

| Session | Title | Delivers | Depends on |
|---------|-------|----------|------------|
| 1 | Mode engine + NVC Coach (backend) | `chat/modes.js`, schema migration, prompt layering, web exclusion, tests | — |
| 2 | Composer + Settings UI | picker, banner, indicator, settings pane, status plumbing, route | 1 |
| 3 | Safety framework hardening | crisis layer finalized, disclosures, quiet titles, guardrail test suite | 1 |
| 4 | Style, Career, Life coaches | three pure-prompt modes from the registry template | 3 |
| 5 | Spanish Tutor | language-parameterized tutor, correction-intensity option, tier labelling | 3 |
| 6 | Connector pairing + WhatsApp modes | pairing framework, Chat-with-WhatsApp, NVC×WhatsApp | 3 |
| 7 | Supportive Listener | the highest-risk mode on the proven framework | 3 (and review of 4) |
| 8 | Policy, packaging, docs | `allowedModes` across all seven surfaces, README, copy audit | 2 |
| 9 | Slack pairing (stretch) | StreamableHTTP transport in `McpPool`, NVC×Slack | 6 |

### Session 1 — Mode engine + NVC Coach, backend only

*Files:* `chat/modes.js` (new), `chat/server.js`, `chat/store.js`, `test/modes.test.js` (new).

1. Registry module per §3.1 with **one** complete mode: `nvc` (full prompt layers, guardrails,
   disclosure, starters, `titleLabel`), plus `MODE_DEFAULTS` covering all seven planned ids
   (defined ids may ship before their content; undefined content = mode hidden).
2. `store.js`: `addColumn("conversations", "mode", "TEXT")`; expose in `ensureConversation`
   (accept mode at creation), `getConversation`, `listConversations`.
3. `server.js`: accept `body.mode` on `/api/chat/ask` (validated: known id AND enabled;
   unknown/disabled → 400 with an honest message); persist on first turn; read from DB on
   later turns; assemble `modePreamble` at `912-915`; force `webArmed` false and add the
   `runTool` refusal; skip `maybeTitle` for mode conversations (use `titleLabel` + date);
   empty tools array for no-tools modes.
4. Tests, house style (plain-English names, a header comment saying why): every mode off by
   default; unknown mode id rejected; `webAllowed(mode)` false for every mode;
   `modePreamble` budget ≤ 2000 chars per mode; crisis sentences present verbatim in every
   coaching mode; NVC prompt contains the not-therapy and anti-weaponization sentences; the
   exclusivity conjunction extracted into a pure helper so it is testable without HTTP.

*Accept when:* a `curl` conversation against `/api/chat/ask` with `mode: "nvc"` coaches in
NVC voice, survives process restart with mode intact, refuses an armed-web request on a mode
turn with the refusal string, and `npm test` is green.

### Session 2 — Composer and Settings UI

*Files:* `chat/static/index.html`, `app.js`, `app.css`, `settings.html`, `settings.js`,
`chat/server.js`.

1. `modes` in the three payloads (§3.2); `POST /api/chat/modes` route with `LOCKED` check.
2. Composer per §3.9: pill + picker + disclosure banner + per-conversation indicator;
   restore on `openConversation`, reset on `newChat`; hide/clear web arming while mode
   active; picker only on empty conversations.
3. Settings pane per §3.9 with `markWrite()`; deep link `/settings#modes` works (PANES).
4. `toolGuard` relaxation for pure-prompt modes.
5. `node --check` over every touched static file (CI runs it; there is no browser test rig).

*Accept when:* the full loop works by hand in a browser — enable in Settings, pick in
composer, converse, reopen, indicator and banner restored, web pill absent, managed-locked
behaviour correct — and nothing regresses on the 15s poll race.

### Session 3 — Safety framework hardening

*Files:* `chat/modes.js`, `test/modes.test.js`, `chat/server.js` (only if injection points
need adjusting).

Finalize `CRISIS_LAYER` wording (write it for a small local model: short, imperative,
unambiguous); per-mode disclosure copy; the NVC abuse-pivot and anti-weaponization sentences
in final form; verify quiet-title behaviour end to end; red-team the prompts by hand against
the floor model (`qwen2.5:3b`) and the 8B tier — transcript snippets of the red-team runs go
in the Dev Log. Every guardrail sentence pinned verbatim by a test. This session's output is
mostly *copy and tests*, and it gates every content session after it.

### Session 4 — Style Coach, Career Coach, Life Coach

Three registry entries. Style Coach content is ported from the StyleCoach Notion spec
(§2.2 — including the "communication styles" IP framing); Career and Life per §2.5/§2.6 with
mutual scope copy against Listener. Budget test holds each ≤ 2000 chars. Starters written for
each. Red-team pass per mode recorded in the Dev Log.

### Session 5 — Spanish Tutor

Tutor template parameterized by language; `spanish` entry; correction-intensity as the
mode's option (a boolean in the mode's settings block — follow the declared-enforcement
spirit: the option only changes prompt text, and says so); `recommendedTier` surfaced in
picker + settings when the active model is below it. Q5 decides whether FR/DE entries ride
along.

### Session 6 — Connector pairing framework + WhatsApp modes

*Files:* `chat/modes.js`, `chat/server.js`, `chat/mcp.js` (read-only helpers only),
`chat/static/app.js`, `settings.js`, tests.

1. `modeToolFilter` wired at `server.js:910` (filter before the cap), `runTool` allowlist
   re-check, connector-availability gating in payloads and picker (§3.6).
2. `whatsapp` data mode (read-only minimal-profile tools, no `send_message`).
3. NVC gains `optionalConnector: "whatsapp"` — when the connector is `ok` *and* the user
   picks "NVC + WhatsApp" in the picker, the read tools are offered and the preamble names
   them (the `toolPreamble` naming pattern); drafts are copy-out only, never sent.
4. Tests: allowlist filtering, execution refusal for out-of-list tools, memory/send tools
   provably absent from every coaching mode's offered set.

*Accept when:* with Hermeneia linked, the WhatsApp mode discusses real history; with it
failed/absent, both paired modes degrade with the connector's own state named; a model
attempting `whatsapp__send_message` in-mode gets the refusal string.

### Session 7 — Supportive Listener

The `listener` entry per §2.7 on the now-proven framework, plus a dedicated red-team pass
(crisis pivots, diagnosis-fishing, medication questions) with transcripts in the Dev Log.
Gate: the crisis pivot must fire on the floor model, not just the 8B tier.

### Session 8 — Managed policy, packaging, docs

`allowedModes` across the seven surfaces (§3.8, pending Q6); README: modes section + Settings
table row + composer description updates; copy audit against the privacy superlatives
("the one thing that leaves this machine" wording must stay true — pure-local modes are
compatible, paired modes need a considered sentence); `docs/` snapshot refresh; CHANGELOG-ish
Dev Log entry. CI (`package.yml`) gets the MSI property assertion for the new key.

### Session 9 (stretch) — Slack pairing groundwork

StreamableHTTP transport in `McpPool` (`mcp.js:229-270` currently throws on
non-stdio specs; the MCP SDK ships the transport — keep the zero-new-dependency rule: it is
already a dependency), reconnect/describe semantics for HTTP servers, then NVC×Slack as a
paired mode. This unlocks business connectors in the chat UI generally — scope creep risk is
real; keep the session to transport + one mode.

---

## 6. Testing strategy

- `npm test` (`node --test`, no deps) — `test/modes.test.js` pins: defaults off, budgets,
  exclusivity helper, guardrail sentences verbatim, allowlist filter behaviour, unknown-id
  rejection. Where a rule lives in `server.js` glue (the conjunction, the runTool refusal),
  extract the decision into a pure exported helper so it is testable without HTTP — the
  project has no HTTP harness and building one is out of scope.
- `node --check` over every touched `chat/static/*.js` (CI's syntax pass is the only browser
  coverage).
- Manual red-team per content session, on both the floor model and the 8B tier, transcripts
  summarized in the Dev Log. Prompt-only guardrails are advisory; the red-team notes are the
  evidence they hold in practice.
- `test/managed.test.js` extended in Session 8 (policy parse, narrow-only).

## 7. Session protocol and Dev Log

Every session, after each major work effort (not only at the end):

1. Commit on the session's feature branch with sentence-style, area-prefixed messages
   (house style: "Modes: …"). Push. PRs target `main`; note that the installer pins the
   release branch (`v2.0.0-beta.2`) and `main` is kept identical to it — shipping a session
   means updating both, per repo convention.
2. Append an entry to the **Dev Log sub-page of the Notion plan** (newest entry first):
   - **Date — Session N: title** and branch/PR/commit ids.
   - **Shipped:** what exists now that didn't, in the repo's narrative voice — lead with
     *the constraint that shaped it* (see the existing Refugio Dev Log for the register).
   - **Decisions and deviations:** anything decided that the plan didn't, anything done
     differently than planned, and why. Update the plan page itself when a deviation
     changes later sessions.
   - **Tests:** what `npm test` covers now; red-team notes for content sessions.
   - **Open items:** carried-over work, newly discovered issues.
   - **Next:** the single most useful thing for the next session to do first.
3. Tick the session in the plan's status table (add a Status column value: In progress →
   Done) so the plan page always shows live state.
