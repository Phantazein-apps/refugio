# Packaging REFUGIO for managed deployment

`.pkg` for macOS, `.msi` for Windows, both installable silently by MDM, both
configurable by policy. This document is mostly about the parts that are not
obvious, and one part that is genuinely not possible.

```
packaging/
├── macos/
│   ├── build-pkg.sh            pkgbuild → productbuild → productsign → notarytool
│   ├── distribution.xml        rootVolumeOnly + enable_localSystem
│   ├── scripts/{pre,post}install
│   ├── com.phantazein.refugio.agent.plist   /Library/LaunchAgents
│   ├── refugio-user-setup      the per-user half, run at each login
│   ├── refugio-cli             `refugio` for a packaged install
│   └── profiles/
│       ├── …pppc.mobileconfig      TCC grants — template, needs your Team ID
│       └── …settings.mobileconfig  managed settings — copy and edit
└── windows/
    ├── REFUGIO.wxs             WiX v4/v5, perMachine, Active Setup
    ├── build-msi.ps1           stage → wix build → signtool
    ├── user-setup.cjs          the per-user half, run by Active Setup
    ├── REFUGIO.admx            Group Policy template
    └── en-US/REFUGIO.adml
```

## The design, and why it isn't a wrapper

The ask was "wrap our existing scripts". The runtime is wrapped — `start-refugio.cjs`
and everything under it is exactly what runs. **`install-node.cjs` is not, and
cannot be.**

That script is a per-user, interactive installer: it prompts for credentials,
clones into `~/refugio`, and writes `~/Library/LaunchAgents`. An MDM install
runs as **root, non-interactively, quite possibly with nobody logged in** —
where `os.homedir()` is `/var/root`. Wrapping it would install REFUGIO for the
root account and for no human being, and would do it silently enough that the
MDM reports success.

So the packages replace that script's job with the standard split:

| | macOS | Windows |
|---|---|---|
| **Per machine**, at install | `/usr/local/refugio`, `/Applications/REFUGIO.app`, `/Library/LaunchAgents/…` | `C:\Program Files\REFUGIO`, `HKLM` |
| **Per user**, at first login | `/Library/LaunchAgents` agent → `refugio-user-setup` | Active Setup → `user-setup.cjs` |

Active Setup is the right Windows mechanism here and is under-used: its
`StubPath` runs once per user, the first time each user logs on after the
`Version` string changes. A `Run` key would fire on every logon and could never
tell the first from the four-hundredth.

**A LaunchAgent, not a LaunchDaemon**, and that is not a detail. REFUGIO reads
the user's Notes, Reminders and Messages. Those live inside the user's session
and behind the user's TCC consent. A daemon runs as root outside any session,
where it can reach none of them — and where "REFUGIO can read my messages"
would mean something much worse than it does now.

### Where a packaged install keeps its state

The supervisor decides this by asking whether it can write next to its own
code — a git checkout in `~/refugio` can, `/usr/local/refugio` and
`C:\Program Files\REFUGIO` cannot. That one check moves two things:

| | git install | packaged install |
|---|---|---|
| `mcpo-config.json` | `<install>/mcpo-config.json` | `~/.refugio-data/` |
| chat database, settings, attachments | `<install>/data/` | `~/.refugio-data/` |

Both were outright bugs before the packages existed. `mcpo-config.json` is
rewritten on **every** launch — into a root-owned directory that throws
`EACCES`, the supervisor dies, the login agent's `KeepAlive` restarts it, and
the machine sits in a crash loop that looks from outside like a package which
installed fine and does nothing. And the chat database in the install directory
would be **one database shared by everyone who logs into that Mac** — not a
permissions inconvenience but one person reading another's conversations.

Existing installs are unaffected: their directory is writable, so their history
stays exactly where it is. Only packaged installs — which are new, and have
nothing to migrate — go per-user.

Two consequences worth knowing:

- `https://refugio` (the Caddy + mkcert nicety) does **not** work on a packaged
  install. The certificates live in the install directory and it is read-only.
  `http://127.0.0.1:8090` is unaffected.
- The per-user setup writes `REFUGIO_INSTALL=pkg` into `~/.refugio.env`. That
  line is load-bearing, not decoration: the supervisor reads a file with no
  keys as "the installer was never run", says so and exits 1 — which under
  `KeepAlive` is a restart loop every ten seconds, forever.

### What is bundled, and what is not

