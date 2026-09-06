#!/usr/bin/env node
// REFUGIO Installer — cross-platform, no Docker required
// Usage: curl -fsSL https://raw.githubusercontent.com/Phantazein-apps/refugio/main/install-refugio | bash
//    or: node install-node.cjs [--no-start] [--non-interactive] [--skip-owui] [directory]

const { execSync, spawn } = require("child_process")
const fs = require("fs")
const path = require("path")
const os = require("os")
const readline = require("readline")

// ── Helpers ──────────────────────────────────────────────────

const isWin = os.platform() === "win32"
const home = os.homedir()

// ── Which product is being installed ─────────────────────────
//
// This repository builds two: REFUGIO and REFUGIO Listener. They are separate
// installs — separate directory, port, credentials file, login item and data —
// and a machine holds one of them at a time.
//
// The table that says what differs is editions.cjs, in the repository. This
// file cannot read it: it is downloaded on its own and run BEFORE anything is
// cloned. So it carries the three facts it needs before the clone — where to
// install, what to print, and which port to check is free — and nothing else.
// Every other edition fact is read from editions.cjs the moment it exists, and
// loadEdition() below refuses to continue if these three disagree with it.
// test/edition.test.js fails on the same disagreement, so the drift is caught
// before anyone runs the installer rather than during.
const EDITION_BOOT = {
  standard: { dir: "refugio", product: "REFUGIO", chatPort: 8090 },
  listener: { dir: "refugio-listener", product: "REFUGIO Listener", chatPort: 8091 },
}

/** The edition being installed, and its full row once the clone has happened.
 *  `boot` until then. */
let ED = { id: "standard", ...EDITION_BOOT.standard }

// Resolved uv command. On Apple Silicon this may become an absolute path to a
// native arm64 uv so we never build an x86_64 Python env (which lacks macOS
// wheels for onnxruntime / cryptography). Set by installUV().
let UV = "uv"

const C = process.stdout.isTTY ? {
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  bold: "\x1b[1m", dim: "\x1b[2m", reset: "\x1b[0m"
} : { green: "", red: "", yellow: "", bold: "", dim: "", reset: "" }

function ok(msg) { console.log(`  ${C.green}✓${C.reset} ${msg}`) }
function warn(msg) { console.log(`  ${C.yellow}!${C.reset} ${msg}`) }
function fail(msg) { console.log(`  ${C.red}✗${C.reset} ${msg}`) }

function has(cmd) {
  try {
    execSync(isWin ? `where ${cmd}` : `which ${cmd}`, { stdio: "ignore" })
    return true
  } catch { return false }
}

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "inherit", ...opts })
}

function runQuiet(cmd) {
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
}

// True on Apple Silicon hardware — reported even when the current process is
// running under Rosetta (x86_64), so it reflects the machine, not the toolchain.
function isAppleSilicon() {
  if (os.platform() !== "darwin") return false
  try { return runQuiet("sysctl -n hw.optional.arm64") === "1" } catch { return false }
}

// Is a given binary an x86_64 Mach-O? (used to spot Rosetta/Intel toolchains)
function isX86Binary(bin) {
  try { return /x86_64/.test(runQuiet(`file "${bin}"`)) } catch { return false }
}

function whichCmd(cmd) {
  try { return runQuiet(isWin ? `where ${cmd}` : `command -v ${cmd}`).split("\n")[0].trim() } catch { return "" }
}

// The Python request for uv. On Apple Silicon we pin the ARCH explicitly so uv
// won't reuse a cached x86_64 interpreter (which would re-break onnxruntime), and
// we pin the VERSION to 3.12 so native deps like cryptography have prebuilt wheels
// (uv otherwise defaults to 3.14/3.15, which lack them and trigger source builds).
function pyArg() {
  return isAppleSilicon() ? "cpython-3.12-macos-aarch64-none" : "3.12"
}

async function ask(question, defaultVal = "", secret = false) {
  const suffix = defaultVal ? ` ${C.dim}[${defaultVal}]${C.reset}` : ""
  if (!secret) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return new Promise(resolve => {
      rl.question(`  ${question}${suffix}: `, answer => {
        rl.close()
        resolve(answer.trim() || defaultVal)
      })
    })
  }
  // Secret mode: mask input with asterisks
  return new Promise(resolve => {
    process.stdout.write(`  ${question}${suffix}: `)
    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf-8")
    let input = ""
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n") {
        stdin.setRawMode(wasRaw || false)
        stdin.pause()
        stdin.removeListener("data", onData)
        process.stdout.write("\n")
        resolve(input.trim() || defaultVal)
      } else if (ch === "" || ch === "\b") {
        if (input.length > 0) {
          input = input.slice(0, -1)
          process.stdout.write("\b \b")
        }
      } else if (ch === "") {
        // Ctrl+C
        process.exit(1)
      } else {
        input += ch
        process.stdout.write("*")
      }
    }
    stdin.on("data", onData)
  })
}

async function confirm(question, defaultYes = false) {
  const hint = defaultYes ? "Y/n" : "y/N"
  const answer = await ask(`${question} (${hint})`, defaultYes ? "y" : "n")
  return /^y/i.test(answer)
}

// ── Connectors ───────────────────────────────────────────────
// Connectors are split into two groups: PERSONAL (your own messages, mail, and
// notes — offered first) and BUSINESS (workplace systems — behind a single
// opt-in gate). WhatsApp (Hermeneia) and email (Epistole) have their own setup
// flows with a browser auth step, so they're not in these credential lists.

const ACCOUNT_CONNECTOR = {
  id: "account", name: "Your Account",
  fields: [
    { key: "OWUI_NAME", prompt: "Your display name" },
    { key: "OWUI_EMAIL", prompt: "Your email address" },
    { key: "OWUI_PASSWORD", prompt: "Set a password", secret: true, defaultVal: "changeme" }
  ]
}

// Notion used to be prompted for here too. Same reasoning as the toggles
// above: a secret token pasted into a terminal, with the help URL scrolling
// past, is worse than the same field in the setup window — which can also
// check the token's shape before storing it.

const BUSINESS_CONNECTORS = [
  {
    id: "slack", name: "Slack",
    help: "https://api.slack.com/apps → OAuth & Permissions → User Token Scopes: search:read, channels:history, channels:read, users:read",
    fields: [
      { key: "SLACK_TOKEN", prompt: "Slack user token (xoxp-...)", secret: true }
    ]
  },
  {
    id: "jira", name: "Jira",
    help: "https://id.atlassian.com/manage-profile/security/api-tokens",
    fields: [
      { key: "JIRA_DOMAIN", prompt: "Jira domain (e.g. yourcompany.atlassian.net)" },
      { key: "JIRA_EMAIL", prompt: "Jira email" },
      { key: "JIRA_API_TOKEN", prompt: "Jira API token", secret: true }
    ]
  },
  {
    id: "servicenow", name: "ServiceNow",
    help: "Instance format: yourcompany.service-now.com",
    fields: [
      { key: "SERVICENOW_INSTANCE", prompt: "ServiceNow instance URL" },
      { key: "SERVICENOW_USERNAME", prompt: "ServiceNow username" },
      { key: "SERVICENOW_PASSWORD", prompt: "ServiceNow password", secret: true }
    ]
  },
  {
    id: "salesforce", name: "Salesforce",
    help: "Instance format: https://yourcompany.my.salesforce.com",
    fields: [
      { key: "SALESFORCE_INSTANCE_URL", prompt: "Salesforce instance URL" },
      { key: "SALESFORCE_USERNAME", prompt: "Salesforce username" },
      { key: "SALESFORCE_PASSWORD", prompt: "Salesforce password", secret: true },
      { key: "SALESFORCE_SECURITY_TOKEN", prompt: "Salesforce security token (blank if IP allowlisted)", secret: true }
    ]
  }
]

// Memory is chosen separately (MemPalace vs GitHub-backed). These are the
// fields prompted only when the GitHub-backed backend is selected.
const GITHUB_FIELDS = [
  { key: "GITHUB_TOKEN", prompt: "GitHub PAT (ghp_...)", secret: true },
  { key: "GITHUB_OWNER", prompt: "GitHub org or username" },
  { key: "GITHUB_REPO", prompt: "GitHub repo name" },
  { key: "GITHUB_MEMORY_PATH", prompt: "Memory file path", defaultVal: "MEMORY.md" }
]

// Prompts for GitHub-backed memory credentials. Returns false if the user skips
// (no token) — most people won't have a PAT + private repo ready, so the token
// prompt offers a clean exit instead of trapping them.
async function promptGithubFields(env, existing) {
  console.log(`    ${C.dim}Needs a GitHub fine-grained PAT + a private repo. Don't have one yet?${C.reset}`)
  console.log(`    ${C.dim}Press Enter at the token prompt to skip — re-run the installer later to set it up.${C.reset}`)
  console.log(`    ${C.dim}Token: https://github.com/settings/tokens?type=beta → Permissions: Contents → Read and write${C.reset}`)
  const [tokenField, ...rest] = GITHUB_FIELDS
  const curTok = existing[tokenField.key] || ""
  const tok = await ask(`${tokenField.prompt} (Enter to skip)`, curTok ? `****${curTok.slice(-4)}` : "", true)
  if ((!tok || tok.startsWith("****")) && !curTok) return false   // skipped
  env[tokenField.key] = (tok && !tok.startsWith("****")) ? tok : curTok
  for (const field of rest) {
    const current = existing[field.key] || field.defaultVal || ""
    const display = field.secret && current ? `****${current.slice(-4)}` : current
    const value = await ask(field.prompt, display, field.secret)
    if (value && !value.startsWith("****")) env[field.key] = value
    else if (current) env[field.key] = current
  }
  // Need token + owner + repo to actually work. If anything's missing, skip
  // cleanly (and drop the partial values) rather than leaving a broken connector.
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    warn("Incomplete GitHub details — skipping memory (re-run the installer to add it later)")
    delete env.GITHUB_TOKEN; delete env.GITHUB_OWNER; delete env.GITHUB_REPO; delete env.GITHUB_MEMORY_PATH
    return false
  }
  return true
}

// ── macOS menu-bar app ───────────────────────────────────────
// REFUGIO's stack (Ollama + model + Open WebUI) can hold GBs of RAM, and
// without this the only way to stop it is a terminal — so the menu bar is how
// a non-technical user reclaims their memory. The app already exists in
// menubar/; it was just never installed for them.
//
// Needs the Swift toolchain. If it's absent we skip with a one-line hint
// rather than failing the install or dragging the user through an Xcode
// download mid-setup.
function installMenuBarApp(targetDir) {
  // The menu-bar app and the tray icons are REFUGIO's, and only REFUGIO's, for
  // now. They are a Swift bundle and two scripts that hard-code the standard
  // install's directory, port, log path and bundle identifier; building a
  // second, differently-identified copy of them is real work with no way to
  // test it from anywhere but a Mac, and shipping an untested one would give
  // the Listener a menu-bar icon that starts and stops the other product.
  // Everything the launchers actually do is available from the CLI this
  // installer writes, which IS per-edition. See docs/editions.md.
  if (ED.id !== "standard") {
    console.log(`  ${C.dim}Menu-bar and tray launchers are REFUGIO-only for now — use the`)
    console.log(`    ${ED.cli} command (or "${startCommandName()}") to start and stop.${C.reset}`)
    return
  }
  const menubarDir = path.join(targetDir, "menubar")
  const script = path.join(menubarDir, "install.sh")
  if (!fs.existsSync(script)) return

  // "Already installed" used to end it, so the app never picked up a newer
  // build — someone who installed once kept a months-old menu bar forever, and
  // a broken app stayed broken because the installer congratulated itself and
  // moved on. Rebuild whenever the sources are newer than what is installed.
  const installed = "/Applications/REFUGIO.app"
  if (fs.existsSync(installed)) {
    let stale = true
    try {
      const appTime = fs.statSync(path.join(installed, "Contents", "MacOS", "RefugioBar")).mtimeMs
      const srcTime = Math.max(...fs.readdirSync(path.join(menubarDir, "Sources", "RefugioBar"))
        .map((f) => fs.statSync(path.join(menubarDir, "Sources", "RefugioBar", f)).mtimeMs))
      stale = srcTime > appTime
    } catch { /* can't tell — rebuilding is the safe answer */ }
    if (!stale) {
      ok("Menu-bar app is up to date (/Applications/REFUGIO.app)")
      return
    }
    console.log(`  ${C.dim}Menu-bar app is out of date — rebuilding.${C.reset}`)
  }
  if (!has("swift")) {
    console.log(`  ${C.dim}Menu-bar app skipped — needs the Swift toolchain.`)
    console.log(`    Install it with: xcode-select --install`)
    console.log(`    Then run: cd "${menubarDir}" && ./install.sh${C.reset}`)
    return
  }

  console.log(`  ${C.bold}Menu-bar app${C.reset} ${C.dim}— start/stop/quit REFUGIO without a terminal${C.reset}`)
  try {
    // Capture rather than discard: a build that fails silently leaves someone
    // with no menu bar and no idea why, which is exactly the state this app
    // exists to avoid being in.
    execSync(`"${script}"`, { cwd: menubarDir, stdio: "pipe" })
    ok("Menu-bar app installed — look for REFUGIO's mark in your menu bar")
    console.log(`    ${C.dim}Use “Stop REFUGIO” there to free the memory it uses.${C.reset}`)
  } catch (e) {
    // Print install.sh's OWN output, whole. It already says the important
    // thing — that /Applications still holds the previous build, and when it
    // was made — and this used to filter for lines matching `error:`, which
    // dropped exactly that message. A build failure here is not a footnote:
    // the app keeps running with the old behaviour, and the symptoms
    // (an icon that doesn't change, a window that won't drag) look like
    // separate bugs for as long as nobody sees this.
    warn("Menu-bar app build FAILED — /Applications/REFUGIO.app was NOT replaced.")
    const out = `${e.stdout || ""}\n${e.stderr || ""}`.trim() || String(e.message || "")
    for (const line of out.split("\n").slice(-30)) {
      if (line.trim()) console.log(`      ${line}`)
    }
    console.log(`    ${C.dim}Retry with: cd "${menubarDir}" && ./install.sh${C.reset}`)
  }
}

