#!/usr/bin/env node
// REFUGIO Process Supervisor — launches and monitors the local LLM and the chat window
// Usage: node start-refugio.cjs [--no-browser]
//
// Stays running as a supervisor. If a child process crashes, it is auto-restarted
// with exponential backoff. launchd monitors THIS process and restarts it if it
// dies.

const { execSync, spawn } = require("child_process")
const fs = require("fs")
const path = require("path")
const os = require("os")
const http = require("http")

const home = os.homedir()
const REFUGIO_DIR = path.resolve(__dirname)

// ── Which product this install is ───────────────────────────
//
// REFUGIO and REFUGIO Listener are one codebase and two installs, and every
// path below that mentions the home directory is one of the things that
// differs between them. Resolved the same way the chat server resolves it —
// the environment first, then the .refugio-edition marker the installer wrote
// beside this file, then standard — so a supervisor started by launchd with no
// environment and a supervisor started by hand agree about which product they
// are supervising.
const { editionFor, isEdition, MARKER_FILE, DEFAULT_EDITION } = require(path.join(REFUGIO_DIR, "editions.cjs"))
const EDITION = (() => {
  const asked = (process.env.REFUGIO_EDITION || "").trim()
  if (asked) return isEdition(asked) ? asked : DEFAULT_EDITION
  try {
    const marked = fs.readFileSync(path.join(REFUGIO_DIR, MARKER_FILE), "utf-8").trim()
    if (isEdition(marked)) return marked
  } catch {}
  return DEFAULT_EDITION
})()
const PRODUCT = editionFor(EDITION)
const LOG_DIR = path.join(home, PRODUCT.logDir)
const ENV_FILE = path.join(home, PRODUCT.envFile)

/**
 * Is this a packaged install — laid down by the .pkg rather than cloned by
 * install-node.cjs?
 *
 * Decided by asking whether we can write next to ourselves, which is the thing
 * that actually matters, rather than a flag someone has to remember to set. A
 * git checkout in ~/refugio is writable; /usr/local/refugio is not.
 *
 * It changes two things, and both were outright bugs before this existed:
 *
 *   1. mcpo-config.json is rewritten on every launch. Into a root-owned
 *      directory that throws EACCES, the supervisor dies, the login agent's
 *      KeepAlive restarts it, and the machine sits in a crash loop that looks
 *      from outside like a package which installed fine and does nothing.
 *   2. The chat database lived in REFUGIO_DIR/data. On a shared Mac that is
 *      one database for everyone who logs in — not a permissions inconvenience
 *      but one person reading another person's conversations.
 *
 * Existing installs are deliberately unaffected: their directory IS writable,
 * so they keep REFUGIO_DIR/data and their history stays exactly where it is.
 * Only a packaged install — which is new, and has nothing to migrate — goes
 * per-user.
 */
const PACKAGED = (() => {
  try { fs.accessSync(REFUGIO_DIR, fs.constants.W_OK); return false } catch { return true }
})()

/** Where mutable state goes: per-user under a packaged install, alongside the
 *  code for a git checkout, which is where it has always been. */
const STATE_DIR = PACKAGED ? path.join(home, PRODUCT.dataDir) : REFUGIO_DIR
const CHAT_DATA_DIR = PACKAGED ? STATE_DIR : path.join(REFUGIO_DIR, "data")
if (PACKAGED) { try { fs.mkdirSync(STATE_DIR, { recursive: true }) } catch {} }

const C = process.stdout.isTTY ? {
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  bold: "\x1b[1m", dim: "\x1b[2m", reset: "\x1b[0m"
} : { green: "", red: "", yellow: "", bold: "", dim: "", reset: "" }

function ok(msg) { console.log(`  ${C.green}✓${C.reset} ${msg}`) }
function warn(msg) { console.log(`  ${C.yellow}!${C.reset} ${msg}`) }
function fail(msg) { console.log(`  ${C.red}✗${C.reset} ${msg}`) }
function ts() { return new Date().toLocaleTimeString() }

function has(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" })
    return true
  } catch { return false }
}

// ── Load credentials ────────────────────────────────────────

