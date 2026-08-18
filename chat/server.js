#!/usr/bin/env node
// REFUGIO chat server — the local chat UI, served by Node.
//
// Replaces Open WebUI on the default path. OWUI needs `uv` + a Python venv and
// loads PyTorch (~1-1.5 GB) just to boot; when `uv` is missing the installer
// silently skips it and REFUGIO starts with no interface at all. This serves an
// equivalent single-user chat window with zero extra dependencies.
//
// Usage: node chat/server.js [--port 8090]
// Env:   REFUGIO_CHAT_PORT, REFUGIO_CHAT_MODEL, OLLAMA_BASE_URL, REFUGIO_DATA_DIR

import http from "http";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, extname, normalize } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { homedir, totalmem } from "os";

import { writeFileSync, readFileSync, mkdirSync } from "fs";
import * as store from "./store.js";
import { CONNECTOR_OPTIONS, defaultSettings, optionsFor, setupUrlFor } from "./connector-options.js";
import { McpPool } from "./mcp.js";
import { explain, outputLines } from "./connector-errors.js";
import * as updates from "./updates.js";
import { WEB_TOOL, WEB_DEFAULTS, WEB_SEARCH_UI, webSearch, formatResults } from "./websearch.js";
import { listModels, isUp, chatStream, complete, pullModel, showModel, OLLAMA_BASE } from "./ollama.js";
import * as catalog from "./model-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, "static");

// The version the settings page prints. Read from package.json rather than
// duplicated here, so the number in the corner of the window is the number
// that was released and cannot drift from it.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(__dirname), "package.json"), "utf-8")).version || "";
  } catch { return ""; }
})();

const argPort = (() => {
  const i = process.argv.indexOf("--port");
  return i > -1 ? parseInt(process.argv[i + 1], 10) : null;
})();
const PORT = argPort || parseInt(process.env.REFUGIO_CHAT_PORT || "8090", 10);

const DATA_DIR = process.env.REFUGIO_DATA_DIR || join(homedir(), ".refugio-data");
const DB_PATH = join(DATA_DIR, "chat.db");

const SYSTEM_PROMPT =
  process.env.REFUGIO_SYSTEM_PROMPT ||
  "You are REFUGIO, a helpful assistant running entirely on the user's own computer. " +
  "Be concise and direct. If you don't know something, say so.";

/** Tell the model, in prose, that it has tools.
 *
 *  Handing a model a `tools` array is not the same as telling it to use them.
 *  Asked to "summarize my WhatsApp messages", a small model will happily reply
 *  "please paste your messages" — it pattern-matches the request as needing
 *  information it lacks rather than as a tool call. Naming the connectors and
 *  forbidding the ask-the-user escape hatch is what closes that gap; larger
 *  models don't need it, and it costs them nothing. */
function toolPreamble(tools) {
  if (!tools.length) return "";
  const servers = [...new Set(tools.map((t) => t.function.name.split("__")[0]))];
  const local = servers.filter((s) => s !== WEB_SERVER);
  let out = "";
  if (local.length) {
    out += "\n\nYou have tools that read the user's own data on this machine" +
      ` (${local.join(", ")}). When a question is about that data, call the` +
      " relevant tool instead of answering from memory. Never ask the user to" +
      " paste in data you can fetch yourself — call the tool and use the result.";
  }
  // Said separately, and only on a turn the user armed. Folding web search into
  // the sentence above would describe it as one more local connector, which is
  // the one thing it is not.
  if (servers.includes(WEB_SERVER)) {
    out += "\n\nFor this message only, the user has allowed you to search the" +
      ` public web with ${WEB_TOOL.function.name}. Use it when the answer` +
      " depends on current or external information you do not already have," +
      " and keep the query short — it is sent to a search engine. Cite the" +
      " links you used.";
  }
  return out;
}

// The prefix in `web__search`. Tool names are `server__tool` everywhere else,
// so web search borrows the shape without being an MCP server.
const WEB_SERVER = WEB_TOOL.function.name.split("__")[0];

const log = (m) => console.log(`[chat] ${m}`);

// Tool capability comes from the same ladder the installer and supervisor use,
// so the UI can't disagree with them about what the running model can do.
// Loaded lazily and tolerantly: the chat UI must still start if scripts/ is
// missing (a bare checkout, a future split of this directory).
let _memFit;
function memFit() {
  if (_memFit === undefined) {
    try {
      _memFit = createRequire(import.meta.url)(join(dirname(__dirname), "scripts", "mem-fit.cjs"));
    } catch { _memFit = null; }
  }
  return _memFit;
}

// ── What REFUGIO knows about models ─────────────────────────
//
// Three sources, merged by chat/model-catalog.js: the built-in ladder above
// (measured, shipped, frozen the day you installed), the catalog fetched from
// the repository (curated, and the reason a model released last week can show
// up here at all), and what Ollama says about the models on this machine
// (probed — the rescue for a model somebody pulled in a terminal, which used
// to render as "unrated" with no size and no verdict).
//
// Everything below asks this index rather than the ladder directly, so a
// catalog entry corrects a size and a rating in one place.

const CATALOG_CACHE = join(DATA_DIR, "model-catalog.json");

/** Last successful catalog, from disk at boot and replaced by a check. */
let catalogState = null;
/** tag → { ramGb, tools, estimated, parameterSize, quantization }, from
 *  Ollama's /api/show. Rebuilt by a rescan; never fetched on a poll, because
 *  /api/show is one request per installed model and the status endpoint runs
 *  every fifteen seconds in an open window. */
let probeState = [];

function modelIndex() {
  return catalog.mergeIndex({
    builtin: memFit()?.MODEL_LADDER || [],
    catalog: catalogState?.models || [],
    probes: probeState,
  });
}

const bareTag = (name) => String(name || "").split("@")[0];

/** What a model needs, from whichever source rated it. 0 when nobody has. */
function modelRamGb(tag) {
  return modelIndex().get(bareTag(tag))?.ramGb || 0;
}