// ── Windows tray ─────────────────────────────────────────────
// WinForms NotifyIcon ships with Windows, so the tray needs no dependency and
// no build step. Writes a launcher .vbs (runs PowerShell with no console
// window) plus a Startup shortcut, mirroring the macOS menu-bar app.
function installWindowsTray(targetDir) {
  // The menu-bar app and the tray icons are REFUGIO's, and only REFUGIO's, for
  // now. They are a Swift bundle and two scripts that hard-code the standard
  // install's directory, port, log path and bundle identifier; building a
  // second, differently-identified copy of them is real work with no way to
  // test it from anywhere but a Mac, and shipping an untested one would give
  // the Listener a menu-bar icon that starts and stops the other product.
  // Everything the launchers actually do is available from the CLI this
  // installer writes, which IS per-edition. See docs/editions.md.
  if (ED.id !== "standard") {
    console.log(`  ${C.dim}Menu-bar and tray launchers are REFUGIO-only for now — use the`)
    console.log(`    ${ED.cli} command (or "${startCommandName()}") to start and stop.${C.reset}`)
    return
  }
  const ps1 = path.join(targetDir, "tray", "refugio-tray.ps1")
  if (!fs.existsSync(ps1)) return

  // .vbs wrapper: launching powershell.exe directly flashes a console window.
  const vbs =
    `Set s = CreateObject("Wscript.Shell")\r\n` +
    `s.Run "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${ps1}"" ` +
    `-RefugioDir ""${targetDir}""", 0, False\r\n`
  const vbsPath = path.join(targetDir, "REFUGIO Tray.vbs")
  try { fs.writeFileSync(vbsPath, vbs) } catch { return }

  // Start with Windows so the tray is there when the user needs it.
  try {
    const startup = path.join(home, "AppData", "Roaming", "Microsoft",
      "Windows", "Start Menu", "Programs", "Startup")
    if (fs.existsSync(startup)) {
      fs.copyFileSync(vbsPath, path.join(startup, "REFUGIO Tray.vbs"))
    }
  } catch {}

  try { execSync(`wscript "${vbsPath}"`, { stdio: "ignore" }) } catch {}
  ok("Tray icon installed — look for REFUGIO near the clock")
  console.log(`    ${C.dim}Use "Stop REFUGIO & Quit" there to free the memory it uses.${C.reset}`)
}

// ── Linux tray ───────────────────────────────────────────────
// Linux has no universal tray API — GNOME needs the AppIndicator extension,
// most other desktops work out of the box — so this drives `yad`, packaged
// everywhere. Without yad the script prints install guidance and exits; the
// `refugio` CLI is unaffected either way.
function installLinuxTray(targetDir, appsDir) {
  // The menu-bar app and the tray icons are REFUGIO's, and only REFUGIO's, for
  // now. They are a Swift bundle and two scripts that hard-code the standard
  // install's directory, port, log path and bundle identifier; building a
  // second, differently-identified copy of them is real work with no way to
  // test it from anywhere but a Mac, and shipping an untested one would give
  // the Listener a menu-bar icon that starts and stops the other product.
  // Everything the launchers actually do is available from the CLI this
  // installer writes, which IS per-edition. See docs/editions.md.
  if (ED.id !== "standard") {
    console.log(`  ${C.dim}Menu-bar and tray launchers are REFUGIO-only for now — use the`)
    console.log(`    ${ED.cli} command (or "${startCommandName()}") to start and stop.${C.reset}`)
    return
  }
  const sh = path.join(targetDir, "tray", "refugio-tray.sh")
  if (!fs.existsSync(sh)) return
  try { fs.chmodSync(sh, 0o755) } catch {}

  const entry =
    `[Desktop Entry]\nType=Application\nName=REFUGIO Tray\n` +
    `Comment=Start, stop and open REFUGIO from the system tray\n` +
    `Exec="${sh}"\nIcon=${path.join(targetDir, "branding", "favicon.png")}\n` +
    `Terminal=false\nCategories=Utility;\nX-GNOME-Autostart-enabled=true\n`
  try { fs.writeFileSync(path.join(appsDir, "refugio-tray.desktop"), entry) } catch {}

  const autostart = path.join(home, ".config", "autostart")
  try {
    fs.mkdirSync(autostart, { recursive: true })
    fs.writeFileSync(path.join(autostart, "refugio-tray.desktop"), entry)
  } catch {}

  if (has("yad")) {
    try { execSync(`setsid "${sh}" >/dev/null 2>&1 &`, { stdio: "ignore", shell: "/bin/bash" }) } catch {}
    ok("Tray icon installed — look for REFUGIO in your system tray")
    console.log(`    ${C.dim}Use "Stop REFUGIO & Quit" there to free the memory it uses.${C.reset}`)
  } else {
    console.log(`  ${C.dim}Tray icon set up, but it needs 'yad' to show:`)
    console.log(`    Debian/Ubuntu: sudo apt install yad   ·   Fedora: sudo dnf install yad`)
    console.log(`    (GNOME also needs the AppIndicator extension.)`)
    console.log(`    REFUGIO works without it: 'refugio' to start, 'refugio stop' to free RAM.${C.reset}`)
  }
}

// ── Personal connector: WhatsApp via Hermeneia ───────────────
// Hermeneia (github.com/Phantazein-apps/hermeneia) is a local WhatsApp MCP
// server and REFUGIO's flagship personal connector. Its bridge is pure Go
// (no CGO), so it runs on macOS (Apple Silicon + Intel), Linux (x64/arm64),
// and Windows — which is exactly what lets a headless Linux REFUGIO host talk
// to WhatsApp. "Install" is a shallow clone (which carries the Node bundle,
// dist/index.js) plus fetching the matching prebuilt bridge binary from the
// latest release. Auth is a QR scan: running the server exposes a QR page and
// its local status API reports when the phone has linked.

const HERMENEIA_REPO = "https://github.com/Phantazein-apps/hermeneia.git"
// Pin Hermeneia to a RELEASE TAG, not its default branch.
//
// This previously cloned Hermeneia unpinned, which caused a live outage: its
// master stopped committing the prebuilt Go bridge binary (it moved to release
// assets), so every new REFUGIO install cloned a master with no runnable
// bridge and silently lost WhatsApp. Pinning the checkout AND pulling the
// bridge from that same release keeps the two halves in lockstep.
// Override for testing: HERMENEIA_VERSION=master.
const HERMENEIA_VERSION = process.env.HERMENEIA_VERSION || "v0.4.13"
const HERMENEIA_RELEASE_BASE =
  `https://github.com/Phantazein-apps/hermeneia/releases/download/${HERMENEIA_VERSION}`
const HERMENEIA_QR_PORT = 3456

// Move an existing Hermeneia checkout onto the pinned ref. Fetches the tag
// first (a --depth 1 clone won't have it), then checks it out detached.
// Best-effort: a checkout that can't be moved is left as-is rather than
// failing the install — ensureHermeneiaBridge() still validates what's there.
function checkoutHermeneiaVersion(dir) {
  try {
    const cur = execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, encoding: "utf-8" }).trim()
    execSync(`git fetch --depth 1 origin tag ${HERMENEIA_VERSION}`, { cwd: dir, stdio: "ignore" })
    execSync(`git checkout --quiet ${HERMENEIA_VERSION}`, { cwd: dir, stdio: "ignore" })
    if (cur !== HERMENEIA_VERSION) {
      console.log(`    ${C.dim}Hermeneia pinned to ${HERMENEIA_VERSION}${C.reset}`)
    }
  } catch {
    warn(`Could not move Hermeneia to ${HERMENEIA_VERSION} — using the existing checkout.`)
  }
}

// Map this machine to the bridge binary Hermeneia publishes, using the SAME
// naming its dist/bridge.ts resolver expects (win32→windows, x64→amd64).
// Returns null for a platform/arch combination Hermeneia doesn't build for.
function hermeneiaBridgeTarget() {
  const goos = os.platform() === "win32" ? "windows" : os.platform() // darwin | linux | windows
  const arch = os.arch() // 'x64' | 'arm64' | ...
  const goarch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null
  if (!goarch) return null
  const supported = new Set(["darwin-arm64", "darwin-amd64", "linux-amd64", "linux-arm64", "windows-amd64"])
  if (!supported.has(`${goos}-${goarch}`)) return null
  return { goos, goarch, ext: goos === "windows" ? ".exe" : "" }
}

// Hermeneia's per-platform data directory (mirrors its src/index.ts getDataDir),
// used to detect whether a WhatsApp account has already been linked.
function hermeneiaDataDir() {
  if (process.env.HERMENEIA_DATA_DIR) return process.env.HERMENEIA_DATA_DIR
  if (os.platform() === "darwin") return path.join(home, "Library", "Application Support", "Hermeneia")
  if (os.platform() === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Hermeneia")
  return path.join(home, ".hermeneia")
}

// Ensure the Go bridge binary exists in the checkout's dist/. The binary is no
// longer committed to Hermeneia's git (it's a large, platform-specific
// artifact), so after a clone we fetch the matching prebuilt from the latest
// release. Returns true if a usable bridge is present afterwards.
function ensureHermeneiaBridge(dir) {
  const target = hermeneiaBridgeTarget()
  if (!target) {
    warn(`No prebuilt WhatsApp bridge for this platform (${os.platform()}/${os.arch()}).`)
    return false
  }
  const { goos, goarch, ext } = target
  const distDir = path.join(dir, "dist")
  const binName = `hermeneia-bridge-${goos}-${goarch}${ext}`
  const binPath = path.join(distDir, binName)

  // Already present — a prior install, or built from source with `npm run build`.
  if (fs.existsSync(binPath) || fs.existsSync(path.join(distDir, `hermeneia-bridge${ext}`))) return true

  const asset = `hermeneia-bridge-${goos}-${goarch}.tar.gz`
  const url = `${HERMENEIA_RELEASE_BASE}/${asset}`
  const tmp = path.join(os.tmpdir(), asset)
  try {
    execSync(`curl -fsSL -o "${tmp}" "${url}"`, { stdio: "ignore", shell: true })
    execSync(`tar xzf "${tmp}" -C "${distDir}"`, { stdio: "ignore", shell: true })
    if (!isWin) { try { fs.chmodSync(binPath, 0o755) } catch {} }
    try { fs.unlinkSync(tmp) } catch {}
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    warn(`Could not fetch the WhatsApp bridge for ${goos}/${goarch}.`)
    console.log(`    ${C.dim}Tried ${url}${C.reset}`)
    console.log(`    ${C.dim}If this platform has no release yet, build it from source: cd "${dir}" && npm install && npm run build (needs Go 1.21+).${C.reset}`)
    return false
  }
  return fs.existsSync(binPath)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function fetchJson(url, timeout = 1500) {
  return new Promise(resolve => {
    try {
      const req = require("http").get(url, res => {
        let body = ""
        res.on("data", c => body += c)
        res.on("end", () => { try { resolve(JSON.parse(body)) } catch { resolve(null) } })
      })
      req.on("error", () => resolve(null))
      req.setTimeout(timeout, () => { req.destroy(); resolve(null) })
    } catch { resolve(null) }
  })
}

// Has this machine EVER paired a WhatsApp account? This is only a cheap
// file-based hint — NOT proof the device is still linked. accounts.json keeps
// the phone number (and the session DB stays on disk) even after WhatsApp
// revokes the device server-side or the user removes the "Claude" device from
// their phone. So this can report "paired" for a connection that's actually
// dead. Treat a true result as "worth verifying", never as "definitely
// connected" — only Hermeneia's live status API (see hermeneiaQRAuth) knows
// the real state.
function hermeneiaEverPaired() {
  const dataDir = hermeneiaDataDir()
  try {
    const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, "accounts.json"), "utf-8"))
    if (!Array.isArray(accounts) || accounts.length === 0) return false
    if (accounts.some(a => a && a.phone)) return true
    const hasSession = accounts.some(a => a && a.id &&
      fs.existsSync(path.join(dataDir, "accounts", a.id, "whatsmeow.db")))
    const msgDb = fs.statSync(path.join(dataDir, "messages.db"))
    return hasSession && msgDb.size > 1024 * 1024
  } catch { return false }
}

async function hermeneiaQRAuth(dir) {
  const setupUrl = `http://127.0.0.1:${HERMENEIA_QR_PORT}/setup`
  console.log("")
  console.log(`    ${C.bold}Linking your WhatsApp${C.reset} — a QR page opens in your browser.`)
  console.log(`    ${C.dim}Headless or remote host? No browser opens — open this yourself`)
  console.log(`    (tunnel the port over SSH if needed): ${C.reset}${C.bold}${setupUrl}${C.reset}`)
  console.log(`    On your phone: ${C.bold}WhatsApp → Settings → Linked Devices → Link a Device${C.reset},`)
  console.log(`    then point the camera at the QR code.`)
  console.log("")

  // Run Hermeneia directly. If the saved session is still valid it just
  // connects (authenticated=true, no QR). If not — including after WhatsApp
  // revoked the device — it starts the QR page and, on a desktop, opens the
  // browser itself. stdin stays open (pipe) — it's a stdio MCP server.
  const child = spawn(process.execPath, [path.join(dir, "dist", "index.js")], {
    stdio: ["pipe", "ignore", "ignore"],
    env: {
      ...process.env,
      HERMENEIA_QR_PORT: String(HERMENEIA_QR_PORT),
      // Pairing made here shows up as "REFUGIO" in WhatsApp > Linked Devices
      HERMENEIA_DEVICE_NAME: "REFUGIO"
    }
  })
  let spawnFailed = false
  child.on("error", () => { spawnFailed = true })

  const deadline = Date.now() + 180_000
  let linked = false
  process.stdout.write("    Waiting for the scan (up to 3 min) ")
  while (Date.now() < deadline && !spawnFailed) {
    // Hermeneia's QR server bumps to the next port if 3456 is taken
    for (const port of [HERMENEIA_QR_PORT, HERMENEIA_QR_PORT + 1]) {
      const s = await fetchJson(`http://127.0.0.1:${port}/api/status/default`)
      if (s && s.authenticated) { linked = true; break }
    }
    if (linked) break
    process.stdout.write(".")
    await sleep(2000)
  }
  console.log("")

  if (linked) {
    ok("WhatsApp linked! (message history syncs in the background once REFUGIO runs)")
    await sleep(8000)   // let the bridge persist the fresh session before stopping
  } else {
    warn("QR not scanned — no problem. The QR page opens again the first time REFUGIO starts.")
  }
  try { child.kill("SIGTERM") } catch {}
  await sleep(1500)   // release Hermeneia's single-instance lock before the supervisor respawns it
  return linked
}

