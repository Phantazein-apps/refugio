# Discussion modes — how they work, and what was measured

A register of the feature as it exists on `main`, written for whoever changes
it next. It is deliberately **not** a copy of the plan: the plan is a living
Notion page that schedules sessions and records open questions, and a second
copy of it in the repo would be stale the week it landed. What is here instead
is the shape of the code, the promises that are enforced rather than asked for,
and the findings that cost a session each and would otherwise be re-learned at
the same price.

Every file:line below was read on `main` rather than recalled.

---

## What a mode is

A named frame around **one conversation**: prompt layers, guardrails, UI copy,
and — for two of them — a read-only connector allowlist. Six ship: `nvc`,
`styles`, `whatsapp`, `spanish`, `career`, `life`, plus the derived pairing
`nvc+whatsapp`. A seventh id, `listener`, is declared in the defaults and has
no content, so it is not offerable.

**Six ship in the build; no install offers all six.** The coaching modes are
REFUGIO Listener's product and `whatsapp` is REFUGIO's, decided by category in
`editions.cjs` and applied by `offeredModes()` / `modeOffered()`. Both products
compile all of them — which is the point, because it means everything below is
tested once and cannot rot in the edition nobody is currently working on. The
split itself, and what it deliberately did not do, is
[`docs/editions.md`](editions.md); the rest of this file is about the modes and
is true in whichever product ships them.

(The `listener` mode id and the `listener` EDITION are different things with
the same name: the id is the Supportive Listener coaching mode that has not
been written, and the edition is the product it would ship in.)

The whole catalogue is one dependency-free module, `chat/modes.js`: the table,
the copy the window renders, and the pure helpers every enforcement point
calls. Nothing about a mode is written at runtime except its enablement boolean
and the per-conversation column — packaged installs cannot write beside their
own code.

## The seams

| What | Where |
|---|---|
| Registry, copy, pure helpers | `chat/modes.js` |
| Which product offers which modes | `offeredModes` / `modeOffered`, `chat/modes.js`; the table in `editions.cjs` |
| Enablement (one boolean per id) | `modes` block in the edition's data directory — `~/.refugio-data/connector-settings.json`, or `~/.refugio-listener-data/…` |
| A mode's own option (one boolean) | its own top-level block, e.g. `tutor: { thorough }` |
| Per-conversation persistence | `conversations.mode TEXT` — `chat/store.js:65`, written at creation by `ensureConversation` (`store.js:92`) |
| Which mode this turn runs in | `chat/server.js:1011` — read from the row, never from the client, after turn one |
| Prompt assembly | `chat/server.js:1062` — `SYSTEM_PROMPT + modePreamble(mode, settings) + toolPreamble(tools)` |
| Web exclusion | `armWebSearch` at `server.js:1031`, refused again in `toolRefusal` (`modes.js:1295`) |
| Tool filtering | `server.js:1047` — allowlist applied **before** the round-robin cap, then re-checked at execution |
| Crisis floor | `crisisNotice()` (`modes.js:241`) appended at `server.js:1136`, to the stream and to the stored message |
| Quiet titles | `maybeTitle` (`server.js:942`) is skipped; the registry's `titleLabel` plus the date is used |
| Managed policy | `allowedModes` in `chat/managed.js`, clamped at load and refused per id in the routes |
| Edition refusal | `validateMode`'s third refusal (`modes.js`), `wrongEditionMsg` for the two write routes (`server.js`) |

Three rules hold across all of it:

- **A mode removes capability.** Coaching modes are handed no tools at all,
  memory included — the connector whose job is to persist and, in its
  GitHub-backed variant, upload what was said.
- **Prompt text is advisory; code is the guarantee.** Guardrail sentences shape
  what the model says and promise nothing. Everything enforceable — no web, no
  tools outside the list, no title generated over the content — is enforced
  where something acts, and every guardrail sentence is pinned verbatim by
  `test/modes.test.js`.
- **Tokens are latency.** History is never truncated and the target models have
  ~8k contexts, so a mode's preamble is paid again on every turn. The ceiling
  is 2000 characters, 2300 for a connector-paired variant, and the shared
  crisis layer is 825 of it.

