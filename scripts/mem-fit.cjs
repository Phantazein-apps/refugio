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
//   tools       - can it call tools at all, reliably enough to be worth shipping?
//                 REFUGIO exists to let a local model read your own data through
//                 connectors. A model that answers "please paste your messages"
//                 is not a smaller REFUGIO; it is a worse version of the local
//                 chat apps we have no intention of replacing. This flag gates
//                 the product — see machineSupport() below.
//   nativeTools - narrower, and Open WebUI's problem specifically: can it drive
//                 OWUI's *native* function-calling, or does OWUI need its
//                 prompt-based mode? Independent of `tools`.
const MODEL_LADDER = [
  { tag: "qwen2.5:0.5b", ramGb: 0.8,  tools: false, nativeTools: false },
  { tag: "llama3.2:1b",  ramGb: 1.5,  tools: false, nativeTools: false },
  // 3B is the floor that works, observed directly rather than assumed: given the
  // same connectors and question, 0.5b ignored its tool list and asked the user
  // to paste the data in; 3b enumerated the list and called the right tool.
  { tag: "qwen2.5:3b",   ramGb: 2.6,  tools: true,  nativeTools: false },
  { tag: "llama3.2:3b",  ramGb: 3.0,  tools: true,  nativeTools: false },
  { tag: "llama3.1:8b",  ramGb: 5.8,  tools: true,  nativeTools: true },
  { tag: "qwen2.5:14b",  ramGb: 9.5,  tools: true,  nativeTools: true },
  { tag: "gpt-oss:20b",  ramGb: 13.5, tools: true,  nativeTools: true },
]

// Smallest model that can actually drive connectors. Below this line REFUGIO
// does not do its job, however well the model chats.
const TOOL_FLOOR = MODEL_LADDER.find(m => m.tools)

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const ladderIndex = tag => MODEL_LADDER.findIndex(m => m.tag === tag)
const modelRamGb = tag => { const m = MODEL_LADDER.find(x => x.tag === tag); return m ? m.ramGb : 0 }
const supportsNativeTools = tag => { const m = MODEL_LADDER.find(x => x.tag === tag); return m ? m.nativeTools : false }
// null (not false) for an off-ladder tag: a model we've never rated is unknown,
// not incapable, and callers must not warn as if they know it can't call tools.
const supportsTools = tag => { const m = MODEL_LADDER.find(x => x.tag === tag); return m ? m.tools : null }

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
//
// The lighter tier never drops below TOOL_FLOOR. Shipping a busy-machine fallback
// that can't call tools is how a user ends up, with no warning, in a REFUGIO whose
// connectors silently do nothing — which is exactly the failure this ladder is
// meant to prevent. Better to run the floor model tight than a useless one easily.
function installPair(optimalTag) {
  const i = ladderIndex(optimalTag)
  if (i < 0) return { optimal: optimalTag, current: null }
  const floor = ladderIndex(TOOL_FLOOR.tag)
  const lighter = MODEL_LADDER[Math.max(floor, i - 1)].tag
  return { optimal: optimalTag, current: lighter === optimalTag ? null : lighter }
}

/**
 * Can this machine run REFUGIO at all?
 *
 * REFUGIO is connectors — a local model reading your own data. That requires a
 * model that can call tools, and the smallest of those is TOOL_FLOOR. If the
 * floor doesn't fit, the honest answer is "not supported on this machine",
 * because the alternative is a chat window that quietly can't do the job.
 *
 *   totalGb  - installed RAM (the hardware ceiling — apps can't be closed to fix it)
 *   freeGb   - RAM free right now (a soft limit — closing apps CAN fix it)
 *   uiGb     - RAM the interface holds: ~0.05 for the built-in chat UI,
 *              ~0.7-1.5 for Open WebUI. Dropping OWUI is most of what makes the
 *              3B floor affordable on an 8 GB machine.
 *
 * Returns { supported, transient, needGb, freeGb, totalGb, floor }.
 *   supported=false, transient=false → the hardware can't do it. Say so.
 *   supported=false, transient=true  → it fits in RAM but not in free RAM today.
 *                                      Closing apps is a real fix; offer it.
 */
function machineSupport({ totalGb = os.totalmem() / GB, freeGb = null, uiGb = 0.05, safetyGb = 1.0 } = {}) {
  const free = freeGb == null ? availableMemGb() : freeGb
  const needGb = TOOL_FLOOR.ramGb + uiGb + safetyGb
  // The OS itself is not optional: ~2.5 GB wired on macOS, less elsewhere, and
  // it is already excluded from `free` but NOT from `totalGb`.
  const osGb = process.platform === "darwin" ? 2.5 : 1.5
  const hardwareOk = totalGb - osGb >= needGb
  return {
    supported: hardwareOk && free >= needGb,
    transient: hardwareOk && free < needGb,
    needGb: Math.round(needGb * 10) / 10,
    freeGb: Math.round(free * 10) / 10,
    totalGb: Math.round(totalGb * 10) / 10,
    floor: TOOL_FLOOR.tag,
  }
}

// Pick the largest INSTALLED model that fits the RAM available right now.
//   availableGb    - reclaimable RAM measured at launch
//   owuiOverheadGb - RAM Open WebUI itself holds (less when embeddings offloaded)
//   installedTags  - model tags currently downloaded (from `ollama list`/api/tags)
//   safetyGb       - headroom kept free during inference
// Returns { tag, fits, heavier, tools }. If NO installed tag is on the ladder (e.g.
// only custom models, or none installed) returns { tag: null, fits: false,
// heavier: null, tools: null } — callers MUST handle a null tag. Otherwise
// `fits=false` means even the lightest candidate is tight (still returned, as the
// floor); `heavier` names a larger installed model that needs more free RAM;
// `tools=false` means the activated model cannot drive connectors, and the caller
// MUST say so rather than start a REFUGIO that silently doesn't work.
//
// Tool-capable models are strongly preferred: a tight qwen2.5:3b that can call
// connectors is REFUGIO, and a comfortable qwen2.5:0.5b that can't is not. We
// downgrade below the floor only when nothing else is installed at all.
function pickInstalledModel({ availableGb, owuiOverheadGb = 1.0, installedTags = [], safetyGb = 1.0 }) {
  const installed = MODEL_LADDER.filter(m => installedTags.includes(m.tag))  // ladder order
  if (installed.length === 0) return { tag: null, fits: false, heavier: null, tools: null }

  const budget = availableGb - owuiOverheadGb - safetyGb
  const capable = installed.filter(m => m.tools)
  // Choose within the tool-capable set when one exists; the tool-blind models
  // are a last resort, never a convenience upgrade for a busy machine.
  const pool = capable.length ? capable : installed

  let best = null
  for (const m of pool) { if (m.ramGb <= budget) best = m }  // last fitting = largest
  const largest = pool[pool.length - 1]
  const picked = best || pool[0]                            // no fit → smallest, run it tight
  return {
    tag: picked.tag,
    fits: !!best,
    heavier: largest.tag !== picked.tag ? largest.tag : null,
    tools: picked.tools,
  }
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
  MODEL_LADDER, TOOL_FLOOR, availableMemGb, ladderIndex, modelRamGb,
  supportsNativeTools, supportsTools, machineSupport,
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