async function setupHermeneia(env, existing, { link = true } = {}) {
  // Hermeneia is REFUGIO's flagship personal connector and runs anywhere a
  // prebuilt bridge exists: macOS (Apple Silicon + Intel), Linux (x64/arm64),
  // Windows (x64). Only bail on a platform with no bridge at all.
  if (!hermeneiaBridgeTarget()) {
    console.log(`    ${C.dim}WhatsApp (Hermeneia) has no prebuilt bridge for ${os.platform()}/${os.arch()} — not offered on this machine.${C.reset}\n`)
    return
  }

  // A saved phone number is NOT proof the device is still linked — WhatsApp can
  // revoke it server-side (or you remove the "Claude" device on your phone) and
  // nothing on disk changes. So we NEVER suppress the link offer based on the
  // file heuristic; the QR flow itself is the source of truth (it reports
  // "already linked!" in seconds if the session is live, or shows a QR if not).
  const configured = existing.HERMENEIA_DIR && fs.existsSync(path.join(existing.HERMENEIA_DIR, "dist", "index.js"))
  if (configured) {
    env.HERMENEIA_DIR = existing.HERMENEIA_DIR
    const everPaired = hermeneiaEverPaired()
    console.log(`  ${C.bold}WhatsApp (Hermeneia)${C.reset} ${C.green}(configured)${C.reset}`)
    console.log(`    ${C.dim}HERMENEIA_DIR=${existing.HERMENEIA_DIR}${everPaired ? " · previously paired (not verified)" : " · not linked yet"}${C.reset}`)
    checkoutHermeneiaVersion(env.HERMENEIA_DIR)
    ensureHermeneiaBridge(env.HERMENEIA_DIR)
    // The scan is a round trip — show a code, wait for a phone, react to four
    // different outcomes — and a terminal is the wrong place for all of it.
    // Hermeneia already serves that page itself, and Settings links to it.
    if (link) {
      const prompt = everPaired
        ? "  Verify / re-link your WhatsApp now (QR scan if the link is dead)?"
        : "  Link your WhatsApp now (QR scan)?"
      if (await confirm(prompt, !everPaired)) {
        await hermeneiaQRAuth(env.HERMENEIA_DIR)
      }
    } else {
      console.log(`    ${C.dim}Link your phone from Settings \u25b8 Connectors \u2014 it shows the QR code.${C.reset}`)
    }
    console.log("")
    return
  }

  console.log(`  ${C.bold}WhatsApp (Hermeneia)${C.reset}`)
  console.log(`    ${C.dim}Read, search, and send your WhatsApp messages — everything stays on this machine.${C.reset}`)
  // Asks about the DOWNLOAD, not about the connector. This is a git clone plus
  // a Go bridge binary — a few hundred megabytes — which is a fair thing to
  // ask before doing and is exactly the sort of work an installer is for.
  // Whether WhatsApp is actually connected is decided later, in the window, by
  // scanning a code with a phone. The old wording ("Connect WhatsApp?") ran
  // the two together, which is why linking then happened in a terminal.
  const label = link
    ? "Connect WhatsApp?"
    : "Download the WhatsApp bridge? (you link your phone later, in the window)"
  if (!await confirm(label, true)) { console.log(""); return }

  const dir = existing.HERMENEIA_DIR || path.join(home, "hermeneia")
  try {
    if (fs.existsSync(path.join(dir, ".git"))) {
      // Move an existing checkout ONTO the pinned ref rather than pulling it
      // to the tip of its default branch — a plain `git pull` here is exactly
      // what dragged users onto a master with no bridge binary.
      checkoutHermeneiaVersion(dir)
    } else {
      run(`git clone --depth 1 --branch ${HERMENEIA_VERSION} ${HERMENEIA_REPO} "${dir}"`)
    }
  } catch (e) {
    warn(`Could not download Hermeneia (${e.message}) — skipping WhatsApp`)
    console.log(""); return
  }
  if (!fs.existsSync(path.join(dir, "dist", "index.js"))) {
    warn("Hermeneia checkout has no dist/index.js — skipping WhatsApp")
    console.log(""); return
  }
  // The Go bridge binary is no longer committed to Hermeneia's repo, so fetch
  // the prebuilt for this platform. Without it the checkout can't connect.
  if (!ensureHermeneiaBridge(dir)) {
    warn("Hermeneia is installed but its WhatsApp bridge binary couldn't be fetched — WhatsApp will stay disabled until it's present.")
    env.HERMENEIA_DIR = dir
    console.log(""); return
  }
  env.HERMENEIA_DIR = dir
  ok(`Hermeneia installed → ${dir}`)

  // Always offer to link — see note above; a prior session may be dead.
  const everPaired = hermeneiaEverPaired()
  if (everPaired) {
    console.log(`    ${C.dim}A previous WhatsApp pairing was found on this machine (not verified).${C.reset}`)
  }
  if (!link) {
    // The scan belongs in a window, not here. Hermeneia serves the QR page
    // itself and Settings links to it, so nothing is lost by not asking.
    console.log(`    ${C.dim}Link your phone from Settings \u25b8 Connectors \u2014 it shows the QR code.${C.reset}`)
  } else if (await confirm("  Link (or re-link) your WhatsApp now (QR scan)?", !everPaired)) {
    await hermeneiaQRAuth(dir)
  } else {
    warn("Skipped — the QR page opens the first time REFUGIO starts")
  }
  console.log("")
}

// ── Personal connector: email via Epistole ───────────────────
// Epistole (github.com/Phantazein-apps/epistole) is a remote MCP server the
// user deploys to their own Cloudflare account (a separate ~30-min setup).
// Auth is OAuth in the browser (a one-time code emailed to you); mcp-remote
// runs the flow and caches tokens in ~/.mcp-auth, so the supervisor can
// reconnect headlessly afterwards.