**Bundled:** a Node runtime (~50 MB) and `node_modules`. "Install Node.js 18+
first" is not an instruction you can give to Intune, and a Homebrew Node owned
by one user is invisible to another. This removes the single largest cause of
an install that reports success and then does nothing.

**Not bundled: Ollama, and no model.** Deliberately. Together they are several
gigabytes; downloading them inside an MDM install means a package that takes an
hour, fails on a captive portal, and reports success either way. REFUGIO starts,
notices there is no engine, and says so in a window a person can read. An admin
who wants it pre-staged should deploy Ollama as its own MDM package — that is
the thing MDM is genuinely good at.

Payload is ~250 MB, of which `googleapis` is ~196 MB for the optional Google
Docs connector. Making that dependency lazy would take the package under 60 MB
and is the obvious next win if size matters to you.

## Signing: what it actually costs

This is the part that gates everything, and neither platform is free.

### macOS

Two **different** certificates, both from an Apple Developer Program
membership (**$99/year**), and they are not interchangeable — using one for the
other fails with an error that does not say so:

- **Developer ID Installer** → signs the `.pkg` (`productsign`)
- **Developer ID Application** → signs `REFUGIO.app` inside it (`codesign`)

Then **notarization**, which is separate from signing and required *in addition*
to it. A signed but un-notarized package still shows *"cannot be opened because
Apple cannot check it for malicious software"* on every Mac since Catalina.
Notarization needs an App Store Connect API key. Stapling the ticket is what
makes the package work on a machine that is offline at install time — which,
for a laptop being provisioned, is common.

### Windows

Harder than most people expect. Since **June 2023** the CA/Browser Forum
requires code-signing private keys to live on FIPS 140-2 Level 2 hardware. **A
`.pfx` on a CI runner is no longer how this works.** The options are:

| | Cost | CI-friendly |
|---|---|---|
| Azure Trusted Signing | ~$10/month | Yes — first-party GitHub Action |
| DigiCert KeyLocker | ~$500+/year | Yes |
| SSL.com eSigner | ~$250+/year | Yes |
| OV cert on a USB token | ~$200–400/year | **No** — cannot be used from a hosted runner |

Azure Trusted Signing is the pragmatic pick, and `build-msi.ps1` has a flag for
it. Note also that **SmartScreen will still warn** on a newly-signed MSI until
the certificate builds reputation, unless you buy EV. That is not a bug you can
fix in the build.

### CI

`.github/workflows/package.yml` builds on every push. Signing is conditional:
with no secrets it produces artifacts labelled `-UNSIGNED`, so forks and
outside PRs still get the build *checked*. Set these to sign:

| Secret | What |
|---|---|
| `MACOS_CERT_P12` | both certificates, base64 of a `.p12` |
| `MACOS_CERT_PASSWORD` | its password |
| `MACOS_INSTALLER_IDENTITY` | `Developer ID Installer: Acme (TEAMID)` |
| `MACOS_APPLICATION_IDENTITY` | `Developer ID Application: Acme (TEAMID)` |
| `NOTARY_KEY` / `NOTARY_KEY_ID` / `NOTARY_ISSUER_ID` | App Store Connect API key |

Both jobs **install the package they just built** and check what landed. A
package that builds is not the same as a package that installs, and the
difference is discovered by an IT department mid-rollout otherwise.

## The thing that is not possible

**An installer cannot grant itself access to Notes, Reminders or Messages.**

macOS asks the user, per app, at the moment of first use. Nothing a `.pkg` does
can pre-answer that — by design, and it is the right design. On an unmanaged
Mac the user clicks Allow and it works.

On a *managed* Mac that prompt is a real problem: it appears the first time
someone asks about their reminders, it is easy to dismiss by accident, and a
dismissed prompt is **remembered** — after which the connector fails forever
and the user has no idea why.

The answer is a **PPPC profile** pushed by MDM alongside the package, which
grants the access up front and silently. `profiles/…pppc.mobileconfig` is a
working template with two placeholders. Fill them after signing:

```bash
codesign -dr - /Applications/REFUGIO.app
# everything after "designated => " is the CodeRequirement
```

This only works on a **Developer ID signed** build. An ad-hoc signed app has no
stable identity for a profile to name, so MDM cannot grant it anything.

One warning about that file: it includes `SystemPolicyAllFiles` (Full Disk
Access) because the Messages connector reads `chat.db` directly. That is the
broadest grant macOS has. **Delete that section if you are not deploying the
Messages connector** — do not ship it "just in case".

