#!/usr/bin/env node
// Cross-platform "available RAM" detection + runtime model fitting.
//
// At INSTALL time we size the model to TOTAL RAM (it decides what to download).
// But the real constraint is how much RAM is FREE *after* the user's apps are
// loaded — an 8 GB Mac running a browser + chat apps may have ~0 GB free. So at
// LAUNCH we re-pick the largest model that fits right now, downshifting toward
// the smallest. This keeps REFUGIO from OOM-thrashing on a busy machine, with no
// troubleshooting required from the user.

const { execSync } = require("child_process")
const fs = require("fs")
const os = require("os")

const GB = 1024 ** 3

// Ordered smallest → largest. ramGb = approx resident RAM when the model is
// loaded under Ollama (Q4_K_M weights + a modest KV cache). Tags mirror
// install-node.cjs pickModelForRam().
const MODEL_LADDER = [
  { tag: "llama3.2:1b", ramGb: 1.5 },
  { tag: "llama3.2:3b", ramGb: 3.0 },
  { tag: "llama3.1:8b", ramGb: 5.8 },
  { tag: "qwen2.5:14b", ramGb: 9.5 },
  { tag: "gpt-oss:20b", ramGb: 13.5 },
]

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

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

// Pick the largest model that fits the RAM available right now.
//   availableGb    - reclaimable RAM measured at launch
//   owuiOverheadGb - RAM Open WebUI itself holds (less when embeddings offloaded)
//   ceilingTag     - never exceed this (what was downloaded / the total-RAM pick)
//   safetyGb       - headroom kept free during inference
// Returns { tag, fits, downshiftedFrom }. `fits=false` means even the smallest
// model is tight (it's still returned, as the floor, but expect pressure).
function pickRuntimeModel({ availableGb, owuiOverheadGb = 1.0, ceilingTag = null, safetyGb = 1.5 }) {
  let ceilingIdx = MODEL_LADDER.length - 1
  if (ceilingTag) {
    const i = MODEL_LADDER.findIndex(m => m.tag === ceilingTag)
    if (i >= 0) ceilingIdx = i
  }
  const budget = availableGb - owuiOverheadGb - safetyGb
  let bestIdx = -1
  for (let i = 0; i <= ceilingIdx; i++) {
    if (MODEL_LADDER[i].ramGb <= budget) bestIdx = i
  }
  const floor = MODEL_LADDER[0].tag
  if (bestIdx < 0) {
    return { tag: floor, fits: false, downshiftedFrom: ceilingTag && ceilingTag !== floor ? ceilingTag : null }
  }
  const tag = MODEL_LADDER[bestIdx].tag
  return { tag, fits: true, downshiftedFrom: ceilingTag && tag !== ceilingTag ? ceilingTag : null }
}

// Index of a tag in the ladder (-1 if custom/unknown).
function ladderIndex(tag) {
  return MODEL_LADDER.findIndex(m => m.tag === tag)
}

module.exports = { MODEL_LADDER, availableMemGb, pickRuntimeModel, ladderIndex }

// CLI for debugging: `node scripts/mem-fit.cjs [ceilingModel]`
if (require.main === module) {
  const total = os.totalmem() / GB
  const avail = availableMemGb()
  const ceiling = process.argv[2] || null
  console.log(`total=${total.toFixed(1)}GB  available=${avail.toFixed(1)}GB  free(os)=${(os.freemem() / GB).toFixed(2)}GB`)
  console.log("pick:", pickRuntimeModel({ availableGb: avail, owuiOverheadGb: total <= 8 ? 0.7 : 1.5, ceilingTag: ceiling }))
}