async function setupEpistole(env, existing, targetDir) {
  if (existing.EPISTOLE_URL) {
    env.EPISTOLE_URL = existing.EPISTOLE_URL
    console.log(`  ${C.bold}Email (Epistole)${C.reset} ${C.green}(configured)${C.reset}`)
    console.log(`    ${C.dim}EPISTOLE_URL=${existing.EPISTOLE_URL}${C.reset}`)
    if (!await confirm("  Reconfigure Email?", false)) { console.log(""); return }
  } else {
    console.log(`  ${C.bold}Email (Epistole)${C.reset}`)
    console.log(`    ${C.dim}Your inbox with semantic search, served from your own (free) Cloudflare Worker.${C.reset}`)
    console.log(`    ${C.dim}Deploy it first: https://github.com/Phantazein-apps/epistole — press Enter to skip.${C.reset}`)
    if (!await confirm("Connect your email?", false)) { console.log(""); return }
  }

  let url = (await ask("Epistole server URL (e.g. https://mail.example.com)", existing.EPISTOLE_URL || "")).trim()
  url = url.replace(/\/+$/, "").replace(/\/mcp$/, "")
  if (!url) { delete env.EPISTOLE_URL; warn("No URL — skipping email"); console.log(""); return }
  if (!/^https?:\/\//.test(url)) url = `https://${url}`
  env.EPISTOLE_URL = url

  // One-time browser authorization so later starts connect without prompting.
  const client = path.join(targetDir, "node_modules", "mcp-remote", "dist", "client.js")
  if (!fs.existsSync(client)) {
    warn("mcp-remote not installed yet — you'll be asked to authorize in the browser on first start")
    console.log(""); return
  }
  console.log(`    ${C.dim}Authorizing in your browser (Epistole emails you a one-time code)...${C.reset}`)
  const authOk = await new Promise(resolve => {
    const child = spawn(process.execPath, [client, `${url}/mcp`], { stdio: ["ignore", "pipe", "pipe"] })
    let done = false
    const finish = val => { if (done) return; done = true; try { child.kill("SIGTERM") } catch {}; resolve(val) }
    const watch = data => { if (/Connected successfully/i.test(String(data))) finish(true) }
    child.stdout.on("data", watch)
    child.stderr.on("data", watch)
    child.on("error", () => finish(false))
    child.on("exit", code => { if (!done) { done = true; resolve(code === 0) } })
    setTimeout(() => finish(false), 300_000).unref()
  })
  if (authOk) ok(`Email connected → ${url}`)
  else warn("Authorization didn't complete — the browser flow re-opens when REFUGIO starts")
  console.log("")
}

// Apple Reminders, Things 3 and Apple Notes used to be prompted for here.
// They are switches with no credentials, no clone and no ports — exactly the
// kind of question that belongs in a window with room to say what the
// connector will be able to read. The first-run wizard owns them now, and on a
// packaged install (where this script never runs) it is the only thing that
// can. See chat/wizard.js for the allow-list of keys it may write.

// ── LLM engine ───────────────────────────────────────────────

const OLLAMA_URL = "http://localhost:11434"
const LMSTUDIO_URL = "http://localhost:1234/v1"

// Pick an Ollama model sized to the machine's RAM.
//
// Every tier here can call tools. That is not a nice-to-have: REFUGIO is
// connectors, and a model that can't call them gives you a worse version of the
// local chat apps we aren't trying to replace. The old ladder handed 8 GB
// machines llama3.2:1b — which can't — under a comment claiming they all could.
//
// The 3B floor became affordable on 8 GB by dropping Open WebUI: OWUI held
// 0.7-1.5 GB, the built-in chat UI holds ~50 MB. That reclaimed space is spent
// here, on a model that can actually do the job.
function pickModelForRam() {
  const gb = os.totalmem() / (1024 ** 3)
  if (gb <= 10) return "qwen2.5:3b"     // ~2.6 GB — the tool-calling floor
  if (gb <= 16) return "llama3.2:3b"    // ~3 GB   — 16 GB
  if (gb <= 32) return "llama3.1:8b"    // ~4.7 GB — 32 GB
  if (gb <= 48) return "qwen2.5:14b"    // ~9 GB
  return "gpt-oss:20b"                   // ~13 GB  — 48 GB+
}

/**
 * Refuse to install on a machine that can't run a tool-calling model.
 *
 * REFUGIO is connectors. Installed on hardware that can only hold a 1B model,
 * it becomes a chat window whose connectors silently do nothing — the user asks
 * it to summarise their messages and it politely asks them to paste the messages
 * in. That is not a degraded REFUGIO, it is a broken one, and shipping it costs
 * the user a multi-GB download to find out.
 *
 * Two distinct answers, because only one of them the user can act on:
 *   - not enough RAM installed  → say it plainly, stop, don't imply a fix exists
 *   - enough RAM, none free now → closing apps genuinely fixes this; say how much
 *
 * Runs after clone (mem-fit.cjs is the single source of truth for the floor) but
 * before Open WebUI and the model download, which are the expensive parts.
 * Returns true to continue.
 */
function checkMachineSupported(targetDir, flags) {
  let memFit
  try { memFit = require(path.join(targetDir, "scripts", "mem-fit.cjs")) } catch { return true }

  // The built-in chat UI is what we install now, so size against its ~50 MB
  // rather than Open WebUI's 0.7-1.5 GB.
  const s = memFit.machineSupport({ uiGb: 0.05 })
  if (s.supported) return true

  console.log("")
  if (s.transient) {
    warn(`Only ${s.freeGb} GB of RAM is free right now; REFUGIO needs about ${s.needGb} GB.`)
    warn(`Your ${s.totalGb} GB machine is big enough — close some apps before starting REFUGIO.`)
    console.log("")
    return true
  }

  fail(`This machine can't run REFUGIO: ${s.totalGb} GB of RAM, and it needs about ${s.needGb} GB free.`)
  console.log("")
  console.log(`  REFUGIO connects a local AI to your own data — your messages, calendar,`)
  console.log(`  notes. That requires a model that can call tools, and the smallest one`)
  console.log(`  that reliably can is ${s.floor} (~${memFit.modelRamGb(s.floor)} GB).`)
  console.log("")
  console.log(`  Smaller models do fit, and they can hold a conversation, but they can't`)
  console.log(`  reach your data — which is the entire point. Plenty of good local-AI`)
  console.log(`  apps run happily on this hardware; REFUGIO isn't one of them.`)
  console.log("")
  console.log(`  ${C.dim}Install anyway (chat only, connectors won't work): --force-unsupported${C.reset}`)
  console.log("")

  if (flags.has("--force-unsupported")) {
    warn("Continuing anyway — connectors will not work.")
    console.log("")
    return true
  }
  return false
}

// On low-RAM machines REFUGIO doesn't auto-start on login (Open WebUI would sit
// resident ~0.6 GB all day); the user launches it on demand instead.
const isLowRam = () => os.totalmem() / (1024 ** 3) <= 8

// Probe an HTTP endpoint — resolves true on any response within the timeout
function probeHttp(url, timeout = 1500) {
  return new Promise(resolve => {
    try {
      const http = require("http")
      const req = http.get(url, res => { res.resume(); resolve(true) })
      req.on("error", () => resolve(false))
      req.setTimeout(timeout, () => { req.destroy(); resolve(false) })
    } catch { resolve(false) }
  })
}

// ── Phase 1: Banner ──────────────────────────────────────────

/**
 * Which edition the caller asked for.
 *
 * `--listener` is the shorthand the install-listener bootstrap uses;
 * `--edition <id>` and REFUGIO_EDITION are the long forms, so a script can
 * name it without knowing which flags exist. An unrecognised name is a hard
 * stop rather than a silent fall back to standard: someone who typed
 * `--edition lisener` wants the Listener, and quietly installing the other
 * product into the other directory is the worst possible way to answer that.
 */
function pickEdition(args) {
  const i = args.indexOf("--edition")
  const asked = (args.includes("--listener") ? "listener"
    : i >= 0 ? (args[i + 1] || "")
    : process.env.REFUGIO_EDITION || "standard").trim()
  if (!EDITION_BOOT[asked]) {
    fail(`Unknown edition "${asked}" — expected one of: ${Object.keys(EDITION_BOOT).join(", ")}`)
    process.exit(1)
  }
  return asked
}

/** The double-clickable launcher's file name, per product.
 *
 *  Named after the product rather than kept as "Start REFUGIO.command" for
 *  both, because on a Mac this is a file someone finds in a folder months
 *  later, and it is the only thing in that folder that says what it starts. */
function startCommandName() {
  return `Start ${ED.product}.command`
}

/**
 * Refuse to install alongside the other product, and say how to proceed.
 *
 * The two editions do not share a directory, a port, a login item or a
 * database, so nothing here is a technical necessity — they could both sit on
 * the disk. The reason is that they are two products with one purpose each,
 * and a machine running both has two chat windows that look alike, two login
 * items, two supervisors and two model processes, with the conversation a
 * person wanted in whichever one they happened to open. That is not a
 * configuration anyone chose; it is one they end up in.
 *
 * So: refuse, name what is already there, and offer the two ways out. The
 * default is the safe one. `--replace` stops the other product and takes away
 * its launchers, and deliberately does NOT delete its directory or its data —
 * switching products must not be the way a person loses conversations they
 * never agreed to lose, and going back is then just running its installer.
 */
function checkEditionConflict(editionId, flags) {
  const others = Object.entries(EDITION_BOOT)
    .filter(([id]) => id !== editionId)
    .map(([id, b]) => ({ id, ...b, dir: path.join(home, b.dir) }))
    .filter((o) => fs.existsSync(path.join(o.dir, "package.json")))
  if (!others.length) return

  const other = others[0]
  if (!flags.has("--replace")) {
    console.log("")
    fail(`${other.product} is already installed at ${other.dir}`)
    console.log("")
    console.log(`  ${ED.product} and ${other.product} are separate products, and this`)
    console.log(`  machine holds one of them at a time.`)
    console.log("")
    console.log(`  To switch to ${ED.product}:`)
    console.log(`    re-run this installer with ${C.bold}--replace${C.reset}`)
    console.log(`    ${C.dim}Stops ${other.product} and removes its login item and launchers.`)
    console.log(`    Its folder and its conversations are left exactly where they are,`)
    console.log(`    so running its installer again brings it back.${C.reset}`)
    console.log("")
    console.log(`  To remove ${other.product} entirely first:`)
    console.log(`    ${C.bold}${path.join(other.dir, "uninstall-refugio")}${C.reset}`)
    console.log("")
    process.exit(1)
  }

  console.log(`  ${C.bold}Replacing ${other.product}${C.reset} ${C.dim}— its folder and conversations are kept${C.reset}`)
  standDown(other)
}

/**
 * Stop the other edition and take away everything that would start it again.
 *
 * Every step is best-effort and silent about absence: this runs on a machine
 * that may have had the other product installed by any of three routes across
 * two years, and a missing login item is the expected case, not a failure.
 * What must not happen is a half-stood-down install whose launchd job restarts
 * the supervisor an hour later on a port this one is not using — which is why
 * the login item is removed BEFORE the process is killed, in both places it
 * could be.
 */
function standDown(other) {
  const marker = path.join(other.dir, ".refugio-edition")
  // Read the other install's own table rather than assuming: it knows its
  // label and its log directory, and a version of it older than this split
  // simply answers with the standard names, which are the right ones for it.
  let row = null
  try { row = require(path.join(other.dir, "editions.cjs")).editionFor(other.id) } catch {}
  const agentLabel = row?.agentLabel || "com.phantazein.refugio"
  const logDir = path.join(home, row?.logDir || ".refugio-logs")
  const macApp = row?.macApp || "REFUGIO.app"
  const cli = row?.cli || "refugio"

  if (os.platform() === "darwin") {
    const plist = path.join(home, "Library", "LaunchAgents", `${agentLabel}.plist`)
    try { execSync(`launchctl bootout gui/$(id -u) "${plist}"`, { stdio: "ignore" }) } catch {}
    try { if (fs.existsSync(plist)) fs.unlinkSync(plist) } catch {}
    try { execSync(`pkill -f "${macApp}/Contents/MacOS/RefugioBar"`, { stdio: "ignore" }) } catch {}
  } else if (os.platform() === "linux") {
    const unit = `${cli}.service`
    try { execSync(`systemctl --user disable --now ${unit}`, { stdio: "ignore" }) } catch {}
    try { fs.unlinkSync(path.join(home, ".config", "systemd", "user", unit)) } catch {}
    try { execSync("systemctl --user daemon-reload", { stdio: "ignore" }) } catch {}
    for (const d of [path.join(home, ".config", "autostart"), path.join(home, ".local", "share", "applications")]) {
      for (const f of [`${cli}.desktop`, `${cli}-tray.desktop`]) {
        try { fs.unlinkSync(path.join(d, f)) } catch {}
      }
    }
  } else if (isWin) {
    const startup = path.join(home, "AppData", "Roaming", "Microsoft", "Windows",
      "Start Menu", "Programs", "Startup")
    for (const f of [`${other.product}.vbs`, "REFUGIO.vbs", `${other.product} Tray.vbs`, "REFUGIO Tray.vbs"]) {
      try { fs.unlinkSync(path.join(startup, f)) } catch {}
    }
  }

  // Then the running supervisor, by the pid it wrote down.
  try {
    const pid = parseInt(fs.readFileSync(path.join(logDir, "supervisor.pid"), "utf-8").trim(), 10)
    if (pid > 0) process.kill(pid, "SIGTERM")
  } catch {}

  ok(`${other.product} stopped — its folder is still at ${other.dir}`)
  if (fs.existsSync(marker) || row) {
    // With its edition named. That installer defaults to standard when nothing
    // says otherwise, so the bare command would reinstall the OTHER product
    // into the other directory and leave this folder sitting where it is.
    console.log(`    ${C.dim}Bring it back later with: node ${path.join(other.dir, "install-node.cjs")} --edition ${other.id} --replace${C.reset}`)
  }
}

/**
 * Swap the bootstrap row for the real one, now that the repository is on disk.
 *
 * The assertion is the point. Two copies of the same fact is the arrangement
 * this file is forced into, and the only thing that makes it safe is that the
 * moment they can be compared, they are.
 */
function loadEdition(targetDir, editionId) {
  const table = path.join(targetDir, "editions.cjs")
  // A checkout that predates the split has no table at all. That is not drift,
  // it is a version mismatch — this installer was fetched from one ref and
  // REFUGIO_VERSION pinned the clone to another — and it needs its own
  // sentence, because "Cannot find module editions.cjs" sends someone looking
  // for a missing file rather than at the version they pinned. The supported
  // flow cannot reach it: install-refugio fetches this file from
  // $REFUGIO_VERSION and clones the same ref, so both halves always match.
  if (!fs.existsSync(table)) {
    fail(`The version this installed (${process.env.REFUGIO_VERSION || "the default"}) predates the ` +
      `REFUGIO / REFUGIO Listener split, so it cannot be installed as "${editionId}".`)
    console.log("")
    console.log(`  ${C.dim}It was cloned to ${targetDir} and left there.`)
    console.log(`  Install a version that has both products:`)
    console.log(`    REFUGIO_VERSION=main curl -fsSL https://raw.githubusercontent.com/Phantazein-apps/refugio/main/${editionId === "listener" ? "install-listener" : "install-refugio"} | bash${C.reset}`)
    console.log("")
    process.exit(1)
  }
  const row = require(table).editionFor(editionId)
  const boot = EDITION_BOOT[editionId]
  if (row.id !== editionId || row.installDir !== boot.dir || row.product !== boot.product
      || row.chatPort !== boot.chatPort) {
    fail(`This installer and ${path.join(targetDir, "editions.cjs")} disagree about the ` +
      `"${editionId}" edition (installer: ${boot.dir}/${boot.product}/:${boot.chatPort}, ` +
      `repository: ${row.installDir}/${row.product}/:${row.chatPort}). Re-download the installer.`)
    process.exit(1)
  }
  return row
}

function showBanner() {
  // Two products, two things worth saying under the name. The connector list
  // is REFUGIO's whole point and is beside the point in the Listener, where
  // the coaching modes carry no connectors at all — printing it there would
  // advertise the other product's feature on the first screen of this one.
  const body = ED.id === "listener" ? `
 Installs a local LLM (Ollama by default) and REFUGIO Listener's chat window:
 private coaching conversations — NVC, style, career, life, language — that
 never search the web and never leave this machine.

 No prerequisites — everything installs automatically.
` : `
 Installs a local LLM (Ollama by default) and REFUGIO's chat window, plus
 optional personal connectors (WhatsApp, email, Notion, memory)
 and business connectors (Slack, Jira, and more).

 No prerequisites — everything installs automatically.
 You can skip any connector and add credentials later.
`
  console.log(`
${C.bold}============================================================
 🏔️  ${ED.product} Installer
 A self-hosted refuge for your AI — runs on your own machine
============================================================${C.reset}
${body}`)
}

// ── Phase 2: Check Dependencies ──────────────────────────────

function installUV() {
  const appleSilicon = isAppleSilicon()

  // On Apple Silicon, REFUGIO needs an ARM64 uv. Common trap: an Intel Homebrew
  // under Rosetta supplies an x86_64 uv, which builds an x86_64 Python env that
  // has NO macOS wheels for onnxruntime (Open WebUI) or cryptography (mcpo) — so
  // the install fails. Detect that and install a native arm64 uv instead.
  if (has("uv")) {
    const p = whichCmd("uv")
    const needArm = appleSilicon && isX86Binary(p) && !p.includes("/.local/bin/")
    if (!needArm) {
      UV = "uv"
      ok(`uv (${runQuiet("uv --version")})`)
      return true
    }
    warn(`Found x86_64 uv (${p}) on Apple Silicon — installing a native arm64 uv...`)
  } else {
    warn("Installing uv (Python package manager)...")
  }

  try {
    if (isWin) {
      run("powershell -ExecutionPolicy ByPass -c \"irm https://astral.sh/uv/install.ps1 | iex\"", { shell: true })
      // Refresh PATH
      const newPath = execSync("cmd /c echo %PATH%", { encoding: "utf-8" }).trim()
      process.env.PATH = newPath
    } else if (appleSilicon) {
      // Force the installer to run arm64 even when invoked from an x86_64 (Rosetta)
      // node, so it fetches the arm64 uv build.
      run("arch -arm64 /bin/sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'", { shell: true })
      const armUv = path.join(home, ".local", "bin", "uv")
      if (fs.existsSync(armUv)) UV = armUv
      process.env.PATH = `${home}/.local/bin:${process.env.PATH}`
    } else {
      run("curl -LsSf https://astral.sh/uv/install.sh | sh", { shell: true })
      // uv installs to ~/.local/bin (or ~/.cargo/bin)
      process.env.PATH = `${home}/.local/bin:${home}/.cargo/bin:${process.env.PATH}`
    }

    const uvCmd = UV === "uv" ? "uv" : `"${UV}"`
    const ver = runQuiet(`${uvCmd} --version`)
    if (ver) {
      if (appleSilicon && UV !== "uv" && isX86Binary(UV)) {
        warn("uv still reports x86_64 — Open WebUI / MCPO wheels may not resolve")
      }
      ok(`uv installed (${ver})`)
      return true
    }
  } catch {}

  // Last resort — use whatever uv is on PATH, even if its arch is suboptimal
  if (has("uv")) { UV = "uv"; warn("Using existing uv (architecture may be suboptimal)"); return true }
  fail("Could not install uv — install manually from https://docs.astral.sh/uv/")
  return false
}

function checkDeps() {
  console.log(`${C.bold}Checking dependencies...${C.reset}\n`)

  // Git
  if (has("git")) {
    ok(`Git (${runQuiet("git --version").replace("git version ", "")})`)
  } else {
    fail("Git is required — install from https://git-scm.com")
    process.exit(1)
  }

  // Node (already running)
  const nodeVer = parseInt(process.version.slice(1))
  if (nodeVer >= 18) {
    ok(`Node.js (${process.version})`)
  } else {
    fail(`Node.js ${process.version} is too old — need >= 18`)
    process.exit(1)
  }

  // uv (installs if needed — handles Python automatically)
  const hasUV = installUV()

  console.log("")
  return { hasUV }
}

// ── Pre-flight: Docker, port conflicts, stale services ──────

async function preflight(targetDir) {
  let issues = false

  // Check for Docker containers running Open WebUI or REFUGIO (old install method)
  if (has("docker")) {
    try {
      // Check both running and stopped containers
      const running = runQuiet("docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null") || ""
      const stopped = runQuiet("docker ps -a --filter status=exited --format '{{.Names}}' 2>/dev/null") || ""
      const allContainers = [...running.split("\n"), ...stopped.split("\n")]
        .filter(line => line && /open.?webui|refugio|8080/i.test(line))
        .map(line => line.split(" ")[0])
        .filter((name, i, arr) => name && arr.indexOf(name) === i)  // dedupe

      if (allContainers.length > 0) {
        warn("Found Docker containers from a previous install:")
        allContainers.forEach(c => console.log(`    ${C.dim}${c}${C.reset}`))
        console.log(`    ${C.dim}REFUGIO runs natively — Docker is no longer needed.${C.reset}`)
        const stop = await confirm("Remove these Docker containers?", true)
        if (stop) {
          for (const name of allContainers) {
            try {
              runQuiet(`docker stop ${name} 2>/dev/null`)
              runQuiet(`docker rm ${name} 2>/dev/null`)
              ok(`Removed container: ${name}`)
            } catch {}
          }
          // Clean up Docker images too
          try {
            runQuiet("docker image rm ghcr.io/open-webui/open-webui:main 2>/dev/null")
            runQuiet("docker image rm ghcr.io/open-webui/open-webui:latest 2>/dev/null")
            ok("Removed old Docker images")
          } catch {}
        } else {
          warn("Docker containers left — port 8080 may conflict")
          issues = true
        }
      }
    } catch {}

    // Clean up old Docker data directory
    const oldDataDir = path.join(home, "open-webui-data")
    if (fs.existsSync(oldDataDir)) {
      warn("Found old Docker data directory: ~/open-webui-data/")
      console.log(`    ${C.dim}This was used by a Docker-based install. The new install stores data differently.${C.reset}`)
      const remove = await confirm("Remove ~/open-webui-data/?", true)
      if (remove) {
        try {
          fs.rmSync(oldDataDir, { recursive: true, force: true })
          ok("Removed ~/open-webui-data/")
        } catch (e) {
          warn(`Could not remove: ${e.message}`)
        }
      }
    }
  }

  // Migrate from a previous IBEX install (REFUGIO's predecessor): stop/disable its
  // auto-start service FIRST, so it isn't respawning its own Open WebUI on :8080
  // (otherwise the refugio hostname shows the IBEX login screen). Must run before
  // the port check below — killing :8080 is futile while IBEX's KeepAlive respawns.
  cleanupLegacyIbex()

  // Is the port we are about to use already taken?
  //
  // This checked 8080 unconditionally — Open WebUI's port, which the default
  // install no longer uses. So it offered to kill a process over a port that
  // did not matter, while never checking 8090, the one that does. A question
  // about the wrong port is worse than no question: it teaches people to say
  // yes to killing processes the installer has no business touching.
  const wantsOwuiPort = process.argv.includes("--owui") || process.env.REFUGIO_OWUI === "1"
  const uiPort = wantsOwuiPort ? 8080 : parseInt(process.env.REFUGIO_CHAT_PORT || String(ED.chatPort), 10)
  try {
    const portCheck = isWin
      ? runQuiet(`netstat -ano | findstr :${uiPort} | findstr LISTENING`)
      : runQuiet(`lsof -iTCP:${uiPort} -sTCP:LISTEN -t 2>/dev/null`)
    if (portCheck) {
      warn(`Port ${uiPort} is already in use`)
      if (!isWin) {
        try {
          const procInfo = runQuiet(`ps -p ${portCheck.split("\n")[0]} -o comm= 2>/dev/null`)
          console.log(`    ${C.dim}Process: ${procInfo} (PID ${portCheck.split("\n")[0]})${C.reset}`)
        } catch {}
      }
      const killIt = await confirm(`Kill the process using port ${uiPort}?`, true)
      if (killIt) {
        try {
          if (isWin) {
            run(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${uiPort} ^| findstr LISTENING') do taskkill /PID %a /F`, { shell: true, stdio: "ignore" })
          } else {
            run(`lsof -iTCP:${uiPort} -sTCP:LISTEN -t | xargs kill`, { shell: true, stdio: "ignore" })
          }
          ok(`Freed port ${uiPort}`)
        } catch {}
      } else {
        issues = true
      }
    }
  } catch {
    // Port is free — good
  }

  // Unload existing launchd/systemd service (will be re-created after install)
  if (os.platform() === "darwin") {
    const plistPath = path.join(home, "Library", "LaunchAgents", "com.phantazein.refugio.plist")
    if (fs.existsSync(plistPath)) {
      try { execSync(`launchctl bootout gui/$(id -u) "${plistPath}"`, { stdio: "ignore" }) } catch {}
      try { execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" }) } catch {}
    }
  } else if (os.platform() === "linux") {
    try { execSync("systemctl --user stop refugio.service", { stdio: "ignore" }) } catch {}
  }

  if (issues) {
    const cont = await confirm("Continue with install anyway?", true)
    if (!cont) {
      console.log("\n  Install cancelled.\n")
      process.exit(0)
    }
  }
}

// ── Phase 3: Clone & Install ─────────────────────────────────

async function cloneAndInstall(targetDir) {
  console.log(`${C.bold}Installing ${ED.product}...${C.reset}\n`)

  // Track which version to install — override with REFUGIO_VERSION env var
  const refugioVersion = process.env.REFUGIO_VERSION || "main"

  if (fs.existsSync(path.join(targetDir, "package.json"))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, "package.json"), "utf-8"))
      if (pkg.name === "refugio") {
        ok(`Found existing ${ED.product} at ${targetDir}`)
        console.log(`    ${C.dim}This will update to ${refugioVersion}.`)
        console.log(`    Your credentials and settings in ~/${ED.envFile} are not affected.${C.reset}`)
        const update = await confirm("Update?", true)
        if (update) {
          run("git fetch --tags origin", { cwd: targetDir })
          run(`git checkout ${refugioVersion}`, { cwd: targetDir })
          try { run(`git pull --ff-only origin ${refugioVersion}`, { cwd: targetDir }) } catch {}
          ok(`Updated to ${refugioVersion}`)
        } else {
          ok("Keeping current version")
        }
      }
    } catch {}
  } else {
    ok(`Cloning the ${ED.product} repository...`)
    run(`git clone --branch ${refugioVersion} https://github.com/Phantazein-apps/refugio.git "${targetDir}"`)
  }

  ok("Installing npm dependencies...")
  run("npm install --loglevel=error", { cwd: targetDir })

  console.log("")
}

