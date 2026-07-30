#!/usr/bin/env node
// REFUGIO Process Supervisor — launches and monitors the local LLM, MCP servers, Open WebUI, and Caddy
// Usage: node start-refugio.cjs [--no-browser] [--no-owui]
//
// Stays running as a supervisor. If a child process crashes, it is auto-restarted
// with exponential backoff. launchd/systemd monitors THIS process and restarts it
// if it dies.

const { execSync, spawn } = require("child_process")
const fs = require("fs")
const path = require("path")
const os = require("os")
const http = require("http")

const isWin = os.platform() === "win32"
const home = os.homedir()
const REFUGIO_DIR = path.resolve(__dirname)

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
    execSync(isWin ? `where ${cmd}` : `which ${cmd}`, { stdio: "ignore" })
    return true
  } catch { return false }
}

// ── Load credentials ────────────────────────────────────────

function loadEnv() {
  const env = {}
  const envFile = path.join(home, ".refugio.env")
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

// ── Open browser ────────────────────────────────────────────

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

// ── Find Open WebUI static dir ──────────────────────────────

function findOwuiStaticDir() {
  const envLib = path.join(REFUGIO_DIR, "app", "env", "lib")
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

// ── Apply branding ──────────────────────────────────────────

function applyBranding() {
  const staticDir = findOwuiStaticDir()
  if (!staticDir) return
  const brandDir = path.join(REFUGIO_DIR, "branding")
  if (!fs.existsSync(brandDir)) return

  const pkgDir = path.join(staticDir, "..")  // open_webui package root
  const frontendStaticDir = path.join(pkgDir, "frontend", "static")
  const frontendDir = path.join(pkgDir, "frontend")

  const assets = [
    ["favicon.png", "favicon.png"],
    ["favicon.png", "favicon-dark.png"],
    ["favicon.png", "apple-touch-icon.png"],
    ["favicon.ico", "favicon.ico"],
    ["favicon.svg", "favicon.svg"],
    ["favicon-96x96.png", "favicon-96x96.png"],
    ["logo.png", "logo.png"],
    ["splash.png", "splash.png"],
    ["splash-dark.png", "splash-dark.png"],
    ["user.png", "user.png"],
    ["web-app-manifest-192x192.png", "web-app-manifest-192x192.png"],
    ["web-app-manifest-512x512.png", "web-app-manifest-512x512.png"],
  ]

  // Replace in BOTH source (frontend/static/) and destination (static/)
  // OWUI's config.py copies frontend/static/ → static/ on startup,
  // so replacing the source ensures branding survives restarts.
  let count = 0
  for (const [src, dst] of assets) {
    const srcPath = path.join(brandDir, src)
    if (!fs.existsSync(srcPath)) continue
    for (const targetDir of [frontendStaticDir, staticDir]) {
      const dstPath = path.join(targetDir, dst)
      try { fs.copyFileSync(srcPath, dstPath); count++ } catch {}
    }
  }
  // Also replace frontend/favicon.png and frontend/user.png (alternate source)
  for (const f of ["favicon.png", "user.png"]) {
    const srcPath = path.join(brandDir, f)
    const dstPath = path.join(frontendDir, f)
    if (fs.existsSync(srcPath)) {
      try { fs.copyFileSync(srcPath, dstPath); count++ } catch {}
    }
  }
  if (count > 0) ok(`Applied REFUGIO branding (${count} assets to source + runtime)`)

  // Patch "Open WebUI" text in HTML/manifest files (both source and runtime copies)
  const textPatches = [
    [path.join(frontendDir, "index.html"), /<title>Open WebUI<\/title>/, "<title>REFUGIO</title>"],
    [path.join(frontendDir, "opensearch.xml"), /<ShortName>Open WebUI<\/ShortName>/, "<ShortName>REFUGIO</ShortName>"],
    [path.join(frontendDir, "opensearch.xml"), /<Description>Search Open WebUI<\/Description>/, "<Description>Search REFUGIO</Description>"],
    [path.join(staticDir, "site.webmanifest"), /"name":\s*"Open WebUI"/, '"name": "REFUGIO"'],
    [path.join(staticDir, "site.webmanifest"), /"short_name":\s*"WebUI"/, '"short_name": "REFUGIO"'],
    [path.join(frontendStaticDir, "site.webmanifest"), /"name":\s*"Open WebUI"/, '"name": "REFUGIO"'],
    [path.join(frontendStaticDir, "site.webmanifest"), /"short_name":\s*"WebUI"/, '"short_name": "REFUGIO"'],
  ]

  for (const [filePath, pattern, replacement] of textPatches) {
    try {
      if (!fs.existsSync(filePath)) continue
      const content = fs.readFileSync(filePath, "utf-8")
      const patched = content.replace(pattern, replacement)
      if (patched !== content) fs.writeFileSync(filePath, patched)
    } catch {}
  }

  // Remove OWUI's forced " (Open WebUI)" suffix on custom WEBUI_NAME
  // env.py: if WEBUI_NAME != 'Open WebUI': WEBUI_NAME += ' (Open WebUI)'
  const envPy = path.join(pkgDir, "env.py")
  try {
    if (fs.existsSync(envPy)) {
      const content = fs.readFileSync(envPy, "utf-8")
      const patched = content.replace(
        /if WEBUI_NAME != 'Open WebUI':\n\s+WEBUI_NAME \+= ' \(Open WebUI\)'/,
        "# REFUGIO: removed forced (Open WebUI) suffix\n# if WEBUI_NAME != 'Open WebUI':\n#     WEBUI_NAME += ' (Open WebUI)'"
      )
      if (patched !== content) {
        fs.writeFileSync(envPy, patched)
      }
      // Always clear .pyc cache so Python loads the patched env.py
      const pycacheDir = path.join(pkgDir, "__pycache__")
      if (fs.existsSync(pycacheDir)) {
        try {
          for (const f of fs.readdirSync(pycacheDir)) {
            if (f.startsWith("env.") && f.endsWith(".pyc")) {
              fs.unlinkSync(path.join(pycacheDir, f))
            }
          }
        } catch {}
      }
    }
  } catch {}
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
          if (isWin) {
            // Windows: taskkill the process tree
            try { execSync(`taskkill /PID ${entry.proc.pid} /T /F`, { stdio: "ignore" }) } catch {}
          } else {
            entry.proc.kill("SIGTERM")
          }
          ok(`Stopped ${name}`)
        } catch {}
      }
    }

    // Also stop Caddy
    try {
      const cb = ["/opt/homebrew/bin/caddy", "/usr/local/bin/caddy", "/usr/bin/caddy"]
        .find(p => fs.existsSync(p)) || "caddy"
      execSync(`"${cb}" stop`, { stdio: "ignore" })
    } catch {}

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

