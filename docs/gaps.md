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
| Windows | `packaging/windows/user-setup.js` writes `Startup\REFUGIO.cmd`, which starts **the supervisor** | Never writes the tray's `.vbs` or its Startup entry. `tray/refugio-tray.ps1` is in the payload and nothing ever runs it. |
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

## 8. Neither installer has ever been built

The `.pkg` and `.msi` are written and reviewed; the first real build is the
next run of `.github/workflows/package.yml`. Signing needs certificates that do
not exist yet, so what CI produces until then is unsigned and un-notarized —
which on macOS means *"cannot be opened because Apple cannot check it for
malicious software"* on every Mac since Catalina. See `packaging/README.md`
for the certificate types and costs.

## 9. Not a gap: TCC consent

`packaging/README.md` §"The thing that is not possible" — an installer cannot
grant itself access to Notes, Reminders or Messages, and no amount of packaging
work will change that. It requires a PPPC profile pushed by MDM alongside the
package, keyed to the app's Developer ID signature. Listed here so it stops
being re-raised as something that was forgotten.
