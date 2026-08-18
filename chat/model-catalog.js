// Is there a better model than the one you are running?
//
// THIS IS THE THIRD THING IN REFUGIO THAT LEAVES THE MACHINE, and it is built
// like the second (chat/updates.js): name what is sent, keep it to the
// minimum, and let it be switched off in the same one place.
//
// What a check sends: an HTTPS GET to raw.githubusercontent.com for one public
// file — models.json in this repository. It carries your IP address and the
// fact that some machine asked for a public file. No identifier, no version of
// yours, and in particular NO list of what you have installed: the comparison
// happens here, on your machine, after the file arrives. Nothing is uploaded.
//
// Why a file in the repository, and not a question to Ollama's library: Ollama
// has no endpoint that enumerates what exists, and scraping ollama.com means
// parsing a page nobody promised to keep stable. A JSON file here is a list
// REFUGIO's maintainers stand behind, and publishing a newly-rated model is a
// one-file edit — so a model released after you installed can reach you
// WITHOUT you updating REFUGIO. That is the whole point: the ladder baked into
// scripts/mem-fit.cjs was frozen on the day you cloned.
//
// The built-in ladder stays the fallback and stays the installer's source of
// truth. The catalog only ever adds to it, and is never required: with no
// network, no cache and no catalog at all, everything here still answers.

import { readCache, writeCache } from "./updates.js";

/** The file, and the only host it is ever fetched from. Not configurable —
 *  "check for models" must not become a way to point REFUGIO at an arbitrary
 *  URL, and the entries it returns end up in a download whitelist. */
export const CATALOG_FILE = "models.json";
const RAW_HOST = "raw.githubusercontent.com";

/** If the branch you are on has no catalog (an old release branch, a fork that
 *  never carried one), fall back to this one. A stale ladder is the problem
 *  being solved; refusing to look anywhere else would preserve it. */
export const FALLBACK_BRANCH = "main";

const FETCH_TIMEOUT_MS = 8000;
/** A catalog is a few kB of JSON. Anything approaching this is not our file. */
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 200;

/**
 * The tag pattern. This is a trust boundary, not a formality: a tag that
 * survives this is a tag the server will let Ollama download, so it is
 * restricted to what an Ollama model name can legitimately be — an optional
 * namespace, a name, and an explicit tag. No schemes, no hosts, no paths that
 * could be read as one, and the colon is required so every entry names a
 * specific size rather than whatever ":latest" happens to be today.
 */
const TAG_RE = /^[a-z0-9][a-z0-9._-]{0,62}(\/[a-z0-9][a-z0-9._-]{0,62})?:[a-z0-9][a-z0-9._-]{0,62}$/i;

const round1 = (n) => Math.round(n * 10) / 10;
const bare = (tag) => String(tag || "").split("@")[0];
const clip = (s, n) => (typeof s === "string" ? s.slice(0, n) : null);

// ── Where the catalog lives ─────────────────────────────────

/** `owner/repo` from an origin URL, or null when it isn't GitHub.
 *
 *  Only github.com, and only because raw.githubusercontent.com is the host
 *  this module is allowed to talk to. Someone hosting their own fork elsewhere
 *  gets the built-in ladder, which is a working REFUGIO, not a broken one. */
