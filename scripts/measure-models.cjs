#!/usr/bin/env node
// Measure what a model actually occupies under Ollama, instead of guessing.
//
// Why this exists. Every `ramGb` REFUGIO ships was, until 2026-09-16, a number
// somebody wrote down. The three catalog estimates were measured that day and
// all three were high; so was llama3.1:8b, the one built-in figure anybody
// re-checked. docs/gaps.md §12 records the rest of the built-in ladder as
// unmeasured. This runs the same measurement over it by hand — no model
// harness, no tokens — so the ladder can be corrected from numbers.
//
// What is measured, per model, with nothing else loaded:
//   size       `ollama ps` SIZE (from /api/ps). This is the figure `ramGb` means.
//   gpu        size_vram / size. Anything under 100% ran partly on CPU and is
//              not a clean figure — it depends on this machine's wired limit.
//   context    the context the runner was started with. REFUGIO sends Ollama no
//              options, so this is Ollama's default, and it is the context the
//              figure is true at.
//   runnerRss  resident memory of the runner process — `llama-server` on
//              current Ollama, `ollama runner` on older ones. Not `ollama
//              serve`, which holds almost nothing.
//   wired      the change in macOS wired memory across the load (Metal
//              allocations are wired).
//   avail      scripts/mem-fit.cjs availableMemGb() before and after — the
//              number REFUGIO itself decides with.
//
// Why a plain prompt rather than a tool-calling turn through REFUGIO. Ollama
// reserves the whole context when the runner starts. Checked 2026-09-17 on
// qwen2.5:3b: SIZE was 2155169709 bytes after a 70-token reply and still
// 2155169709 after 450 more, with runner RSS flat at 1.94 GiB. What fills
// memory is the load, not the conversation, so a turn that calls a connector
// costs model time and measures nothing extra.
//
// Safe by default: it measures only models already installed, downloads
// nothing unless asked, and deletes nothing unless asked — and even then only a
// model this run downloaded itself.
//
// Usage:
//   node scripts/measure-models.cjs                         # the built-in ladder, installed ones
//   node scripts/measure-models.cjs --pull                  # download ladder models that are missing
//   node scripts/measure-models.cjs --pull --remove-pulled  # ...and delete them again afterwards
//   node scripts/measure-models.cjs --only qwen2.5:3b,llama3.1:8b
//   node scripts/measure-models.cjs --json out.json         # also write the raw figures