/**
 * Put https://refugio in front of a port, if the certificate and Caddy exist.
 *
 * Extracted because this used to live INSIDE the Open WebUI branch — and on a
 * v2 install Open WebUI is not installed, so that branch never runs and the
 * supervisor never started Caddy at all. https://refugio then worked only for
 * as long as the instance the INSTALLER started happened to survive: a reboot,
 * a `caddy stop`, a crash, and it was gone with no way back, because
 * `refugio restart` was not what had started it.
 *
 * Returns whether the domain is now serving, so callers can say so honestly
 * rather than printing a URL that may not resolve.
 */
function startCaddy(port) {
  if (isWin) return false
  const certFile = path.join(REFUGIO_DIR, "certs", "refugio.pem")
  const keyFile = path.join(REFUGIO_DIR, "certs", "refugio-key.pem")
  const caddyFile = path.join(REFUGIO_DIR, "Caddyfile")
  // launchd's PATH does not include /opt/homebrew/bin, so look in the places
  // Caddy actually installs to before trusting the name alone.
  const caddyBin = ["/opt/homebrew/bin/caddy", "/usr/local/bin/caddy", "/usr/bin/caddy"]
    .find(p => fs.existsSync(p)) || (has("caddy") ? "caddy" : null)
  if (!fs.existsSync(certFile) || !caddyBin) return false

  // Rewritten every start: the port can change between runs (8090 for the chat
  // window, 8080 for Open WebUI), and a stale Caddyfile proxies to whatever
  // was serving last time.
  fs.writeFileSync(caddyFile, `https://refugio {\n    tls ${certFile} ${keyFile}\n    reverse_proxy localhost:${port}\n}\n`)
  try {
    try { execSync(`"${caddyBin}" stop`, { stdio: "ignore" }) } catch {}
    execSync(`"${caddyBin}" start --config "${caddyFile}"`, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const noBrowser = args.has("--no-browser")

  // Open WebUI is opt-IN now, not opt-out.
  //
  // It used to be the only interface, so starting it whenever it was installed
  // was right. It no longer is: the built-in chat UI is the default surface and
  // owns the connectors, which leaves OWUI running with no tools while holding
  // 0.6-1.5 GB. Paying that on every launch for a window the user has stopped
  // opening is the opposite of what someone installs a local AI for.
  //
  // Still one command away for anyone who prefers it — and REFUGIO_CHAT=0 gives
  // it the connectors back, which is what makes it genuinely usable rather than
  // merely present.
  //
  // Resolved against ~/.refugio.env further down, where loadEnv() has run; only
  // the flags can be read this early.
  const owuiFlag = (args.has("--owui") || args.has("--open-webui")) ? true
    : args.has("--no-owui") ? false
    : null

  // ── Prevent duplicate supervisors ──────────────────────────
  const pidFile = path.join(home, ".refugio-logs", "supervisor.pid")
  try {
    fs.mkdirSync(path.join(home, ".refugio-logs"), { recursive: true })
  } catch {}

  if (fs.existsSync(pidFile)) {
    const oldPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim())
    if (oldPid) {
      try {
        process.kill(oldPid, 0)  // check if process exists (throws if not)
        // Process exists — is it actually a supervisor? (cross-platform check)
        let looksLikeSupervisor = false
        try {
          const cmdCheck = isWin
            ? execSync(`tasklist /FI "PID eq ${oldPid}" /FO CSV /NH`, { encoding: "utf-8" }).trim()
            : execSync(`ps -p ${oldPid} -o args=`, { encoding: "utf-8" }).trim()
          looksLikeSupervisor = isWin ? /node/i.test(cmdCheck) : cmdCheck.includes("start-refugio")
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

  // Now that ~/.refugio.env is loaded, settle the Open WebUI question:
  // explicit flag wins, else REFUGIO_OWUI=1 opts in, else it stays off.
  const noOwui = owuiFlag === null ? env.REFUGIO_OWUI !== "1" : !owuiFlag
  if (Object.keys(env).length === 0) {
    fail("No credentials found at ~/.refugio.env")
    fail("Run the installer first: curl -fsSL https://raw.githubusercontent.com/Phantazein-apps/refugio/main/install-refugio | bash")
    process.exit(1)
  }

  const supervisor = new Supervisor()

  // Handle shutdown signals
  process.on("SIGTERM", () => supervisor.shutdown())
  process.on("SIGINT", () => supervisor.shutdown())
  if (isWin) {
    process.on("SIGHUP", () => supervisor.shutdown())
  }

  const mergedEnv = { ...process.env, ...env }

  // ── Memory snapshot (shared by model selection + OWUI sizing) ──
  // Measure RAM that's actually FREE now so BOTH the model choice and the
  // RAG-embedding offload react to the same real constraint. Using total RAM for
  // one and available for the other would let PyTorch load on a busy high-RAM
  // machine and OOM the model.
  let memFit = null
  try { memFit = require(path.join(REFUGIO_DIR, "scripts", "mem-fit.cjs")) } catch {}
  const totalGb = os.totalmem() / (1024 ** 3)
  const availableGb = memFit ? memFit.availableMemGb() : totalGb
  // Offload OWUI's RAG embeddings to Ollama (skip the ~1-1.5 GB PyTorch load at
  // boot) when memory is tight — a small machine OR a big one that's busy now.
  // owuiOverhead below MUST match this so model fit and the offload agree.
  const offloadEmbeddings = totalGb <= 8 || availableGb < 6
  const owuiOverhead = offloadEmbeddings ? 0.7 : 1.5

  // ── Ensure the local LLM (Ollama) is serving ────────────────
  // For local-model setups, keep `ollama serve` alive under the supervisor so
  // the model is available after a reboot. Skip if something already owns :11434
  // (the macOS app / Windows service / Linux systemd unit).
  const wantsOllama = env.REFUGIO_ENGINE === "ollama" ||
    (env.OLLAMA_BASE_URL && /(localhost|127\.0\.0\.1):11434/.test(env.OLLAMA_BASE_URL))
  if (wantsOllama) {
    const ollamaUp = await probeHttp("http://127.0.0.1:11434/api/tags")
    if (ollamaUp) {
      ok("Ollama already running → http://localhost:11434")
    } else {
      // Prefer the macOS app's Ollama binary; fall back to PATH.
      const appOllama = "/Applications/Ollama.app/Contents/Resources/ollama"
      let ollamaBin = fs.existsSync(appOllama) ? appOllama : (has("ollama") ? "ollama" : null)
      if (!ollamaBin && isWin) {
        // Ollama may be installed but not on this session's PATH on Windows.
        for (const c of [path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe"), "C:\\Program Files\\Ollama\\ollama.exe"]) {
          try { if (c && fs.existsSync(c)) { ollamaBin = c; break } } catch {}
        }
      }
      if (ollamaBin) {
        // On Apple Silicon, force the arm64 slice so Ollama uses the GPU (Metal).
        // A universal binary spawned from an x86_64/Rosetta node would otherwise
        // run CPU-only — unusably slow.
        let appleSilicon = false
        try { appleSilicon = execSync("sysctl -n hw.optional.arm64", { encoding: "utf-8" }).trim() === "1" } catch {}
        const cmd = (!isWin && appleSilicon) ? "arch" : ollamaBin
        const cargs = (!isWin && appleSilicon) ? ["-arm64", ollamaBin, "serve"] : ["serve"]
        // On small machines, unload the model soon after idle so it doesn't hold
        // ~1-3 GB of RAM hostage between messages (keeps the whole Mac responsive).
        // Tight memory (small machine OR busy right now) → unload the model fast
        // so it doesn't hold RAM hostage. Same available-RAM signal as model fit.
        const keepAlive = offloadEmbeddings ? "30s" : "5m"
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
      const pick = memFit.pickInstalledModel({ availableGb, owuiOverheadGb: owuiOverhead, installedTags: installed })
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

  // ── Start MCP servers ───────────────────────────────────────
  const servers = [
    { key: "SLACK_TOKEN", server: "slack", port: 3001 },
    { key: "NOTION_TOKEN", server: "notion", port: 3002 },
    { key: "JIRA_DOMAIN", server: "jira", port: 3003 },
    { key: "GITHUB_TOKEN", server: "memory", port: 3004 },
    { key: "SERVICENOW_INSTANCE", server: "servicenow", port: 3005 },
    { key: "SALESFORCE_INSTANCE_URL", server: "salesforce", port: 3007 }
  ]

  // Track which servers are active for MCPO config
  const activeMcpServers = []
  const nodeBin = process.execPath  // full path to node, safe for launchd

  for (const s of servers) {
    if (s.server === "memory") {
      // GitHub-backed memory only when explicitly chosen AND fully configured.
      // (MemPalace is wired separately via MCPO below.) This prevents a stray or
      // partial GITHUB_TOKEN from starting a broken memory server.
      if (env.REFUGIO_MEMORY !== "github" || !env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) continue
    } else if (!env[s.key]) {
      continue
    }
    supervisor.start(`${s.server}-mcp`, nodeBin, [`servers/${s.server}.js`, "--http"], {
      env: { ...mergedEnv, MCP_SSE_PORT: String(s.port) }
    })
    ok(`${s.server} MCP server → http://localhost:${s.port}/mcp`)
    activeMcpServers.push(s)
  }

  // ── MemPalace (local memory) — stdio MCP server proxied via MCPO ──
  const mempalaceMcpBin = isWin
    ? path.join(home, ".local", "bin", "mempalace-mcp.exe")
    : path.join(home, ".local", "bin", "mempalace-mcp")
  const useMemPalace = env.REFUGIO_MEMORY === "mempalace" && fs.existsSync(mempalaceMcpBin)
  if (useMemPalace) ok("memory (MemPalace, lean 2-tool wrapper) → via MCPO (stdio)")

  // ── WhatsApp (Hermeneia) — stdio MCP server proxied via MCPO ──
  // A local checkout (installed by the installer, or the user's own — set
  // HERMENEIA_DIR in ~/.refugio.env). Needs both the Node bundle (dist/index.js)
  // and the platform Go bridge binary (dist/hermeneia-bridge*, fetched by the
  // installer — it's no longer committed to Hermeneia's repo). MCPO spawns it
  // directly; on an unlinked account it exposes the QR page (and, on a desktop,
  // opens the browser itself).
  const hermeneiaJs = env.HERMENEIA_DIR ? path.join(env.HERMENEIA_DIR, "dist", "index.js") : null
  const hermeneiaDist = env.HERMENEIA_DIR ? path.join(env.HERMENEIA_DIR, "dist") : null
  const hermeneiaHasBridge = !!(hermeneiaDist && fs.existsSync(hermeneiaDist) &&
    fs.readdirSync(hermeneiaDist).some(f => f.startsWith("hermeneia-bridge")))
  const useHermeneia = !!(hermeneiaJs && fs.existsSync(hermeneiaJs) && hermeneiaHasBridge)
  if (useHermeneia) ok("whatsapp (Hermeneia) → via MCPO (stdio)")
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
  if (useEpistole) ok(`email (Epistole @ ${env.EPISTOLE_URL}) → via MCPO (mcp-remote)`)
  else if (env.EPISTOLE_URL) warn("EPISTOLE_URL is set but mcp-remote is not installed (run: npm install) — email disabled")

  // ── Apple Reminders / Things 3 — local JXA MCP servers (vendored) ──
  // Shipped as npm dependencies of REFUGIO; enabled by installer flags.
  // macOS only (they drive the apps via osascript/JXA).
  const remindersJs = path.join(REFUGIO_DIR, "node_modules", "reminders-mcp", "dist", "index.js")
  const useReminders = os.platform() === "darwin" && env.REFUGIO_REMINDERS === "1" && fs.existsSync(remindersJs)
  if (useReminders) ok("reminders (Apple Reminders) → via MCPO (stdio)")

  const thingsJs = path.join(REFUGIO_DIR, "node_modules", "just-claude-things", "dist", "index.js")
  const useThings = os.platform() === "darwin" && env.REFUGIO_THINGS === "1" && fs.existsSync(thingsJs)
  if (useThings) ok("things (Things 3) → via MCPO (stdio)")

  // Apple Notes. In-repo rather than an npm dependency, so it ships with the
  // checkout and cannot be missing. No "is it installed?" check either —
  // unlike Things 3, Notes.app is part of macOS.
  const notesJs = path.join(REFUGIO_DIR, "servers", "notes.js")
  const useNotes = os.platform() === "darwin" && env.REFUGIO_NOTES === "1" && fs.existsSync(notesJs)
  if (useNotes) ok("notes (Apple Notes) → via MCPO (stdio)")

  // ── Generate MCPO config and start proxy ────────────────────
  const MCPO_PORT = 8010
  const mcpoBin = isWin
    ? path.join(home, ".local", "bin", "mcpo.exe")
    : path.join(home, ".local", "bin", "mcpo")
  const hasMcpoServers = activeMcpServers.length > 0 || useMemPalace || useHermeneia || useEpistole ||
    useReminders || useThings

  // Exactly ONE surface may own the stdio MCP servers.
  //
  // MCPO spawns every server in mcpo-config.json to translate MCP → OpenAPI for
  // Open WebUI. The built-in chat UI speaks MCP directly and spawns them too.
  // Run both and each connector exists twice — harmless for a stateless one like
  // Things, fatal for Hermeneia, which is deliberately single-instance: two
  // processes would fight over one WhatsApp session, so the second detects the
  // first via a PID file and exits. Cleanly, with status 0 and no error — so the
  // symptom is simply that WhatsApp is missing from the chat UI's tools while
  // the stateless connectors work, with nothing anywhere explaining it.
  //
  // The chat UI is the default surface, so it wins by default. MCPO exists only
  // for Open WebUI; set REFUGIO_CHAT=0 to use OWUI instead and hand the
  // connectors back to it.
  const chatOwnsConnectors = env.REFUGIO_CHAT !== "0" &&
    fs.existsSync(path.join(REFUGIO_DIR, "chat", "server.js"))

  // Note the condition is `hasMcpoServers` alone, not "…&& mcpo is installed".
  // mcpo-config.json is the single declaration of which connectors exist, and
  // the built-in chat UI reads it too. Gating the file's existence on MCPO's
  // binary meant a machine without `uv` got a chat UI with no connectors at
  // all — the same silent-skip failure that hid Open WebUI's absence.
  if (hasMcpoServers) {
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

    for (const s of activeMcpServers) {
      mcpoConfig.mcpServers[s.server] = {
        type: "streamable-http",
        url: `http://127.0.0.1:${s.port}/mcp`
      }
    }

    // Memory: MCPO spawns our lean wrapper (servers/memory-lite.js), which
    // re-exposes just 2 MemPalace tools (search/save) so small models aren't
    // flooded with MemPalace's 33 tools.
    if (useMemPalace) {
      mcpoConfig.mcpServers["memory"] = {
        command: nodeBin,
        args: [path.join(REFUGIO_DIR, "servers", "memory-lite.js")]
      }
    }

    const mcpoConfigPath = path.join(REFUGIO_DIR, "mcpo-config.json")

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
      warn(`Check ~/.refugio.env and that each connector's files are still present.`)
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
    allServers.push(...activeMcpServers.map(s => s.server))
    if (useMemPalace) allServers.push("memory")

    // The config file is still written either way — the chat UI reads the same
    // file to know which connectors exist. Only the spawning is exclusive.
    if (chatOwnsConnectors) {
      ok(`Connectors → built-in chat UI (${allServers.join(", ")})`)
      console.log(`    ${C.dim}MCPO not started — it would spawn a second copy of every ` +
        `connector. Set REFUGIO_CHAT=0 to give them to Open WebUI instead.${C.reset}`)
    } else if (fs.existsSync(mcpoBin)) {
      // Wait briefly for MCP servers to be ready before starting MCPO
      setTimeout(() => {
        supervisor.start("mcpo", mcpoBin, [
          "--port", String(MCPO_PORT),
          "--config", mcpoConfigPath,
          "--host", "127.0.0.1"
        ], { env: mergedEnv })
        ok(`MCPO proxy → http://localhost:${MCPO_PORT} (${allServers.join(", ")})`)
      }, 3000)
    } else {
      warn("MCPO not installed — tools may not work in Open WebUI")
      warn("Install with: uv tool install mcpo")
    }
  }

  // ── Start the built-in chat UI ──────────────────────────────
  // Node-served, zero extra dependencies — no uv, no Python venv, no PyTorch.
  // Runs alongside Open WebUI for now; the banner points here first, and OWUI
  // stays available for anyone who wants its heavier feature set.
  // Disable with REFUGIO_CHAT=0.
  const CHAT_PORT = parseInt(env.REFUGIO_CHAT_PORT || "8090", 10)
  const chatEntry = path.join(REFUGIO_DIR, "chat", "server.js")
  let chatUrl = null
  if (env.REFUGIO_CHAT !== "0" && fs.existsSync(chatEntry)) {
    // Something already on the port is almost always a chat server the user
    // started by hand. Starting a second one can only fail with EADDRINUSE,
    // and the supervisor would then restart it ten times in a row — a loud,
    // baffling loop whose actual cause is that REFUGIO is already working.
    // Adopt it instead.
    const portBusy = await probeHttp(`http://127.0.0.1:${CHAT_PORT}/api/chat/status`, 1500)
    if (portBusy) {
      chatUrl = `http://127.0.0.1:${CHAT_PORT}`
      ok(`REFUGIO chat already running → ${chatUrl} (not started again)`)
      warn(`Port ${CHAT_PORT} was already serving. If that's an old copy, stop it and relaunch.`)
    } else {
      // Keep the child's output. Discarding it (the supervisor's default) makes
      // a crash-looping chat server undebuggable — the exit code is all you get.
      let chatStdio = "ignore"
      try {
        const chatLog = fs.openSync(path.join(home, ".refugio-logs", "chat.log"), "a")
        chatStdio = ["ignore", chatLog, chatLog]
      } catch {}
      supervisor.start("chat", nodeBin, ["--no-warnings", chatEntry, "--port", String(CHAT_PORT)], {
        env: { ...mergedEnv, REFUGIO_DATA_DIR: path.join(REFUGIO_DIR, "data") },
        stdio: chatStdio
      })
      chatUrl = `http://127.0.0.1:${CHAT_PORT}`
      ok(`REFUGIO chat → ${chatUrl}`)
    }
  }

  // ── Start Open WebUI ────────────────────────────────────────
  const PORT = 8080
  const owuiBin = isWin
    ? path.join(REFUGIO_DIR, "app", "env", "Scripts", "open-webui.exe")
    : path.join(REFUGIO_DIR, "app", "env", "bin", "open-webui")

  // Tracked out here so the closing banner can always tell the user where to
  // go (or why there's nowhere to go yet). Open WebUI IS the REFUGIO UI —
  // without it the supervisor runs headless and there is nothing to open.
  let uiUrl = null
  let uiState = "missing"   // "ready" | "starting" | "missing" | "skipped"

  if (!noOwui && fs.existsSync(owuiBin)) {
    // Apply branding BEFORE starting OWUI — replace source files in frontend/static/
    // so OWUI's own config.py copies our branded assets into static/ on startup
    applyBranding()

    // Persist OWUI data (account, chats, settings) OUTSIDE the venv so it
    // survives reinstalls/updates — the venv is wiped (--clear) on every re-run.
    const dataDir = path.join(REFUGIO_DIR, "data")
    try { fs.mkdirSync(dataDir, { recursive: true }) } catch {}
    const lowRam = offloadEmbeddings   // tied to AVAILABLE RAM (see memory snapshot above)
    const owuiEnv = {
      ...process.env,
      WEBUI_NAME: "REFUGIO",
      DATA_DIR: dataDir,
      CHAT_RESPONSE_MAX_TOOL_CALL_RETRIES: "2",
      ENABLE_VERSION_UPDATE_CHECK: "false",
      // On low-RAM machines, offload RAG embeddings to Ollama so Open WebUI does
      // NOT load PyTorch + a sentence-transformers model (~1-1.5 GB) at startup.
      // That fixed cost is what OOM-loops OWUI's first boot on 8 GB.
      ...(lowRam ? { RAG_EMBEDDING_ENGINE: "ollama" } : {})
    }
    if (env.OPENAI_API_BASE_URL) {
      owuiEnv.ENABLE_OPENAI_API = "true"
      owuiEnv.OPENAI_API_BASE_URLS = env.OPENAI_API_BASE_URL
      owuiEnv.OPENAI_API_KEYS = env.OPENAI_API_KEY || "none"
    } else {
      owuiEnv.ENABLE_OPENAI_API = "false"
    }
    if (env.OLLAMA_BASE_URL) {
      owuiEnv.ENABLE_OLLAMA_API = "true"
      owuiEnv.OLLAMA_BASE_URL = env.OLLAMA_BASE_URL
    } else {
      owuiEnv.ENABLE_OLLAMA_API = "false"
    }

    // Log OWUI output to a file so first-boot / init problems are visible
    // (the supervisor otherwise discards child output).
    let owuiStdio = "ignore"
    try {
      const owuiLog = fs.openSync(path.join(home, ".refugio-logs", "open-webui.log"), "a")
      owuiStdio = ["ignore", owuiLog, owuiLog]
    } catch {}
    supervisor.start("open-webui", owuiBin, ["serve", "--port", String(PORT), "--host", "127.0.0.1"], {
      env: owuiEnv, stdio: owuiStdio
    })
    ok("Starting Open WebUI...")

    // ── Start Caddy ─────────────────────────────────────────────
    let refugioUrl = isWin ? `http://127.0.0.1:${PORT}` : `http://refugio.localhost:${PORT}`
    if (startCaddy(PORT)) {
      ok("https://refugio → localhost:" + PORT)
      refugioUrl = "https://refugio"
    }

    // ── Wait for Open WebUI ─────────────────────────────────────
    const waitStart = Date.now()
    process.stdout.write("  Waiting for Open WebUI... (0s) ")
    const timer = setInterval(() => {
      const elapsed = Math.round((Date.now() - waitStart) / 1000)
      process.stdout.write(`\r  Waiting for Open WebUI... (${elapsed}s) `)
    }, 1000)
    const ready = await waitForServer(`http://127.0.0.1:${PORT}/api/config`, 300000)
    clearInterval(timer)

    if (ready) {
      const elapsed = Math.round((Date.now() - waitStart) / 1000)
      process.stdout.write(`\r  Waiting for Open WebUI... done (${elapsed}s)\n`)
      ok(`Open WebUI → ${refugioUrl}`)
      uiUrl = refugioUrl
      uiState = "ready"

      // Wait for MCPO to be ready before configuring tool servers
      if (hasMcpoServers) {
        const mcpoReady = await waitForServer(`http://127.0.0.1:${MCPO_PORT}/openapi.json`, 30000)
        if (mcpoReady) ok("MCPO proxy ready")
        else warn("MCPO not ready — tool registration may fail")
      }

      // Configure OWUI: account, system prompt, tool servers, models
      let token = null
      try {
        const output = execSync(`"${nodeBin}" scripts/configure-owui.cjs --port ${PORT}`, {
          cwd: REFUGIO_DIR, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
          timeout: 30000, env: { ...mergedEnv, REFUGIO_RUNTIME_MODEL: runtimeModel }
        }).trim()
        for (const line of output.split("\n")) {
          if (line.startsWith("__TOKEN__=")) {
            token = line.replace("__TOKEN__=", "")
          } else if (line.trim()) {
            console.log(line)
          }
        }
      } catch (e) {
        warn(`Configure failed: ${e.message}`)
        if (e.stderr) warn(e.stderr.toString().trim().slice(0, 200))
      }

      if (!noBrowser) {
        if (token) {
          const staticDir = findOwuiStaticDir()
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
      }
    } else {
      process.stdout.write(" timed out\n")
      warn("Open WebUI is still starting (first boot downloads an embedding model)")
      warn("Open " + refugioUrl + " manually once it's up")
      warn(`If login/tools aren't set up, run: node scripts/configure-owui.cjs --port ${PORT}`)
      uiUrl = refugioUrl
      uiState = "starting"
    }
  } else if (chatUrl) {
    // The built-in chat covers the "somewhere to talk to it" case, so a missing
    // Open WebUI is no longer a dead end — just a missing advanced option.
    uiUrl = chatUrl
    uiState = "ready"
    console.log(`    ${C.dim}Open WebUI not installed — using the built-in chat (that's fine).${C.reset}`)
  } else if (!noOwui) {
    // Open WebUI IS the REFUGIO interface — without it there is no chat window,
    // no browser to open, and https://refugio has nothing behind it. Say so
    // plainly and give the exact command, instead of a vague "run the installer".
    uiState = "missing"
    warn("Open WebUI is NOT installed — REFUGIO has no chat interface yet.")
    console.log(`    ${C.dim}Open WebUI is the REFUGIO window. Until it's installed, the supervisor`)
    console.log(`    runs headless: nothing opens in your browser and https://refugio won't load.`)
    console.log(`    Install it with:${C.reset}  ${C.bold}cd "${REFUGIO_DIR}" && node install-node.cjs${C.reset}`)
    console.log(`    ${C.dim}(It needs 'uv' — if the installer skipped Open WebUI, that's usually why.)${C.reset}`)
  } else {
    uiState = "skipped"
  }

  // ── https://refugio, on whichever surface is actually serving ──
  //
  // The Open WebUI branch above starts Caddy for itself. This is the other
  // path — the default one — where OWUI is not installed at all, so nothing
  // had started it. The port is read back off whichever URL won rather than
  // assumed, so the domain follows the surface instead of a constant.
  if (uiUrl && !uiUrl.startsWith("https://refugio")) {
    const m = /:(\d+)/.exec(uiUrl)
    if (m && startCaddy(parseInt(m[1], 10))) {
      ok(`https://refugio → localhost:${m[1]}`)
      uiUrl = "https://refugio"
    }
  }

  // Lead with the one thing the user actually needs: where to go, or why
  // there's nowhere to go yet.
  let access
  if (uiState === "ready") {
    access = `  ${C.bold}Open REFUGIO:${C.reset}  ${C.bold}${uiUrl}${C.reset}
  ${C.dim}(a browser tab should have opened already — if not, use the link above)${C.reset}`
  } else if (uiState === "starting") {
    access = `  ${C.bold}Open REFUGIO:${C.reset}  ${C.bold}${uiUrl}${C.reset}  ${C.yellow}(still booting — give it a minute)${C.reset}`
  } else if (uiState === "skipped") {
    access = `  ${C.dim}Open WebUI was skipped (--no-owui). Tools are up; there's no chat UI.${C.reset}`
  } else {
    access = `  ${C.yellow}No chat interface yet${C.reset} — Open WebUI isn't installed, so there is
  nothing to open in a browser. Install it with:

      ${C.bold}cd "${REFUGIO_DIR}" && node install-node.cjs${C.reset}

  ${C.dim}Your connectors (WhatsApp, etc.) are already wired and will appear
  automatically once Open WebUI is installed.${C.reset}`
  }

  console.log(`
${C.bold}============================================================
 🏔️  REFUGIO is running — supervisor active
============================================================${C.reset}

${access}

  Processes are monitored and auto-restarted if they crash.
  To stop:  Ctrl+C, or ${C.bold}refugio stop${C.reset}
  Logs:     ~/.refugio-logs/
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
