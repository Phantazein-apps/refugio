#!/usr/bin/env node
// Provision an Ollama model — resilient to Cloudflare R2 being unreachable.
//
// Ollama serves model *weights* from Cloudflare R2 (172.64.x). Some networks
// (corporate firewalls, certain ISPs/VPNs) can't reach that range, so
// `ollama pull` hangs/fails even though the rest of the internet works. When the
// registry is unreachable, this imports the equivalent GGUF from HuggingFace (a
// different CDN) and registers it with `ollama create`.
//
// Usage: node pull-model.cjs <model>     (or set REFUGIO_MODEL)

const { execSync } = require("child_process")
const https = require("https")
const http = require("http")
const fs = require("fs")
const os = require("os")
const path = require("path")

const isWin = os.platform() === "win32"
const OLLAMA = "http://127.0.0.1:11434"

const C = process.stdout.isTTY
  ? { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", x: "\x1b[0m" }
  : { g: "", y: "", r: "", x: "" }
const ok = m => console.log(`  ${C.g}✓${C.x} ${m}`)
const warn = m => console.log(`  ${C.y}!${C.x} ${m}`)
const fail = m => console.log(`  ${C.r}✗${C.x} ${m}`)

// HuggingFace GGUF source per Ollama tag (verified). Q4_K_M unless noted.
const HF = {
  "llama3.2:1b": ["bartowski/Llama-3.2-1B-Instruct-GGUF", "Llama-3.2-1B-Instruct-Q4_K_M.gguf"],
  "llama3.2:3b": ["bartowski/Llama-3.2-3B-Instruct-GGUF", "Llama-3.2-3B-Instruct-Q4_K_M.gguf"],
  "llama3.1:8b": ["bartowski/Meta-Llama-3.1-8B-Instruct-GGUF", "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf"],
  "qwen2.5:14b": ["bartowski/Qwen2.5-14B-Instruct-GGUF", "Qwen2.5-14B-Instruct-Q4_K_M.gguf"],
  "gpt-oss:20b": ["ggml-org/gpt-oss-20b-GGUF", "gpt-oss-20b-mxfp4.gguf"],
}

function has(cmd) {
  try { execSync(isWin ? `where ${cmd}` : `which ${cmd}`, { stdio: "ignore" }); return true } catch { return false }
}
function ollamaBin() {
  const app = "/Applications/Ollama.app/Contents/Resources/ollama"
  if (!isWin && fs.existsSync(app)) return app
  return has("ollama") ? "ollama" : null
}
function run(cmd) { execSync(cmd, { stdio: "inherit", shell: true }) }

function probe(url, ms = 6000) {
  return new Promise(resolve => {
    const lib = url.startsWith("https") ? https : http
    let done = false
    const finish = v => { if (!done) { done = true; resolve(v) } }
    const req = lib.get(url, r => { r.resume(); finish(true) })
    req.on("error", () => finish(false))
    req.setTimeout(ms, () => { req.destroy(); finish(false) })
  })
}
function apiGet(p) {
  return new Promise(resolve => {
    http.get(OLLAMA + p, r => { let b = ""; r.on("data", c => b += c); r.on("end", () => { try { resolve(JSON.parse(b)) } catch { resolve({}) } }) })
      .on("error", () => resolve({}))
  })
}
async function hasModel(m) {
  const t = await apiGet("/api/tags")
  return (t.models || []).some(x => x.name === m || x.model === m)
}

function hfImport(model) {
  const src = HF[model]
  if (!src) throw new Error(`no HuggingFace fallback for "${model}" — try a different model or fix Cloudflare R2 access`)
  const [repo, file] = src
  const url = `https://huggingface.co/${repo}/resolve/main/${file}`
  const bin = ollamaBin()
  if (!bin) throw new Error("ollama binary not found")
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refugio-gguf-"))
  const gguf = path.join(tmp, "model.gguf")
  try {
    ok(`Downloading ${model} from HuggingFace (bypassing Cloudflare R2)...`)
    run(`curl -L --fail --retry 3 -o "${gguf}" "${url}"`)
    fs.writeFileSync(path.join(tmp, "Modelfile"), `FROM ${gguf}\n`)
    ok(`Importing into Ollama as ${model}...`)
    run(`"${bin}" create ${model} -f "${path.join(tmp, "Modelfile")}"`)
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

async function main() {
  const model = process.argv[2] || process.env.REFUGIO_MODEL
  if (!model) { fail("usage: pull-model.cjs <model>  (or set REFUGIO_MODEL)"); process.exit(1) }

  if (!(await probe(`${OLLAMA}/api/tags`, 3000))) {
    fail("Ollama isn't running on http://localhost:11434 — start it first")
    process.exit(1)
  }
  if (await hasModel(model)) { ok(`Model already present: ${model}`); return }

  const bin = ollamaBin()
  // Cloudflare R2 serves Ollama's model weights — probe whether it's reachable.
  const r2 = await probe("https://r2.cloudflarestorage.com/", 6000)

  if (r2 && bin) {
    try {
      ok(`Downloading ${model} from the Ollama registry...`)
      run(`"${bin}" pull ${model}`)
      if (await hasModel(model)) { ok(`Model ready: ${model}`); return }
      warn("Registry pull finished but the model isn't present — trying HuggingFace...")
    } catch (e) {
      warn(`Registry pull failed (${e.message || e}) — trying HuggingFace...`)
    }
  } else if (!r2) {
    warn("Ollama's model CDN (Cloudflare R2) is unreachable on this network — using HuggingFace instead")
  }

  try {
    hfImport(model)
    if (await hasModel(model)) { ok(`Model ready: ${model} (via HuggingFace)`); return }
    fail(`Import finished but ${model} isn't present`); process.exit(1)
  } catch (e) {
    fail(`Could not provision ${model}: ${e.message || e}`)
    warn(`Manual options: "ollama pull ${model}", or check network access to Cloudflare R2 / huggingface.co`)
    process.exit(1)
  }
}

main().catch(e => { fail(e.message || String(e)); process.exit(1) })