function modelSupportsTools(tag) {
  if (!tag) return null;
  // Bare tag ("qwen2.5:3b") vs. an Ollama name that may carry a digest suffix.
  // Still null (not false) for anything unrated: unknown is not incapable.
  return modelIndex().get(bareTag(tag))?.tools ?? null;
}

/** Load the last catalog we fetched. No network — boot must not open a socket,
 *  and a cached list is the whole reason the check survives a restart. */
function loadCatalogCache() {
  try {
    catalogState = catalog.readCatalogCache(CATALOG_CACHE);
    if (catalogState) log(`model catalog: ${catalogState.models.length} entries, checked ${catalogState.checkedAt || "never"}`);
  } catch { catalogState = null; }
}

/**
 * Ask the repository for the current catalog.
 *
 * Gated by the SAME switch as update checks, and deliberately so: Settings ▸
 * Updates promises that off means REFUGIO makes no requests. A second network
 * feature that quietly ignored that switch would make the first one a lie.
 */
async function runCatalogCheck() {
  const local = await updates.localState(REPO_DIR);
  const remote = await updates.originUrl(REPO_DIR);
  const result = await catalog.checkCatalog({ remote, branch: local.branch });
  if (result.ok) {
    const checkedAt = new Date().toISOString();
    catalogState = { checkedAt, url: result.url, branch: result.branch, version: result.version, updated: result.updated, models: result.models, skipped: result.skipped };
    catalog.writeCatalogCache(CATALOG_CACHE, catalogState);
    log(`model catalog: ${result.models.length} entries from ${result.branch}${result.skipped ? `, ${result.skipped} skipped` : ""}`);
  }
  return result;
}

/**
 * Ask Ollama about every installed model.
 *
 * The half of "rescan" that needs no network at all, and the half that works
 * on a machine that has never been online: sizes come from /api/tags, tool
 * ratings from /api/show. Bounded concurrency because this is one request per
 * model and a user can have a dozen.
 */