const { execSync, spawnSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const memFit = require("./mem-fit.cjs")

const OLLAMA = process.env.OLLAMA_HOST_URL || "http://127.0.0.1:11434"
const GB = 1e9
const GIB = 1024 ** 3
const PROMPT = "Write three short sentences about rivers."

// ── Pure helpers (exported for tests) ───────────────────────

/** Pages wired down, from `vm_stat` output, in bytes. null if unparseable. */
function wiredBytes(vmStatText) {
  const page = /page size of (\d+) bytes/.exec(vmStatText || "")
  const wired = /Pages wired down:\s+(\d+)\./.exec(vmStatText || "")
  if (!page || !wired) return null
  return parseInt(wired[1], 10) * parseInt(page[1], 10)
}

/**
 * Runner processes from `ps -axo pid,ppid,rss,command` output. A runner is the
 * process that holds the weights: `llama-server` on Ollama 0.34+, `ollama
 * runner` before that. `ollama serve` is the scheduler and is deliberately NOT
 * a runner — counting it is how a first attempt at this measured almost nothing.
 */
function runnerProcesses(psText) {
  const out = []
  for (const line of String(psText || "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const command = m[4]
    const isRunner = /(^|\/)llama-server(\s|$)/.test(command) || /(^|\/)ollama\s+runner(\s|$)/.test(command)
    if (!isRunner) continue
    out.push({ pid: +m[1], ppid: +m[2], rssBytes: +m[3] * 1024, command })
  }
  return out
}

/** Share of the loaded model on the GPU, 0-100, or null when unknown. */
function gpuPercent(size, sizeVram) {
  if (!(size > 0) || typeof sizeVram !== "number") return null
  return Math.round((sizeVram / size) * 100)
}

/**
 * Decide what to do with each requested tag, before anything is touched.
 *   measure  - installed, or will be downloaded first
 *   pull     - missing and --pull was given
 *   skip     - missing and --pull was not given
 */
function plan({ tags, installed, pull }) {
  const have = new Set(installed)
  return tags.map((tag) => {
    if (have.has(tag)) return { tag, action: "measure", pull: false }
    return pull ? { tag, action: "measure", pull: true } : { tag, action: "skip", pull: false, why: "not installed (pass --pull to download it)" }
  })
}

/**
 * May this run delete `tag` afterwards? Only when asked to AND only if this run
 * downloaded it. A model that was installed before the run is the owner's, and
 * no flag makes it this script's to delete.
 */
function mayRemove({ tag, pulledThisRun, removePulled, installedBefore }) {
  return !!removePulled && pulledThisRun.has(tag) && !installedBefore.includes(tag)
}

// ── Talking to Ollama and the machine ───────────────────────

async function api(path, body) {
  const res = await fetch(OLLAMA + path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* reported below */ }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${json?.error || text.slice(0, 200)}`)
  return json
}

const sh = (cmd) => { try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() } catch { return "" } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const gb = (b) => (b == null ? "—" : (b / GB).toFixed(1))
const gib = (b) => (b == null ? "—" : (b / GIB).toFixed(2))

async function loaded() { return ((await api("/api/ps"))?.models || []) }

async function unloadAll() {
  for (const m of await loaded()) await api("/api/generate", { model: m.name, keep_alive: 0 })
  for (let i = 0; i < 30; i++) { if ((await loaded()).length === 0) return; await sleep(500) }
  throw new Error("a model is still loaded after asking Ollama to unload everything")
}

function machine() {
  return {
    date: new Date().toISOString().slice(0, 10),
    host: os.hostname(),
    chip: sh("sysctl -n machdep.cpu.brand_string") || os.cpus()[0]?.model || null,
    totalGb: +(os.totalmem() / GIB).toFixed(1),
    os: process.platform === "darwin" ? `macOS ${sh("sw_vers -productVersion")} (${sh("sw_vers -buildVersion")})` : `${os.type()} ${os.release()}`,
    wiredLimitMb: process.platform === "darwin" ? sh("sysctl -n iogpu.wired_limit_mb") || null : null,
    freeDisk: sh(`df -h "${os.homedir()}" | tail -1 | awk '{print $4}'`) || null,
  }
}

async function measureOne(tag) {
  await unloadAll()
  const vmBefore = wiredBytes(sh("vm_stat"))
  const availBefore = memFit.availableMemGb()
  // No `options`: REFUGIO sends none, so the runner gets Ollama's default
  // context — which is the context the shipped figure has to be true at.
  const gen = await api("/api/generate", { model: tag, prompt: PROMPT, stream: false, keep_alive: "5m" })
  const entry = (await loaded()).find((m) => m.name === tag || m.model === tag)
  if (!entry) throw new Error("generated, but the model is not in /api/ps")
  const runners = runnerProcesses(sh("ps -axo pid,ppid,rss,command"))
  const vmAfter = wiredBytes(sh("vm_stat"))
  const result = {
    tag,
    shippedGb: memFit.modelRamGb(tag) || null,
    sizeBytes: entry.size,
    sizeVramBytes: entry.size_vram,
    gpuPercent: gpuPercent(entry.size, entry.size_vram),
    context: entry.context_length ?? null,
    runnerRssBytes: runners.length ? runners.reduce((s, r) => s + r.rssBytes, 0) : null,
    runners: runners.length,
    wiredDeltaBytes: vmBefore != null && vmAfter != null ? vmAfter - vmBefore : null,
    availBeforeGb: +availBefore.toFixed(2),
    availAfterGb: +memFit.availableMemGb().toFixed(2),
    generatedTokens: gen?.eval_count ?? null,
  }
  await unloadAll()
  return result
}

function table(rows) {
  const lines = [
    "| tag | shipped | `ollama ps` SIZE | GPU | context | runner RSS | wired Δ | available before → after |",
    "|---|---|---|---|---|---|---|---|",
  ]
  for (const r of rows) {
    if (r.error || r.skipped) {
      lines.push(`| \`${r.tag}\` | ${r.shippedGb ?? "—"} | ${r.skipped ? "skipped" : "failed"}: ${r.skipped || r.error} | | | | | |`)
      continue
    }
    const gpu = r.gpuPercent == null ? "—" : r.gpuPercent === 100 ? "100%" : `**${r.gpuPercent}%**`
    lines.push(`| \`${r.tag}\` | ${r.shippedGb ?? "—"} | **${gb(r.sizeBytes)} GB** | ${gpu} | ${r.context ?? "—"} | ${gib(r.runnerRssBytes)} GiB | ${gib(r.wiredDeltaBytes)} GiB | ${r.availBeforeGb} → ${r.availAfterGb} GB |`)
  }
  return lines.join("\n")
}

