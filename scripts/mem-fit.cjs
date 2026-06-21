#!/usr/bin/env node
// Cross-platform "available RAM" detection + runtime model fitting.
//
// At INSTALL time we download TWO models: the "optimal" one sized to TOTAL RAM,
// and a lighter "current" one (one tier down) for when the machine is busy. The
// real constraint at LAUNCH is how much RAM is FREE *after* the user's apps load
// — so each launch we activate the largest INSTALLED model that fits right now.
// No troubleshooting required from the user.

const { execSync } = require("child_process")
const fs = require("fs")
const os = require("os")

const GB = 1024 ** 3

// Ordered smallest → largest.
//   ramGb       - approx resident RAM when loaded under Ollama (Q4 + a modest KV cache)
//   nativeTools - whether the model can drive Open WebUI's native function-calling
//                 cleanly; small models over-fire tools, so they use prompt-based.
const MODEL_LADDER = [
  { tag: "qwen2.5:0.5b", ramGb: 0.8, nativeTools: false },
  { tag: "llama3.2:1b",  ramGb: 1.5, nativeTools: false },
  { tag: "llama3.2:3b",  ramGb: 3.0, nativeTools: false },
  { tag: "llama3.1:8b",  ramGb: 5.8, nativeTools: true },
  { tag: "qwen2.5:14b",  ramGb: 9.5, nativeTools: true },
  { tag: "gpt-oss:20b",  ramGb: 13.5, nativeTools: true },
]

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const ladderIndex = tag => MODEL_LADDER.findIndex(m => m.tag === tag)
const modelRamGb = tag => { const m = MODEL_LADDER.find(x => x.tag === tag); return m ? m.ramGb : 0 }
const supportsNativeTools = tag => { const m = MODEL_LADDER.find(x => x.tag === tag); return m ? m.nativeTools : false }

// Reclaimable ("available") memory in GB — NOT os.freemem(), which on macOS and
// Linux counts only truly-free pages and wildly under-reports what's usable.
function availableMemGb() {
  const totalGb = os.totalmem() / GB
  try {
    if (process.platform === "darwin") {
      const out = execSync("vm_stat", { encoding: "utf-8" })
      const pm = out.match(/page size of (\d+) bytes/)
      const page = pm ? parseInt(pm[1], 10) : 4096
      const get = label => {
        const m = out.match(new RegExp(label + ":\\s+(\\d+)\\."))
        return m ? parseInt(m[1], 10) : 0
      }
      // free + inactive + speculative + purgeable ≈ what the OS can hand out
      // without swapping (inactive/purgeable are reclaimable file/cache pages).
      const pages = get("Pages free") + get("Pages inactive") +
        get("Pages speculative") + get("Pages purgeable")
      const avail = (pages * page) / GB
      if (avail > 0) return clamp(avail, 0, totalGb)
    } else if (process.platform === "linux") {
      const mi = fs.readFileSync("/proc/meminfo", "utf-8")
      const m = mi.match(/MemAvailable:\s+(\d+)\s+kB/)
      if (m) return clamp((parseInt(m[1], 10) * 1024) / GB, 0, totalGb)
    } else if (process.platform === "win32") {
      // On Windows os.freemem() reports available physical memory already.
      return clamp(os.freemem() / GB, 0, totalGb)
    }
  } catch { /* fall through */ }
  // Conservative fallback (may under-pick): truly-free memory.
  return clamp(os.freemem() / GB, 0, totalGb)
}

// The "optimal" + "current" pair to DOWNLOAD at install: the model sized to total
// RAM, plus one tier lighter for busy conditions. Deduped (smaller machines may
// collapse to one). Returns { optimal, current } tags.
function installPair(optimalTag) {
  const i = ladderIndex(optimalTag)
  if (i < 0) return { optimal: optimalTag, current: null }
  const current = MODEL_LADDER[Math.max(0, i - 1)].tag
  return { optimal: optimalTag, current: current === optimalTag ? null : current }
}

// Pick the largest INSTALLED model that fits the RAM available right now.
//   availableGb    - reclaimable RAM measured at launch
//   owuiOverheadGb - RAM Open WebUI itself holds (less when embeddings offloaded)
//   installedTags  - model tags currently downloaded (from `ollama list`/api/tags)
//   safetyGb       - headroom kept free during inference
// Returns { tag, fits, heavier }. If NO installed tag is on the ladder (e.g. only
// custom models, or none installed) returns { tag: null, fits: false, heavier: null }
// — callers MUST handle a null tag. Otherwise `fits=false` means even the lightest
// installed model is tight (still returned, as the floor); `heavier` names a larger
// installed model that needs more free RAM (for the launch message).
function pickInstalledModel({ availableGb, owuiOverheadGb = 1.0, installedTags = [], safetyGb = 1.0 }) {
  const installed = MODEL_LADDER.filter(m => installedTags.includes(m.tag))  // ladder order
  if (installed.length === 0) return { tag: null, fits: false, heavier: null }
  const budget = availableGb - owuiOverheadGb - safetyGb
  let best = null
  for (const m of installed) { if (m.ramGb <= budget) best = m }  // last fitting = largest
  const largest = installed[installed.length - 1].tag
  if (!best) {
    const smallest = installed[0].tag
    return { tag: smallest, fits: false, heavier: largest !== smallest ? largest : null }
  }
  return { tag: best.tag, fits: true, heavier: best.tag !== largest ? largest : null }
}

// Legacy helper (ladder-based, allows on-demand pull). Kept for the CLI.
function pickRuntimeModel({ availableGb, owuiOverheadGb = 1.0, ceilingTag = null, safetyGb = 1.0 }) {
  let ceilingIdx = MODEL_LADDER.length - 1
  if (ceilingTag) { const i = ladderIndex(ceilingTag); if (i >= 0) ceilingIdx = i }
  const budget = availableGb - owuiOverheadGb - safetyGb
  let bestIdx = -1
  for (let i = 0; i <= ceilingIdx; i++) { if (MODEL_LADDER[i].ramGb <= budget) bestIdx = i }
  const floor = MODEL_LADDER[0].tag
  if (bestIdx < 0) return { tag: floor, fits: false, downshiftedFrom: ceilingTag && ceilingTag !== floor ? ceilingTag : null }
  const tag = MODEL_LADDER[bestIdx].tag
  return { tag, fits: true, downshiftedFrom: ceilingTag && tag !== ceilingTag ? ceilingTag : null }
}

module.exports = {
  MODEL_LADDER, availableMemGb, ladderIndex, modelRamGb, supportsNativeTools,
  installPair, pickInstalledModel, pickRuntimeModel,
}

// CLI for debugging: `node scripts/mem-fit.cjs [installedTag,installedTag,...]`
if (require.main === module) {
  const total = os.totalmem() / GB
  const avail = availableMemGb()
  const installed = (process.argv[2] || "").split(",").filter(Boolean)
  const off = total <= 8 || avail < 6
  console.log(`total=${total.toFixed(1)}GB  available=${avail.toFixed(1)}GB  free(os)=${(os.freemem() / GB).toFixed(2)}GB  offload=${off}`)
  if (installed.length) console.log("pickInstalled:", pickInstalledModel({ availableGb: avail, owuiOverheadGb: off ? 0.7 : 1.5, installedTags: installed }))
}