async function probeInstalled(models) {
  const out = [];
  const queue = [...models];
  const worker = async () => {
    while (queue.length) {
      const m = queue.shift();
      const info = await showModel(m.name);
      out.push({
        tag: bareTag(m.name),
        ramGb: catalog.estimateRamGb(m.size),
        tools: catalog.toolsFromCapabilities(info?.capabilities),
        parameterSize: info?.parameterSize || null,
        quantization: info?.quantization || null,
      });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  probeState = out;
  return out;
}

/** Is there something better than what is running? Computed here so the chat,
 *  the settings page and the rescan result cannot disagree about the answer. */
function currentRecommendation(index, installedNames, activeModel) {
  const mf = memFit();
  if (!mf) return null;
  return catalog.recommend({
    index,
    installed: installedNames,
    active: activeModel,
    freeGb: mf.availableMemGb(),
    totalGb: totalmem() / 1024 ** 3,
  });
}

/** The summary the Models pane shows above the button. */
function catalogSummary(index) {
  const isNew = catalog.newModels(index);
  return {
    checkedAt: catalogState?.checkedAt || null,
    updated: catalogState?.updated || null,
    branch: catalogState?.branch || null,
    count: catalogState?.models?.length || 0,
    // Models this build shipped without — the answer to "did checking find
    // anything?", which is the only reason the button exists.
    newTags: isNew.map((m) => m.tag),
    enabled: updateSettings().enabled,
  };
}

/** Describe each installed model against the RAM free right now.
 *
 *  Switching model is the main lever a user has over speed, and picking one
 *  blind means discovering it doesn't fit by watching the machine swap. Open
 *  WebUI labelled models this way and it was genuinely useful; the built-in UI
 *  should not be a downgrade. `needGb` is what the model wants; `fits` answers
 *  the actual question — can I run this without closing anything first. */
function describeModels(names, activeModel) {
  const mf = memFit();
  const index = modelIndex();
  const freeGb = mf ? mf.availableMemGb() : null;
  let budget = freeGb == null ? null : freeGb - 0.05 - 1.0;  // chat UI + headroom

  // A loaded model occupies the very RAM this check measures, so the running
  // model made ITSELF look too big: load qwen2.5:3b and free RAM drops by
  // 2.6 GB, after which the label says "free 2.6 GB more" about the model you
  // are successfully using. Switching away returns that memory, so it belongs
  // in the budget for every other model too.
  const activeGb = activeModel ? modelRamGb(activeModel) : 0;
  if (budget != null && activeGb) budget += activeGb;

  return names.map((name) => {
    const known = index.get(bareTag(name));
    const needGb = known?.ramGb || 0;
    // The running model demonstrably fits — it is running.
    const isActive = !!activeModel && name === activeModel;
    const fits = isActive ? true : (needGb && budget != null ? needGb <= budget : null);

    // "Too big right now" and "too big for this Mac" are different problems
    // with different answers — close some apps, versus never going to work —
    // and the old label collapsed them into one number of gigabytes to free.
    // Telling someone to free 2.6 GB is not an instruction most people can
    // act on: on macOS you do not free memory by hand, the system manages it.
    const everFits = needGb ? needGb <= (totalmem() / 1024 ** 3) - 1.5 : null;

    return {
      name,
      needGb: needGb || null,                    // null = not on the ladder, unknown
      fits,
      everFits,
      // Kept for the tooltip, where a number is useful to someone who wants
      // one. It is no longer the label.
      freeUpGb: fits === false ? Math.max(0.1, Math.round((needGb - budget) * 10) / 10) : null,
      tools: known?.tools ?? null,
      // Where the numbers came from, so the row can say so. An estimate
      // presented as a measurement is the one thing this page must not do.
      source: known?.source || null,
      estimated: !!known?.estimated,
      note: known?.note || null,
    };
  });
}

// ── Updates ─────────────────────────────────────────────────
//
// See chat/updates.js for what a check sends and why it is `git ls-remote`.
// The parts that live here are the ones that need the server's paths and
// settings file.

const REPO_DIR = dirname(__dirname);
const UPDATE_CACHE = join(DATA_DIR, "update-check.json");

/** On by default.
 *
 *  This is a judgement, and it cuts against "nothing leaves this computer" —
 *  so it is worth stating plainly rather than burying. An update check sends
 *  no data of yours; it asks a public repository for a public commit hash, and
 *  GitHub learns an IP address asked. Set against that: this is alpha software
 *  whose bugs get fixed weekly, and a user who is never told is a user running
 *  a known-broken build for months. Defaulting to silence protects the slogan
 *  and not the person. Settings ▸ Updates turns it off, permanently, in one
 *  click, and off genuinely means no requests. */
function updateSettings() {
  return { enabled: connectorSettings.updates?.enabled !== false };
}

/** The cached answer plus the live local state. Never touches the network. */
async function updateState() {
  const cache = updates.readCache(UPDATE_CACHE);
  const local = await updates.localState(REPO_DIR);
  const state = updates.describe({
    local,
    // A remote hash from a previous check. Compared against the CURRENT local
    // hash, so an update applied by hand clears the notice on the next poll
    // without needing another request.
    remote: { sha: cache.latestSha || null, error: null },
    checkedAt: cache.checkedAt || null,
    enabled: updateSettings().enabled,
  });
  return { ...state, dir: REPO_DIR, command: updates.updateCommand(REPO_DIR) };
}

async function runUpdateCheck() {
  const local = await updates.localState(REPO_DIR);
  if (!local.supported) {
    return { ...(await updateState()), supported: false };
  }
  const remote = await updates.remoteHead(REPO_DIR, local.branch);
  const checkedAt = new Date().toISOString();
  // Only a successful answer is cached. Caching a failure would make the next
  // poll report "no update" with confidence we do not have.
  if (remote.sha) updates.writeCache(UPDATE_CACHE, { checkedAt, latestSha: remote.sha, branch: local.branch });
  const state = updates.describe({ local, remote, checkedAt, enabled: true });
  if (state.updateAvailable) log(`update available on ${local.branch}: ${state.latestSha}`);
  return { ...state, dir: REPO_DIR, command: updates.updateCommand(REPO_DIR) };
}

/** Check at most once a day, and never within the first minute of launch —
 *  starting REFUGIO should not put a request on the wire before the window has
 *  even painted. */
function scheduleUpdateChecks() {
  const maybeCheck = async () => {
    if (!updateSettings().enabled) return;
    if (!updates.isDue(updates.readCache(UPDATE_CACHE))) return;
    try { await runUpdateCheck(); } catch (e) { log(`update check failed: ${e.message}`); }
  };
  setTimeout(maybeCheck, 60_000).unref?.();
  // Hourly wake-up, daily request: the interval only fires a check when a day
  // has passed, which is what makes this survive a machine that sleeps.
  setInterval(maybeCheck, 60 * 60_000).unref?.();
}

/** Where this machine's memory has gone, for the bar on the models page.
 *
 *  Three numbers and only three, because only three are honestly knowable:
 *  what the machine has, what is free right now, and what the selected model
 *  wants. "In use by other apps" is the remainder — it is arithmetic, not a
 *  measurement, and it is labelled that way in the UI.
 *
 *  What this deliberately does NOT do is attribute memory to named
 *  applications ("close Chrome, frees 4.1 GB"). Getting that right means
 *  reading per-process RSS and summing it per app bundle, and RSS
 *  double-counts shared pages badly enough that the numbers would be wrong in
 *  the user's favour — telling someone that closing Chrome frees 4 GB when it
 *  frees 1.2 is the kind of specific, checkable, wrong advice that costs trust
 *  in everything else on the page.
 *
 *  `activeGb` is what the model needs when resident, not proof that it is
 *  resident: Ollama unloads an idle model after a few minutes, and there is no
 *  cheap way to ask. The bar segment is the model's claim on memory while it
 *  is in use, which is the number that matters when deciding whether a
 *  different model would fit. */
function memoryBreakdown(activeModel) {
  const mf = memFit();
  if (!mf) return null;
  const totalGb = totalmem() / 1024 ** 3;
  const freeGb = mf.availableMemGb();
  const activeGb = activeModel ? modelRamGb(activeModel) : 0;
  const r = (n) => Math.round(n * 10) / 10;
  return {
    totalGb: r(totalGb),
    freeGb: r(freeGb),
    activeGb: r(activeGb),
    // Clamped at zero: on a machine where the model is not actually resident,
    // free + activeGb can exceed total, and a negative "other apps" segment
    // would render as an inverted bar.
    otherGb: r(Math.max(0, totalGb - freeGb - activeGb)),
    activeModel: activeModel || null,
  };
}

/** Models this Mac could run but hasn't downloaded.
 *
 *  The picker used to list only what Ollama already had — which after a fresh
 *  install is exactly one model, and the only way to get another was
 *  `ollama pull` in a terminal. That is the thing this app exists to avoid.
 *
 *  Only models that fit the machine at all are offered. Suggesting a 13.5 GB
 *  download to someone with 8 GB of RAM wastes twenty minutes to arrive at a
 *  model they cannot run. */
function downloadableModels(installed) {
  const mf = memFit();
  if (!mf) return [];
  const have = new Set(installed.map(bareTag));
  const totalGb = totalmem() / 1024 ** 3;
  // Read from the merged index rather than the ladder, which is what makes a
  // model added to the catalog after this build shipped actually downloadable.
  // This list is also the whitelist POST /api/chat/models/pull checks against,
  // so every filter here is a filter on what Ollama can be asked to fetch.
  return [...modelIndex().values()]
    .filter((m) => !have.has(m.tag) && m.tools === true && m.ramGb > 0 && m.ramGb <= totalGb - 1.5)
    // Most capable first, then lightest — the order someone reads to decide.
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0) || a.ramGb - b.ramGb)
    .map((m) => ({
      name: m.tag,
      needGb: m.ramGb,
      tools: true,
      rank: m.rank,
      // Two labels the download row earns: "this build never knew about it",
      // and "nobody here has watched it call a connector".
      isNew: !!m.isNew,
      verified: !!m.verified,
      note: m.note || null,
    }));
}