// ── Phase 4: Credentials File ────────────────────────────────

function readEnvFile(envPath) {
  const env = {}
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, "utf-8").split("\n").forEach(line => {
      line = line.trim()
      if (!line || line.startsWith("#")) return
      const eq = line.indexOf("=")
      if (eq > 0) {
        const key = line.slice(0, eq).trim()
        const val = line.slice(eq + 1).trim()
        if (val) env[key] = val
      }
    })
  }
  return env
}

function writeEnvFile(envPath, env) {
  const sections = [
    { header: "LLM Engine", keys: ["REFUGIO_ENGINE", "OLLAMA_BASE_URL", "OPENAI_API_BASE_URL", "OPENAI_API_KEY", "REFUGIO_MODEL"] },
    { header: "Your Account", keys: ["OWUI_NAME", "OWUI_EMAIL", "OWUI_PASSWORD"] },
    { header: "WhatsApp (Hermeneia)", keys: ["HERMENEIA_DIR"] },
    { header: "Email (Epistole)", keys: ["EPISTOLE_URL"] },
    { header: "Apple Reminders / Things 3 / Notes", keys: ["REFUGIO_REMINDERS", "REFUGIO_THINGS", "REFUGIO_NOTES"] },
    { header: "Notion", keys: ["NOTION_TOKEN"] },
    { header: "Memory", keys: ["REFUGIO_MEMORY", "GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO", "GITHUB_MEMORY_PATH"] },
    { header: "Slack", keys: ["SLACK_TOKEN"] },
    { header: "Jira", keys: ["JIRA_DOMAIN", "JIRA_EMAIL", "JIRA_API_TOKEN"] },
    { header: "ServiceNow", keys: ["SERVICENOW_INSTANCE", "SERVICENOW_USERNAME", "SERVICENOW_PASSWORD"] },
    { header: "Salesforce", keys: ["SALESFORCE_INSTANCE_URL", "SALESFORCE_USERNAME", "SALESFORCE_PASSWORD", "SALESFORCE_SECURITY_TOKEN"] }
  ]

  let content = `# ${ED.product} Credentials (chmod 600)\n# Edit values below, then start ${ED.product}\n\n`
  // Which product this file belongs to, in the file itself. The marker beside
  // the code is the authority, but a credentials file that says nothing about
  // its edition is one nobody can identify when two of them are sitting in the
  // same home directory after a switch.
  content += `# -- Edition ${"─".repeat(43)}\nREFUGIO_EDITION=${ED.id}\n\n`

  for (const section of sections) {
    content += `# -- ${section.header} ${"─".repeat(Math.max(0, 50 - section.header.length))}\n`
    for (const key of section.keys) {
      content += `${key}=${env[key] || ""}\n`
    }
    content += "\n"
  }

  fs.writeFileSync(envPath, content, { mode: 0o600 })

  if (isWin) {
    try {
      const username = os.userInfo().username
      execSync(`icacls "${envPath}" /inheritance:r /grant:r "${username}:(R,W)"`, { stdio: "ignore" })
    } catch {}
  }
}

// ── Phase 5: Interactive Credential Setup ────────────────────

async function promptCredentials(envPath, targetDir) {
  console.log(`${C.bold}Configure connectors...${C.reset}\n`)

  const existing = readEnvFile(envPath)
  const env = { ...existing }

  // Generic prompt for one credential-based connector (used by both groups)
  async function promptConnector(conn) {
    const hasExisting = conn.fields.some(f => existing[f.key])

    // Show current values if configured
    if (hasExisting) {
      console.log(`  ${C.bold}${conn.name}${C.reset} ${C.green}(configured)${C.reset}`)
      for (const field of conn.fields) {
        const val = existing[field.key]
        if (val) {
          const display = field.secret ? `****${val.slice(-4)}` : val
          console.log(`    ${C.dim}${field.key}=${display}${C.reset}`)
        }
      }
      const shouldReconfigure = await confirm(`  Reconfigure ${conn.name}?`, false)
      if (!shouldReconfigure) {
        console.log("")
        return
      }
    } else {
      const shouldConfigure = await confirm(`Configure ${conn.name}?`, conn.id === "account")
      if (!shouldConfigure) {
        console.log("")
        return
      }
    }

    if (conn.help) {
      console.log(`    ${C.dim}${conn.help}${C.reset}`)
    }

    for (const field of conn.fields) {
      const current = existing[field.key] || field.defaultVal || ""
      const display = field.secret && current ? `****${current.slice(-4)}` : current
      const value = await ask(field.prompt, display, field.secret)
      if (value && !value.startsWith("****")) {
        env[field.key] = value
      } else if (current) {
        env[field.key] = current
      }
    }
    console.log("")
  }

  console.log(`  ${C.bold}LLM Engine${C.reset}`)

  // Not a question any more. Almost everyone wants Ollama — it is the one this
  // installs and manages for you — and asking made the choice look consequential
  // to people who had never heard of either. LM Studio is for someone who
  // already runs it and knows they do:
  //
  //   REFUGIO_ENGINE=lmstudio   use LM Studio's local server on :1234
  //   REFUGIO_ENGINE=none       set a backend up later, by hand
  //
  // An existing ~/.refugio.env wins over the default, so reinstalling never
  // silently moves someone off the engine they chose last time.
  const engine = (process.env.REFUGIO_ENGINE || existing.REFUGIO_ENGINE || "ollama").toLowerCase()
  const llmChoice = engine === "lmstudio" ? "2" : engine === "none" || engine === "skip" ? "3" : "1"

  // LM Studio is a GUI app we can't auto-install, so we connect to its local
  // server (OpenAI-compatible on :1234). Probed only when it is the choice, or
  // to mention it to someone who is evidently already running it.
  const lmStudioUp = await probeHttp(`${LMSTUDIO_URL}/models`)
  if (llmChoice === "1" && lmStudioUp) {
    console.log(`    ${C.dim}LM Studio is running on :1234. REFUGIO uses Ollama by default —`)
    console.log(`    re-run with REFUGIO_ENGINE=lmstudio to use LM Studio instead.${C.reset}`)
  }

  if (llmChoice === "2") {
    env.OPENAI_API_BASE_URL = LMSTUDIO_URL
    env.OPENAI_API_KEY = "lm-studio"
    delete env.OLLAMA_BASE_URL
    delete env.REFUGIO_MODEL
    env.REFUGIO_ENGINE = "lmstudio"
    if (!lmStudioUp) {
      warn("LM Studio server not detected on http://localhost:1234")
      warn("In LM Studio: load a model → Developer tab → Start Server (port 1234)")
      warn("REFUGIO will use it automatically once it's running")
    }
    ok("Using LM Studio (http://localhost:1234)")
  } else if (llmChoice === "3") {
    env.REFUGIO_ENGINE = ""
    ok(`Skipping LLM engine — configure later in ~/${ED.envFile}`)
  } else {
    env.OLLAMA_BASE_URL = OLLAMA_URL
    env.REFUGIO_ENGINE = "ollama"
    env.REFUGIO_MODEL = env.REFUGIO_MODEL || pickModelForRam()
    // Clear any stale OpenAI-style backend
    delete env.OPENAI_API_BASE_URL
    delete env.OPENAI_API_KEY
    ok(`Using local Ollama — model: ${env.REFUGIO_MODEL} (sized to ${Math.round(os.totalmem() / (1024 ** 3))} GB RAM)`)
  }
  console.log("")

  // Open WebUI's login, and nothing else — the chat window binds to loopback
  // and has no accounts. Asking everyone to invent a password for a product
  // they are not installing is a question with no consequence, which teaches
  // people to answer the rest of the installer without reading it.
  if (process.argv.includes("--owui") || process.env.REFUGIO_OWUI === "1") {
    console.log(`  ${C.dim}Open WebUI needs a login — the chat window does not.${C.reset}`)
    await promptConnector(ACCOUNT_CONNECTOR)
  }

  // ── Personal connectors ───────────────────────────────────
  //
  // Most of what used to be here has moved into the window. "Connect Apple
  // Reminders? [Y/n]" is a fine question asked in a terrible place: it arrives
  // in a wall of terminal output, before the user has seen REFUGIO at all, and
  // it cannot show what the connector will be able to read. The first-run
  // wizard asks the same things with room to explain them — and on a packaged
  // install, where this script never runs, it is the ONLY thing that asks.
  //
  // What stays here is what genuinely belongs to an installer: fetching and
  // building the WhatsApp bridge, which is a git clone and a compile. The
  // QR scan that used to follow it does not — Hermeneia serves its own setup
  // page, and Settings ▸ Connectors links straight to it.
  console.log(`  ${C.bold}── Personal connectors ──${C.reset} ${C.dim}installed here, switched on in the window${C.reset}\n`)
  await setupHermeneia(env, existing, { link: false })
  await setupEpistole(env, existing, targetDir)

  // ── Memory backend (tier-aware) ──────────────────────────
  // MemPalace runs a local ChromaDB + embedding model (~1.5 GB) — great on
  // 16 GB+, too heavy on 8 GB alongside the model. So on small machines we offer
  // only the lightweight GitHub-backed memory (no local embeddings, ~0 RAM).
  console.log(`  ${C.bold}Memory${C.reset}`)
  const memCapable = os.totalmem() / (1024 ** 3) > 8
  // Default ON only where there's RAM headroom; low-performance (≤8 GB) devices
  // default to NO so memory never competes with the model for scarce RAM.
  if (await confirm("Configure persistent memory?", memCapable)) {
    if (memCapable) {
      console.log(`    1) MemPalace — local semantic memory, no account (recommended)`)
      console.log(`    2) GitHub-backed (PACK-style) — lightweight; syncs to a private GitHub repo`)
      const memChoice = await ask("Choose", existing.REFUGIO_MEMORY === "github" ? "2" : "1")
      if (memChoice === "2") {
        if (await promptGithubFields(env, existing)) {
          env.REFUGIO_MEMORY = "github"
          ok("Using GitHub-backed memory (PACK-style)")
        } else {
          env.REFUGIO_MEMORY = ""
          ok("Memory skipped — re-run the installer anytime to set it up")
        }
      } else {
        env.REFUGIO_MEMORY = "mempalace"
        ok("Using MemPalace (local semantic memory)")
      }
    } else {
      console.log(`    ${C.dim}MemPalace (local semantic memory) needs ~16 GB RAM — not offered on this device.${C.reset}`)
      console.log(`    1) GitHub-backed (PACK-style) — lightweight, no local embeddings (recommended)`)
      console.log(`    2) None — model only`)
      const memChoice = await ask("Choose", "1")
      if (memChoice === "1") {
        if (await promptGithubFields(env, existing)) {
          env.REFUGIO_MEMORY = "github"
          ok("Using GitHub-backed memory (lightweight)")
        } else {
          env.REFUGIO_MEMORY = ""
          ok("No persistent memory — re-run the installer anytime to add it")
        }
      } else {
        env.REFUGIO_MEMORY = ""
        ok("No persistent memory (model only)")
      }
    }
  } else {
    env.REFUGIO_MEMORY = ""
  }
  console.log("")

  // ── Business connectors — workplace systems, behind one opt-in gate ──
  // Most personal installs don't need these; anyone with existing credentials
  // gets the prompts by default so reconfiguring stays one keypress away.
  const anyBusiness = BUSINESS_CONNECTORS.some(c => c.fields.some(f => existing[f.key]))
  console.log(`  ${C.bold}── Business connectors ──${C.reset} ${C.dim}Slack, Jira, ServiceNow, Salesforce${C.reset}`)
  if (await confirm("Configure business connectors?", anyBusiness)) {
    console.log("")
    for (const conn of BUSINESS_CONNECTORS) {
      await promptConnector(conn)
    }
  } else {
    console.log("")
  }

  writeEnvFile(envPath, env)
  ok(`Credentials saved to ${envPath}`)
  console.log("")
  return env
}