function loadEnv() {
  const env = {}
  const envFile = ENV_FILE
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, "utf-8").split("\n").forEach(line => {
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

// ── Wait for server ─────────────────────────────────────────

function waitForServer(url, maxWait = 60000) {
  const start = Date.now()
  return new Promise(resolve => {
    const check = () => {
      if (Date.now() - start > maxWait) return resolve(false)
      const req = http.get(url, res => { res.resume(); resolve(true) })
      req.on("error", () => setTimeout(check, 2000))
      req.setTimeout(2000, () => { req.destroy(); setTimeout(check, 2000) })
    }
    check()
  })
}

// Quick one-shot probe — true if the endpoint responds within the timeout
function probeHttp(url, timeout = 1500) {
  return new Promise(resolve => {
    const req = http.get(url, res => { res.resume(); resolve(true) })
    req.on("error", () => resolve(false))
    req.setTimeout(timeout, () => { req.destroy(); resolve(false) })
  })
}

// GET a URL and parse JSON; resolves {} on any error/timeout.
function getJson(url, timeout = 4000) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      let b = ""
      res.on("data", c => b += c)
      res.on("end", () => { try { resolve(JSON.parse(b)) } catch { resolve({}) } })
    })
    req.on("error", () => resolve({}))
    req.setTimeout(timeout, () => { req.destroy(); resolve({}) })
  })
}

/** The pid of a process listening on `port` that is this install's chat
 *  server — its command line names `chatEntry` — or null. Asks lsof for the
 *  listener and ps for its arguments; anything that cannot be read is "not
 *  ours", which leaves the old adopt-it behaviour in place. */