// Tool limits. A large tool surface degrades model accuracy — they pick wrong
// or loop — so the count is capped and the agentic loop is bounded. Both are
// overridable.
//
// 24 was too low to be safe. A stock install is Hermeneia (18) + reminders (7)
// + Things (10) = 35, and capping there cut half of WhatsApp — including
// list_chats, which "summarise my chats" needs. Losing the tool the user is
// asking for is worse than offering a few too many, and the cap now falls
// evenly across servers rather than truncating whichever connected last.
const TOOL_LIMIT = parseInt(process.env.REFUGIO_TOOL_LIMIT || "40", 10);
const MAX_TOOL_ROUNDS = parseInt(process.env.REFUGIO_MAX_TOOL_ROUNDS || "5", 10);
// How much of a tool result is sent to the browser for the sources panel.
// Generous — this is a local socket, and a truncated source is only half an
// answer to "where did this come from?" — but not unbounded.
const SOURCE_CHARS = parseInt(process.env.REFUGIO_SOURCE_CHARS || "8000", 10);
const MCP_CONFIG = process.env.REFUGIO_MCPO_CONFIG ||
  join(dirname(__dirname), "mcpo-config.json");

/** @type {McpPool|null} */
let mcp = null;
// False until the first connect sweep finishes. Distinguishes "nothing is
// configured" from "we haven't looked yet" — the difference between telling
// someone to re-run the installer and telling them to wait five seconds.
let connectorsSettled = false;

// Connector scope settings, saved beside the chat database. A JSON file rather
// than a table: it is a handful of booleans a user may reasonably want to read
// or edit by hand, and it must survive the database being deleted.
const SETTINGS_PATH = join(DATA_DIR, "connector-settings.json");

function loadSettings() {
  // Web search rides in the same file: it is one boolean, it belongs with the
  // other "what may REFUGIO reach" answers, and a user who opens this file
  // should see every one of them in one place.
  // `updates` rides here for the same reason `web` does: this file is the one
  // place a person can read to answer "what may REFUGIO reach?", and an update
  // check reaches the network. Both belong in the same list.
  const defaults = { ...defaultSettings(), web: { ...WEB_DEFAULTS }, updates: { enabled: true } };
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    // Merge over defaults so an option added in a later version starts off,
    // and an option removed from the code doesn't linger as a live setting.
    for (const [server, opts] of Object.entries(defaults)) {
      for (const key of Object.keys(opts)) {
        if (typeof saved?.[server]?.[key] === "boolean") opts[key] = saved[server][key];
      }
    }
  } catch { /* first run, or unreadable — defaults are the safe answer */ }
  return defaults;
}

function saveSettings(settings) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  } catch (e) {
    log(`could not save connector settings: ${e.message}`);
  }
}

let connectorSettings = loadSettings();

// Human-facing names for the server ids in mcpo-config.json. Anything not
// listed falls back to its id capitalised, so a new connector reads correctly
// without a code change here.
const CONNECTOR_LABELS = {
  whatsapp: "WhatsApp", email: "Email", reminders: "Apple Reminders",
  things: "Things 3", notion: "Notion", memory: "Memory",
};
const labelFor = (id) => CONNECTOR_LABELS[id] || id.charAt(0).toUpperCase() + id.slice(1);

// describe() calls list_accounts on every connector, far too heavy for a 15s
// status poll. Cached briefly; opening the panel forces a refresh.
let connectorCache = { at: 0, rows: [] };
const CONNECTOR_TTL = 30_000;

async function connectorRows({ force = false } = {}) {
  if (!mcp) return [];
  if (!force && Date.now() - connectorCache.at < CONNECTOR_TTL) return connectorCache.rows;
  const rows = (await mcp.describe()).map((r) => {
    const label = labelFor(r.id);
    return {
      ...r,
      label,
      // Offered whenever the connector isn't fully healthy — a running connector
      // whose account is unreachable usually needs re-linking, not restarting.
      setup: r.state === "ok" ? null : setupUrlFor(r.id, mcp.servers.get(r.id)?.spec),
      // The plain-language cause and the connector's own words, computed here
      // so the browser never has to pattern-match a stack trace. A healthy
      // connector carries neither — there is nothing to explain, and an empty
      // "what it printed" frame on a working row reads as a problem.
      ...(r.state === "ok"
        ? { explanation: null, output: [] }
        : { explanation: explain({ ...r, label }), output: outputLines(r) }),
      options: optionsFor(r.id).map((o) => ({
        key: o.key, label: o.label, hint: o.hint || null,
        value: !!connectorSettings[r.id]?.[o.key],
      })),
    };
  });
  // Don't let an incomplete answer harden into a 30s lie. A connector still
  // booting can't list its accounts yet, which undercounts — cache that only
  // briefly so the number corrects itself instead of sitting wrong.
  const settled = !rows.some((r) => r.accountsUnknown || r.state === "connecting");
  connectorCache = { at: settled ? Date.now() : Date.now() - (CONNECTOR_TTL - 3000), rows };
  return rows;
}

/** How many connectors a person would say they have.
 *
 *  Multi-account connectors count once per account — two WhatsApp numbers are
 *  two things to think about, not one. Failures are counted separately rather
 *  than folded in: a healthy-looking total while WhatsApp was silently down is
 *  the exact reassuring-but-wrong signal that hid a real outage. */
function countConnectors(rows) {
  let ready = 0, failed = 0, connecting = 0, degraded = 0;
  for (const r of rows) {
    if (r.state === "connecting") { connecting++; continue; }
    if (!r.ok) { failed++; continue; }
    // Running but unreachable is its own category. Counting it as ready is how
    // a user ends up asking about WhatsApp messages that can't be fetched.
    if (r.state === "degraded") { degraded++; continue; }
    ready += Math.max(1, r.accounts.length);
  }
  return { ready, failed, connecting, degraded };
}