export function parseOrigin(remote) {
  const url = String(remote || "").trim();
  const m = url.match(/^(?:https:\/\/|git:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

/** The URL for one branch's catalog. Pure, so the interesting part — that it
 *  can only ever address one host and one file — is testable. */
export function catalogUrl({ remote, branch }) {
  const origin = parseOrigin(remote);
  if (!origin || !branch) return null;
  if (!/^[\w][\w./-]{0,120}$/.test(branch) || branch.includes("..")) return null;
  return `https://${RAW_HOST}/${origin.owner}/${origin.repo}/${encodeURIComponent(branch)}/${CATALOG_FILE}`;
}

// ── Reading a catalog ───────────────────────────────────────

/**
 * Validate a catalog document.
 *
 * A malformed document is rejected whole; a malformed ENTRY is dropped and
 * counted. The difference matters: one bad line in a list of twenty models
 * should not cost a user the other nineteen, but a file that isn't a catalog
 * at all must not be treated as an empty one — "no new models" and "the answer
 * was garbage" are different things to tell someone.
 *
 * @returns {{version:number, updated:string|null, models:Array, skipped:number}}
 */
export function parseCatalog(text) {
  if (typeof text === "string" && text.length > MAX_BYTES) throw new Error("catalog is too large");
  let doc;
  try { doc = typeof text === "string" ? JSON.parse(text) : text; }
  catch { throw new Error("catalog is not JSON"); }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.models)) {
    throw new Error("catalog has no models list");
  }
  if (doc.models.length > MAX_ENTRIES) throw new Error("catalog lists too many models");

  const seen = new Set();
  const models = [];
  let skipped = 0;
  for (const raw of doc.models) {
    const m = validateEntry(raw, seen);
    if (m) { models.push(m); seen.add(m.tag); } else skipped++;
  }
  return {
    version: Number.isFinite(doc.version) ? doc.version : 1,
    updated: clip(doc.updated, 32),
    models,
    skipped,
  };
}

function validateEntry(raw, seen) {
  if (!raw || typeof raw !== "object") return null;
  const tag = typeof raw.tag === "string" ? raw.tag.trim() : "";
  if (!TAG_RE.test(tag) || seen.has(tag)) return null;
  // Strictly a number, not something Number() can be talked into. This field
  // decides what gets offered for download; remote input does not get coercion.
  const ramGb = typeof raw.ramGb === "number" ? raw.ramGb : NaN;
  if (!Number.isFinite(ramGb) || ramGb <= 0 || ramGb > 1024) return null;
  // `tools` is required and must be a boolean. An entry whose tool-calling is
  // unstated is exactly the entry that gets someone a REFUGIO whose connectors
  // silently do nothing — the failure the whole ladder exists to prevent.
  if (typeof raw.tools !== "boolean") return null;
  const rank = typeof raw.rank === "number" && Number.isFinite(raw.rank) ? raw.rank : null;
  return {
    tag,
    ramGb: round1(ramGb),
    tools: raw.tools,
    nativeTools: raw.nativeTools === true,
    rank,
    // Unverified means: listed, downloadable, and never RECOMMENDED. REFUGIO
    // does not tell you to switch to something nobody has watched call a
    // connector — see recommend() below.
    verified: raw.verified === true,
    note: clip(raw.note, 240),
    added: clip(raw.added, 32),
  };
}

/**
 * Fetch and validate the catalog, trying the current branch and then main.
 *
 * Never throws: a check that fails is a state to report, not an exception to
 * handle at three call sites. Offline is reported as offline rather than as an
 * error, for the same reason chat/updates.js does — a laptop on a train has
 * not malfunctioned.
 */
export async function checkCatalog({ remote, branch, timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const tried = [];
  const branches = branch && branch !== FALLBACK_BRANCH ? [branch, FALLBACK_BRANCH] : [branch || FALLBACK_BRANCH];
  let lastError = null;
  let offline = false;

  for (const b of branches) {
    const url = catalogUrl({ remote, branch: b });
    if (!url) return { ok: false, url: null, branch: b, error: "this copy has no GitHub origin to ask", offline: false, models: [] };
    tried.push(url);
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "application/json" },
        redirect: "error",
      });
      if (res.status === 404) { lastError = `no ${CATALOG_FILE} on ${b}`; continue; }
      if (!res.ok) { lastError = `github answered ${res.status}`; continue; }
      const len = Number(res.headers?.get?.("content-length"));
      if (Number.isFinite(len) && len > MAX_BYTES) { lastError = "catalog is too large"; continue; }
      const text = await res.text();
      const parsed = parseCatalog(text);
      return { ok: true, url, branch: b, error: null, offline: false, ...parsed };
    } catch (e) {
      if (isOffline(e)) { offline = true; lastError = "offline"; break; }
      lastError = (e?.message || "check failed").split("\n")[0].slice(0, 200);
    }
  }
  return { ok: false, url: tried[tried.length - 1] || null, branch: branches[0], models: [], skipped: 0, offline, error: offline ? null : lastError };
}

