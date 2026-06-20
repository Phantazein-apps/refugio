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

async function main() {
  const args = new Set(process.argv.slice(2))
  const noBrowser = args.has("--no-browser")
  const noOwui = args.has("--no-owui")

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

  // ── Ensure the local LLM (Ollama) is serving ────────────────
  // For local-model setups, keep `ollama serve` alive under the supervisor so
  // the model is available after a reboot. Skip if something already owns :11434
  // (the macOS app / Windows service / Linux systemd unit).
  const wantsOllama = env.REFUGIO_ENGINE === "ollama" ||
    (env.OLLAMA_BASE_URL && /(localhost|127\.0\.0\.1):11434/.test(env.OLLAMA_BASE_URL))
  if (wantsOllama && has("ollama")) {
    const ollamaUp = await probeHttp("http://127.0.0.1:11434/api/tags")
    if (!ollamaUp) {
      supervisor.start("ollama", "ollama", ["serve"], { env: mergedEnv })
      ok("Ollama server → http://localhost:11434")
    } else {
      ok("Ollama already running → http://localhost:11434")
    }
  }

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
    // When MemPalace is the chosen memory backend, don't also start the
    // GitHub-backed memory server (MemPalace is wired via MCPO below).
    if (s.server === "memory" && env.REFUGIO_MEMORY === "mempalace") continue
    if (env[s.key]) {
      supervisor.start(`${s.server}-mcp`, nodeBin, [`servers/${s.server}.js`, "--http"], {
        env: { ...mergedEnv, MCP_SSE_PORT: String(s.port) }
      })
      ok(`${s.server} MCP server → http://localhost:${s.port}/mcp`)
      activeMcpServers.push(s)
    }
  }

  // ── MemPalace (local memory) — stdio MCP server proxied via MCPO ──
  const mempalaceMcpBin = isWin
    ? path.join(home, ".local", "bin", "mempalace-mcp.exe")
    : path.join(home, ".local", "bin", "mempalace-mcp")
  const useMemPalace = env.REFUGIO_MEMORY === "mempalace" && fs.existsSync(mempalaceMcpBin)
  if (useMemPalace) ok("memory (MemPalace, local) → via MCPO (stdio)")

  // ── Generate MCPO config and start proxy ────────────────────
  const MCPO_PORT = 8010
  const mcpoBin = isWin
    ? path.join(home, ".local", "bin", "mcpo.exe")
    : path.join(home, ".local", "bin", "mcpo")
  const hasMcpoServers = activeMcpServers.length > 0 || useMemPalace

  if (hasMcpoServers && fs.existsSync(mcpoBin)) {
    const mcpoConfig = { mcpServers: {} }
    for (const s of activeMcpServers) {
      mcpoConfig.mcpServers[s.server] = {
        type: "streamable-http",
        url: `http://127.0.0.1:${s.port}/mcp`
      }
    }

    // MemPalace is a stdio MCP server — MCPO spawns and proxies it as "memory"
    if (useMemPalace) {
      mcpoConfig.mcpServers["memory"] = {
        command: mempalaceMcpBin,
        args: []
      }
    }

    const mcpoConfigPath = path.join(REFUGIO_DIR, "mcpo-config.json")
    fs.writeFileSync(mcpoConfigPath, JSON.stringify(mcpoConfig, null, 2) + "\n")

    const allServers = activeMcpServers.map(s => s.server)
    if (useMemPalace) allServers.push("memory")

    // Wait briefly for MCP servers to be ready before starting MCPO
    setTimeout(() => {
      supervisor.start("mcpo", mcpoBin, [
        "--port", String(MCPO_PORT),
        "--config", mcpoConfigPath,
        "--host", "127.0.0.1"
      ], { env: mergedEnv })
      ok(`MCPO proxy → http://localhost:${MCPO_PORT} (${allServers.join(", ")})`)
    }, 3000)
  } else if (hasMcpoServers) {
    warn("MCPO not installed — tools may not work in Open WebUI")
    warn("Install with: uv tool install mcpo")
  }

  // ── Start Open WebUI ────────────────────────────────────────
  const PORT = 8080
  const owuiBin = isWin
    ? path.join(REFUGIO_DIR, "app", "env", "Scripts", "open-webui")
    : path.join(REFUGIO_DIR, "app", "env", "bin", "open-webui")

  if (!noOwui && fs.existsSync(owuiBin)) {
    // Apply branding BEFORE starting OWUI — replace source files in frontend/static/
    // so OWUI's own config.py copies our branded assets into static/ on startup
    applyBranding()

    // Persist OWUI data (account, chats, settings) OUTSIDE the venv so it
    // survives reinstalls/updates — the venv is wiped (--clear) on every re-run.
    const dataDir = path.join(REFUGIO_DIR, "data")
    try { fs.mkdirSync(dataDir, { recursive: true }) } catch {}
    const owuiEnv = {
      ...process.env,
      WEBUI_NAME: "REFUGIO",
      DATA_DIR: dataDir,
      CHAT_RESPONSE_MAX_TOOL_CALL_RETRIES: "2",
      ENABLE_VERSION_UPDATE_CHECK: "false"
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
    let refugioUrl = `http://refugio.localhost:${PORT}`
    const certFile = path.join(REFUGIO_DIR, "certs", "refugio.pem")
    const keyFile = path.join(REFUGIO_DIR, "certs", "refugio-key.pem")
    const caddyFile = path.join(REFUGIO_DIR, "Caddyfile")

    // Find caddy binary — launchd PATH doesn't include /opt/homebrew/bin
    const caddyBin = ["/opt/homebrew/bin/caddy", "/usr/local/bin/caddy", "/usr/bin/caddy"]
      .find(p => fs.existsSync(p)) || (has("caddy") ? "caddy" : null)

    if (fs.existsSync(certFile) && caddyBin) {
      fs.writeFileSync(caddyFile, `https://refugio {\n    tls ${certFile} ${keyFile}\n    reverse_proxy localhost:${PORT}\n}\n`)
      try {
        try { execSync(`"${caddyBin}" stop`, { stdio: "ignore" }) } catch {}
        execSync(`"${caddyBin}" start --config "${caddyFile}"`, { stdio: "ignore" })
        ok("https://refugio → localhost:" + PORT)
        refugioUrl = "https://refugio"
      } catch {}
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
          timeout: 30000
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
    }
  } else if (!noOwui) {
    warn("Open WebUI not installed — run the installer to set it up")
  }

  console.log(`
${C.bold}============================================================
 🏔️  REFUGIO is running — supervisor active
============================================================${C.reset}

  Processes are monitored and auto-restarted if they crash.
  To stop:  Ctrl+C or kill this process
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
