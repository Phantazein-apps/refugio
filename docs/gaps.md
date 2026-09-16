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
interface calls it an estimate depends on which **file** it arrived in rather
than on whether anybody measured it.

There are three sources, merged by `mergeIndex` in `chat/model-catalog.js`:

- the built-in ladder, `scripts/mem-fit.cjs:27` — `estimated: false`
  (`chat/model-catalog.js:279`)
- `models.json`, fetched by "Check for better models" — `estimated: false`
  (`chat/model-catalog.js:297`)
- a probe of an installed model REFUGIO has no rating for — `estimated: true`
  (`chat/model-catalog.js:322`)

The flag is hard-coded per source. A catalog entry cannot declare itself an
estimate: pass `estimated: true` in `models.json` and `mergeIndex` discards it
and writes `false`. `models.json`'s own `fields` block documents nine keys, and
neither `estimated` nor `source` is among them, so there is no supported way to
say it either.

This matters because the interface acts on the flag. `chat/static/settings.js:548`
prefixes a tilde, and `:549` attaches *"Estimated from the download size —
nobody has measured this one"* — but only when `estimated` is true. The rescan
aside at `:747` promises that sizes for models nobody has measured "are
estimated from their download size and shown with a ~".
`chat/server.js:303-304` states the rule outright: *"An estimate presented as a
measurement is the one thing this page must not do."*

Three catalog entries say in their own `note` that their size is estimated from
the download. All three render without the tilde and without the tooltip:

| tag | `ramGb` | own note says estimated | Settings renders |
|---|---|---|---|
| `lfm2.5:8b` | 6.1 | yes | `6.1 GB`, no tooltip |
| `gemma4:e4b` | 11.0 | yes | `11 GB`, no tooltip |
| `muse-glimmer:30b` | 20.2 | yes | `20.2 GB`, no tooltip |

Meanwhile an unrated model found on the machine — the one case where REFUGIO
genuinely knows nothing — is the only one that gets the honest label. The page
is most careful where it has least reason to be, and least careful about the
numbers a person is most likely to act on, because a catalog entry is what
"Check for better models" puts in front of them.

The built-in ladder is not exempt. `scripts/mem-fit.cjs:27` calls its column
"approx resident RAM under Ollama (Q4 + a modest KV cache)", and only the 3B
floor carries a note that it was "observed directly rather than assumed". The
rest are ship-dated approximations, flagged `estimated: false`.

**What closing it takes.** Two things, and only the second is a code change:

1. Measured resident figures for the three estimated entries — `ollama ps` SIZE
   and the CPU/GPU split, taken while the model is loaded and has served a turn
   that actually touches the KV cache and any expert pages.
2. An `estimated`/`source` field on a catalog entry that survives `mergeIndex`,
   so a number and its provenance travel together instead of the provenance
   being re-derived from which file the number arrived in.

**Why this entry is open rather than closed.** The measurement needs a machine
the models fit on, and the Mac it was attempted on is not one:

| | |
|---|---|
| Machine | Apple M3, macOS 26.6.2 (25G83) |
| Total RAM | 8.00 GB |
| Free at the time (`availableMemGb()`) | 1.27 GB |
| `machineSupport()` | `supported: false`, `transient: true`, `needGb: 3.7` |

`gemma4:e4b`'s weights are 9.61 GB and `lfm2.5:8b`'s are 5.16 GB — read from
their registry manifests, which match the download sizes the notes quote. The
tags resolve and both are pullable; neither can be resident on an 8 GB machine,
and `machineSupport()` was refusing even the 2.6 GB floor model at the time. A
figure obtained by loading a 9.6 GB model on an 8 GB Mac would measure swap
behaviour, not the model — and writing that down as "measured" is the failure
this entry exists to record.