/** A dropped connection is not a bad catalog. Told apart so the UI can say
 *  "couldn't reach the network" instead of implying the file was wrong. */
function isOffline(e) {
  const code = e?.cause?.code || e?.code || "";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|UND_ERR/i.test(code)) return true;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return true;
  return /fetch failed|network|timeout|timed out/i.test(e?.message || "");
}

// ── The cache on disk ───────────────────────────────────────
//
// Same shape and the same reasoning as the update cache: a check is a
// deliberate act, so its answer has to survive a restart or the button becomes
// something people press twice.

export function readCatalogCache(path) {
  const raw = readCache(path);
  if (!raw?.catalog) return null;
  try {
    const parsed = parseCatalog(raw.catalog);
    return { checkedAt: raw.checkedAt || null, url: raw.url || null, branch: raw.branch || null, ...parsed };
  } catch {
    // A cache file that no longer validates is discarded in silence. It is a
    // copy of something we can fetch again, never the only copy of anything.
    return null;
  }
}

export function writeCatalogCache(path, { checkedAt, url, branch, version, updated, models }) {
  writeCache(path, { checkedAt, url, branch, catalog: { version, updated, models } });
}

// ── What Ollama can tell us about what is already here ──────

/**
 * Approximate resident RAM from a model's download size.
 *
 * Only ever used for models NOBODY has rated — off-ladder, off-catalog, pulled
 * by the user in a terminal. Before this they showed as "—" with no fit
 * verdict at all, which is a worse answer than an approximate one, provided it
 * is LABELLED approximate. Weights plus a modest KV cache and Ollama's own
 * overhead: about ten per cent, plus a fixed 0.4 GB. Checked against the
 * ladder's measured figures, where it lands within a few hundred megabytes and
 * errs high on the large end — the safe direction when the answer decides
 * whether a machine starts swapping.
 */
export function estimateRamGb(sizeBytes) {
  const gb = Number(sizeBytes) / 1024 ** 3;
  if (!Number.isFinite(gb) || gb <= 0) return 0;
  return round1(gb * 1.1 + 0.4);
}

/** Does Ollama itself say this model can call tools?
 *
 *  Ollama reports `capabilities` on /api/show; older builds do not report the
 *  field at all. Absent means UNKNOWN and must stay null — a model REFUGIO has
 *  not rated is unrated, and claiming it cannot call tools because an old
 *  Ollama declined to say is the kind of confident wrong answer this page is
 *  supposed to be free of. */
export function toolsFromCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) return null;
  return capabilities.includes("tools");
}

// ── Putting the three sources together ──────────────────────

/**
 * One index of every model REFUGIO knows about, from three sources in order of
 * authority: the built-in ladder (measured, shipped), the catalog (curated,
 * fetched), and what Ollama says about models installed here (probed).
 *
 * Curated numbers always win over probed ones. A probe can only fill a gap —
 * it never overrides a figure somebody measured.
 */