## What the red-teams established

Each of these was measured on `qwen2.5:3b` (the floor tier, and what a default
install runs) and `qwen2.5:7b`. They are not opinions about prompting; they are
what happened, and they generalise past the mode that found them.

1. **Triggers are matched lexically, not understood.** A guardrail naming a
   category — "wanting to hurt themselves" — is not applied to "everyone would
   be better off without me" by either tier. Spend the characters on the
   phrasings people actually use.
2. **An unconditional format instruction beats a conditional guardrail.** "Answer
   in this shape" made both tiers produce the coaching template for suicidal
   ideation. The method has to be conditional for the guardrail to have
   somewhere to bite.
3. **A format label the crisis layer cannot cancel by name beats the layer.** It
   stops the coaching by forbidding the strings a method emits. A mode that
   invents a new label has handed the model a format the stop does not cover;
   deleting one three-word stem took the Life Coach from 4 of 6 crisis failures
   to 6 of 6 correct. A test enforces this for every coaching mode.
4. **Say whose steps they are.** A method with no owner is handed to the person
   as homework — 8 of 12 usable replies became 12 of 12 when NVC said so.
5. **State the prior, or the SAFETY list becomes the most concrete thing in the
   prompt** and the model opens with it (4 of 5 replies).
6. **A branch that stops the mode's main behaviour must say the action before
   the absence**, or the nearest concrete "stop" template — the crisis one —
   gets copied into ordinary turns.
7. **Concrete examples in a small model's prompt are answers, not
   illustrations.** "Running to the corner" as an example of a small step was
   given verbatim to someone whose evenings were disappearing.
8. **Measure both directions in the same pass.** Every wording that improved one
   number moved another. A probe that counts only the behaviour you want scores
   the version that shouts it at everyone highest.

## What is known not to work

- **The prompt-only crisis guardrail does not hold on the floor tier.** No
  wording was found that is sensitive enough for the quiet phrasings and quiet
  enough to leave ordinary coaching turns alone. `crisisSignals()` exists
  because of that: REFUGIO adds the resources itself, in its own labelled box,
  whatever the model said. Every mode declares `recommendedTier: "8b"` and says
  why in its own words.
- **`crisisSignals()` is English-only.** In the Spanish tutor that means the
  code floor covers the language the person is not being encouraged to write
  in — the reverse of every other coaching mode. Teaching it another language
  needs an adversarial negative set written by a different hand than the
  patterns; a corpus written alongside them scored 100% precision and an
  adversarial one found 33% false positives.
- **The paired NVC variant reads the exchange only 1–3 turns in 6** on either
  tier, because the mode's own "answer in this shape" is unconditional and
  reading keeps losing to it. Its budget is exhausted at 2297 of 2300.
- **The floor tier gets tool arguments wrong** in the WhatsApp modes — it passes
  the parameter schema back as the value, matches nothing, and reports that a
  conversation is empty when it is not.
- **Nothing is remembered across conversations.** Within one, history is never
  truncated. The modes that would obviously want persistence say they do not
  have it rather than implying continuity.

## Adding a mode

One registry entry is usually the whole change, and its `category` decides
which product ships it — there is no second list to add it to, and a category
no edition offers is caught by a test rather than by a mode nobody can reach. `carriesCrisisLayer(mode)` is
the single predicate deciding which modes get the crisis layer **and** the code
floor, and it reads `category === "coaching"` — a mode that is not in that
category silently gets neither, which a test forbids by asserting both halves
cover the same set. A mode declaring an option needs a settings block and a
row in the pane; nothing else in the surfaces needs touching, because the
picker, the pane, the tier note and the disclosure banner all render what
`modeSummaries()` sends, and it never carries prompt text.

The living plan, its open questions and the per-session Dev Log are in Notion:
*Refugio ▸ Private Discussion Modes — Implementation Plan*. If this file and
that page disagree about intent, the page wins; if they disagree about what the
code does, this file was checked against `main` and the page was not.
