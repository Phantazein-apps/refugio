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

const CONNECTORS = [
  {
    id: "account", name: "Your Account",
    fields: [
      { key: "OWUI_NAME", prompt: "Your display name" },
      { key: "OWUI_EMAIL", prompt: "Your email address" },
      { key: "OWUI_PASSWORD", prompt: "Set a password", secret: true, defaultVal: "changeme" }
    ]
  },
  {
    id: "slack", name: "Slack",
    help: "https://api.slack.com/apps → OAuth & Permissions → User Token Scopes: search:read, channels:history, channels:read, users:read",
    fields: [
      { key: "SLACK_TOKEN", prompt: "Slack user token (xoxp-...)", secret: true }
    ]
  },
  {
    id: "notion", name: "Notion",
    help: "https://www.notion.so/profile/integrations → New integration → Copy Internal Integration Secret",
    fields: [
      { key: "NOTION_TOKEN", prompt: "Notion integration token (ntn_...)", secret: true }
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

async function promptGithubFields(env, existing) {
  console.log(`    ${C.dim}https://github.com/settings/tokens?type=beta → Fine-grained PAT → Permissions: Contents → Read and write${C.reset}`)
  for (const field of GITHUB_FIELDS) {
    const current = existing[field.key] || field.defaultVal || ""
    const display = field.secret && current ? `****${current.slice(-4)}` : current
    const value = await ask(field.prompt, display, field.secret)
    if (value && !value.startsWith("****")) env[field.key] = value
    else if (current) env[field.key] = current
  }
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
 optional workplace connectors (Slack, Notion, Jira, and more).

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
    { header: "Slack", keys: ["SLACK_TOKEN"] },
    { header: "Notion", keys: ["NOTION_TOKEN"] },
    { header: "Jira", keys: ["JIRA_DOMAIN", "JIRA_EMAIL", "JIRA_API_TOKEN"] },
    { header: "ServiceNow", keys: ["SERVICENOW_INSTANCE", "SERVICENOW_USERNAME", "SERVICENOW_PASSWORD"] },
    { header: "Salesforce", keys: ["SALESFORCE_INSTANCE_URL", "SALESFORCE_USERNAME", "SALESFORCE_PASSWORD", "SALESFORCE_SECURITY_TOKEN"] },
    { header: "Memory", keys: ["REFUGIO_MEMORY", "GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO", "GITHUB_MEMORY_PATH"] }
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

async function promptCredentials(envPath) {
  console.log(`${C.bold}Configure connectors...${C.reset}\n`)

  const existing = readEnvFile(envPath)
  const env = { ...existing }

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

  for (const conn of CONNECTORS) {
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
        continue
      }
    } else {
      const shouldConfigure = await confirm(`Configure ${conn.name}?`, conn.id === "account")
      if (!shouldConfigure) {
        console.log("")
        continue
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
        env.REFUGIO_MEMORY = "github"
        await promptGithubFields(env, existing)
        ok("Using GitHub-backed memory (PACK-style)")
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
        env.REFUGIO_MEMORY = "github"
        await promptGithubFields(env, existing)
        ok("Using GitHub-backed memory (lightweight)")
      } else {
        env.REFUGIO_MEMORY = ""
        ok("No persistent memory (model only)")
      }
    }
  } else {
    env.REFUGIO_MEMORY = ""
  }
  console.log("")

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
      ? `"${path.join(envDir, "Scripts", "activate")}"`
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

  // Provision the model via the resilient puller: it tries the Ollama registry,
  // and if that's unreachable (e.g. Cloudflare R2 blocked) it imports the GGUF
  // from HuggingFace instead — so the install still completes on locked-down nets.
  const model = env.REFUGIO_MODEL || pickModelForRam()
  const pullScript = path.join(targetDir, "scripts", "pull-model.cjs")
  try {
    run(`"${process.execPath}" "${pullScript}" ${model}`, { env: { ...process.env, REFUGIO_MODEL: model } })
  } catch (err) {
    warn(`Model provisioning failed: ${err.message}`)
    warn(`Retry later: node ${pullScript} ${model}`)
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

async function startREFUGIO(targetDir, env) {
  console.log(`${C.bold}Starting REFUGIO...${C.reset}\n`)

  const PORT = 8080

  // The supervisor (start-refugio.cjs) is already running via launchd/systemd
  // (setupAutoStart runs before this function)
  ok("REFUGIO supervisor started via auto-start service")

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

function setupAutoStart(targetDir) {
  const nodePath = process.execPath
  const startScript = path.join(targetDir, "start-refugio.cjs")

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
ExecStart=${nodePath} ${startScript} --no-browser
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
    env = await promptCredentials(envPath)
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

  // Set up auto-start on login (starts the supervisor via launchd/systemd)
  // Must happen BEFORE startREFUGIO so we don't spawn a duplicate supervisor
  if (!flags.has("--no-start") && !flags.has("--non-interactive")) {
    setupAutoStart(targetDir)
  }

  // Wait for OWUI to be ready and open browser
  if (!flags.has("--no-start") && !flags.has("--non-interactive")) {
    await startREFUGIO(targetDir, env)
  }

  console.log(`${C.bold}============================================================`)
  console.log(` 🏔️  REFUGIO is ready!`)
  console.log(`============================================================${C.reset}`)
  console.log("")
  console.log(`  Installation:  ${targetDir}`)
  console.log(`  Credentials:   ${envPath}`)
  console.log("")
  console.log(`  To start REFUGIO manually:`)
  console.log(`    node ${path.join(targetDir, "start-refugio.cjs")}`)
  console.log("")
  console.log(`  REFUGIO will auto-start on login.`)
  console.log("")
}

main().catch(err => {
  console.error(`\n  \x1b[31m✗\x1b[0m ${err.message}`)
  process.exit(1)
})