// ── Phase 6: Open WebUI Setup ────────────────────────────────

async function setupOpenWebUI(targetDir) {
  if (!has("uv")) {
    // Open WebUI is the REFUGIO interface — skipping it leaves the user with a
    // supervisor that starts, opens no browser, and has no chat window. Make
    // that consequence explicit rather than a one-line "skipping" notice.
    warn("Open WebUI SKIPPED — 'uv' is not installed.")
    console.log(`    ${C.dim}Open WebUI is the REFUGIO window. Without it, REFUGIO starts but has no`)
    console.log(`    chat interface and nothing opens in your browser.`)
    console.log(`    Install uv, then re-run this installer:${C.reset}`)
    console.log(`      ${C.bold}curl -LsSf https://astral.sh/uv/install.sh | sh${C.reset}   ${C.dim}(macOS / Linux)${C.reset}`)
    console.log("")
    return
  }

  console.log(`${C.bold}Installing Open WebUI...${C.reset}\n`)

  // Genuine Intel Macs: onnxruntime (an Open WebUI dependency) no longer ships
  // x86_64 macOS wheels, so the native install can't resolve. Warn up front.
  if (os.platform() === "darwin" && !isAppleSilicon()) {
    warn("Intel macOS detected — Open WebUI's onnxruntime dependency has no Intel-mac wheels.")
    warn("If the install below fails, use an Apple Silicon Mac, Linux, or Windows.")
  }

  const appDir = path.join(targetDir, "app")
  const envDir = path.join(appDir, "env")
  if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true })

  try {
    // uv downloads the right Python automatically — no system Python needed
    run(`"${UV}" venv "${envDir}" --python ${pyArg()} --clear`, { cwd: appDir })
    const activate = isWin
      ? `call "${path.join(envDir, "Scripts", "activate.bat")}"`
      : `source "${path.join(envDir, "bin", "activate")}"`
    run(`${activate} && "${UV}" pip install "open-webui==0.8.12" itsdangerous`, {
      cwd: appDir, shell: true
    })
    ok("Open WebUI installed")
  } catch (err) {
    warn(`Open WebUI install failed: ${err.message}`)
    warn(`You can install it manually later: "${UV}" pip install open-webui`)
  }

  // Install MCPO (MCP-to-OpenAPI proxy) for reliable tool integration
  try {
    run(`"${UV}" tool install mcpo --python ${pyArg()} --force`, { shell: true })
    ok("MCPO proxy installed")
  } catch {}
  console.log("")
}

// ── Phase 7: Start & Open Browser ────────────────────────────

function openBrowser(url) {
  try {
    if (os.platform() === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" })
    } else if (isWin) {
      execSync(`start "" "${url}"`, { stdio: "ignore" })
    } else {
      execSync(`xdg-open "${url}"`, { stdio: "ignore" })
    }
  } catch {}
}

async function waitForServer(url, maxWait = 60000) {
  const http = require("http")
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, res => { res.resume(); resolve(true) })
        req.on("error", reject)
        req.setTimeout(2000, () => { req.destroy(); reject() })
      })
      return true
    } catch {
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  return false
}

function findOwuiStaticDir(targetDir) {
  // Find Open WebUI's static directory inside the venv
  const envLib = path.join(targetDir, "app", "env", "lib")
  if (!fs.existsSync(envLib)) return null
  try {
    const pyDirs = fs.readdirSync(envLib).filter(d => d.startsWith("python"))
    for (const pyDir of pyDirs) {
      const staticDir = path.join(envLib, pyDir, "site-packages", "open_webui", "static")
      if (fs.existsSync(staticDir)) return staticDir
    }
  } catch {}
  return null
}

async function setupLocalDomain(targetDir, port, fallbackUrl) {
  // Modern browsers resolve *.localhost to 127.0.0.1 automatically
  // No hosts file, no admin password, no extra software needed
  const localhostUrl = `http://refugio.localhost:${port}`

  if (isWin) {
    // Windows browsers don't support *.localhost reliably
    return fallbackUrl
  }

  // Check if https://refugio was previously configured (mkcert + caddy)
  const certsDir = path.join(targetDir, "certs")
  const certFile = path.join(certsDir, "refugio.pem")
  const keyFile = path.join(certsDir, "refugio-key.pem")
  const caddyFile = path.join(targetDir, "Caddyfile")

  const hasHttpsDomain = fs.existsSync(certFile) && has("caddy") &&
    (() => { try { return runQuiet("cat /etc/hosts").includes("127.0.0.1 refugio") } catch { return false } })()

  if (hasHttpsDomain) {
    // Restore existing https://refugio setup
    fs.writeFileSync(caddyFile, `https://refugio {\n    tls ${certFile} ${keyFile}\n    reverse_proxy localhost:${port}\n}\n`)
    try {
      try { run("caddy stop", { stdio: "ignore" }) } catch {}
      run(`caddy start --config "${caddyFile}"`, { stdio: "ignore" })
      ok("https://refugio restored")
      return "https://refugio"
    } catch {}
  }

  // https://refugio is set up automatically. It used to be a question, and a
  // question is the wrong shape for this: everything it needs can be attempted
  // and every failure has a working fallback, so the only thing asking bought
  // was the chance to say no to something you wanted.
  //
  // REFUGIO_DOMAIN=0 opts out — for a headless box, or anyone who would rather
  // not have a hosts entry.
  ok(`Available at ${localhostUrl}`)
  if (process.env.REFUGIO_DOMAIN === "0") return localhostUrl
  console.log(`  ${C.dim}Setting up https://refugio — this needs your admin password once.${C.reset}`)

  // Install mkcert and caddy
  if (os.platform() === "darwin" && has("brew")) {
    if (!has("mkcert")) { ok("Installing mkcert..."); try { run("brew install mkcert", { stdio: "ignore" }) } catch {} }
    if (!has("caddy")) { ok("Installing caddy..."); try { run("brew install caddy", { stdio: "ignore" }) } catch {} }
    try { run("brew list nss 2>/dev/null || brew install nss", { shell: true, stdio: "ignore" }) } catch {}
  } else if (os.platform() === "linux") {
    if (!has("mkcert")) { try { run("sudo apt-get install -y mkcert 2>/dev/null || sudo snap install mkcert", { shell: true, stdio: "ignore" }) } catch {} }
    if (!has("caddy")) { try { run("sudo apt-get install -y caddy", { shell: true, stdio: "ignore" }) } catch {} }
  }

  if (!has("mkcert") || !has("caddy")) {
    warn("Could not install mkcert/caddy — using " + localhostUrl)
    return localhostUrl
  }

  // Generate certs
  if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true })
  try {
    run(`mkcert -install`, { stdio: "ignore" })
    run(`mkcert -cert-file "${certFile}" -key-file "${keyFile}" refugio`, { stdio: "ignore" })
  } catch {
    warn("Failed to generate certificate")
    return localhostUrl
  }

  // Add hosts entry
  try {
    const hosts = runQuiet("cat /etc/hosts")
    if (!hosts.includes("127.0.0.1 refugio")) {
      if (os.platform() === "darwin") {
        run(`osascript -e 'do shell script "echo 127.0.0.1 refugio >> /etc/hosts" with administrator privileges'`, { shell: true })
      } else {
        run(`sudo sh -c 'echo "127.0.0.1 refugio" >> /etc/hosts'`, { shell: true })
      }
    }
  } catch {
    warn("Failed to update /etc/hosts")
    return localhostUrl
  }

  // Write Caddyfile and start
  fs.writeFileSync(caddyFile, `https://refugio {\n    tls ${certFile} ${keyFile}\n    reverse_proxy localhost:${port}\n}\n`)
  try {
    try { run("caddy stop", { stdio: "ignore" }) } catch {}
    run(`caddy start --config "${caddyFile}"`, { stdio: "ignore" })
    ok("https://refugio is now available")
    return "https://refugio"
  } catch {
    warn("Caddy failed to start")
    return localhostUrl
  }
}

// ── Phase 6b: Local LLM Engine (Ollama) ─────────────────────

const APP_OLLAMA = "/Applications/Ollama.app/Contents/Resources/ollama"

function installOllama() {
  const appleSilicon = isAppleSilicon()
  const haveArmApp = fs.existsSync(APP_OLLAMA)

  if (has("ollama") || haveArmApp) {
    // Already have an arm64-capable Ollama? (the app bundle counts.) On Apple
    // Silicon an x86_64-only CLI runs CPU-only, so install the arm64 app instead.
    const needArm = appleSilicon && !haveArmApp && isX86Binary(whichCmd("ollama"))
    if (!needArm) { ok("Ollama already installed"); return true }
    warn("Existing Ollama is x86_64 (Rosetta) — installing the arm64 app for GPU speed...")
  } else {
    warn("Installing Ollama...")
  }

  try {
    if (os.platform() === "darwin") {
      const hasArmBrew = fs.existsSync("/opt/homebrew/bin/brew")
      if (has("brew") && (!appleSilicon || hasArmBrew)) {
        // Native brew: arm64 brew on Apple Silicon, or Intel brew on an Intel Mac
        run("brew install ollama")
      } else {
        // Official universal app (runs arm64 on Apple Silicon). Unzip only — the
        // supervisor runs the binary directly, so we avoid the GUI app's
        // first-launch onboarding, which would block the server from starting.
        const zip = path.join(os.tmpdir(), "Ollama-darwin.zip")
        run(`curl -fsSL https://ollama.com/download/Ollama-darwin.zip -o "${zip}"`, { shell: true })
        run(`unzip -oq "${zip}" -d /Applications`, { shell: true })
        try { execSync("xattr -dr com.apple.quarantine /Applications/Ollama.app", { stdio: "ignore" }) } catch {}
      }
    } else if (os.platform() === "linux") {
      run("curl -fsSL https://ollama.com/install.sh | sh", { shell: true })
    } else if (isWin) {
      if (has("winget")) {
        run("winget install --id Ollama.Ollama -e --accept-package-agreements --accept-source-agreements")
      } else {
        const exe = path.join(os.tmpdir(), "OllamaSetup.exe")
        run(`curl -fsSL https://ollama.com/download/OllamaSetup.exe -o "${exe}"`, { shell: true })
        run(`"${exe}" /VERYSILENT /NORESTART`, { shell: true })
      }
    }
  } catch (err) {
    warn(`Ollama install hit a snag: ${err.message}`)
  }
  if (has("ollama") || fs.existsSync(APP_OLLAMA)) { ok("Ollama installed"); return true }
  return false
}

// Ollama signs registry requests with a keypair in ~/.ollama, written by the
// server on its first start. `ollama pull` reads that key ITSELF, so a live
// server is not sufficient — a machine where ~/.ollama was just removed (by
// our own uninstaller, which deletes it along with the models) gets a running
// server and a pull that dies with:
//
//   Error: pull model manifest: open ~/.ollama/id_ed25519: no such file or directory
//
// Making the directory before the server starts gives it somewhere to write,
// and waiting for the key afterwards is the precondition that actually matters.
const OLLAMA_KEY = path.join(home, ".ollama", "id_ed25519")

async function ollamaKeyReady(waitMs = 15000) {
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    if (fs.existsSync(OLLAMA_KEY)) return true
    await new Promise(r => setTimeout(r, 1000))
  }
  return fs.existsSync(OLLAMA_KEY)
}

async function ensureOllamaServing() {
  // Before any probe: the server can only create the keypair if the directory
  // is reachable, and this costs nothing when it already exists.
  try { fs.mkdirSync(path.dirname(OLLAMA_KEY), { recursive: true }) } catch {}

  if (await probeHttp(`${OLLAMA_URL}/api/tags`, 1500)) {
    // Answering does not mean ready to pull. A server that came up before the
    // directory existed will never have written the key.
    if (!(await ollamaKeyReady(3000))) {
      warn("Ollama is running but has no signing key yet — restarting it so it writes one")
      try { execSync("pkill -f 'ollama serve'", { stdio: "ignore" }) } catch {}
      await new Promise(r => setTimeout(r, 2000))
    } else {
      return true
    }
  }
  // Server not up — start it. Prefer the macOS app binary and force arm64 on
  // Apple Silicon so the install-time server (and model pull) uses the GPU build.
  const ollamaBin = fs.existsSync(APP_OLLAMA) ? APP_OLLAMA : (has("ollama") ? "ollama" : null)
  if (ollamaBin) {
    try {
      const cmd = (!isWin && isAppleSilicon()) ? "arch" : ollamaBin
      const args = (!isWin && isAppleSilicon()) ? ["-arm64", ollamaBin, "serve"] : ["serve"]
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" })
      child.unref()
    } catch {}
  }
  // Wait up to ~30s for the server to come up
  let up = false
  for (let i = 0; i < 15; i++) {
    if (await probeHttp(`${OLLAMA_URL}/api/tags`, 1500)) { up = true; break }
    await new Promise(r => setTimeout(r, 2000))
  }
  if (!up) up = await probeHttp(`${OLLAMA_URL}/api/tags`, 1500)
  if (!up) return false

  // Report readiness only once pulling can actually work.
  if (!(await ollamaKeyReady())) {
    // Make it ourselves. The file is an ordinary OpenSSH ed25519 private key —
    // Ollama reads it with Go's ssh package — so ssh-keygen produces exactly
    // what it expects. Waiting for a server that has already declined to write
    // one just fails later, in the middle of a multi-gigabyte download, with an
    // error that reads like a network problem.
    warn("Ollama has no signing key — generating one so downloads can work")
    try {
      run(`ssh-keygen -t ed25519 -N "" -C "" -f "${OLLAMA_KEY}"`, { shell: true, stdio: "ignore" })
    } catch {}
    if (fs.existsSync(OLLAMA_KEY)) {
      ok("Signing key created")
    } else {
      warn(`Could not create ${OLLAMA_KEY} — model downloads will fail.`)
      warn(`Try by hand: ssh-keygen -t ed25519 -N "" -C "" -f ~/.ollama/id_ed25519`)
    }
  }
  return true
}