export function mergeIndex({ builtin = [], catalog = [], probes = [] } = {}) {
  const index = new Map();
  const builtinTags = new Set();

  builtin.forEach((m, i) => {
    builtinTags.add(m.tag);
    index.set(m.tag, {
      tag: m.tag,
      ramGb: m.ramGb,
      tools: !!m.tools,
      nativeTools: !!m.nativeTools,
      // The ladder is ordered smallest to largest, which is also the order of
      // how well these models answer. Ranks are spaced so a catalog entry can
      // land between two of them.
      rank: (i + 1) * 10,
      verified: true,
      source: "builtin",
      isNew: false,
      estimated: false,
      note: null,
    });
  });

  for (const m of catalog) {
    const prev = index.get(m.tag);
    index.set(m.tag, {
      tag: m.tag,
      ramGb: m.ramGb,
      tools: m.tools,
      nativeTools: m.nativeTools,
      rank: m.rank ?? prev?.rank ?? null,
      verified: m.verified || !!prev,   // a shipped model stays verified
      source: "catalog",
      // The answer to "what did checking actually find?" — a model this build
      // could not have known about.
      isNew: !builtinTags.has(m.tag),
      estimated: false,
      note: m.note,
      added: m.added,
    });
  }

  for (const p of probes) {
    const tag = bare(p.tag);
    if (!tag) continue;
    const prev = index.get(tag);
    if (prev) {
      // Fill a hole, never overwrite. The one thing worth taking from a probe
      // about a known model is a tool rating we don't have.
      if (prev.tools == null && p.tools != null) index.set(tag, { ...prev, tools: p.tools });
      continue;
    }
    index.set(tag, {
      tag,
      ramGb: p.ramGb || 0,
      tools: p.tools ?? null,
      nativeTools: false,
      rank: null,                 // unranked: never recommended, only described
      verified: false,
      source: "probe",
      isNew: false,
      estimated: true,
      note: [p.parameterSize, p.quantization].filter(Boolean).join(" · ") || null,
    });
  }

  return index;
}

/** Models the catalog added that this build shipped without. */
export function newModels(index) {
  return [...index.values()].filter((m) => m.isNew);
}

/**
 * The one sentence this feature owes the user: is there something better than
 * what you are running, that fits in the memory free RIGHT NOW?
 *
 * Three kinds of answer, and no others:
 *   tools    - what is running cannot call tools. Anything rated beats it.
 *   upgrade  - a model that answers better and still fits.
 *   lighter  - the same capability for less memory. This is the case the
 *              button was asked for: newer small models keep arriving, and
 *              nothing in REFUGIO used to notice.
 *
 * Silence is a valid answer and the common one. Never recommends an unverified
 * entry: listing a model nobody has watched call a connector is fine, telling
 * someone to switch to it is not.
 */
export function recommend({ index, installed = [], active = null, freeGb = null, totalGb = null, uiGb = 0.05, safetyGb = 1.0 } = {}) {
  if (!index || freeGb == null || totalGb == null) return null;
  const activeTag = bare(active);
  const cur = activeTag ? index.get(activeTag) : null;
  const have = new Set(installed.map(bare));

  // Switching away returns the running model's memory, so it is part of the
  // budget for every candidate — the same correction describeModels() makes.
  const budget = freeGb - uiGb - safetyGb + (cur?.ramGb || 0);
  const ceiling = totalGb - 1.5;

  const candidates = [...index.values()].filter((m) =>
    m.tag !== activeTag && m.tools === true && m.verified && m.rank != null &&
    m.ramGb > 0 && m.ramGb <= budget && m.ramGb <= ceiling);
  if (!candidates.length) return null;

  const pack = (m, kind, extra = {}) => ({
    tag: m.tag,
    needGb: m.ramGb,
    rank: m.rank,
    installed: have.has(m.tag),
    isNew: !!m.isNew,
    note: m.note || null,
    replaces: cur?.tag || activeTag || null,
    kind,
    ...extra,
  });

  const best = [...candidates].sort((a, b) => b.rank - a.rank || a.ramGb - b.ramGb)[0];

  if (cur && cur.tools === false) return pack(best, "tools");
  // Unrated and apparently working: leave it alone. Nagging someone about a
  // model we have no opinion on is how a helpful panel becomes wallpaper.
  if (!cur || cur.rank == null) return null;

  if (best.rank > cur.rank) return pack(best, "upgrade");

  const lighter = candidates
    .filter((m) => m.rank >= cur.rank && m.ramGb <= cur.ramGb - 0.3)
    .sort((a, b) => a.ramGb - b.ramGb || b.rank - a.rank)[0];
  if (lighter) return pack(lighter, "lighter", { savesGb: round1(cur.ramGb - lighter.ramGb) });

  return null;
}
