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

const PERSONAL_CONNECTORS = [
  {
    id: "notion", name: "Notion",
    help: "https://www.notion.so/profile/integrations → New integration → Copy Internal Integration Secret",
    fields: [
      { key: "NOTION_TOKEN", prompt: "Notion integration token (ntn_...)", secret: true }
    ]
  }
]

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

// ── Personal connector: WhatsApp via Hermeneia ───────────────
// Hermeneia (github.com/Phantazein-apps/hermeneia) is a local WhatsApp MCP
// server. Its repo ships a prebuilt dist/ (Node bundle + arm64 Go bridge), so
// "install" is just a shallow clone — no build step. Auth is a QR scan:
// running the server opens a browser page with the QR, and its local status
// API reports when the phone has linked. macOS Apple Silicon only for now.

const HERMENEIA_REPO = "https://github.com/Phantazein-apps/hermeneia.git"
const HERMENEIA_QR_PORT = 3456

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

// Has any WhatsApp account already been linked? accounts.json records a phone
// number after pairing, but older Hermeneia versions leave it null — so also
// accept an account session DB plus a non-trivial message store as proof.
function hermeneiaLinked() {
  const dataDir = process.env.HERMENEIA_DATA_DIR ||
    path.join(home, "Library", "Application Support", "Hermeneia")
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
  console.log("")
  console.log(`    ${C.bold}Link your WhatsApp${C.reset} — a browser page with a QR code will open.`)
  console.log(`    On your phone: ${C.bold}WhatsApp → Settings → Linked Devices → Link a Device${C.reset},`)
  console.log(`    then point the camera at the QR code.`)
  console.log("")

  // Run Hermeneia directly; on an unlinked account it starts the QR page and
  // opens the browser itself. stdin stays open (pipe) — it's a stdio MCP server.
  const child = spawn(process.execPath, [path.join(dir, "dist", "index.js")], {
    stdio: ["pipe", "ignore", "ignore"],
    env: { ...process.env, HERMENEIA_QR_PORT: String(HERMENEIA_QR_PORT) }
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

async function setupHermeneia(env, existing) {
  if (!(os.platform() === "darwin" && isAppleSilicon())) {
    console.log(`    ${C.dim}WhatsApp (Hermeneia) needs a Mac with an Apple chip — not offered on this machine.${C.reset}\n`)
    return
  }

  const configured = existing.HERMENEIA_DIR && fs.existsSync(path.join(existing.HERMENEIA_DIR, "dist", "index.js"))
  if (configured) {
    env.HERMENEIA_DIR = existing.HERMENEIA_DIR
    const linked = hermeneiaLinked()
    console.log(`  ${C.bold}WhatsApp (Hermeneia)${C.reset} ${C.green}(configured)${C.reset}`)
    console.log(`    ${C.dim}HERMENEIA_DIR=${existing.HERMENEIA_DIR} · phone ${linked ? "linked" : "NOT linked yet"}${C.reset}`)
    try { execSync("git pull --ff-only", { cwd: env.HERMENEIA_DIR, stdio: "ignore" }) } catch {}
    if (!linked && await confirm("  Link your WhatsApp now (QR scan)?", true)) {
      await hermeneiaQRAuth(env.HERMENEIA_DIR)
    }
    console.log("")
    return
  }

  console.log(`  ${C.bold}WhatsApp (Hermeneia)${C.reset}`)
  console.log(`    ${C.dim}Read, search, and send your WhatsApp messages — everything stays on this Mac.${C.reset}`)
  if (!await confirm("Connect WhatsApp?", true)) { console.log(""); return }

  const dir = existing.HERMENEIA_DIR || path.join(home, "hermeneia")
  try {
    if (fs.existsSync(path.join(dir, ".git"))) {
      try { execSync("git pull --ff-only", { cwd: dir, stdio: "ignore" }) } catch {}
    } else {
      run(`git clone --depth 1 ${HERMENEIA_REPO} "${dir}"`)
    }
  } catch (e) {
    warn(`Could not download Hermeneia (${e.message}) — skipping WhatsApp`)
    console.log(""); return
  }
  if (!fs.existsSync(path.join(dir, "dist", "index.js"))) {
    warn("Hermeneia checkout has no dist/index.js — skipping WhatsApp")
    console.log(""); return
  }
  env.HERMENEIA_DIR = dir
  ok(`Hermeneia installed → ${dir}`)

  if (hermeneiaLinked()) {
    ok("WhatsApp already linked (existing Hermeneia session found)")
  } else if (await confirm("  Link your WhatsApp now (QR scan)?", true)) {
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

// ── Personal connectors: Apple Reminders + Things 3 ──────────
// Both are local JXA-based MCP servers vendored as npm dependencies of
// REFUGIO (Phantazein's just-claude-reminders / just-claude-things) — no
// credentials, no clone, no ports. macOS only: the first tool call triggers
// the standard macOS Automation permission prompt for the target app.

async function setupAppleReminders(env, existing) {
  if (os.platform() !== "darwin") return
  const on = existing.REFUGIO_REMINDERS === "1"
  console.log(`  ${C.bold}Apple Reminders${C.reset}${on ? ` ${C.green}(enabled)${C.reset}` : ""}`)
  console.log(`    ${C.dim}Read, create, and complete your reminders. macOS asks for Automation permission on first use.${C.reset}`)
  env.REFUGIO_REMINDERS = (await confirm("Connect Apple Reminders?", true)) ? "1" : ""
  console.log("")
}

async function setupThings(env, existing) {
  if (os.platform() !== "darwin") return
  const on = existing.REFUGIO_THINGS === "1"
  const installed = fs.existsSync("/Applications/Things3.app")
  if (!installed && !on) {
    console.log(`    ${C.dim}Things 3 not found in /Applications — skipping that connector.${C.reset}\n`)
    return
  }
  console.log(`  ${C.bold}Things 3${C.reset}${on ? ` ${C.green}(enabled)${C.reset}` : ""}`)
  console.log(`    ${C.dim}Browse and manage your Things to-dos, projects, and areas. Automation permission on first use.${C.reset}`)
  if (!installed) warn("Things 3 app not found in /Applications — the connector won't work until it's installed")
  env.REFUGIO_THINGS = (await confirm("Connect Things 3?", true)) ? "1" : ""
  console.log("")
}

// ── LLM engine ───────────────────────────────────────────────

const OLLAMA_URL = "http://localhost:11434"
const LMSTUDIO_URL = "http://localhost:1234/v1"

// Pick an Ollama model sized to the machine's RAM. All are tool-calling capable.
function pickModelForRam() {
  const gb = os.totalmem() / (1024 ** 3)
  // Sized to fit alongside macOS (~2.5 GB wired) + the user's apps, not just in
  // total RAM. An 8 GB Mac can't hold a 3b (~2.8 GB) without swapping once other
  // apps are open, so it gets the 1b.
  if (gb <= 8) return "llama3.2:1b"     // ~0.8 GB — 8 GB and under
  if (gb <= 16) return "llama3.2:3b"    // ~2 GB   — 16 GB
  if (gb <= 32) return "llama3.1:8b"    // ~4.7 GB — 32 GB
  if (gb <= 48) return "qwen2.5:14b"    // ~9 GB
  return "gpt-oss:20b"                   // ~13 GB  — 48 GB+
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

function showBanner() {
  console.log(`
${C.bold}============================================================
 🏔️  REFUGIO Installer
 A self-hosted refuge for your AI — runs on your own machine
============================================================${C.reset}

 Installs a local LLM (Ollama or LM Studio) + Open WebUI, plus
 optional personal connectors (WhatsApp, email, Notion, memory)
 and business connectors (Slack, Jira, and more).

 No prerequisites — everything installs automatically.
 You can skip any connector and add credentials later.
`)
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

  // Check if port 8080 is in use
  try {
    const portCheck = isWin
      ? runQuiet("netstat -ano | findstr :8080 | findstr LISTENING")
      : runQuiet("lsof -iTCP:8080 -sTCP:LISTEN -t 2>/dev/null")
    if (portCheck) {
      warn("Port 8080 is already in use")
      if (!isWin) {
        try {
          const procInfo = runQuiet(`ps -p ${portCheck.split("\n")[0]} -o comm= 2>/dev/null`)
          console.log(`    ${C.dim}Process: ${procInfo} (PID ${portCheck.split("\n")[0]})${C.reset}`)
        } catch {}
      }
      const killIt = await confirm("Kill the process using port 8080?", true)
      if (killIt) {
        try {
          if (isWin) {
            run("for /f \"tokens=5\" %a in ('netstat -ano ^| findstr :8080 ^| findstr LISTENING') do taskkill /PID %a /F", { shell: true, stdio: "ignore" })
          } else {
            run("lsof -iTCP:8080 -sTCP:LISTEN -t | xargs kill", { shell: true, stdio: "ignore" })
          }
          ok("Freed port 8080")
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
  console.log(`${C.bold}Installing REFUGIO...${C.reset}\n`)

  // Track which version to install — override with REFUGIO_VERSION env var
  const refugioVersion = process.env.REFUGIO_VERSION || "main"

  if (fs.existsSync(path.join(targetDir, "package.json"))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, "package.json"), "utf-8"))
      if (pkg.name === "refugio") {
        ok(`Found existing REFUGIO at ${targetDir}`)
        console.log(`    ${C.dim}This will update to ${refugioVersion}.`)
        console.log(`    Your credentials and settings in ~/.refugio.env are not affected.${C.reset}`)
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
    ok("Cloning REFUGIO repository...")
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
    { header: "Apple Reminders / Things 3", keys: ["REFUGIO_REMINDERS", "REFUGIO_THINGS"] },
    { header: "Notion", keys: ["NOTION_TOKEN"] },
    { header: "Memory", keys: ["REFUGIO_MEMORY", "GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO", "GITHUB_MEMORY_PATH"] },
    { header: "Slack", keys: ["SLACK_TOKEN"] },
    { header: "Jira", keys: ["JIRA_DOMAIN", "JIRA_EMAIL", "JIRA_API_TOKEN"] },
    { header: "ServiceNow", keys: ["SERVICENOW_INSTANCE", "SERVICENOW_USERNAME", "SERVICENOW_PASSWORD"] },
    { header: "Salesforce", keys: ["SALESFORCE_INSTANCE_URL", "SALESFORCE_USERNAME", "SALESFORCE_PASSWORD", "SALESFORCE_SECURITY_TOKEN"] }
  ]

  let content = "# REFUGIO Credentials (chmod 600)\n# Edit values below, then start REFUGIO\n\n"

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

  // LM Studio is a GUI app we can't auto-install, so we connect to its local
  // server (OpenAI-compatible on :1234). Detect whether it's already running.
  const lmStudioUp = await probeHttp(`${LMSTUDIO_URL}/models`)
  console.log(`    1) Ollama — auto-install and run a local model (recommended)`)
  console.log(`    2) LM Studio — connect to its local server on :1234${lmStudioUp ? `  ${C.green}(detected)${C.reset}` : `  ${C.dim}(start it first)${C.reset}`}`)
  console.log(`    3) Skip — set up a backend later`)
  const llmChoice = await ask("Choose", lmStudioUp ? "2" : "1")

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
    ok("Skipping LLM engine — configure later in ~/.refugio.env")
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

  await promptConnector(ACCOUNT_CONNECTOR)

  // ── Personal connectors — your own messages, mail, and notes ──
  console.log(`  ${C.bold}── Personal connectors ──${C.reset} ${C.dim}your messages, mail, and notes${C.reset}\n`)
  await setupHermeneia(env, existing)
  await setupEpistole(env, existing, targetDir)
  await setupAppleReminders(env, existing)
  await setupThings(env, existing)
  for (const conn of PERSONAL_CONNECTORS) {
    await promptConnector(conn)
  }

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
    warn("Skipping Open WebUI — uv not available")
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

  // Default: use refugio.localhost (zero-config, works in Chrome/Firefox/Edge)
  ok(`Available at ${localhostUrl}`)

  // Optionally upgrade to https://refugio
  const setupHttps = await confirm("Also set up https://refugio? (requires admin password, mkcert, caddy)", true)
  if (!setupHttps) return localhostUrl

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

async function ensureOllamaServing() {
  if (await probeHttp(`${OLLAMA_URL}/api/tags`, 1500)) return true
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
  for (let i = 0; i < 15; i++) {
    if (await probeHttp(`${OLLAMA_URL}/api/tags`, 1500)) return true
    await new Promise(r => setTimeout(r, 2000))
  }
  return await probeHttp(`${OLLAMA_URL}/api/tags`, 1500)
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
  console.log(`${C.bold}Starting REFUGIO...${C.reset}\n`)

  const PORT = 8080

  if (autoStarted) {
    // The supervisor (start-refugio.cjs) is already running via launchd/systemd
    // (setupAutoStart runs before this function)
    ok("REFUGIO supervisor started via auto-start service")
  } else {
    // On-demand mode (low-RAM): no login service, so launch the supervisor now
    // (detached) for this session. It won't relaunch on future logins.
    try {
      const out = fs.openSync(path.join(home, ".refugio-logs", "refugio.log"), "a")
      const child = spawn(process.execPath, [path.join(targetDir, "start-refugio.cjs"), "--no-browser"], {
        detached: true, stdio: ["ignore", out, out], cwd: targetDir
      })
      child.unref()
      try { fs.closeSync(out) } catch {}  // child inherited the fd; parent doesn't need it
      ok("REFUGIO supervisor started (on-demand)")
    } catch (e) {
      warn(`Could not start supervisor: ${e.message} — run: refugio`)
    }
  }

  // Wait for OWUI to be ready
  const waitStart = Date.now()
  process.stdout.write("  Waiting for Open WebUI to be ready... (first launch downloads a model — up to a few min) ")
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - waitStart) / 1000)
    process.stdout.write(`\r  Waiting for Open WebUI to be ready... (${elapsed}s) `)
  }, 1000)
  const ready = await waitForServer(`http://127.0.0.1:${PORT}/api/config`, 300000)
  clearInterval(timer)

  if (ready) {
    const elapsed = Math.round((Date.now() - waitStart) / 1000)
    process.stdout.write(`\r  Waiting for Open WebUI to be ready... done (${elapsed}s)                \n`)
    ok(`Open WebUI → http://127.0.0.1:${PORT}`)

    // Set up https://refugio local domain
    let refugioUrl = `http://127.0.0.1:${PORT}`
    refugioUrl = await setupLocalDomain(targetDir, PORT, refugioUrl)

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
    const plistPath = path.join(plistDir, "com.phantazein.refugio.plist")

    if (!fs.existsSync(plistDir)) fs.mkdirSync(plistDir, { recursive: true })

    const logDir = path.join(home, ".refugio-logs")
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.phantazein.refugio</string>
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
      ok("REFUGIO will auto-start on login (launchd)")
    } catch {
      try {
        execSync(`launchctl load "${plistPath}"`, { stdio: "ignore" })
        ok("REFUGIO will auto-start on login (launchd)")
      } catch {
        warn("Could not register auto-start — run manually: node ~/refugio/start-refugio.cjs")
      }
    }
  } else if (os.platform() === "linux") {
    // Linux: systemd user service
    const serviceDir = path.join(home, ".config", "systemd", "user")
    const servicePath = path.join(serviceDir, "refugio.service")

    if (!fs.existsSync(serviceDir)) fs.mkdirSync(serviceDir, { recursive: true })

    const service = `[Unit]
Description=REFUGIO
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
      execSync("systemctl --user enable refugio.service", { stdio: "ignore" })
      ok("REFUGIO will auto-start on login (systemd)")
    } catch {
      warn("Could not register auto-start — run manually: node ~/refugio/start-refugio.cjs")
    }
  } else if (isWin) {
    // Windows: VBScript in Startup folder (runs without console window)
    try {
      const startupDir = path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
      const vbsPath = path.join(startupDir, "REFUGIO.vbs")
      const vbs = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run """${nodePath}"" ""${startScript}"" --no-browser", 0, False`
      fs.writeFileSync(vbsPath, vbs)
      ok("REFUGIO will auto-start on login (Startup folder)")
    } catch {
      warn("Could not register auto-start — run manually: node ~/refugio/start-refugio.cjs")
    }
  }

  return true
}

// On-demand setup for low-RAM machines: create convenient launchers (a `refugio`
// CLI + a clickable shortcut) and ensure NO login auto-start remains, so Open
// WebUI isn't resident all day. The user starts REFUGIO when they want it and
// frees the RAM by quitting (Ctrl+C / `refugio stop`).
function setupOnDemand(targetDir, nodePath, startScript) {
  try { fs.mkdirSync(path.join(home, ".refugio-logs"), { recursive: true }) } catch {}

  // Remove any existing login auto-start so it truly won't launch at boot.
  if (os.platform() === "darwin") {
    const plistPath = path.join(home, "Library", "LaunchAgents", "com.phantazein.refugio.plist")
    try { execSync(`launchctl bootout gui/$(id -u) "${plistPath}"`, { stdio: "ignore" }) } catch {}
    try { if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath) } catch {}
  } else if (os.platform() === "linux") {
    try { execSync("systemctl --user disable refugio.service", { stdio: "ignore" }) } catch {}
    try { fs.unlinkSync(path.join(home, ".config", "systemd", "user", "refugio.service")) } catch {}
    try { execSync("systemctl --user daemon-reload", { stdio: "ignore" }) } catch {}
  } else if (isWin) {
    try {
      const vbsPath = path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "REFUGIO.vbs")
      if (fs.existsSync(vbsPath)) fs.unlinkSync(vbsPath)
    } catch {}
  }

  if (!isWin) {
    // `refugio` CLI on PATH (~/.local/bin is on PATH via uv): start | stop | status
    const binDir = path.join(home, ".local", "bin")
    try { fs.mkdirSync(binDir, { recursive: true }) } catch {}
    const cli = `#!/bin/sh
# REFUGIO on-demand launcher
NODE="${nodePath}"
DIR="${targetDir}"
PIDF="$HOME/.refugio-logs/supervisor.pid"
case "$1" in
  stop)
    if [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null; then echo "REFUGIO stopped (RAM freed)"; else echo "REFUGIO is not running"; fi ;;
  status)
    if curl -s --max-time 2 http://127.0.0.1:8080/api/config >/dev/null 2>&1; then echo "running -> http://127.0.0.1:8080"; else echo "stopped"; fi ;;
  *)
    echo "Starting REFUGIO... (Ctrl+C or 'refugio stop' to stop and free RAM)"
    exec "$NODE" "$DIR/start-refugio.cjs" ;;
esac
`
    const cliPath = path.join(binDir, "refugio")
    try { fs.writeFileSync(cliPath, cli); fs.chmodSync(cliPath, 0o755) } catch {}

    if (os.platform() === "darwin") {
      const cmd = `#!/bin/sh\nexec "${nodePath}" "${targetDir}/start-refugio.cjs"\n`
      const cmdPath = path.join(targetDir, "Start REFUGIO.command")
      try { fs.writeFileSync(cmdPath, cmd); fs.chmodSync(cmdPath, 0o755) } catch {}
    } else {
      const appsDir = path.join(home, ".local", "share", "applications")
      try { fs.mkdirSync(appsDir, { recursive: true }) } catch {}
      const desktop = `[Desktop Entry]\nType=Application\nName=REFUGIO\nComment=Start your local AI\nExec="${nodePath}" "${targetDir}/start-refugio.cjs"\nTerminal=true\nCategories=Utility;\n`
      try { fs.writeFileSync(path.join(appsDir, "refugio.desktop"), desktop) } catch {}
    }
  } else {
    // Windows: clickable start + stop .bat (no `refugio` shell CLI on Windows).
    const bat = `@echo off\r\ncall "${nodePath}" "${targetDir}\\start-refugio.cjs"\r\n`
    try { fs.writeFileSync(path.join(targetDir, "Start-REFUGIO.bat"), bat) } catch {}
    const stop = [
      "@echo off",
      "setlocal enabledelayedexpansion",
      'set "PIDF=%USERPROFILE%\\.refugio-logs\\supervisor.pid"',
      'if not exist "%PIDF%" ( echo REFUGIO is not running & exit /b )',
      'set /p PID=<"%PIDF%"',
      "taskkill /PID !PID! /T /F >nul 2>&1 && echo REFUGIO stopped (RAM freed) || echo REFUGIO is not running",
    ].join("\r\n") + "\r\n"
    try { fs.writeFileSync(path.join(targetDir, "Stop-REFUGIO.bat"), stop) } catch {}
  }

  ok("Low-RAM mode: REFUGIO will NOT auto-start on login (keeps your RAM free)")
  if (!isWin) {
    ok("Start anytime:  refugio   ·   stop + free RAM:  refugio stop")
    const onPath = (process.env.PATH || "").split(":").includes(path.join(home, ".local", "bin"))
    if (!onPath) ok(`(if 'refugio' isn't found: run ${path.join(home, ".local", "bin", "refugio")}, or add ~/.local/bin to PATH)`)
    if (os.platform() === "darwin") ok(`Or double-click:  ${path.join(targetDir, "Start REFUGIO.command")}`)
  } else {
    ok(`Start: double-click ${path.join(targetDir, "Start-REFUGIO.bat")}`)
    ok(`Stop + free RAM: double-click ${path.join(targetDir, "Stop-REFUGIO.bat")}`)
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const flags = new Set(args.filter(a => a.startsWith("--")))
  const positional = args.filter(a => !a.startsWith("--"))

  if (flags.has("--help") || flags.has("-h")) {
    console.log(`
  Usage: node install-node.cjs [options] [directory]
     or: curl -fsSL https://raw.githubusercontent.com/Phantazein-apps/refugio/main/install-node.cjs | node

  Options:
    --no-start         Don't launch REFUGIO after install
    --non-interactive  Skip credential prompts (create template only)
    --skip-owui        Skip Open WebUI installation
    --help             Show this help

  Examples:
    node install-node.cjs                    Interactive install to ~/refugio
    node install-node.cjs ./my-refugio       Install to custom directory
    node install-node.cjs --no-start         Install without launching
    node install-node.cjs --non-interactive  Headless install (CI-friendly)
`)
    return
  }

  // Determine target directory
  const dirIdx = args.indexOf("--dir")
  let targetDir
  if (dirIdx >= 0 && args[dirIdx + 1]) {
    targetDir = path.resolve(args[dirIdx + 1])
  } else if (positional.length > 0) {
    targetDir = path.resolve(positional[0])
  } else {
    targetDir = path.join(home, "refugio")
  }

  const envPath = path.join(home, ".refugio.env")

  showBanner()

  const { hasUV } = checkDeps()

  await preflight(targetDir)

  await cloneAndInstall(targetDir)

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

  if (!flags.has("--skip-owui")) {
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
  console.log(` 🏔️  REFUGIO is ready!`)
  console.log(`============================================================${C.reset}`)
  console.log("")
  console.log(`  Installation:  ${targetDir}`)
  console.log(`  Credentials:   ${envPath}`)
  console.log("")
  if (flags.has("--non-interactive")) {
    // Headless: nothing was auto-started or launcher-installed.
    console.log(`  To start REFUGIO:`)
    console.log(`    node ${path.join(targetDir, "start-refugio.cjs")}`)
  } else if (isLowRam()) {
    if (isWin) {
      console.log(`  Start REFUGIO:     double-click ${path.join(targetDir, "Start-REFUGIO.bat")}`)
      console.log(`  Stop + free RAM:   double-click ${path.join(targetDir, "Stop-REFUGIO.bat")}`)
    } else {
      const extra = os.platform() === "darwin" ? `   (or double-click "Start REFUGIO.command")` : ""
      console.log(`  Start REFUGIO:     refugio${extra}`)
      console.log(`  Stop + free RAM:   refugio stop`)
    }
    console.log("")
    console.log(`  Low-RAM mode: REFUGIO does NOT auto-start on login, so it only`)
    console.log(`  uses memory while you're actually using it.`)
  } else {
    console.log(`  To start REFUGIO manually:`)
    console.log(`    node ${path.join(targetDir, "start-refugio.cjs")}`)
    console.log("")
    console.log(`  REFUGIO will auto-start on login.`)
  }
  console.log("")
}

main().catch(err => {
  console.error(`\n  \x1b[31m✗\x1b[0m ${err.message}`)
  process.exit(1)
})
