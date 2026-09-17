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
never initialised on that machine, and every one of the eleven calls returned
`null` (`No palace found`). That does not weaken the RAM figures — each turn still
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

### Still open: the built-in ladder is unmeasured, and at least one entry is wrong

`scripts/mem-fit.cjs:27` calls its column "approx resident RAM under Ollama
(Q4 + a modest KV cache)", and only the 3B floor carries a note that it was
"observed directly rather than assumed". The rest are ship-dated approximations,
and `chat/model-catalog.js` still stamps every one of them `estimated: false` —
correctly per the new field's meaning only if somebody actually measured them.

Measuring the catalog gave a free check on one of them. `llama3.1:8b` ships as
`ramGb: 5.8`; on the same machine, same context, same method it measures **5.3
GB `ollama ps` / 4.915 GiB wired** — the shipped figure is ~10–18% high, in the
same direction and roughly the same proportion as the three download-sized
estimates were. One sample is not a pattern, but it is the only ladder entry
anybody has re-checked, and it did not survive the check.

A second has since. `qwen2.5:3b` — `TOOL_FLOOR` itself — ships as `ramGb: 2.6`
and measured **2.2 GB** `ollama ps`, 100% GPU at 4096, runner RSS 1.94 GiB, on
2026-09-17 on an Apple M3 / 8 GB, macOS 26.6.2, Ollama 0.34.0, via
`scripts/measure-models.cjs`. That is ~15% high, in the same direction as every
other figure checked so far. It was left alone deliberately: the floor's figure
is what `machineSupport()` adds headroom to, so correcting it changes which
machines REFUGIO says it supports, and that belongs with the 8 GB-minimum
decision above rather than in a measurement.

**What closing this takes.** The same measurement, run over the seven ladder
entries, and either measured figures in `mem-fit.cjs` or `estimated: true`
reaching them the way it now reaches the catalog. Until then the ladder is the
larger surface: it is the installer's source of truth and the fallback whenever
`models.json` cannot be fetched, so it decides what gets downloaded on a machine
that has never reached the network for a catalog.