async function setupLLMEngine(env, targetDir) {
  if (env.REFUGIO_ENGINE !== "ollama") return  // LM Studio / skipped — nothing to install

  console.log(`${C.bold}Setting up local LLM (Ollama)...${C.reset}\n`)

  installOllama()

  const serving = await ensureOllamaServing()
  if (!serving) {
    warn("Ollama isn't responding on http://localhost:11434 yet")
    if (has("ollama")) {
      warn("Start it with: ollama serve, then re-run this installer")
    } else {
      warn("Open the Ollama app (it starts the server), then re-run this installer")
    }
    console.log("")
    return
  }
  ok("Ollama is running (http://localhost:11434)")

  // Provision models via the resilient puller: it tries the Ollama registry, and
  // if that's unreachable (e.g. Cloudflare R2 blocked) it imports the GGUF from
  // HuggingFace instead — so the install still completes on locked-down nets.
  //
  // Download TWO tiers: the "optimal" model sized to total RAM, plus a lighter
  // "current" model (one tier down) for when the machine is busy. At each launch
  // the supervisor activates whichever fits the RAM that's actually free, with no
  // on-demand download. (Smaller machines may collapse to a single model.)
  const optimal = env.REFUGIO_MODEL || pickModelForRam()
  const pullScript = path.join(targetDir, "scripts", "pull-model.cjs")
  let current = null
  try {
    ({ current } = require(path.join(targetDir, "scripts", "mem-fit.cjs")).installPair(optimal))
  } catch {}
  const toPull = [optimal, current].filter(Boolean)
  for (const m of toPull) {
    const role = m === optimal ? "optimal" : "lighter (busy-RAM)"
    try {
      console.log(`  ${C.dim}→ ${role}: ${m}${C.reset}`)
      run(`"${process.execPath}" "${pullScript}" ${m}`, { env: { ...process.env, REFUGIO_MODEL: m } })
    } catch (err) {
      warn(`Model provisioning failed for ${m}: ${err.message}`)
      warn(`Retry later: node ${pullScript} ${m}`)
    }
  }
  console.log("")
}

// ── Phase 6c: MemPalace (local semantic memory) ─────────────

async function setupMemPalace(env) {
  if (env.REFUGIO_MEMORY !== "mempalace") return
  if (!has("uv")) {
    warn("Skipping MemPalace — uv not available")
    return
  }
  console.log(`${C.bold}Installing MemPalace (local memory)...${C.reset}\n`)
  try {
    // Installs the `mempalace-mcp` stdio MCP server into ~/.local/bin (via uv)
    run(`"${UV}" tool install mempalace --python ${pyArg()} --force`, { shell: true })
    ok("MemPalace installed")
  } catch (err) {
    warn(`MemPalace install failed: ${err.message}`)
    warn("Install later with: uv tool install mempalace")
  }
  console.log("")
}

async function startREFUGIO(targetDir, env, autoStarted) {
  console.log(`${C.bold}Starting ${ED.product}...${C.reset}\n`)

  // Which surface owns the UI decides everything below. This block used to be
  // hard-wired to Open WebUI on 8080 — so on a v2 install it waited FIVE
  // MINUTES for a server nothing had started, printing "Waiting for Open WebUI"
  // the whole time, and then never reached the domain setup at all. That is why
  // https://refugio stopped appearing.
  const usingOwui = process.argv.includes("--owui") || process.env.REFUGIO_OWUI === "1"
  const CHAT_PORT = parseInt(env.REFUGIO_CHAT_PORT || String(ED.chatPort), 10)
  const PORT = usingOwui ? 8080 : CHAT_PORT

  if (autoStarted) {
    // The supervisor (start-refugio.cjs) is already running via launchd/systemd
    // (setupAutoStart runs before this function)
    ok(`${ED.product} supervisor started via auto-start service`)
  } else {
    // On-demand mode (low-RAM): no login service, so launch the supervisor now
    // (detached) for this session. It won't relaunch on future logins.
    try {
      const out = fs.openSync(path.join(home, ED.logDir, "refugio.log"), "a")
      const child = spawn(process.execPath, [path.join(targetDir, "start-refugio.cjs"), "--no-browser"], {
        detached: true, stdio: ["ignore", out, out], cwd: targetDir
      })
      child.unref()
      try { fs.closeSync(out) } catch {}  // child inherited the fd; parent doesn't need it
      ok(`${ED.product} supervisor started (on-demand)`)
    } catch (e) {
      warn(`Could not start supervisor: ${e.message} — run: refugio`)
    }
  }

  // Wait for OWUI to be ready. The hint gets its own line — rewriting a line
  // longer than the terminal width with \r leaves wrapped residue behind.
  // \x1b[K clears from the cursor to end of line after each rewrite.
  const waitStart = Date.now()
  const surface = usingOwui ? "Open WebUI" : ED.product
  // The chat server binds immediately; only Open WebUI needs minutes. Waiting
  // five minutes either way meant a failure looked identical to a slow start.
  const readyPath = usingOwui ? "/api/config" : "/api/chat/status"
  const readyTimeout = usingOwui ? 300000 : 60000
  if (usingOwui) console.log(`  ${C.dim}First launch downloads a model — this can take a few minutes.${C.reset}`)
  process.stdout.write(`  Waiting for ${surface} to be ready... `)
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - waitStart) / 1000)
    process.stdout.write(`\r  Waiting for ${surface} to be ready... (${elapsed}s)\x1b[K`)
  }, 1000)
  const ready = await waitForServer(`http://127.0.0.1:${PORT}${readyPath}`, readyTimeout)
  clearInterval(timer)

  if (ready) {
    const elapsed = Math.round((Date.now() - waitStart) / 1000)
    process.stdout.write(`\r  Waiting for ${surface} to be ready... done (${elapsed}s)\x1b[K\n`)
    ok(`${surface} → http://127.0.0.1:${PORT}`)

    // Set up https://refugio local domain
    let refugioUrl = `http://127.0.0.1:${PORT}`
    refugioUrl = await setupLocalDomain(targetDir, PORT, refugioUrl)

    // Everything from here is Open WebUI's: MCPO, an account, and a sign-in
    // trampoline. The chat window has none of those — it is already serving,
    // it speaks MCP itself, and it has no login — so on the default path the
    // browser opens and that is the whole of it.
    if (!usingOwui) {
      ok(`Opening ${ED.product}...`)
      openBrowser(refugioUrl)
      return refugioUrl
    }

    // Wait for MCPO to be ready before opening browser
    // (start-refugio.cjs starts MCPO with a 3s delay, configure runs after OWUI is ready)
    const mcpoReady = await waitForServer("http://127.0.0.1:8010/openapi.json", 30000)
    if (mcpoReady) {
      ok("MCPO proxy ready")
    } else {
      warn("MCPO not ready yet — tools may need a moment")
    }

    // Wait for start-refugio.cjs to finish configure (creates account, registers tools)
    // then sign in to get auth token for auto-login
    let token = null
    const signinStart = Date.now()
    while (!token && Date.now() - signinStart < 60000) {
      try {
        const http = require("http")
        const signin = await new Promise((resolve, reject) => {
          const data = JSON.stringify({ email: env.OWUI_EMAIL, password: env.OWUI_PASSWORD || "changeme" })
          const req = http.request({
            hostname: "127.0.0.1", port: PORT, path: "/api/v1/auths/signin",
            method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length }
          }, res => {
            let body = ""
            res.on("data", c => body += c)
            res.on("end", () => { try { resolve(JSON.parse(body)) } catch { resolve({}) } })
          })
          req.on("error", reject)
          req.write(data)
          req.end()
        })
        token = signin.token || null
      } catch {}
      if (!token) await new Promise(r => setTimeout(r, 3000))
    }

    // Auto-authenticate via trampoline page
    if (token) {
      const staticDir = findOwuiStaticDir(targetDir)
      if (staticDir) {
        const authHtml = `<!DOCTYPE html><html><body><script>
localStorage.setItem('token', '${token}');
window.location.href = '/';
</script><p>Signing in...</p></body></html>`
        fs.writeFileSync(path.join(staticDir, "auth.html"), authHtml)
        ok("Opening browser (auto-authenticated)...")
        openBrowser(`${refugioUrl}/static/auth.html`)
      } else {
        ok("Opening browser...")
        openBrowser(refugioUrl)
      }
    } else {
      ok("Opening browser...")
      openBrowser(refugioUrl)
    }
  } else {
    process.stdout.write(" timed out\n")
    warn("Open WebUI is still starting — open http://127.0.0.1:" + PORT + " manually")
  }

  console.log("")
}

// ── Phase 8: Auto-Start on Login ─────────────────────────────

// Migrate from the predecessor "IBEX" install (REFUGIO is a fork of
// Percona-Lab/IBEX). A leftover IBEX auto-start service keeps running its OWN
// Open WebUI on :8080, so the refugio hostname shows the IBEX login screen. Stop
// + disable + remove that service (and kill stragglers). We do NOT delete the
// user's IBEX files/data — only the conflicting service.
function cleanupLegacyIbex() {
  let found = false
  try {
    if (os.platform() === "darwin") {
      const laDir = path.join(home, "Library", "LaunchAgents")
      let plists = []
      try { plists = fs.readdirSync(laDir).filter(f => /ibex/i.test(f) && f.endsWith(".plist")) } catch {}
      for (const f of plists) {
        const p = path.join(laDir, f)
        const label = f.replace(/\.plist$/, "")
        try { execSync(`launchctl bootout gui/$(id -u)/${label}`, { stdio: "ignore" }) } catch {}
        try { execSync(`launchctl bootout gui/$(id -u) "${p}"`, { stdio: "ignore" }) } catch {}
        try { execSync(`launchctl unload "${p}"`, { stdio: "ignore" }) } catch {}
        try { fs.unlinkSync(p) } catch {}
        found = true
      }
    } else if (os.platform() === "linux") {
      for (const unit of ["ibex.service", "com.percona.ibex.service"]) {
        try { execSync(`systemctl --user stop ${unit}`, { stdio: "ignore" }) } catch {}
        try { execSync(`systemctl --user disable ${unit}`, { stdio: "ignore" }) } catch {}
        const up = path.join(home, ".config", "systemd", "user", unit)
        try { if (fs.existsSync(up)) { fs.unlinkSync(up); found = true } } catch {}
      }
      try { execSync("systemctl --user daemon-reload", { stdio: "ignore" }) } catch {}
    } else if (isWin) {
      const startup = path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
      for (const f of ["IBEX.vbs", "ibex.vbs"]) {
        const p = path.join(startup, f)
        try { if (fs.existsSync(p)) { fs.unlinkSync(p); found = true } } catch {}
      }
    }
    // Kill a still-running IBEX supervisor/OWUI (macOS/Linux KeepAlive is gone now;
    // on Windows the .vbs was fire-once, so the port-8080 check below handles it).
    if (!isWin) { try { execSync("pkill -f start-ibex", { stdio: "ignore" }) } catch {} }
  } catch {}
  if (found) {
    warn("Found a previous IBEX install — disabled its auto-start so it won't conflict with REFUGIO on :8080")
    warn("Your old IBEX files were left untouched (remove ~/IBEX manually if you no longer need it)")
  }
}

// Returns true if REFUGIO was registered to auto-start on login (caller relies on
// the service having started the supervisor); false in on-demand (low-RAM) mode,
// where the caller must start the supervisor itself for this session.
function setupAutoStart(targetDir) {
  const nodePath = process.execPath
  const startScript = path.join(targetDir, "start-refugio.cjs")

  // Low-RAM: set up on-demand launchers instead of login auto-start.
  if (isLowRam()) {
    setupOnDemand(targetDir, nodePath, startScript)
    return false
  }

  if (os.platform() === "darwin") {
    // macOS: launchd plist
    const plistDir = path.join(home, "Library", "LaunchAgents")
    const plistPath = path.join(plistDir, `${ED.agentLabel}.plist`)

    if (!fs.existsSync(plistDir)) fs.mkdirSync(plistDir, { recursive: true })

    const logDir = path.join(home, ED.logDir)
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${ED.agentLabel}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${startScript}</string>
        <string>--no-browser</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${targetDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logDir}/refugio.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/refugio.err</string>
</dict>
</plist>`

    fs.writeFileSync(plistPath, plist)

    // Unload if already loaded, then load
    try { execSync(`launchctl bootout gui/$(id -u) "${plistPath}"`, { stdio: "ignore" }) } catch {}
    try {
      execSync(`launchctl bootstrap gui/$(id -u) "${plistPath}"`, { stdio: "ignore" })
      ok(`${ED.product} will auto-start on login (launchd)`)
    } catch {
      try {
        execSync(`launchctl load "${plistPath}"`, { stdio: "ignore" })
        ok(`${ED.product} will auto-start on login (launchd)`)
      } catch {
        warn(`Could not register auto-start — run manually: node ${startScript}`)
      }
    }
  } else if (os.platform() === "linux") {
    // Linux: systemd user service
    const serviceDir = path.join(home, ".config", "systemd", "user")
    const servicePath = path.join(serviceDir, `${ED.cli}.service`)

    if (!fs.existsSync(serviceDir)) fs.mkdirSync(serviceDir, { recursive: true })

    const service = `[Unit]
Description=${ED.product}
After=network.target

[Service]
ExecStart="${nodePath}" "${startScript}" --no-browser
WorkingDirectory=${targetDir}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`

    fs.writeFileSync(servicePath, service)
    try {
      execSync("systemctl --user daemon-reload", { stdio: "ignore" })
      execSync(`systemctl --user enable ${ED.cli}.service`, { stdio: "ignore" })
      ok(`${ED.product} will auto-start on login (systemd)`)
    } catch {
      warn(`Could not register auto-start — run manually: node ${startScript}`)
    }
  } else if (isWin) {
    // Windows: VBScript in Startup folder (runs without console window)
    try {
      const startupDir = path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
      const vbsPath = path.join(startupDir, `${ED.product}.vbs`)
      const vbs = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run """${nodePath}"" ""${startScript}"" --no-browser", 0, False`
      fs.writeFileSync(vbsPath, vbs)
      ok(`${ED.product} will auto-start on login (Startup folder)`)
    } catch {
      warn(`Could not register auto-start — run manually: node ${startScript}`)
    }
  }

  return true
}