function ownChatServerOnPort(port, chatEntry) {
  try {
    const pids = execSync(`lsof -nP -tiTCP:${port} -sTCP:LISTEN`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map(s => parseInt(s, 10)).filter(n => n > 1 && n !== process.pid)
    for (const pid of pids) {
      const args = execSync(`ps -p ${pid} -o args=`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      if (args.includes(chatEntry)) return pid
    }
  } catch {}
  return null
}

// ── Open browser ────────────────────────────────────────────

function openBrowser(url) {
  try { execSync(`open "${url}"`, { stdio: "ignore" }) } catch {}
}

// ── Process Supervisor ──────────────────────────────────────

class Supervisor {
  constructor() {
    this.children = new Map()  // name → { proc, cmd, args, opts, restarts, lastStart }
    this.shuttingDown = false
    this.MAX_RESTARTS = 10
    this.BACKOFF_BASE = 2000   // 2s initial backoff
    this.BACKOFF_MAX = 60000   // 60s max backoff
    this.RESET_AFTER = 300000  // Reset restart count after 5 min of stability
  }

  // Start a managed child process
  start(name, cmd, args, opts = {}) {
    if (this.shuttingDown) return null

    const child = spawn(cmd, args, {
      cwd: opts.cwd || REFUGIO_DIR,
      stdio: opts.stdio || "ignore",
      env: opts.env || process.env,
      // NOT detached — child dies when parent dies
    })

    const entry = this.children.get(name) || { restarts: 0, lastStart: 0 }
    entry.proc = child
    entry.cmd = cmd
    entry.args = args
    entry.opts = opts
    entry.lastStart = Date.now()
    this.children.set(name, entry)

    child.on("exit", (code, signal) => {
      if (this.shuttingDown) return

      // Reset restart counter if process was stable for a while
      if (Date.now() - entry.lastStart > this.RESET_AFTER) {
        entry.restarts = 0
      }

      entry.restarts++

      if (entry.restarts > this.MAX_RESTARTS) {
        fail(`${name} crashed too many times (${this.MAX_RESTARTS}) — giving up`)
        return
      }

      const backoff = Math.min(
        this.BACKOFF_BASE * Math.pow(1.5, entry.restarts - 1),
        this.BACKOFF_MAX
      )

      warn(`${name} exited (code=${code}, signal=${signal}) — restarting in ${Math.round(backoff / 1000)}s (attempt ${entry.restarts}/${this.MAX_RESTARTS})`)

      setTimeout(() => {
        if (!this.shuttingDown) {
          ok(`Restarting ${name}...`)
          this.start(name, cmd, args, opts)
        }
      }, backoff)
    })

    return child
  }

  // Graceful shutdown — kill all children
  shutdown() {
    if (this.shuttingDown) return
    this.shuttingDown = true

    console.log(`\n  ${C.yellow}Shutting down REFUGIO...${C.reset}`)

    for (const [name, entry] of this.children) {
      if (entry.proc && !entry.proc.killed) {
        try {
          entry.proc.kill("SIGTERM")
          ok(`Stopped ${name}`)
        } catch {}
      }
    }

    // Give children a moment to exit, then force-kill
    setTimeout(() => {
      for (const [name, entry] of this.children) {
        if (entry.proc && !entry.proc.killed) {
          try { entry.proc.kill("SIGKILL") } catch {}
        }
      }
      process.exit(0)
    }, 3000)
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const args = new Set(process.argv.slice(2))
  const noBrowser = args.has("--no-browser")

  // ── Prevent duplicate supervisors ──────────────────────────
  const pidFile = path.join(LOG_DIR, "supervisor.pid")
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  } catch {}

  if (fs.existsSync(pidFile)) {
    const oldPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim())
    if (oldPid) {
      try {
        process.kill(oldPid, 0)  // check if process exists (throws if not)
        // Process exists — is it actually a supervisor, or a recycled PID?
        let looksLikeSupervisor = false
        try {
          const cmdCheck = execSync(`ps -p ${oldPid} -o args=`, { encoding: "utf-8" }).trim()
          looksLikeSupervisor = cmdCheck.includes("start-refugio")
        } catch {}
        if (looksLikeSupervisor) {
          warn(`Another REFUGIO supervisor is already running (PID ${oldPid})`)
          warn("Stopping the old one first...")
          try {
            process.kill(oldPid, "SIGTERM")
            // Wait for it to exit
            for (let i = 0; i < 10; i++) {
              try { process.kill(oldPid, 0); } catch { break }
              await new Promise(r => setTimeout(r, 1000))
            }
            // Force kill if still alive
            try { process.kill(oldPid, 0); process.kill(oldPid, "SIGKILL") } catch {}
          } catch {}
        }
      } catch {}  // process doesn't exist — stale pidfile, continue
    }
  }

  fs.writeFileSync(pidFile, String(process.pid))
  process.on("exit", () => {
    try {
      const currentPid = fs.readFileSync(pidFile, "utf-8").trim()
      if (currentPid === String(process.pid)) fs.unlinkSync(pidFile)
    } catch {}
  })

  console.log(`
${C.bold}============================================================
 🏔️  Starting REFUGIO
============================================================${C.reset}
`)

  const env = loadEnv()
  if (Object.keys(env).length === 0) {
    fail(`No credentials found at ~/${PRODUCT.envFile}`)
    fail("Run the installer first: curl -fsSL https://raw.githubusercontent.com/Phantazein-apps/refugio/main/install-refugio | bash")
    process.exit(1)
  }

  const supervisor = new Supervisor()

  // Handle shutdown signals
  process.on("SIGTERM", () => supervisor.shutdown())
  process.on("SIGINT", () => supervisor.shutdown())

  const mergedEnv = { ...process.env, ...env }

  // ── Memory snapshot (shared by model selection + Ollama keep-alive) ──
  // Measure RAM that's actually FREE now so BOTH the model choice and how long
  // Ollama holds an idle model react to the same real constraint. Using total
  // RAM for one and available for the other would keep a model resident on a
  // busy high-RAM machine that the model choice had already judged too tight.
  let memFit = null
  try { memFit = require(path.join(REFUGIO_DIR, "scripts", "mem-fit.cjs")) } catch {}
  const totalGb = os.totalmem() / (1024 ** 3)
  const availableGb = memFit ? memFit.availableMemGb() : totalGb
  // Tight memory: a small machine OR a big one that's busy now.
  const memoryTight = totalGb <= 8 || availableGb < 6
  // RAM the chat window itself holds beside the model. It is plain Node, so the
  // figure is small and does not move with memory pressure — the same 0.05 GB
  // chat/server.js budgets when it tells the user which models fit.
  const uiOverheadGb = 0.05

  // ── Ensure the local LLM (Ollama) is serving ────────────────
  // For local-model setups, keep `ollama serve` alive under the supervisor so
  // the model is available after a reboot. Skip if something already owns :11434
  // (usually the Ollama app itself).
  const wantsOllama = env.REFUGIO_ENGINE === "ollama" ||
    (env.OLLAMA_BASE_URL && /(localhost|127\.0\.0\.1):11434/.test(env.OLLAMA_BASE_URL))
  if (wantsOllama) {
    const ollamaUp = await probeHttp("http://127.0.0.1:11434/api/tags")
    if (ollamaUp) {
      ok("Ollama already running → http://localhost:11434")
    } else {
      // Prefer the macOS app's Ollama binary; fall back to PATH.
      const appOllama = "/Applications/Ollama.app/Contents/Resources/ollama"
      const ollamaBin = fs.existsSync(appOllama) ? appOllama : (has("ollama") ? "ollama" : null)
      if (ollamaBin) {
        // On Apple Silicon, force the arm64 slice so Ollama uses the GPU (Metal).
        // A universal binary spawned from an x86_64/Rosetta node would otherwise
        // run CPU-only — unusably slow.
        let appleSilicon = false
        try { appleSilicon = execSync("sysctl -n hw.optional.arm64", { encoding: "utf-8" }).trim() === "1" } catch {}
        const cmd = appleSilicon ? "arch" : ollamaBin
        const cargs = appleSilicon ? ["-arm64", ollamaBin, "serve"] : ["serve"]
        // On small machines, unload the model soon after idle so it doesn't hold
        // ~1-3 GB of RAM hostage between messages (keeps the whole Mac responsive).
        // Tight memory (small machine OR busy right now) → unload the model fast
        // so it doesn't hold RAM hostage. Same available-RAM signal as model fit.
        const keepAlive = memoryTight ? "30s" : "5m"
        supervisor.start("ollama", cmd, cargs, { env: { ...mergedEnv, OLLAMA_KEEP_ALIVE: keepAlive } })
        ok(`Ollama server → http://localhost:11434${appleSilicon ? " (arm64/Metal)" : ""} · keep-alive ${keepAlive}`)
      } else {
        warn("Ollama not found — install it or start it manually")
      }
    }
  }

  // ── Adaptive model: activate the model that fits FREE RAM right now ──
  // Two tiers are installed (optimal + a lighter "busy" one). Each launch we pick
  // the largest INSTALLED model that fits the RAM actually free now — no on-demand
  // download, no troubleshooting. If even the lightest is tight, run it anyway and
  // tell the user to close some apps.
  let runtimeModel = env.REFUGIO_MODEL || ""
  if (wantsOllama && memFit) {
    try {
      await waitForServer("http://127.0.0.1:11434/api/tags", 15000)
      const tags = await getJson("http://127.0.0.1:11434/api/tags")
      const installed = (tags.models || []).map(m => m.name || m.model).filter(Boolean)
      const pick = memFit.pickInstalledModel({ availableGb, uiOverheadGb, installedTags: installed })
      if (pick.tag) {
        runtimeModel = pick.tag
        // A model that can't call tools is the one failure worth interrupting
        // the launch banner for: everything looks healthy, the chat answers
        // fluently, and every connector silently does nothing.
        if (pick.tools === false) {
          warn(`${pick.tag} cannot call tools — connectors (WhatsApp, calendar, notes) will NOT work.`)
          warn(`REFUGIO needs at least ${memFit.TOOL_FLOOR.tag}: ollama pull ${memFit.TOOL_FLOOR.tag}`)
        }
        if (!pick.fits) {
          warn(`Low memory: ~${availableGb.toFixed(1)} GB free — running the lightest installed model (${pick.tag}). Close some apps for better results.`)
        } else if (pick.heavier) {
          ok(`~${availableGb.toFixed(1)} GB free → running ${pick.tag} (heavier "${pick.heavier}" is installed; it activates when more RAM is free)`)
        } else {
          ok(`~${availableGb.toFixed(1)} GB free → running ${pick.tag}`)
        }
      } else if (installed.length === 0) {
        // Ollama wasn't ready / returned no models — keep the install-time model
        // (the one we know was pulled) rather than guessing, and say so.
        warn(`Couldn't read installed models yet — defaulting to ${runtimeModel || "Ollama's own default"}`)
      } else {
        // Only off-ladder/custom models are installed — use the configured one.
        warn(`No managed-ladder model installed — using ${runtimeModel || "Ollama's own default"}`)
      }
    } catch { /* best-effort; fall back to the install model */ }
  }
  mergedEnv.REFUGIO_RUNTIME_MODEL = runtimeModel

  const nodeBin = process.execPath  // full path to node, safe for launchd

  // ── Business connectors — in-repo stdio MCP servers ─────────
  // Each is servers/<name>.js, which speaks MCP over stdio when started with no
  // flag (servers/shared.js) and finds its credentials in the environment it
  // inherits, topped up from ~/.refugio.env. The chat window spawns them from
  // mcpo-config.json like every other connector.
  //
  // They used to be started HERE, as HTTP servers on ports 3001–3007, and
  // listed in the config by URL. Only the MCPO proxy could use that shape: the
  // chat window spawns stdio servers, and reported every one of these as "not a
  // stdio server" — so a configured Slack or Jira was simply never reachable.
  // `node servers/<name>.js --http` still works for pointing another MCP client
  // at one by hand; nothing here depends on it.
  const businessServers = [
    { key: "SLACK_TOKEN", server: "slack" },
    { key: "NOTION_TOKEN", server: "notion" },
    { key: "JIRA_DOMAIN", server: "jira" },
    { key: "GITHUB_TOKEN", server: "memory" },
    { key: "SERVICENOW_INSTANCE", server: "servicenow" },
    { key: "SALESFORCE_INSTANCE_URL", server: "salesforce" }
  ]
  const activeBusiness = []
  for (const s of businessServers) {
    if (s.server === "memory") {
      // GitHub-backed memory only when explicitly chosen AND fully configured.
      // (MemPalace is wired separately below.) This prevents a stray or
      // partial GITHUB_TOKEN from declaring a broken memory server.
      if (env.REFUGIO_MEMORY !== "github" || !env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) continue
    } else if (!env[s.key]) {
      continue
    }
    ok(`${s.server} → chat window (stdio)`)
    activeBusiness.push(s.server)
  }

  // ── MemPalace (local memory) — stdio MCP server ────────────
  const mempalaceMcpBin = path.join(home, ".local", "bin", "mempalace-mcp")
  const useMemPalace = env.REFUGIO_MEMORY === "mempalace" && fs.existsSync(mempalaceMcpBin)
  if (useMemPalace) ok("memory (MemPalace, lean 2-tool wrapper) → chat window (stdio)")

  // ── WhatsApp (Hermeneia) — stdio MCP server ────────────────
  // A local checkout (installed by the installer, or the user's own — set
  // HERMENEIA_DIR in ~/.refugio.env). Needs both the Node bundle (dist/index.js)
  // and the platform Go bridge binary (dist/hermeneia-bridge*, fetched by the
  // installer — it's no longer committed to Hermeneia's repo). The chat window
  // spawns it directly; on an unlinked account it exposes the QR page (and
  // opens the browser itself).
  const hermeneiaJs = env.HERMENEIA_DIR ? path.join(env.HERMENEIA_DIR, "dist", "index.js") : null
  const hermeneiaDist = env.HERMENEIA_DIR ? path.join(env.HERMENEIA_DIR, "dist") : null
  const hermeneiaHasBridge = !!(hermeneiaDist && fs.existsSync(hermeneiaDist) &&
    fs.readdirSync(hermeneiaDist).some(f => f.startsWith("hermeneia-bridge")))
  const useHermeneia = !!(hermeneiaJs && fs.existsSync(hermeneiaJs) && hermeneiaHasBridge)
  if (useHermeneia) ok("whatsapp (Hermeneia) → chat window (stdio)")
  else if (env.HERMENEIA_DIR && hermeneiaJs && !fs.existsSync(hermeneiaJs))
    warn(`HERMENEIA_DIR is set but ${hermeneiaJs} is missing — WhatsApp disabled`)
  else if (env.HERMENEIA_DIR && !hermeneiaHasBridge)
    warn(`HERMENEIA_DIR is set but the Go bridge binary is missing from ${hermeneiaDist} — re-run the installer or build it (npm run build) — WhatsApp disabled`)

  // ── Email (Epistole) — remote MCP via mcp-remote ────────────
  // The user's own Cloudflare Worker; mcp-remote proxies stdio↔HTTP and reuses
  // the OAuth tokens cached in ~/.mcp-auth during install (it re-opens the
  // browser flow if they're missing/expired).
  const mcpRemoteJs = path.join(REFUGIO_DIR, "node_modules", "mcp-remote", "dist", "proxy.js")
  const useEpistole = !!env.EPISTOLE_URL && fs.existsSync(mcpRemoteJs)
  if (useEpistole) ok(`email (Epistole @ ${env.EPISTOLE_URL}) → chat window (mcp-remote)`)
  else if (env.EPISTOLE_URL) warn("EPISTOLE_URL is set but mcp-remote is not installed (run: npm install) — email disabled")

  // ── Apple Reminders / Things 3 — local JXA MCP servers (vendored) ──
  // Shipped as npm dependencies of REFUGIO; enabled by installer flags. They
  // drive the apps via osascript/JXA.
  const remindersJs = path.join(REFUGIO_DIR, "node_modules", "reminders-mcp", "dist", "index.js")
  const useReminders = env.REFUGIO_REMINDERS === "1" && fs.existsSync(remindersJs)
  if (useReminders) ok("reminders (Apple Reminders) → chat window (stdio)")

  const thingsJs = path.join(REFUGIO_DIR, "node_modules", "just-claude-things", "dist", "index.js")
  const useThings = env.REFUGIO_THINGS === "1" && fs.existsSync(thingsJs)
  if (useThings) ok("things (Things 3) → chat window (stdio)")

  // Apple Notes. In-repo rather than an npm dependency, so it ships with the
  // checkout and cannot be missing. No "is it installed?" check either —
  // unlike Things 3, Notes.app is part of macOS.
  const notesJs = path.join(REFUGIO_DIR, "servers", "notes.js")
  const useNotes = env.REFUGIO_NOTES === "1" && fs.existsSync(notesJs)
  if (useNotes) ok("notes (Apple Notes) → chat window (stdio)")

  // ── Declare the connectors ──────────────────────────────────
  // mcpo-config.json is the single declaration of which connectors exist; the
  // chat window reads it at startup (REFUGIO_MCPO_CONFIG, below) and spawns
  // every entry itself. The name is historical — the MCPO proxy that Open WebUI
  // needed read the same file — and stays because existing installs, the chat
  // server's default and its tests all know it by that name.
  //
  // Notes belongs in this list as much as anything else. It was missing, and a
  // machine whose only connector was Apple Notes never got a config written, so
  // the chat window started with no connectors and no reason given.
  const hasConnectors = activeBusiness.length > 0 || useMemPalace || useHermeneia || useEpistole ||
    useReminders || useThings || useNotes

  if (hasConnectors) {
    const mcpoConfig = { mcpServers: {} }

    // Personal connectors first — they're the primary use case.
    if (useHermeneia) {
      mcpoConfig.mcpServers["whatsapp"] = {
        command: nodeBin,
        args: [hermeneiaJs],
        env: {
          // Name shown in WhatsApp > Linked Devices for pairings made via REFUGIO
          HERMENEIA_DEVICE_NAME: "REFUGIO",
          // 5 tools instead of 18. Hermeneia's full surface is sized for a large
          // model, where finer tools mean more precise calls; a local 3B model
          // loses accuracy as the list grows, and most of the surface (account
          // management, narrow lookups, internal backfill) is not what anyone
          // asks a chat window for. Keeps the whole stack under the tool cap too.
          HERMENEIA_TOOL_PROFILE: "minimal"
        }
      }
    }
    if (useEpistole) {
      mcpoConfig.mcpServers["email"] = {
        command: nodeBin,
        args: [mcpRemoteJs, `${env.EPISTOLE_URL.replace(/\/+$/, "")}/mcp`]
      }
    }
    if (useReminders) {
      mcpoConfig.mcpServers["reminders"] = { command: nodeBin, args: [remindersJs] }
    }
    if (useThings) {
      mcpoConfig.mcpServers["things"] = { command: nodeBin, args: [thingsJs] }
    }
    if (useNotes) {
      mcpoConfig.mcpServers["notes"] = { command: nodeBin, args: [notesJs] }
    }

    for (const name of activeBusiness) {
      mcpoConfig.mcpServers[name] = {
        command: nodeBin,
        args: [path.join(REFUGIO_DIR, "servers", `${name}.js`)]
      }
    }

    // Memory: the chat window spawns our lean wrapper (servers/memory-lite.js),
    // which re-exposes just 2 MemPalace tools (search/save) so small models
    // aren't flooded with MemPalace's 33 tools.
    if (useMemPalace) {
      mcpoConfig.mcpServers["memory"] = {
        command: nodeBin,
        args: [path.join(REFUGIO_DIR, "servers", "memory-lite.js")]
      }
    }

    // STATE_DIR, not REFUGIO_DIR: this file is rewritten on every launch, and
    // a packaged install cannot write beside its own code.
    const mcpoConfigPath = path.join(STATE_DIR, "mcpo-config.json")

    // Never replace a working declaration with an empty one.
    //
    // Each connector is gated on files existing right now — Hermeneia needs its
    // Go bridge binary present, for instance. A rebuild that clears dist/, an
    // unmounted volume, a half-finished upgrade: any of these can flip a
    // connector off for one launch. Overwriting the config then loses the
    // declaration permanently, and the user sees "No connectors configured"
    // with no idea that a file they still have was simply not visible once.
    //
    // Writing nothing is strictly safer: the old config still points at the
    // same commands, and a connector that really is gone fails loudly at
    // connect time with a reason, which is the outcome we want anyway.
    const nextCount = Object.keys(mcpoConfig.mcpServers).length
    const prevCount = (() => {
      try {
        return Object.keys(JSON.parse(fs.readFileSync(mcpoConfigPath, "utf-8")).mcpServers || {}).length
      } catch { return 0 }
    })()

    if (nextCount === 0 && prevCount > 0) {
      warn(`No connectors detected this launch, but ${mcpoConfigPath} lists ${prevCount} — keeping it.`)
      warn(`Check ~/${PRODUCT.envFile} and that each connector's files are still present.`)
    } else {
      if (nextCount < prevCount) {
        warn(`Connector count dropped ${prevCount} → ${nextCount}; rewriting ${path.basename(mcpoConfigPath)}.`)
      }
      fs.writeFileSync(mcpoConfigPath, JSON.stringify(mcpoConfig, null, 2) + "\n")
    }

    const allServers = []
    if (useHermeneia) allServers.push("whatsapp")
    if (useEpistole) allServers.push("email")
    if (useReminders) allServers.push("reminders")
    if (useThings) allServers.push("things")
    if (useNotes) allServers.push("notes")
    allServers.push(...activeBusiness)
    if (useMemPalace) allServers.push("memory")
    ok(`Connectors → chat window (${allServers.join(", ")})`)
  }

  // ── Start the chat window ───────────────────────────────────
  // REFUGIO's only interface. Node-served, zero extra dependencies — no Python,
  // no PyTorch — and it is the one thing that spawns the connectors above.
  const CHAT_PORT = parseInt(env.REFUGIO_CHAT_PORT || String(PRODUCT.chatPort), 10)
  const chatEntry = path.join(REFUGIO_DIR, "chat", "server.js")
  let chatUrl = null
  if (!fs.existsSync(chatEntry)) {
    // In-repo, so this means a damaged or half-updated checkout — not a choice
    // anyone made. Say so rather than run a supervisor with nothing to open.
    fail(`${chatEntry} is missing — this install is incomplete.`)
  } else {
    // Something already on the port is almost always a chat server the user
    // started by hand. Starting a second one can only fail with EADDRINUSE,
    // and the supervisor would then restart it ten times in a row — a loud,
    // baffling loop whose actual cause is that REFUGIO is already working.
    // Adopt it instead.
    let portBusy = await probeHttp(`http://127.0.0.1:${CHAT_PORT}/api/chat/status`, 1500)

    // Unless it is THIS install's chat server left behind by a supervisor that
    // died without stopping it — killed outright, or out of memory. The menu-bar
    // app restarts a supervisor that dies, so this is no longer a rare case:
    // the new one adopted the orphan, owned nothing, and `refugio stop` then
    // stopped the supervisor and left the chat server serving, its memory held
    // and the app showing REFUGIO as running. Found on a real install.
    //
    // Only ours — the same chat/server.js, by path. A server someone started
    // from another checkout is still adopted, not killed.
    if (portBusy) {
      const orphan = ownChatServerOnPort(CHAT_PORT, chatEntry)
      if (orphan) {
        warn(`Replacing a chat server left behind by an earlier run (pid ${orphan})`)
        try { process.kill(orphan, "SIGTERM") } catch {}
        for (let i = 0; i < 20 && portBusy; i++) {
          await new Promise(r => setTimeout(r, 250))
          portBusy = await probeHttp(`http://127.0.0.1:${CHAT_PORT}/api/chat/status`, 500)
        }
        if (portBusy) { try { process.kill(orphan, "SIGKILL") } catch {} ; await new Promise(r => setTimeout(r, 500)); portBusy = false }
      }
    }
    if (portBusy) {
      chatUrl = `http://127.0.0.1:${CHAT_PORT}`
      ok(`REFUGIO chat already running → ${chatUrl} (not started again)`)
      warn(`Port ${CHAT_PORT} was already serving. If that's an old copy, stop it and relaunch.`)
    } else {
      // Keep the child's output. Discarding it (the supervisor's default) makes
      // a crash-looping chat server undebuggable — the exit code is all you get.
      let chatStdio = "ignore"
      try {
        const chatLog = fs.openSync(path.join(LOG_DIR, "chat.log"), "a")
        chatStdio = ["ignore", chatLog, chatLog]
      } catch {}
      supervisor.start("chat", nodeBin, ["--no-warnings", chatEntry, "--port", String(CHAT_PORT)], {
        env: {
          ...mergedEnv,
          REFUGIO_DATA_DIR: CHAT_DATA_DIR,
          // The child must not re-derive this. It would get the same answer
          // from the same marker, but a supervisor and its server disagreeing
          // about which product they are is the one failure this split cannot
          // tolerate, so it is stated rather than inferred twice.
          REFUGIO_EDITION: EDITION,
          // Same reasoning, one level further out: the setup screen writes
          // credentials through the chat server, and it must write into the
          // file this supervisor actually read.
          REFUGIO_ENV_FILE: ENV_FILE,
          // Told explicitly rather than left to the chat server's own default.
          // Its default resolves relative to its own location, which is the
          // install directory — the one place a packaged install must not
          // write, and the one place the supervisor has just moved away from.
          REFUGIO_MCPO_CONFIG: path.join(STATE_DIR, "mcpo-config.json"),
        },
        stdio: chatStdio
      })
      chatUrl = `http://127.0.0.1:${CHAT_PORT}`
      ok(`${PRODUCT.product} chat → ${chatUrl}`)
    }
  }

  // ── Open it ─────────────────────────────────────────────────
  // Only for a person at a terminal who ran `refugio` (or double-clicked the
  // .command file). `--no-browser` is how the launchd agent, `refugio bg` and
  // the menu-bar app say they are not that — the menu-bar app shows its own
  // native window instead. The TTY check covers what predates the flag: the
  // packaged login agent starts the supervisor bare, and a browser tab at every
  // login, and again on every KeepAlive restart, is not something anyone asked
  // for.
  //
  // Waits for the server to answer first, so the tab does not open on a
  // connection error and leave the person to guess that reloading would fix it.
  // Asks for the page itself, not /api/chat/status: the status route queries
  // Ollama and every connector, and on a first boot can outlast the probe's
  // two-second timeout while the server is perfectly able to serve the window.
  let opened = false
  if (chatUrl && !noBrowser && process.stdout.isTTY) {
    if (await waitForServer(`${chatUrl}/`, 30000)) {
      ok("Opening the chat window in your browser...")
      openBrowser(chatUrl)
      opened = true
    }
  }

  // Lead with the one thing the user actually needs: where to go, or why
  // there's nowhere to go.
  let access
  if (chatUrl) {
    access = `  ${C.bold}Open REFUGIO:${C.reset}  ${C.bold}${chatUrl}${C.reset}` + (opened
      ? `\n  ${C.dim}(a browser tab should have opened already — if not, use the link above)${C.reset}`
      : "")
  } else {
    access = `  ${C.yellow}No chat window${C.reset} — chat/server.js is missing from this install.
  Re-run the installer to repair it:

      ${C.bold}cd "${REFUGIO_DIR}" && node install-node.cjs${C.reset}`
  }

  console.log(`
${C.bold}============================================================
 🏔️  ${PRODUCT.product} is running — supervisor active
============================================================${C.reset}

${access}

  Processes are monitored and auto-restarted if they crash.
  To stop:  Ctrl+C, or ${C.bold}${PRODUCT.cli} stop${C.reset}
  Logs:     ~/${PRODUCT.logDir}/
`)

  // Keep the process alive — the supervisor event handlers will do the rest
  // This interval also serves as a heartbeat
  setInterval(() => {
    // Periodic health check (every 5 minutes) — log status
    const alive = []
    const dead = []
    for (const [name, entry] of supervisor.children) {
      if (entry.proc && !entry.proc.killed && entry.proc.exitCode === null) {
        alive.push(name)
      } else {
        dead.push(name)
      }
    }
    if (dead.length > 0) {
      console.log(`  [${ts()}] Health: ${alive.length} running, ${dead.length} restarting (${dead.join(", ")})`)
    }
  }, 300000) // every 5 minutes
}

main().catch(err => {
  console.error(`\n  \x1b[31m✗\x1b[0m ${err.message}`)
  process.exit(1)
})
