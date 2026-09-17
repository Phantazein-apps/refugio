# What was intended and never built

A register of functionality REFUGIO planned, started, or announced — and does
not have. Written when PRs [#9](https://github.com/Phantazein-apps/refugio/pull/9)
and [#10](https://github.com/Phantazein-apps/refugio/pull/10) were closed
unmerged, so that closing the branches did not also close the intent.

Every line below was checked against `main` rather than recalled. Where a gap
is already admitted in the README, that is noted — the point of this file is
that they are in one place, with the reason, rather than scattered across a
README's rough-edges list, a spec's milestone table and two dead branches.

---

## 1. The packaged installs never start the tray or the menu-bar app

**The largest gap, and the one that undoes PR #9 entirely.**

PR #9 existed because Linux and Windows had no GUI way to stop REFUGIO, which
matters when the stack holds gigabytes of RAM. That shipped — for people who
install from the terminal. `install-node.cjs:283–341` writes the Windows
`.vbs` wrapper plus a Startup shortcut, and the Linux `.desktop` and autostart
entries.

The `.pkg` and `.msi` do neither:

| Platform | What the package does | What it does not |
|---|---|---|
| Windows | `packaging/windows/user-setup.cjs` writes `Startup\REFUGIO.cmd`, which starts **the supervisor** | Never writes the tray's `.vbs` or its Startup entry. `tray/refugio-tray.ps1` is in the payload and nothing ever runs it. |
| macOS | `build-pkg.sh` builds, signs and installs `/Applications/REFUGIO.app` | `refugio-user-setup` execs the supervisor and never opens the app. There is no login item; `SMAppService` self-registration in `LoginItem.swift` only happens after a human launches it from `/Applications` by hand. |
| Linux | — | There is no Linux package at all. No `.deb`, `.rpm` or AppImage, so `tray/refugio-tray.sh` has no managed path. |

The consequence is specific: a machine that receives REFUGIO by MDM runs it
with no icon anywhere, and the only way to stop it is a terminal the deployment
was designed to avoid. The per-user setup scripts are the right place for the
fix — they already run once per user with the user's own privileges, which is
exactly what writing a Startup entry or a login item requires.

## 2. The Windows tray has still never been run on Windows

Written, brace-and-quote balanced, syntax-checked. Nothing more. There is no
PowerShell in the build container and no Windows runner exercises it. Already
in the README's rough edges; repeated here because item 1 would ship it to a
fleet.

```powershell
powershell -ExecutionPolicy Bypass -File tray\refugio-tray.ps1
```

## 3. Tool provenance is rendered and then thrown away

`docs/local-chat-ui-spec.md` §4 and §5 made this an explicit design decision:
keep the 54 lines of citation rendering, empty the data in M1, and repurpose
the `citations` channel in M2 to carry *"this answer used
`whatsapp.list_messages`"*.

Half of that happened. The chips render live during a turn
(`chat/static/app.js:1187`, `.tool-chip` in `app.css`), and then they are gone:
the `messages` table has `content`, `display_content`, `model` and
`attachments`, and no column for the calls behind an answer
(`chat/store.js:30–56`). Reopening a conversation shows what the model said and
not which of your data it read to say it — which is the one provenance question
a local-first tool exists to be able to answer.

Cost to close: one `addColumn("messages", "tool_calls", "TEXT")` and a render
path that already exists.

## 4. Only stdio MCP servers are ever connected

`chat/mcp.js:141–143` — *"Anything non-stdio (mcp-remote wrappers etc.) is
skipped for now."* Every connector must therefore be a local child process.

This was a reasonable M2 boundary and is now load-bearing in the wrong
direction: PCP is MCP over Streamable HTTP with OAuth, so as it stands REFUGIO
cannot be a PCP client of anything — including a Multipass context — without a
transport it does not implement.

## 5. There is no export

The spec marked `/export` **Defer** (§5) and it was never picked back up. No
route in `chat/server.js`, no function in `chat/store.js`. `/share` was dropped
deliberately and correctly — it is cloud-only — but export is not the same
thing.

Worth stating plainly because of what the wider project claims: PCP §1.1.1
makes full export the *first* design principle, and a server that cannot export
a context is non-conforming. REFUGIO currently cannot export its own
conversations. The data is in one SQLite file the user owns, which makes this a
missing convenience rather than a lock-in — but the principle is not
demonstrated by the product that most loudly asserts it.

## 6. Wizard: WhatsApp QR and email round trips

Tracked as task #25 and deferred on purpose. The wizard covers welcome, model
download, the simple connectors, web search and the hand-off. WhatsApp linking
(the QR round trip) and email setup still send the user back to a terminal —
in a packaged install, a terminal that never ran the installer and has no
context for what it is being asked.

## 7. Small models still choose tools badly

Known at the time of PR #10 and only partly mitigated since. `main` now refuses
to install a model that cannot call tools at all, caps the surface
(`REFUGIO_TOOL_LIMIT`, default 40) and bounds the loop
(`REFUGIO_MAX_TOOL_ROUNDS`, default 5). A 3B model still picks wrong. This is a
model-capability limit, not a bug to fix — it is recorded so it is not
rediscovered as one.

## 8. The installers build, and nothing they produce is signed

**Corrected 2026-08-27.** This entry used to read *"neither installer has ever
been built"*. That is no longer true. `.github/workflows/package.yml` builds
both on every push, installs them silently on real macOS and Windows runners
and asserts what landed — including, on Windows, that a deploy-time policy
property set with `msiexec /qn ALLOWEDMODES="..."` reaches the Policies hive.

What remains is signing. The certificates do not exist yet, so the job publishes
its artifacts as `refugio-pkg-UNSIGNED` and `refugio-msi-UNSIGNED` — which on
macOS means *"cannot be opened because Apple cannot check it for malicious
software"* on every Mac since Catalina. See `packaging/README.md` for the
certificate types and costs.

## 9. LM Studio is offered as an engine and the v2 chat window cannot use it

`REFUGIO_ENGINE=lmstudio` is accepted by the installer, written to
`~/.refugio.env` and documented in the README's engine section. In v2 it does
not reach the chat window.

`chat/server.js:36` imports every model call from `chat/ollama.js`, which
speaks Ollama's **native** API — NDJSON `/api/chat`, `/api/tags`, `/api/show`,
`/api/pull` — at `OLLAMA_BASE_URL`. LM Studio serves an OpenAI-compatible
`/v1`, and nothing under `chat/` reads the `OPENAI_API_BASE_URL` the installer
writes for it. The supervisor compounds it rather than catching it: `wantsOllama`
is false under this engine (`start-refugio.cjs:510`), so no Ollama is started,
while the chat server starts regardless (`start-refugio.cjs:824`). What the
person gets is an empty model list and *"No model available. Is Ollama
running?"* — naming the engine they deliberately did not pick.

This worked on the Open WebUI path, which consumed `OPENAI_API_BASE_URL`
directly. It was never carried across when v2 replaced that UI, so it is a
regression that reads as a feature — which is why it is here and not in the
README's rough edges alone.

Cost to close: a `chat/openai.js` with the same six exports, and an engine
switch at the single import. Three are near-mechanical (`complete`, `isUp`,
`listModels` over `/v1/models`, which loses size and `modified_at` and degrades
to "unrated" — a path `chat/server.js:204` already tolerates). `chatStream` has
to accumulate tool-call fragments across indexed deltas where Ollama hands over
a whole object. `showModel` has no equivalent and must return `null`, which
callers already read as UNKNOWN rather than "no". `pullModel` has no equivalent
at all, so the Settings download has to be hidden for this engine rather than
left to fail.

The same file would make vLLM, llama.cpp's `server`, `mlx_lm.server` and TGI
reachable by base URL, with no second model lifecycle to maintain. What it
cannot carry over is the tool-calling gate: `/api/show` capabilities is how
REFUGIO knows a model can drive connectors at all, and no OpenAI-compatible
server reports it. That is a decision to take deliberately rather than a detail
to discover — `models.json` calls that gate "the gate the whole product hangs
on".

## 10. REFUGIO Listener has no menu-bar app, tray icon, or packaged install

The split into two products ([`docs/editions.md`](editions.md)) made everything
a person's data touches per-edition — directory, database, credentials, port,
login item, CLI, launcher scripts. Three surfaces were deliberately left as
REFUGIO's alone, and a Listener install gets none of them:

- **The macOS menu-bar app** (`menubar/`). A Swift bundle whose sources
  hard-code `~/refugio`, `~/.refugio-logs`, ports 8090/8080 and the
  `com.phantazein.refugio` identifier, built by `menubar/install.sh` into
  `/Applications/REFUGIO.app`. Parameterising it is perhaps forty lines of
  Swift plus an `Info.plist` key — and it cannot be compiled or exercised
  anywhere but a Mac, so shipping it untested would give the Listener an icon
  that starts and stops the *other* product. That risk is why the installer
  prints one line saying the launchers are REFUGIO-only rather than installing
  a copy under the wrong identity.
- **The Windows and Linux trays** (`tray/`). The same shape of problem without
  the build step: two scripts written for one install's paths.
- **The `.pkg` and `.msi`** (`packaging/`). Bundle identifiers, an MDM
  configuration profile and an ADMX template, all written for one product. A
  second set is a distribution decision — signing, identifiers, profiles —
  rather than a code change.

What the Listener does get: the per-edition `refugio-listener` command
(`start`, `bg`, `stop`, `restart`, `status`), `Start REFUGIO Listener.command`
on macOS, the `.bat` launchers on Windows, a `.desktop` entry on Linux, and its
own login item. Everything the launchers do is reachable; the icon is not
there.

## 11. Not a gap: TCC consent

`packaging/README.md` §"The thing that is not possible" — an installer cannot
grant itself access to Notes, Reminders or Messages, and no amount of packaging
work will change that. It requires a PPPC profile pushed by MDM alongside the
package, keyed to the app's Developer ID signature. Listed here so it stops
being re-raised as something that was forgotten.

## 12. The model ladder is sized by file

Every `ramGb` in REFUGIO is a number someone wrote down, and whether the
interface calls it an estimate used to depend on which **file** it arrived in
rather than on whether anybody measured it.

**Two of the three things this entry recorded are now closed.** What remains is
the larger half.

### Closed: a catalog entry can declare its own provenance (#43)

`mergeIndex` in `chat/model-catalog.js` hard-coded the `estimated` flag per
source, so a catalog entry could not declare itself a guess: `estimated: true`
in `models.json` was discarded and rewritten to `false`. PR #43 added the field
to `validateEntry` and carried it through the merge to the Settings tilde, and
`models.json`'s `fields` block now documents it. An entry that omits the flag is
claiming the number was measured, and `test/model-catalog.test.js` fails any
entry whose own note admits a guess without setting it.

### Closed: the three catalog estimates are measured (#42)

`lfm2.5:8b`, `gemma4:e4b` and `muse-glimmer:30b` carried `ramGb` values inferred
from their download sizes. All three were measured on 2026-09-16, on an Apple M4
Pro / 24 GB, macOS 26.7, Ollama 0.34.1, at REFUGIO's 4096-token context, each
after a turn that called `memory__memory_search` through the real connector pool:

| tag | was | measured | `ollama ps` PROCESSOR | wired delta | verified by |
|---|---|---|---|---|---|
| `lfm2.5:8b` | 6.1 | **5.3** | 100% GPU | 4.906 GiB | `b2-voice-from-memory` |
| `gemma4:e4b` | 11.0 | **9.5** | 100% GPU | 9.945 GiB | `f1`, `b2` |
| `muse-glimmer:30b` | 20.2 | **17.0** | **14%/86% CPU/GPU** | 15.373 GiB | `f1`, `b2` |

Those calls went through the pool and reached nothing. The memory backend was
never initialised on that machine, and every one of the eleven calls returned the
same 95-character `No palace found` message — recorded by the eval runner as a
*successful* call. (This sentence first said `null`. The scorecard JSON stores a
result's length, never its text, and the reviewer misread a missing field;
corrected 2026-09-17.) That does not weaken the RAM figures — each turn still
generated, called a tool, took a result back and generated again, which is what
fills the KV cache. It does qualify `verified`: all three chose the right tool with
a sensible query, which is what the field asks, but none was ever seen reading a
stored note. The hand scores in the three scorecards are capped at 2 for the same
reason, and say so.

Every estimate was **high** — sizing by download file over-stated all three by
14–19%. `muse-glimmer:30b` is not a clean GPU-resident figure: at the default
wired limit (`iogpu.wired_limit_mb = 0`, ~18 GB of 24) 14% of it ran on CPU, and
wired memory sat at 18.222 GiB, hard against that ceiling. It called tools
correctly and 4–8x slower than the other two (95–125 s per eval task against
5–32 s). The entry's note says so; the number alone would not.

### Three things measuring turned up that the old entry did not predict

1. **The figure is context-dependent, and REFUGIO never says which context.**
   REFUGIO sends no `options` block to Ollama, so every turn runs at Ollama's
   default 4096. `lfm2.5:8b` advertises 125K and `gemma4:e4b` 128K; KV cache
   scales with context, so all three figures above are figures *at 4096*, not
   figures full stop. `ramGb` has no field for the context it was taken at, and
   the notes carry it in prose instead.

2. **On Apple Silicon, process RSS under-reports badly, and the runner is no
   longer called `ollama runner`.** Under Ollama 0.34.1 the child process is
   `llama-server`. Worse, weights live in a Metal wired heap *outside* the
   process resident set: `gemma4:e4b` showed 4.4 GiB RSS against 9.5 GB of real
   residency. The figure that tracks reality is `ollama ps` SIZE, confirmed
   against the wired-memory delta across a load/unload cycle. Anyone repeating
   this measurement from RSS alone will write down roughly half the truth.

3. **All three need Ollama 0.34+ to pull at all.** On 0.18.2 the registry
   refuses the manifest with HTTP 412 and the runtime never sees the weights —
   while `curl` fetches the same manifest and blobs happily, so a manifest check
   proves the tag resolves and proves nothing about whether the model will load.
   `models.json` has no field for a minimum runtime version; the notes carry it
   in prose.

### Not decided here: a tool-calling model now measures under 8 GB

`lfm2.5:8b` calls tools and measures 5.3 GB resident. The task behind #42 said
that combination must not lower the README's 8 GB minimum or `TOOL_FLOOR` in the
same PR, and must be written down instead so the change can be its own decision.
This is that record.

"Under 8 GB" is true of the resident figure and false by REFUGIO's own
accounting. `machineSupport()` in `scripts/mem-fit.cjs` reserves 2.5 GB for
macOS, then adds 0.05 GB for the chat UI and 1.0 GB of headroom to the floor
model's figure:

| model | `ramGb` | `needGb` | usable on an 8 GB Mac | supported |
|---|---|---|---|---|
| `qwen2.5:3b` (today's `TOOL_FLOOR`) | 2.6 | 3.65 | 5.5 | yes |
| `lfm2.5:8b` | 5.3 | 6.35 | 5.5 | **no** |

So making `lfm2.5:8b` the floor would not bring a better model to 8 GB Macs — it
would stop REFUGIO supporting them. Nor is its capability above the floor
settled: it called `memory__memory_search` in both eval tasks, but `f1` returned
an empty answer after ~553 tokens of thinking, which is a completion failure
rather than a tool-calling one. What it could plausibly become is a recommended
step up on 12–16 GB machines — rank 52 against the floor's 30, with ~1B active
parameters keeping it quick. That is a ladder-shape decision, and it is left for
one.

### Measured: the built-in ladder, and every figure checked is high or exact

`scripts/mem-fit.cjs:27` calls its column "approx resident RAM under Ollama
(Q4 + a modest KV cache)", and until now nobody had checked it. The whole ladder
was measured on 2026-09-17 with `scripts/measure-models.cjs`, on the same Apple M4
Pro / 24 GB, macOS 26.7 (25G229), Ollama 0.34.1, at 4096, every model 100% GPU:

| tag | shipped | measured (`ollama ps` SIZE) | |
|---|---|---|---|
| `qwen2.5:0.5b` | 0.8 | **0.5** | high |
| `llama3.2:1b` | 1.5 | **1.5** | exact |
| `qwen2.5:3b` (`TOOL_FLOOR`) | 2.6 | **2.2** | high |
| `llama3.2:3b` | 3.0 | **2.5** | high |
| `llama3.1:8b` | 5.8 | **5.3** | high |
| `qwen2.5:14b` | 9.5 | **9.5** | exact |
| `gpt-oss:20b` | 13.5 | **12.7** | high |

No shipped figure is low. Every fit decision the ladder makes has erred toward
"too big", which is the safe direction: it may refuse a model that would have
fit, but never offers one that won't.

The figure does not depend on the machine. `qwen2.5:3b` measured **2155169709
bytes** on this M4 Pro / 24 GB / Ollama 0.34.1, and the same 2155169709 bytes a
few hours earlier on an Apple M3 / 8 GB, macOS 26.6.2, Ollama 0.34.0. Ollama
sizes the allocation from the weights and the context, so a model fully on the
GPU measures the same anywhere. A GPU share under 100% is the exception.

Two things this run corrects or adds:

- **`muse-glimmer:30b` is 17.6, not 17.0.** Re-measured, it came to 17642039538
  bytes, still 86% GPU. #42 recorded 17.0, most likely read from `ollama ps`'s
  display, which drops the decimal above 10 GB. The raw bytes decide;
  `models.json` was corrected to 17.6 on 2026-09-17. `lfm2.5:8b` (5.3) and `gemma4:e4b` (9.5)
  re-measured exactly as #42 recorded them.
- **Runner RSS is not a stand-in for SIZE.** For `gemma4:e4b` the runner's
  resident memory was 4.67 GiB against 9.5 GB SIZE and a 10.18 GiB wired delta.
  SIZE and wired agree; RSS does not, for this model.

The memory eval was re-run against `eval/fixtures/memory/` on the same machine,
and scored by hand. `lfm2.5:8b` scored **5/6** and `gemma4:e4b` **5/6**: both
found the notes and answered from them. `muse-glimmer:30b` scored **0/6** on two
attempts, never writing an answer, though every one of its searches returned the
notes. Its scorecards set out the likely cause, which is not specific to that
model. Each search returns both notes, about 1,300 tokens. Three searches fill
most of the 4,096-token context REFUGIO runs every model at, and leave no room to
answer. That was inference when it was written; it has since been measured, and
it holds — see *Answered* below.

The runner has a related blind spot. On 2026-09-16 it recorded every "No palace
found" reply as a successful tool call (`ok: true`), which is how empty memory
still earned auto band 2. Fixed 2026-09-17: `scripts/eval.cjs` now records that
reply as a miss, caps the task at band 1 with a note naming the fix, and shares
`isNoPalace()` with `scripts/memory-probe.cjs` so the two cannot disagree.

There was a second blind spot behind it. `muse-glimmer:30b` stopped mid-turn
with nothing written, and nothing on the machine could say whether it had run
out of room: REFUGIO sent Ollama no context option, so every model runs at
Ollama's default, and one memory search returns about 5,000 characters. Ollama
reports `prompt_eval_count` and `done_reason` on the final message of each round
and REFUGIO discarded both. Since 2026-09-17 the chat server logs them per round
and streams them as a `usage` event, the eval keeps them in its scorecards, and a
round that ends `done_reason: "length"` is noted as having run out of context —
a diagnosis, not a band change. That is the measurement the context question was
missing; #49 could only infer it.

Ollama's own log cannot help here: the supervisor starts `ollama serve` with
stdin, stdout and stderr on `/dev/null`, so it writes nothing at all. Every run
before this one left no record of its prompt sizes anywhere.

### Answered: three memory searches exhaust the context

Measured 2026-09-18 on the M4 Pro / 24 GB with the per-round logging above
(#51). One run of `b2-voice-from-memory` and `f1-memory-recall` against
`muse-glimmer:30b`, from `~/.refugio-logs/chat.log`:

| task | round | prompt | generated | ended |
|---|---|---|---|---|
| `b2` | 1 | 700 | 301 | `stop` |
| `b2` | 2 | **3,775** | 321 | **`length`** |
| `f1` | 1 | 672 | 258 | `stop` |
| `f1` | 2 | **3,781** | 315 | **`length`** |

3,775 + 321 = 4,096. 3,781 + 315 = 4,096. Both turns generated exactly the
budget left between the prompt and Ollama's default context, then stopped at the
ceiling with no answer written. The three memory searches happen in round 1; by
round 2 their results are in the prompt, and there is no room to answer from
them.

**This is not about `muse-glimmer:30b`.** Nothing in the mechanism is specific
to it. REFUGIO sends Ollama no context option, so every model runs at the
default — 4,096 on this machine's VRAM. `servers/memory-lite.js` asks for five
results; a palace holding just the two fixture notes returned about 5,200
characters per search, and a real one would return more. `chat/server.js` allows
five tool rounds. Any model that searches memory three times in a turn arrives
at the same ceiling. `lfm2.5:8b` and `gemma4:e4b` scored 5/6 on the same tasks
because they searched **once**, not because they are better at this.

So a model that uses its tools more thoroughly is punished for it, and the
failure looks like the model's fault: it stops mid-turn with nothing written,
which reads as a weak model rather than a budget it was never told about.

**The instrument now records this.** #52 fixed two holes behind the measurement:
the scorecard row dropped `usage` on the way to the file, and `autoScore`
returned on an error or an empty answer before it could add the "ran out of
context" note — which are exactly the turns that run out. A run like this one
now says so in its own scorecard.

**What to do about it is a design decision, not a measurement**, and all three
options cost something:

- **Send a larger `num_ctx`.** The most direct fix, and it changes the RAM
  figures measured above: KV cache scales with context, so every `ramGb` in this
  entry is a figure *at 4096* and would have to be re-taken. It also spends RAM
  on every turn to buy room a few turns need.
- **Cap what memory returns.** `memory-lite.js` chooses `limit: 5` and passes
  results through whole. Truncating them, or asking for fewer, keeps the budget
  but throws away what the model asked for — and the cap would be REFUGIO's
  guess at what matters in a note.
- **Cap total tool-result size per turn.** The general form, since any verbose
  connector can do this and memory is only the one that did. It is also the most
  work, and needs a rule for what to drop when the budget is spent.

**Chosen 2026-09-18: the third.** `chat/tool-budget.js` gives each turn
`REFUGIO_TOOL_RESULT_BUDGET` characters of tool results, default 8,000 — about
2,000 tokens, which leaves room to answer inside the 4,096 default after the
~700 tokens a turn's system prompt and tool list cost. The rule for what to
drop: earlier results are kept whole and later ones pay, because the first
search is the one the model chose with the most context about what it wanted.
Whatever is cut, the model is told in the tool message itself — a result quietly
shortened is worse than one refused, since the model then answers confidently
from half a note. On the measured case, three ~5,250-character searches become
one whole, one truncated at the boundary and one refused, instead of 15,750
characters of prompt and no answer.

What this does not do: it does not change what the person sees. The sources
panel still receives the result up to `REFUGIO_SOURCE_CHARS`, because "where did
this come from?" is the first question anyone asks of an answer built from their
own data. The budget is about what the model is handed, which is what has to
fit. Nor does it settle the context size: it makes 4,096 survivable, so raising
`num_ctx` stays open, and stays the thing that would re-open every RAM figure
in this entry.

Whichever is chosen, `REFUGIO_MAX_TOOL_ROUNDS` (default 5) sets how many times
this can compound, and nothing today tells a person why a turn stopped. The
`done=length` line is in the log, not in the window.

**What closing this takes.** Measuring is done. What remains is a decision, not
a measurement: whether to write these figures into `mem-fit.cjs` and
`models.json`. They are not independent of the rest of this entry. Lowering
`qwen2.5:3b` from 2.6 to 2.2 lowers what `machineSupport()` asks of an 8 GB Mac,
and lowering the ladder overall changes which model the installer picks for a
given amount of RAM. That belongs with the 8 GB-minimum question above.
`muse-glimmer:30b`'s 17.0 → 17.6 was the exception, a correction to a recorded
measurement with no policy in it, and it has been applied.

The context question above took the option that leaves these standing: capping
tool results per turn does not touch the context, so every figure here is still
good. Raising `num_ctx` would re-open all of them, and remains open.
