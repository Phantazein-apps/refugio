# Two products from one repository

A register of the REFUGIO / REFUGIO Listener split as it exists on `main`,
written for whoever changes it next. What is here is the shape of the code, the
decisions that are load-bearing, and the things this split deliberately did not
do — the last being the part that costs a session to re-derive.

Every file:line below was read on `main` rather than recalled.

---

## What the split is

**REFUGIO** is the connector product: a local model with reach into your own
data — WhatsApp, email, reminders, notes, Notion, Slack, Jira. **REFUGIO
Listener** is the coaching product: private conversations with no tools, no web
and nothing leaving the machine.

They are one codebase and two installs. Every mode, every guardrail, every
crisis layer and every test compiles into both; what differs is which modes an
install *offers*, and everything a person's data touches.

| | REFUGIO | REFUGIO Listener |
|---|---|---|
| Modes offered | category `data` — `whatsapp` | category `coaching` — `nvc`, `styles`, `spanish`, `career`, `life`, and the paired `nvc+whatsapp` |
| Install directory | `~/refugio` | `~/refugio-listener` |
| Conversations, settings | `~/.refugio-data` | `~/.refugio-listener-data` |
| Credentials | `~/.refugio.env` | `~/.refugio-listener.env` |
| Logs | `~/.refugio-logs` | `~/.refugio-listener-logs` |
| Chat port | 8090 | 8091 |
| Login item | `com.phantazein.refugio` | `com.phantazein.refugio-listener` |
| Command | `refugio` | `refugio-listener` |
| Bootstrap | `install-refugio` | `install-listener` |

A machine holds one at a time. The installer refuses to add the second and says
how to switch; `--replace` stands the first one down — stops it, removes its
login item and launchers — and deliberately leaves its directory and its
conversations on disk, so going back is running its installer again.

## The seams

| What | Where |
|---|---|
| The table of everything that differs | `editions.cjs` |
| The ESM view, and which edition this process is | `chat/edition.js` |
| Which modes an edition offers | `offeredModes` / `modeOffered`, `chat/modes.js` |
| The rows a surface is sent | `offeredSummaries`, used at `chat/server.js` in `modesPayload` |
| Per-edition pane copy | `MODES_UI_BY_EDITION` / `modesUi`, `chat/modes.js` |
| Refusing the other product's mode | `validateMode`'s third refusal, `chat/modes.js`; `wrongEditionMsg` in `chat/server.js` for the two write routes |
| Port and data directory defaults | `chat/server.js`, from `PRODUCT` |
| Supervisor paths, and telling the child | `start-refugio.cjs` |
| Install directory, conflict, stand-down, launcher names | `install-node.cjs` |
| Which product an uninstall removes | `uninstall-refugio`, from the marker beside it |

Four rules hold across all of it:

- **The table is the only place an edition differs.** A dozen `if (listener)`
  branches spread across an installer, a supervisor and a server is how a tray
  ends up named for one product and a login item for the other. Everything that
  differs is one row in `editions.cjs`, and every consumer reads it from there.
- **An install says what it is; the environment only overrides.** Resolution is
  `REFUGIO_EDITION`, then the `.refugio-edition` marker beside the code, then
  standard. The marker is the reliable one: a launchd job carries no
  environment, and a server started by hand carries a different one.
- **Nothing a person's data lives in is shared.** Not the port, not the
  database, not the credentials, not the login item. `test/edition.test.js`
  asserts this field by field rather than trusting the table to look right.
- **The catalogue is not narrowed, only the offering.** Both products compile
  every mode. The safety layers are therefore tested once, for both, and cannot
  rot in the edition nobody is currently working on.

## Decisions worth not re-litigating

1. **Category, not a second list of ids.** An edition declares
   `modeCategories`, and the registry already makes every mode declare what
   kind of thing it is. A new mode lands in the right product by being written,
   with nothing in `editions.cjs` to edit. The test that keeps this honest
   asserts every defined mode is offered by *exactly one* edition — a mode with
   a category no edition claims would compile, pass every other test, and be
   unreachable from both installs.
2. **A paired variant follows its base mode, not its connector.**
   `nvc+whatsapp` is the Listener's, though the connector it reads is REFUGIO's
   flagship. Connectors are not edition-scoped: both products can run any of
   them, which is what makes the pairing possible at all.
3. **Saved settings are kept, not rewritten.** `MODE_DEFAULTS` still declares
   every id in both products, and the payload's `enabled` map still carries
   them all. A machine that switches products keeps its choices, unoffered
   rather than erased, and gets them back if it switches again. This is also
   why `validateMode` checks the edition *before* "switched off": a file that
   says `nvc: true` in a REFUGIO install is normal, and sending that person to
   a Settings pane with no such switch would be a dead end.
4. **The refusal names the other product.** Three refusals that read as three
   different problems: an unknown id is a bug report, a switched-off mode is a
   trip to Settings, and a mode from the other product is an install. "Not
   available" with no destination is how a feature reads as removed.
5. **One at a time, and switching is not destructive.** The two could
   technically coexist — nothing is shared. They do not, because a machine with
   both has two similar windows, two login items, two supervisors and two model
   processes, and a conversation lands in whichever one was opened. That is not
   a configuration anyone chooses; it is one they end up in.

## What this split did NOT do

- **The macOS menu-bar app and the Windows/Linux tray icons are REFUGIO's
  only.** They hard-code the standard install's directory, port, log path and
  bundle identifier, and the Mac one is a Swift bundle that can only be built
  and exercised on a Mac. A second, differently-identified copy is real work
  with a real risk: an untested Listener menu-bar app would start and stop the
  *other* product. The installer says so in one line and installs the
  per-edition CLI and `Start REFUGIO Listener.command` instead, which do
  everything the launchers do. This is the largest remaining gap.
- **The `.pkg` and `.msi` builds are REFUGIO's only.** `packaging/` carries
  bundle identifiers, MDM configuration profiles and an ADMX template, all
  written for one product. A second set is a distribution decision — signing,
  identifiers, profiles — rather than a code change, and nothing in this split
  blocks it.
- **`install-node.cjs` keeps a second copy of three fields.** It is downloaded
  on its own and run before the repository it would read from exists, so it
  cannot avoid knowing where to install, what to print and which port to check.
  It asserts those three against `editions.cjs` the moment the clone lands, and
  `test/edition.test.js` asserts the same thing early enough to catch the drift
  before anyone runs the installer.
- **Nothing was removed from either product's build.** No mode was deleted, no
  guardrail made conditional, no test split in two. If the Listener's coaching
  modes ever need to stop shipping inside REFUGIO's binary, that is a different
  change with a different cost, and this one is not a step toward it.

## Adding an edition

`editions.cjs`, one row, plus a bootstrap script named in it. The test asserts
the new row shares nothing with the others and that every mode still belongs to
exactly one product — which is the check that will fail, correctly, if the new
edition claims a category another one already offers.
