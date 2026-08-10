// First-run setup — the state, and the writes.
//
// The wizard exists because the terminal installer was asking questions that
// belong in a window: "Connect Apple Reminders? [Y/n]" is a fine question and
// a terrible place to ask it. On a packaged install it is worse than
// misplaced — an MDM deployment never runs the terminal installer at all, so
// without this there is no way to configure a connector on that machine.
//
// ── The dangerous part ──────────────────────────────────────
//
// This module writes ~/.refugio.env. That file is read by the supervisor and
// its values become environment variables for every child process it starts.
// A caller who could put arbitrary keys in it could set NODE_OPTIONS, or
// anything else Node reads from the environment, and get code execution on the
// next launch.
//
// The chat server listens on loopback with no authentication, and "POST
// something" is a thing a page in another browser tab can be made to do. So
// this does not sanitise, it ALLOW-LISTS: a key that is not in FIELDS below
// cannot be written by any request, and each field validates its own value.
// Newlines are rejected everywhere, because a value containing one would smuggle
// a second key into the file no matter how the first key was validated.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

/** Every key the wizard may write, and what counts as a legal value.
 *
 *  Deliberately short. WhatsApp and email are absent because their setup is a
 *  round trip that isn't built yet — and a field here that the UI cannot
 *  actually fill is a hole in the allow-list with nothing on the other side. */
export const FIELDS = {
  // "1" or empty — the supervisor tests these against the string "1", so
  // anything else means off, and empty is how the installer spells off.
  REFUGIO_REMINDERS: { type: "toggle" },
  REFUGIO_THINGS: { type: "toggle" },
  REFUGIO_NOTES: { type: "toggle" },

  REFUGIO_MEMORY: { type: "enum", values: ["", "mempalace", "github"] },

  // A model tag, e.g. llama3.1:8b. Constrained to what an Ollama tag can
  // contain rather than left open: this ends up on a command line.
  REFUGIO_MODEL: { type: "pattern", pattern: /^[a-zA-Z0-9._\-]+(:[a-zA-Z0-9._\-]+)?$/, max: 100 },

  // Notion hands out `ntn_…`; older integrations used `secret_…`. Checked so a
  // pasted password or a whole URL is refused at the door rather than stored
  // and failing later with an error about the wrong thing.
  NOTION_TOKEN: { type: "pattern", pattern: /^(ntn_|secret_)[A-Za-z0-9]{16,120}$/, max: 200, secret: true },
};

/** Validate a patch against the allow-list.
 *
 *  Returns what may be written and what was refused. Refusals are returned
 *  rather than thrown: a wizard step that sets three things and gets one wrong
 *  should save the two that were fine and say which one it did not, instead of
 *  discarding the lot. */
export function sanitise(patch) {
  const values = {};
  const rejected = [];
  if (!patch || typeof patch !== "object") return { values, rejected };

  for (const [key, raw] of Object.entries(patch)) {
    const spec = FIELDS[key];
    if (!spec) { rejected.push({ key, why: "not a setting the wizard may change" }); continue; }

    // Before anything else. A value with a newline in it writes a SECOND line
    // into ~/.refugio.env — which is a second environment variable, chosen by
    // whoever sent the request. No field has any use for one.
    const value = raw === true ? "1" : raw === false ? "" : String(raw ?? "");
    if (/[\r\n\0]/.test(value)) { rejected.push({ key, why: "must not contain a line break" }); continue; }
    if (spec.max && value.length > spec.max) { rejected.push({ key, why: "too long" }); continue; }

    if (spec.type === "toggle") { values[key] = value === "1" || value === "true" ? "1" : ""; continue; }
    if (spec.type === "enum") {
      if (!spec.values.includes(value)) { rejected.push({ key, why: `must be one of ${spec.values.map((v) => v || "(empty)").join(", ")}` }); continue; }
      values[key] = value;
      continue;
    }
    // pattern — empty always allowed, so a field can be cleared.
    if (value === "") { values[key] = ""; continue; }
    if (!spec.pattern.test(value)) { rejected.push({ key, why: "not in the expected format" }); continue; }
    values[key] = value;
  }
  return { values, rejected };
}

// ── The env file ────────────────────────────────────────────
//
// Read-modify-write that keeps the file a person can still read. Rewriting it
// from a parsed object would drop every comment and reorder everything, and
// this is a file the README tells people to edit by hand.

/** Parse `KEY=value` lines. Comments and blanks are ignored, as the supervisor
 *  ignores them. */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

/** Apply values to the file's text, updating keys in place and appending the
 *  rest. Comments, ordering and unknown keys all survive. */
export function mergeEnv(text, values) {
  const lines = String(text ?? "").split("\n");
  const remaining = { ...values };

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (!(key in remaining)) continue;
    lines[i] = `${key}=${remaining[key]}`;
    delete remaining[key];
  }

  const added = Object.entries(remaining);
  if (added.length) {
    // Trailing blank lines would otherwise push the new keys further down the
    // file on every save until the thing is mostly whitespace.
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push("# Added by REFUGIO setup");
    for (const [k, v] of added) lines.push(`${k}=${v}`);
  }
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

/** Merge values into ~/.refugio.env, creating it if it isn't there.
 *
 *  Mode 0600 on create: this file holds a Notion token today and more later,
 *  and on a shared machine the default umask would leave it world-readable. */
export function writeEnvValues(envPath, values) {
  const before = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const after = mergeEnv(before, values);
  if (after === before) return false;
  writeFileSync(envPath, after, { mode: 0o600 });
  return true;
}

// ── State ───────────────────────────────────────────────────

export const STATE_FILE = "setup-state.json";

export function statePath(dataDir) { return join(dataDir, STATE_FILE); }

export function readState(dataDir) {
  try { return JSON.parse(readFileSync(statePath(dataDir), "utf-8")); }
  catch { return null; }
}

export function writeState(dataDir, patch) {
  // Undefined fields are dropped rather than stored as nulls, so a POST that
  // recorded nothing leaves no trace at all.
  const clean = Object.fromEntries(Object.entries(patch || {}).filter(([, v]) => v !== undefined));
  const previous = readState(dataDir);
  if (!previous && !Object.keys(clean).length) return {};
  const next = { ...(previous || {}), ...clean };
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(statePath(dataDir), JSON.stringify(next, null, 2) + "\n");
  } catch { /* a machine we cannot write to is one the wizard simply repeats on */ }
  return next;
}

/** Should the wizard be shown?
 *
 *  Two conditions, and the second one matters more than it looks. Going by the
 *  state file alone would put the wizard in front of every EXISTING user on the
 *  update that introduces it — they have never written one. So a conversation
 *  in the database counts as evidence that this person has used REFUGIO before
 *  and does not need to be welcomed to it.
 *
 *  Skipping writes the state file too, which is what stops the wizard coming
 *  back tomorrow for someone who said no. */
export function isFirstRun(dataDir, conversationCount) {
  const state = readState(dataDir);
  // An ANSWER, not the mere existence of the file. Recording progress through
  // the wizard writes this file too, and treating that as "setup is done"
  // meant a single stray POST — or closing the window on step two — disabled
  // the welcome screen permanently, with nothing anywhere saying why.
  if (state?.completed || state?.skipped) return false;
  return !conversationCount;
}