/** What the connectors panel needs, in one shape.
 *
 *  Web search travels with the connectors because that panel is where the
 *  question "what can REFUGIO reach?" is answered — but as its own field, not
 *  as a row in the list, because it is the one entry that isn't local. */
function connectorPayload(rows) {
  return {
    connectors: rows,
    starting: !connectorsSettled,
    ...countConnectors(rows),
    web: { enabled: !!connectorSettings.web?.enabled, ...WEB_SEARCH_UI },
  };
}

// Model selection: explicit override, else whatever Ollama has (first entry).
let cachedModel = process.env.REFUGIO_CHAT_MODEL || null;
async function resolveModel() {
  if (process.env.REFUGIO_CHAT_MODEL) return process.env.REFUGIO_CHAT_MODEL;
  const models = await listModels();
  if (models.length) cachedModel = models[0].name;
  return cachedModel;
}

// ── HTTP helpers ────────────────────────────────────────────

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

async function serveStatic(res, urlPath) {
  // normalize + prefix check keeps `..` from escaping STATIC_DIR.
  // "/settings" is a page, not a file. Extensionless so the menu-bar app and
  // the in-app link can point at something a person could also type.
  const rel = urlPath === "/" ? "index.html"
    : urlPath === "/settings" || urlPath === "/settings/" ? "settings.html"
    : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const full = normalize(join(STATIC_DIR, rel));
  if (!full.startsWith(STATIC_DIR) || !existsSync(full)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const body = await readFile(full);
  res.writeHead(200, {
    "Content-Type": MIME[extname(full)] || "application/octet-stream",
    "Content-Length": body.length,
    // Revalidate everything. This server sends its own files over a loopback
    // socket, so a cache saves nothing measurable — while a stale one costs
    // real time: after `git pull` the window kept serving the previous CSS
    // and the previous favicon, which reads as "the update didn't work".
    // Fonts are the one exception; they are content-addressed by filename and
    // never change under the same name.
    "Cache-Control": extname(full) === ".woff2"
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
  res.end(body);
}

// ── Turn runner ─────────────────────────────────────────────

/** Ask the model for a short conversation title. Best-effort — a failure here
 *  must never break the turn the user actually asked for. */
async function maybeTitle(convoId, firstMessage, model) {
  if (store.getTitle(convoId)) return null;
  let title = firstMessage.slice(0, 60);
  try {
    const out = await complete({
      model,
      messages: [
        { role: "system", content: "Reply with a 3-6 word title for this conversation. No quotes, no punctuation at the end." },
        { role: "user", content: firstMessage.slice(0, 500) },
      ],
      signal: AbortSignal.timeout(20000),
    });
    const cleaned = out.trim().replace(/^["']|["']$/g, "").split("\n")[0];
    if (cleaned) title = cleaned.slice(0, 80);
  } catch { /* fall back to the truncated message */ }
  store.setTitle(convoId, title);
  return title;
}

/** Execute one tool call.
 *
 *  The web check is repeated here rather than trusted from the tools list. A
 *  model can name a tool it was never offered — either by copying one out of
 *  the conversation history or by inventing it — and "we didn't put it in the
 *  array" is not the guarantee the user was given. The guarantee is that no
 *  search leaves this machine on a turn they did not arm, so it is enforced at
 *  the only place that actually sends anything. */
async function runTool(call, webArmed) {
  if (call.name === WEB_TOOL.function.name) {
    if (!webArmed) return { text: "Error: web search is not enabled for this message.", links: [] };
    const q = String(call.args?.query ?? "").trim();
    log(`web search: ${JSON.stringify(q.slice(0, 80))}`);
    const found = await webSearch(q);
    // The links go to the UI as structured data as well as into the model's
    // prompt as text. A web result is the one source here a person may
    // genuinely want to open for themselves.
    return { text: formatResults(q, found), links: found.results };
  }
  if (!mcp) return { text: `Error: no tool named ${call.name}`, links: [] };
  return { text: await mcp.call(call.name, call.args), links: [] };
}

/**
 * Run one turn and stream it to the client as SSE.
 * Events: `token` (incremental text), `done` (final metadata), `error`.
 */
async function streamTurn(res, { conversationId, message, model, persistUser, web = false }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  store.ensureConversation(conversationId);
  if (persistUser) store.addMessage(conversationId, "user", message);

  send("start", { conversation_id: conversationId });

  // Two conditions, both required, and they mean different things: the setting
  // is "I am willing to search the web at all", the flag is "search on THIS
  // message". Neither implies the other, so the model is only handed the tool
  // when the user has just asked for it.
  const webArmed = !!web && !!connectorSettings.web?.enabled;
  const tools = [...(mcp ? mcp.toolDefs(TOOL_LIMIT) : []), ...(webArmed ? [WEB_TOOL] : [])];

  const messages = [
    { role: "system", content: SYSTEM_PROMPT + toolPreamble(tools) },
    ...store.historyFor(conversationId),
  ];

  // Abort the upstream request if the browser goes away mid-stream, so a
  // closed tab doesn't leave the model generating.
  const ac = new AbortController();
  res.on("close", () => ac.abort());

  // Keep the text as it arrives. If the client disconnects (tab closed, page
  // reloaded, network blip) we still persist what was generated — otherwise
  // the answer is lost entirely and the conversation is left with a user turn
  // and no reply, which then poisons the history sent on the next turn.
  let acc = "";
  const toolsUsed = [];

  try {
    // Agentic loop: the model may call tools, read the results, and call more
    // before answering. Bounded so a model that loops on a failing tool can't
    // spin forever.
    for (let round = 0; ; round++) {
      const { text, toolCalls } = await chatStream(
        { model, messages, tools, signal: ac.signal },
        (piece) => { acc += piece; send("token", { t: piece }); }
      );

      if (!toolCalls.length) break;

      if (round >= MAX_TOOL_ROUNDS) {
        const note = `\n\n_(stopped after ${MAX_TOOL_ROUNDS} tool rounds)_`;
        acc += note; send("token", { t: note });
        break;
      }

      // Ollama needs the assistant turn that requested the calls in history,
      // then one `tool` message per result.
      messages.push({ role: "assistant", content: text, tool_calls: toolCalls.map((c) => ({
        function: { name: c.name, arguments: c.args },
      })) });

      for (const call of toolCalls) {
        send("tool", { name: call.name, args: call.args });
        const { text: result, links } = await runTool(call, webArmed);
        toolsUsed.push(call.name);
        // The full result, not a 160-character preview. "Which of my chats did
        // this come from?" is the first question anyone asks of an answer built
        // from their own data, and a preview cannot answer it. Capped so one
        // enormous tool result can't wedge the stream.
        send("tool_result", {
          name: call.name,
          ok: !result.startsWith("Error"),
          args: call.args,
          text: result.slice(0, SOURCE_CHARS),
          truncated: result.length > SOURCE_CHARS,
          links,
        });
        messages.push({ role: "tool", content: result, tool_name: call.name });
      }
    }

    store.addMessage(conversationId, "assistant", acc, model);
    if (!res.writableEnded) {
      const first = store.historyFor(conversationId).find((m) => m.role === "user");
      const title = await maybeTitle(conversationId, first?.content ?? message, model);
      send("done", { conversation_id: conversationId, title, model });
      res.end();
    }
  } catch (err) {
    // Salvage a partial answer on disconnect or mid-stream failure.
    if (acc) store.addMessage(conversationId, "assistant", acc, model);
    if (ac.signal.aborted) { try { res.end(); } catch {} return; }
    log(`turn failed: ${err.message}`);
    send("error", { error: err.message });
    res.end();
  }
}

// ── Routes ──────────────────────────────────────────────────

async function route(req, res, url) {
  const p = url.pathname;

  // Retry one connector, or stop what's blocking it first. POST because both
  // change state. The connector id comes from the path and must exist in the
  // pool; nothing about which process gets stopped is caller-controlled.
  const fix = /^\/api\/chat\/connectors\/([A-Za-z0-9_-]{1,64})\/(retry|resolve)$/.exec(p);
  if (fix && req.method === "POST") {
    if (!mcp) return sendJson(res, 503, { error: "connectors are still starting" });
    const [, id, action] = fix;
    if (!mcp.servers.has(id)) return sendJson(res, 404, { error: `unknown connector "${id}"` });
    try {
      await (action === "resolve" ? mcp.resolveConflict(id) : mcp.reconnect(id));
    } catch (e) {
      return sendJson(res, 409, { error: e.message });
    }
    connectorCache = { at: 0, rows: [] };          // force a fresh read
    const rows = await connectorRows({ force: true });
    return sendJson(res, 200, connectorPayload(rows));
  }

  if (p === "/api/chat/connectors/settings" && req.method === "POST") {
    const body = await readBody(req);
    const { server, key, value } = body || {};
    // Only keys this build actually declares; nothing arbitrary lands in the file.
    if (!CONNECTOR_OPTIONS[server] || !optionsFor(server).some((o) => o.key === key)) {
      return sendJson(res, 400, { error: "unknown connector option" });
    }
    connectorSettings[server] = { ...connectorSettings[server], [key]: !!value };
    saveSettings(connectorSettings);
    mcp?.setSettings(connectorSettings);
    connectorCache = { at: 0, rows: [] };
    const rows = await connectorRows({ force: true });
    return sendJson(res, 200, connectorPayload(rows));
  }

  if (p === "/api/chat/connectors") {
    const rows = await connectorRows({ force: true });
    return sendJson(res, 200, connectorPayload(rows));
  }

  // Web search gets its own route rather than joining the connector-options
  // one. That route validates against CONNECTOR_OPTIONS, where every entry
  // narrows a connector's scope and declares the mechanism that enforces it;
  // this widens REFUGIO's reach past the machine and enforces nothing. Making
  // it pass that validator would have meant loosening it for everything.
  if (p === "/api/chat/web" && req.method === "POST") {
    const body = await readBody(req);
    connectorSettings.web = { ...connectorSettings.web, enabled: !!body.enabled };
    saveSettings(connectorSettings);
    log(`web search ${connectorSettings.web.enabled ? "enabled" : "disabled"}`);
    return sendJson(res, 200, connectorPayload(await connectorRows()));
  }

  if (p === "/api/chat/status") {
    const up = await isUp();
    const models = up ? await listModels() : [];
    const model = await resolveModel();
    const rows = await connectorRows();
    return sendJson(res, 200, {
      connectors: countConnectors(rows),
      available: up && !!model,
      // Reported separately from `available`, which is false for two different
      // reasons — Ollama down, or Ollama up with nothing installed — that need
      // opposite advice. Collapsing them meant the UI could only say "no
      // model" and stop.
      ollamaUp: up,
      model,
      models: describeModels(models.map((m) => m.name), model),
      downloadable: downloadableModels(models.map((m) => m.name)),
      freeGb: memFit() ? Math.round(memFit().availableMemGb() * 10) / 10 : null,
      memory: memoryBreakdown(model),
      version: VERSION,
      ollama: OLLAMA_BASE,
      tools: mcp ? mcp.toolDefs(TOOL_LIMIT).map((t) => t.function.name) : [],
      // true / false / null-when-unrated. The UI warns only on an explicit
      // false — a model we've never rated is unknown, not incapable.
      modelTools: modelSupportsTools(model),
      // Is there something better than what is running? Computed from what is
      // already known here — no network, so it is safe on a fifteen-second
      // poll, and it stays right after a rescan without another round trip.
      recommendation: currentRecommendation(modelIndex(), models.map((m) => m.name), model),
      catalog: catalogSummary(modelIndex()),
      // The composer needs this on every poll: when web search is switched off
      // the per-message control must disappear, not sit there doing nothing.
      web: { enabled: !!connectorSettings.web?.enabled, ...WEB_SEARCH_UI },
    });
  }

  // What the last check found. Cached only — this never opens a socket, for
  // the same reason GET /api/chat/update doesn't: the settings page polls, and
  // a poll that could reach github.com turns "leave the window open" into a
  // stream of requests.
  if (p === "/api/chat/models/catalog" && req.method === "GET") {
    const index = modelIndex();
    return sendJson(res, 200, {
      ...catalogSummary(index),
      models: [...index.values()].map((m) => ({
        tag: m.tag, ramGb: m.ramGb, tools: m.tools, rank: m.rank,
        verified: m.verified, source: m.source, isNew: m.isNew, note: m.note,
      })),
    });
  }

  // Rescan. The button this endpoint exists for is "is there something better
  // than what I am running?", and it does two separable things:
  //
  //   local   — ask Ollama about every installed model (/api/show), which
  //             re-rates anything nobody has rated and re-measures free RAM.
  //             No network. Always runs.
  //   network — fetch models.json from this repository, which is the only way
  //             a model released after this build can ever be offered. Runs
  //             only when update checks are on, and says plainly when it
  //             didn't.
  //
  // POST because it does something: it opens a connection to
  // raw.githubusercontent.com. That is not a thing to hang off a GET someone
  // can be led into making.
  if (p === "/api/chat/models/rescan" && req.method === "POST") {
    const body = await readBody(req);
    const wantNetwork = body.network !== false;
    const before = new Set(catalogState?.models?.map((m) => m.tag) || []);

    let net = null;
    let networkBlocked = false;
    if (wantNetwork) {
      if (!updateSettings().enabled) networkBlocked = true;
      else net = await runCatalogCheck();
    }

    const up = await isUp();
    const installed = up ? await listModels() : [];
    if (up) await probeInstalled(installed);

    const index = modelIndex();
    const model = await resolveModel();
    const names = installed.map((m) => m.name);
    // "New" here means new TO THIS MACHINE — entries the fetched catalog added
    // to what was already cached. On a first check that is everything the
    // catalog carries beyond the built-in ladder, which is exactly what
    // someone who has never checked wants to see.
    const added = [...index.values()].filter((m) => m.isNew && (!before.size || !before.has(m.tag)));

    log(`model rescan: ${installed.length} installed, ${index.size} known${net?.ok ? `, catalog ${net.models.length}` : ""}`);
    return sendJson(res, 200, {
      checkedAt: new Date().toISOString(),
      network: {
        attempted: wantNetwork && !networkBlocked,
        blocked: networkBlocked,
        ok: !!net?.ok,
        offline: !!net?.offline,
        error: net?.error || null,
        url: net?.url || catalogState?.url || null,
        skipped: net?.skipped || 0,
      },
      probed: up ? installed.length : 0,
      ollamaUp: up,
      catalog: catalogSummary(index),
      added: added.map((m) => ({
        tag: m.tag, needGb: m.ramGb, tools: m.tools, verified: m.verified, note: m.note,
        installed: names.map(bareTag).includes(m.tag),
      })),
      models: describeModels(names, model),
      downloadable: downloadableModels(names),
      recommendation: currentRecommendation(index, names, model),
      memory: memoryBreakdown(model),
      freeGb: memFit() ? Math.round(memFit().availableMemGb() * 10) / 10 : null,
    });
  }

  // Download a model, streaming Ollama's byte counts through to the browser.
  // SSE rather than a request that returns when it's done: this takes minutes,
  // and a spinner with no numbers is indistinguishable from a hang.
  if (p === "/api/chat/models/pull" && req.method === "POST") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    // Only tags this build offers. Nothing arbitrary gets handed to Ollama.
    const offered = downloadableModels((await listModels()).map((m) => m.name));
    if (!offered.some((m) => m.name === name)) {
      return sendJson(res, 400, { error: `won't download "${name}"` });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    log(`downloading ${name}`);
    try {
      await pullModel(name, (m) => send("progress", {
        status: m.status || "", completed: m.completed || 0, total: m.total || 0,
      }), ac.signal);
      log(`downloaded ${name}`);
      send("done", { name });
    } catch (e) {
      if (!ac.signal.aborted) send("error", { error: e.message });
    }
    try { res.end(); } catch {}
    return;
  }

  if (p === "/api/chat/ask" && req.method === "POST") {
    const body = await readBody(req);
    const message = (body.message || "").trim();
    if (!message) return sendJson(res, 400, { error: "message is required" });
    const model = body.model || (await resolveModel());
    if (!model) {
      return sendJson(res, 503, {
        error: "No model available. Is Ollama running? Try: ollama pull llama3.2",
      });
    }
    const conversationId = (body.conversation_id || "").trim() || randomUUID().replace(/-/g, "");
    return streamTurn(res, { conversationId, message, model, persistUser: true, web: body.web });
  }

  // Regenerate / edit both re-run the last turn; they differ only in what the
  // caller drops first.
  if ((p === "/api/chat/regenerate" || p === "/api/chat/edit") && req.method === "POST") {
    const body = await readBody(req);
    const conversationId = (body.conversation_id || "").trim();
    if (!conversationId) return sendJson(res, 400, { error: "conversation_id is required" });
    const model = body.model || (await resolveModel());
    if (!model) return sendJson(res, 503, { error: "No model available." });

    if (p === "/api/chat/regenerate") {
      store.truncateFrom(conversationId, { lastAssistant: true });
      // `web` is not remembered from the original turn. Re-running is a new
      // decision, and silently repeating a search the user armed once would
      // make "manual each time" untrue on exactly the path they aren't watching.
      return streamTurn(res, { conversationId, message: "", model, persistUser: false, web: body.web });
    }
    const edited = (body.message || "").trim();
    if (!edited) return sendJson(res, 400, { error: "message is required" });
    store.truncateFrom(conversationId, { lastAssistant: false });
    return streamTurn(res, { conversationId, message: edited, model, persistUser: true, web: body.web });
  }

  if (p === "/api/chat/conversations" && req.method === "GET") {
    return sendJson(res, 200, store.listConversations());
  }

  // ── Updates ───────────────────────────────────────────────
  //
  // Reads the cached answer; never reaches the network. The UI polls this, and
  // a poll that could open a socket to github.com would turn "leave the window
  // open" into a stream of requests.
  if (p === "/api/chat/update" && req.method === "GET") {
    return sendJson(res, 200, await updateState());
  }

  // Check now. POST because it does something — it opens a connection to
  // github.com — and that is exactly the sort of thing that must not happen on
  // a GET someone can be led into making.
  //
  // There is no "apply" endpoint. Updating means a git pull, a Swift rebuild
  // and a supervisor restart, and the chat server is a CHILD of that
  // supervisor: it would be killing itself half way through. Worse, a failed
  // self-update leaves no working surface to report the failure in. So the UI
  // shows the command and the user runs it.
  if (p === "/api/chat/update/check" && req.method === "POST") {
    if (!updateSettings().enabled) {
      return sendJson(res, 403, { error: "update checks are switched off" });
    }
    return sendJson(res, 200, await runUpdateCheck());
  }

  // Turn checking on or off. Off means no background timer and no manual
  // check — the switch has to mean "this app makes no network requests",
  // or it means nothing.
  if (p === "/api/chat/update/settings" && req.method === "POST") {
    const body = await readBody(req);
    connectorSettings.updates = { ...connectorSettings.updates, enabled: !!body.enabled };
    saveSettings(connectorSettings);
    log(`update checks ${connectorSettings.updates.enabled ? "enabled" : "disabled"}`);
    if (connectorSettings.updates.enabled) return sendJson(res, 200, await runUpdateCheck());
    return sendJson(res, 200, await updateState());
  }

  // What the "Data & reset" page needs to state before it offers to destroy
  // anything: how much there is, and where it lives. The path matters — it is
  // the answer to "where is my data?", which on a local-first app is a
  // question with a real answer, and it lets someone take a copy first.
  if (p === "/api/chat/data" && req.method === "GET") {
    return sendJson(res, 200, { ...store.historyStats(), dataDir: DATA_DIR, dbPath: DB_PATH });
  }

  // Destroy all chat history. Guarded by an explicit confirm token rather than
  // just the method: this endpoint sits on a loopback server with no auth, and
  // "POST somewhere" is something a page in another tab can be made to do. The
  // token has to be typed by the person doing it.
  if (p === "/api/chat/data/reset" && req.method === "POST") {
    const body = await readBody(req);
    if (body?.confirm !== "delete") {
      return sendJson(res, 400, { error: 'send {"confirm":"delete"} to erase chat history' });
    }
    const deleted = store.deleteAllConversations();
    log(`chat history erased — ${deleted} conversation(s)`);
    return sendJson(res, 200, { deleted });
  }

  const convoMatch = p.match(/^\/api\/chat\/conversations\/([A-Za-z0-9_-]+)$/);
  if (convoMatch) {
    const id = convoMatch[1];
    if (req.method === "GET") {
      const convo = store.getConversation(id);
      return convo
        ? sendJson(res, 200, convo)
        : sendJson(res, 404, { error: "Conversation not found" });
    }
    if (req.method === "DELETE") {
      return sendJson(res, 200, { deleted: store.deleteConversation(id) });
    }
  }

  const pinMatch = p.match(/^\/api\/chat\/conversations\/([A-Za-z0-9_-]+)\/pin$/);
  if (pinMatch && req.method === "POST") {
    const body = await readBody(req);
    store.setPinned(pinMatch[1], !!body.pinned);
    return sendJson(res, 200, { ok: true });
  }

  if (p.startsWith("/api/")) return sendJson(res, 404, { error: "Unknown endpoint" });
  return serveStatic(res, p);
}

// ── Boot ────────────────────────────────────────────────────

store.initStore(DB_PATH);
// The catalog from the last check, read off disk. No network at boot.
loadCatalogCache();

const server = http.createServer((req, res) => {
  // A malformed request-target (e.g. "//", which parses as protocol-relative)
  // makes `new URL` throw. Unhandled, that exception escapes the request scope
  // and kills the process — one bad URL would take the whole UI down.
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  } catch {
    return sendJson(res, 400, { error: "Bad request URL" });
  }
  route(req, res, url).catch((err) => {
    log(`error on ${url.pathname}: ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
    else try { res.end(); } catch {}
  });
});

// A bind failure is the one startup error worth explaining. Unhandled, it
// prints a stack trace and exits 1 — and under the supervisor, which restarts
// on exit 1, that becomes ten identical failures whose cause is one line of
// text nobody sees. Say what is wrong and stop.
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    log(`port ${PORT} is already in use — REFUGIO chat is probably already running.`);
    log(`Open http://127.0.0.1:${PORT}, or stop the other copy and start again.`);
  } else {
    log(`could not start: ${e.message}`);
  }
  process.exit(1);
});

// Bind to loopback only. This serves the user's private conversations with no
// authentication — it must never be reachable from the network.
server.listen(PORT, "127.0.0.1", async () => {
  log(`REFUGIO chat → http://127.0.0.1:${PORT}`);
  log(`store: ${DB_PATH}`);
  const model = await resolveModel();
  log(model ? `model: ${model}` : `no model yet (Ollama at ${OLLAMA_BASE})`);

  // Tools connect after the server is listening so a slow or broken connector
  // delays tool availability, never the UI itself.
  //
  // The pool is published BEFORE connecting, not after. Assigning it only on
  // completion left a 10-15s window (Hermeneia is not quick to start) in which
  // the UI could see no pool at all and say "No connectors configured — re-run
  // the installer", which is both wrong and alarming. The pool registers every
  // configured server up front, so publishing early means that window reports
  // "connecting" instead.
  if (process.env.REFUGIO_TOOLS !== "0") {
    const pool = new McpPool();
    pool.setSettings(connectorSettings);
    mcp = pool;
    await pool.connectAll(MCP_CONFIG);
  }
  connectorsSettled = true;

  scheduleUpdateChecks();
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("shutting down");
    server.close();
    store.closeStore();
    mcp?.close();
    process.exit(0);
  });
}