function parseArgs(argv) {
  const a = { pull: false, removePulled: false, only: null, json: null }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === "--pull") a.pull = true
    else if (k === "--remove-pulled") a.removePulled = true
    else if (k === "--only") a.only = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean)
    else if (k === "--json") a.json = argv[++i]
    else throw new Error(`unknown argument: ${k}`)
  }
  return a
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = (await api("/api/version").catch(() => null))?.version
  if (!version) throw new Error(`Ollama is not answering at ${OLLAMA}. Start it (or REFUGIO) first.`)
  const installedBefore = ((await api("/api/tags"))?.models || []).map((m) => m.name)
  const tags = args.only || memFit.MODEL_LADDER.map((m) => m.tag)
  const m = { ...machine(), ollama: version }

  console.log(`\n${m.chip} · ${m.totalGb} GB · ${m.os} · Ollama ${m.ollama}`)
  console.log(`wired limit ${m.wiredLimitMb === "0" ? "default (0)" : m.wiredLimitMb ?? "n/a"} · free disk ${m.freeDisk ?? "?"}\n`)

  const pulledThisRun = new Set()
  const rows = []
  for (const step of plan({ tags, installed: installedBefore, pull: args.pull })) {
    const shippedGb = memFit.modelRamGb(step.tag) || null
    if (step.action === "skip") { console.log(`  skip     ${step.tag} — ${step.why}`); rows.push({ tag: step.tag, shippedGb, skipped: step.why }); continue }
    try {
      if (step.pull) {
        console.log(`  pull     ${step.tag}`)
        const p = spawnSync("ollama", ["pull", step.tag], { stdio: "inherit" })
        if (p.status !== 0) throw new Error(`ollama pull exited ${p.status}`)
        pulledThisRun.add(step.tag)
      }
      console.log(`  measure  ${step.tag}`)
      const r = await measureOne(step.tag)
      rows.push(r)
      console.log(`           ${gb(r.sizeBytes)} GB · ${r.gpuPercent}% GPU · ctx ${r.context} · runner ${gib(r.runnerRssBytes)} GiB`)
    } catch (err) {
      console.log(`  FAILED   ${step.tag} — ${err.message}`)
      rows.push({ tag: step.tag, shippedGb, error: err.message })
    }
    if (mayRemove({ tag: step.tag, pulledThisRun, removePulled: args.removePulled, installedBefore })) {
      console.log(`  remove   ${step.tag} (downloaded by this run)`)
      spawnSync("ollama", ["rm", step.tag], { stdio: "inherit" })
    }
  }

  console.log(`\n### RAM measured ${m.date} — ${m.chip}, ${m.totalGb} GB, ${m.os}, Ollama ${m.ollama}\n`)
  console.log(table(rows))
  console.log("\nSIZE is what `ramGb` means. A GPU share under 100% is not a clean figure: it depends on this machine's wired limit.")
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({ machine: m, prompt: PROMPT, results: rows }, null, 2) + "\n")
    console.log(`\nRaw figures written to ${args.json}`)
  }
  return rows.some((r) => r.error) ? 1 : 0
}

module.exports = { wiredBytes, runnerProcesses, gpuPercent, plan, mayRemove, table, parseArgs }

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => { console.error(`\n${err.message}`); process.exit(1) })
}