## Managed settings

An admin can take decisions away from the user. `chat/managed.js` reads:

| Platform | Source |
|---|---|
| macOS | `/Library/Managed Preferences/com.phantazein.refugio.plist` (a config profile) |
| Windows | `HKLM\SOFTWARE\Policies\Phantazein\REFUGIO` (Group Policy / Intune ADMX / an MSI property) |
| Linux | `/etc/refugio/managed.json` |
| any | `REFUGIO_MANAGED_POLICY=/path/to.json` — for trying a policy before pushing it |

| Key | Values | Effect |
|---|---|---|
| `webSearch` | `off` \| `user` | The user cannot switch web search on at all. |
| `updateChecks` | `off` \| `user` | No contact with github.com, including "Check now". |
| `attachments` | `off` \| `user` | The paperclip is removed from the chat. |
| `allowedConnectors` | list | Only these connectors are **started**. |
| `allowedModes` | list | Only these discussion modes may be switched on; the rest are forced off. |

Three properties worth stating plainly:

- **Policy may only ever narrow.** There is no value of any key that turns web
  search *on*. Arming a search is a per-message decision the user makes with a
  warning in front of them, and that promise is not an administrator's to
  override.
- **A managed control is disabled, not overwritten.** A switch that accepts a
  click and reverts on the next poll reads as a bug in REFUGIO. A greyed-out
  switch saying *"Set by your organisation"* reads as what it is.
- **`allowedConnectors` is enforced where connectors are started**, not where
  they are drawn. A connector merely hidden is still running, still holding an
  open session to the user's WhatsApp, and still one prompt away from being read.
- **`allowedModes` clamps as well as locks.** A discussion mode is a saved
  boolean, not a process, so a mode the user switched on before the policy
  arrived is turned **off** and greyed — not left on and hidden. The ids are
  `nvc`, `styles`, `whatsapp`, `spanish`, `career`, `life`; a list naming none
  of them (`allowedModes: none`) takes the feature away entirely. There is no
  value that switches a mode *on* for someone: modes are off by default and a
  coaching conversation is one a person chooses to have.

A malformed policy never stops REFUGIO starting — an admin pushes to 400
machines and does not watch them boot, so a typo must not be a fleet outage.
Unknown keys and bad values are dropped **and logged by name**, because silence
there means an admin believing web search is off everywhere when it is on
everywhere.

Check what reached a machine:

```bash
refugio policy                                  # macOS
reg query HKLM\SOFTWARE\Policies\Phantazein\REFUGIO   # Windows
```

## Deploying

**Jamf** — upload the `.pkg` as a package, add both `.mobileconfig` profiles as
Configuration Profiles, scope all three to the same smart group. Order does not
matter; the profiles may land first.

**Intune (macOS)** — *macOS app (PKG)*. It must be signed **and** notarized;
Intune's agent will not install an unsigned package. Push the profiles as
*Templates ▸ Custom*.

**Intune (Windows)** — upload the `.msi` as a *Line-of-business app*, or wrap it
as `.intunewin`. Install command:

```
msiexec /i REFUGIO.msi /qn
msiexec /i REFUGIO.msi /qn WEBSEARCH=off UPDATECHECKS=off
```

Detection: `HKLM\SOFTWARE\Phantazein\REFUGIO\Version`.

For policy via Group Policy instead of MSI properties, copy `REFUGIO.admx` to
`%SystemRoot%\PolicyDefinitions\` (and the `.adml` to `en-US\`), or import it
under *Devices ▸ Configuration ▸ Import ADMX*.

## Building by hand

```bash
./packaging/macos/build-pkg.sh                     # unsigned, for testing
INSTALLER_ID="Developer ID Installer: Acme (TEAM)" \
APP_ID="Developer ID Application: Acme (TEAM)" \
NOTARY_PROFILE=refugio \
  ./packaging/macos/build-pkg.sh                   # signed + notarized
```

```powershell
.\packaging\windows\build-msi.ps1
.\packaging\windows\build-msi.ps1 -AzureTrustedSigning `
    -Endpoint https://weu.codesigning.azure.net -Account acme -Profile refugio
```

An unsigned build is genuinely useful for testing and genuinely useless for
distribution — Gatekeeper refuses the `.pkg` on any Mac that did not build it.
Both scripts say so loudly rather than producing something that looks finished.