// On-demand setup for low-RAM machines: create convenient launchers (a `refugio`
// CLI + a clickable shortcut) and ensure NO login auto-start remains, so Open
// WebUI isn't resident all day. The user starts REFUGIO when they want it and
// frees the RAM by quitting (Ctrl+C / `refugio stop`).
function setupOnDemand(targetDir, nodePath, startScript) {
  try { fs.mkdirSync(path.join(home, ED.logDir), { recursive: true }) } catch {}

  // Remove any existing login auto-start so it truly won't launch at boot.
  if (os.platform() === "darwin") {
    const plistPath = path.join(home, "Library", "LaunchAgents", `${ED.agentLabel}.plist`)
    try { execSync(`launchctl bootout gui/$(id -u) "${plistPath}"`, { stdio: "ignore" }) } catch {}
    try { if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath) } catch {}
  } else if (os.platform() === "linux") {
    try { execSync(`systemctl --user disable ${ED.cli}.service`, { stdio: "ignore" }) } catch {}
    try { fs.unlinkSync(path.join(home, ".config", "systemd", "user", `${ED.cli}.service`)) } catch {}
    try { execSync("systemctl --user daemon-reload", { stdio: "ignore" }) } catch {}
  } else if (isWin) {
    try {
      const vbsPath = path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${ED.product}.vbs`)
      if (fs.existsSync(vbsPath)) fs.unlinkSync(vbsPath)
    } catch {}
  }

  if (!isWin) {
    // `refugio` CLI on PATH (~/.local/bin is on PATH via uv):
    //   start | bg | stop | restart | status | menubar
    //
    // `bg`, `restart` and `menubar` exist because the menu-bar icon is not
    // guaranteed — it can fail to get a slot on a full menu bar. When that
    // happens the only way to stop and restart was a foreground process
    // holding a terminal open, which is not where a fallback belongs.
    const binDir = path.join(home, ".local", "bin")
    try { fs.mkdirSync(binDir, { recursive: true }) } catch {}
    // Every name in here is the edition's: the command, the log directory, the
    // port it probes and the product it reports. A REFUGIO Listener install
    // writing a `refugio` on PATH would take over the other product's command
    // and then start the wrong supervisor from it.
    const menubarCase = ED.id === "standard" ? `
  menubar)
    # Relaunch the menu-bar app and show what it decided. It writes one line per
    # launch saying whether it got a slot in the menu bar.
    if [ -d /Applications/${ED.macApp} ]; then
      pkill -f "${ED.macApp}/Contents/MacOS/RefugioBar" 2>/dev/null
      sleep 1
      open /Applications/${ED.macApp}
      sleep 3
      echo "--- $LOGS/menubar.log ---"
      tail -n 5 "$LOGS/menubar.log" 2>/dev/null || echo "(no log yet — this build predates it)"
    else
      echo "Menu-bar app is not installed. Build it with: cd $DIR/menubar && ./install.sh"
    fi ;;` : ""
    const cli = `#!/bin/sh
# ${ED.product} on-demand launcher
NODE="${nodePath}"
DIR="${targetDir}"
LOGS="$HOME/${ED.logDir}"
PIDF="$LOGS/supervisor.pid"

refugio_stop() {
  if [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null; then echo "${ED.product} stopped (RAM freed)"
  else echo "${ED.product} is not running"; fi
}
refugio_bg() {
  mkdir -p "$LOGS"
  nohup "$NODE" "$DIR/start-refugio.cjs" --no-browser >>"$LOGS/refugio.log" 2>&1 &
}

case "$1" in
  stop) refugio_stop ;;
  bg)
    refugio_bg
    echo "${ED.product} starting in the background — '${ED.cli} status' to check, '${ED.cli} stop' to stop." ;;
  restart)
    refugio_stop
    sleep 2
    refugio_bg
    echo "${ED.product} restarting in the background — '${ED.cli} status' to check." ;;
  status)
    if curl -s --max-time 2 http://127.0.0.1:${ED.chatPort}/api/chat/status >/dev/null 2>&1; then echo "running -> http://127.0.0.1:${ED.chatPort}"
    elif curl -s --max-time 2 http://127.0.0.1:8080/api/config >/dev/null 2>&1; then echo "running -> http://127.0.0.1:8080 (Open WebUI)"
    else echo "stopped"; fi ;;${menubarCase}
  *)
    echo "Starting ${ED.product}... (Ctrl+C or '${ED.cli} stop' to stop and free RAM)"
    echo "Tip: '${ED.cli} bg' starts it without holding this terminal."
    exec "$NODE" "$DIR/start-refugio.cjs" ;;
esac
`
    const cliPath = path.join(binDir, ED.cli)
    try { fs.writeFileSync(cliPath, cli); fs.chmodSync(cliPath, 0o755) } catch {}

    if (os.platform() === "darwin") {
      const cmd = `#!/bin/sh\nexec "${nodePath}" "${targetDir}/start-refugio.cjs"\n`
      const cmdPath = path.join(targetDir, startCommandName())
      try { fs.writeFileSync(cmdPath, cmd); fs.chmodSync(cmdPath, 0o755) } catch {}
      installMenuBarApp(targetDir)
    } else {
      const appsDir = path.join(home, ".local", "share", "applications")
      try { fs.mkdirSync(appsDir, { recursive: true }) } catch {}
      const desktop = `[Desktop Entry]\nType=Application\nName=${ED.product}\nComment=Start your local AI\nExec="${nodePath}" "${targetDir}/start-refugio.cjs"\nTerminal=true\nCategories=Utility;\n`
      try { fs.writeFileSync(path.join(appsDir, `${ED.cli}.desktop`), desktop) } catch {}
      installLinuxTray(targetDir, appsDir)
    }
  } else {
    // Windows: clickable start + stop .bat (no `refugio` shell CLI on Windows).
    const bat = `@echo off\r\ncall "${nodePath}" "${targetDir}\\start-refugio.cjs"\r\n`
    try { fs.writeFileSync(path.join(targetDir, "Start-REFUGIO.bat"), bat) } catch {}
    const stop = [
      "@echo off",
      "setlocal enabledelayedexpansion",
      `set "PIDF=%USERPROFILE%\\${ED.logDir}\\supervisor.pid"`,
      `if not exist "%PIDF%" ( echo ${ED.product} is not running & exit /b )`,
      'set /p PID=<"%PIDF%"',
      `taskkill /PID !PID! /T /F >nul 2>&1 && echo ${ED.product} stopped (RAM freed) || echo ${ED.product} is not running`,
    ].join("\r\n") + "\r\n"
    try { fs.writeFileSync(path.join(targetDir, "Stop-REFUGIO.bat"), stop) } catch {}
    installWindowsTray(targetDir)
  }

  ok(`Low-RAM mode: ${ED.product} will NOT auto-start on login (keeps your RAM free)`)
  if (!isWin) {
    ok(`Start anytime:  ${ED.cli}   ·   stop + free RAM:  ${ED.cli} stop`)
    const onPath = (process.env.PATH || "").split(":").includes(path.join(home, ".local", "bin"))
    if (!onPath) ok(`(if '${ED.cli}' isn't found: run ${path.join(home, ".local", "bin", ED.cli)}, or add ~/.local/bin to PATH)`)
    if (os.platform() === "darwin") ok(`Or double-click:  ${path.join(targetDir, startCommandName())}`)
  } else {
    ok(`Start: double-click ${path.join(targetDir, "Start-REFUGIO.bat")}`)
    ok(`Stop + free RAM: double-click ${path.join(targetDir, "Stop-REFUGIO.bat")}`)
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const flags = new Set(args.filter(a => a.startsWith("--")))
  // A flag's VALUE is not a positional argument. `--edition listener` used to
  // leave "listener" in this list, and the directory rule below would then
  // install into ./listener — the one bug a two-product installer must not
  // have, because it lands the wrong product in an unexpected place and says
  // nothing. `--dir` was already immune by accident (its own branch wins);
  // this makes both immune on purpose.
  const VALUED_FLAGS = new Set(["--edition", "--dir"])
  const positional = args.filter((a, i) =>
    !a.startsWith("--") && !VALUED_FLAGS.has(args[i - 1]))

  if (flags.has("--help") || flags.has("-h")) {
    console.log(`
  Usage: node install-node.cjs [options] [directory]
     or: curl -fsSL https://raw.githubusercontent.com/Phantazein-apps/refugio/main/install-node.cjs | node

  Options:
    --edition <id>     Which product: standard (default) or listener
    --listener         Shorthand for --edition listener
    --replace          Stand down the other edition if it is installed
    --no-start         Don't launch after install
    --non-interactive  Skip credential prompts (create template only)
    --owui             Also install Open WebUI (legacy interface, being retired)
    --skip-owui        No-op, kept for compatibility — Open WebUI is now opt-in
    --help             Show this help

  Environment:
    REFUGIO_EDITION=listener  Same as --listener
    REFUGIO_ENGINE=lmstudio   Use LM Studio's local server (:1234) instead of Ollama
    REFUGIO_ENGINE=none       Skip the LLM engine; configure it later by hand
    REFUGIO_MODEL=<tag>       Override the auto-selected Ollama model
    REFUGIO_OWUI=1            Same as --owui

  Editions:
    REFUGIO and REFUGIO Listener are separate products built from this one
    repository, and a machine holds one at a time. They install to different
    directories (~/refugio and ~/refugio-listener), keep separate conversations
    and credentials, and serve on different ports. REFUGIO carries the
    connectors; the Listener carries the private coaching modes.

  Examples:
    node install-node.cjs                    Interactive install to ~/refugio
    node install-node.cjs --listener         Install REFUGIO Listener instead
    node install-node.cjs --listener --replace   ...replacing an existing REFUGIO
    node install-node.cjs ./my-refugio       Install to custom directory
    node install-node.cjs --no-start         Install without launching
    node install-node.cjs --non-interactive  Headless install (CI-friendly)
`)
    return
  }

  // Which product, before anything else: it decides the directory, the
  // credentials file, the port and the name on every line printed below.
  const editionId = pickEdition(args)
  ED = { id: editionId, ...EDITION_BOOT[editionId] }

  // Determine target directory
  const dirIdx = args.indexOf("--dir")
  let targetDir
  if (dirIdx >= 0 && args[dirIdx + 1]) {
    targetDir = path.resolve(args[dirIdx + 1])
  } else if (positional.length > 0) {
    targetDir = path.resolve(positional[0])
  } else {
    targetDir = path.join(home, ED.dir)
  }

  showBanner()

  // Before the clone, because a refusal that has already downloaded a
  // repository into the user's home directory is not a refusal.
  checkEditionConflict(editionId, flags)

  const { hasUV } = checkDeps()

  await preflight(targetDir)

  await cloneAndInstall(targetDir)

  // The repository exists now, so the real edition table does too.
  ED = { ...loadEdition(targetDir, editionId), dir: ED.dir }
  // The fact, written beside the code: the supervisor and the chat server read
  // this rather than depending on an environment that launchd will not carry.
  try { fs.writeFileSync(path.join(targetDir, ".refugio-edition"), `${editionId}\n`) } catch {}

  const envPath = path.join(home, ED.envFile)

  if (!checkMachineSupported(targetDir, flags)) return

  let env
  if (flags.has("--non-interactive")) {
    if (!fs.existsSync(envPath)) {
      writeEnvFile(envPath, {})
      ok(`Created credential template at ${envPath}`)
      ok(`Edit it with your API tokens, then start with: node ${path.join(targetDir, "start-refugio.cjs")}`)
    } else {
      ok(`Using existing credentials at ${envPath}`)
    }
    env = readEnvFile(envPath)
  } else {
    env = await promptCredentials(envPath, targetDir)
  }

  // Open WebUI is OPT-IN. It used to install unless --skip-owui was passed,
  // which meant the default install still pulled uv, built a Python virtual
  // environment and downloaded PyTorch — for an interface it no longer starts.
  // The README already described the current behaviour ("No Python"); this is
  // the code catching up with it.
  //
  // --skip-owui is kept as a no-op so anyone scripting against it still works.
  const wantsOwui = flags.has("--owui") || process.env.REFUGIO_OWUI === "1"
  if (wantsOwui) {
    await setupOpenWebUI(targetDir)
  }

  // Install and warm up the local LLM engine (Ollama) — pulls the model
  // BEFORE the supervisor starts Open WebUI so it's ready on first launch.
  // Skip in headless mode: pulling a multi-GB model / installing MemPalace is
  // heavy work that only makes sense when we're about to launch the service.
  if (!flags.has("--non-interactive")) {
    await setupLLMEngine(env, targetDir)
    // Install MemPalace if the user chose it as their memory backend
    await setupMemPalace(env)
  }

  // Set up auto-start (login service on capable machines; on-demand launchers on
  // low-RAM). Must happen BEFORE startREFUGIO so we don't spawn a duplicate.
  let autoStarted = false
  if (!flags.has("--no-start") && !flags.has("--non-interactive")) {
    autoStarted = setupAutoStart(targetDir)
  }

  // Wait for OWUI to be ready and open browser
  if (!flags.has("--no-start") && !flags.has("--non-interactive")) {
    await startREFUGIO(targetDir, env, autoStarted)
  }

  console.log(`${C.bold}============================================================`)
  console.log(` 🏔️  ${ED.product} is ready!`)
  console.log(`============================================================${C.reset}`)
  console.log("")
  console.log(`  Installation:  ${targetDir}`)
  console.log(`  Credentials:   ${envPath}`)
  console.log("")
  if (!flags.has("--non-interactive")) {
    // The rest of setup happens in the window. Said here because the browser
    // may open behind the terminal, and someone who does not know a setup
    // screen is waiting will conclude their connectors were never configured.
    console.log(`  ${C.bold}Finish in the window:${C.reset} choose a model and switch on your connectors.`)
    console.log(`  ${C.dim}${ED.product} opens setup the first time it starts. It is also at /setup, and`)
    console.log(`  everything in it is in Settings afterwards.${C.reset}`)
    console.log("")
  }
  if (flags.has("--non-interactive")) {
    // Headless: nothing was auto-started or launcher-installed.
    console.log(`  To start ${ED.product}:`)
    console.log(`    node ${path.join(targetDir, "start-refugio.cjs")}`)
  } else if (isLowRam()) {
    if (isWin) {
      console.log(`  Start ${ED.product}:     double-click ${path.join(targetDir, "Start-REFUGIO.bat")}`)
      console.log(`  Stop + free RAM:   double-click ${path.join(targetDir, "Stop-REFUGIO.bat")}`)
    } else {
      const extra = os.platform() === "darwin" ? `   (or double-click "${startCommandName()}")` : ""
      console.log(`  Start ${ED.product}:     ${ED.cli}${extra}`)
      console.log(`  Stop + free RAM:   ${ED.cli} stop`)
    }
    console.log("")
    console.log(`  Low-RAM mode: ${ED.product} does NOT auto-start on login, so it only`)
    console.log(`  uses memory while you're actually using it.`)
  } else {
    console.log(`  To start ${ED.product} manually:`)
    console.log(`    node ${path.join(targetDir, "start-refugio.cjs")}`)
    console.log("")
    console.log(`  ${ED.product} will auto-start on login.`)
  }
  console.log("")
}

main().catch(err => {
  console.error(`\n  \x1b[31m✗\x1b[0m ${err.message}`)
  process.exit(1)
})
