// Is there a newer REFUGIO?
//
// THIS IS THE SECOND THING IN REFUGIO THAT LEAVES THE MACHINE, and the whole
// module is arranged around saying so. Web search was the first, and it set
// the pattern: name what is sent, keep it to the minimum, and let it be
// switched off in one place.
//
// What an update check sends: a TCP connection to github.com, carrying your IP
// address and the fact that some machine asked for a branch's current commit.
// That is all — no identifier, no version of yours, no data of any kind. The
// request is the same one `git ls-remote` makes, because it IS `git ls-remote`.
//
// Why ls-remote and not the GitHub API: the API needs a token above 60
// requests an hour, returns JSON we would have to trust, and rate-limits by
// IP. ls-remote is one round trip, needs no credentials, and the answer — a
// commit hash — is checkable against the local clone with no interpretation.
//
// Releases here are BRANCHES, not tags (v1.0.0 … v2.0.0-beta.2). So "is there
// an update" means "has the branch I am on moved ahead of my checkout", which
// is exactly what comparing two hashes answers.

import { execFile } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

/** How often a background check may run. Daily: releases here are not hourly,
 *  and a local-first app should not talk to the network on a timer people
 *  would notice. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Never let a hung network hold anything up. A check that times out is not an
 *  error worth showing — it is a check that will happen again tomorrow. */
const GIT_TIMEOUT_MS = 8000;

function git(args, { cwd, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd,
      timeout: timeoutMs,
      // Git must never stop to ask for credentials: this runs unattended in a
      // background timer, and a prompt would hang until the timeout with no
      // one to answer it.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
  });
}

/**
 * The commit hash `git ls-remote` reported for one ref.
 *
 * Exported for testing, and separate from the call because this is the part
 * that can be wrong: ls-remote prints `<sha>\t<ref>` per line, and asking for
 * "v2.0.0-beta.2" can match both `refs/heads/…` and `refs/tags/…` when a repo
 * has both. Heads win — the installer tracks a branch.
 */
export function parseLsRemote(stdout, ref) {
  const lines = String(stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const rows = lines.map((l) => {
    const [sha, name] = l.split(/\s+/);
    return { sha, name };
  }).filter((r) => /^[0-9a-f]{40}$/i.test(r.sha || ""));

  return rows.find((r) => r.name === `refs/heads/${ref}`)?.sha
    // A tag object's ^{} line is the commit it points at — that, not the tag.
    || rows.find((r) => r.name === `refs/tags/${ref}^{}`)?.sha
    || rows.find((r) => r.name === `refs/tags/${ref}`)?.sha
    || null;
}

/** What the local checkout is. Null fields where the answer isn't knowable —
 *  someone may have installed from a zip, in which case there is no git at all
 *  and an update check is not a thing we can offer. */
export async function localState(dir) {
  const out = { supported: false, sha: null, branch: null, date: null, version: null };
  try {
    out.version = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")).version || null;
  } catch { /* no package.json — still fine */ }
  if (!existsSync(join(dir, ".git"))) return out;
  try {
    out.sha = await git(["rev-parse", "HEAD"], { cwd: dir });
    out.branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
    out.date = await git(["log", "-1", "--format=%cI"], { cwd: dir });
    // A detached HEAD has no branch to compare against; say unsupported rather
    // than compare against something arbitrary and report a false update.
    out.supported = !!out.sha && !!out.branch && out.branch !== "HEAD";
  } catch { /* git present but unusable — leave unsupported */ }
  return out;
}

/**
 * Ask the remote what the tracked branch points at now.
 *
 * @returns {Promise<{sha: string|null, error: string|null}>}
 */
export async function remoteHead(dir, branch) {
  try {
    const out = await git(["ls-remote", "origin", branch], { cwd: dir });
    const sha = parseLsRemote(out, branch);
    return { sha, error: sha ? null : `origin has no branch "${branch}"` };
  } catch (e) {
    // Offline is the common case and is not a failure worth a red banner.
    const msg = /could not resolve host|network is unreachable|timed out|timeout/i.test(e.message || "")
      ? "offline"
      : (e.message || "check failed").split("\n")[0].slice(0, 200);
    return { sha: null, error: msg };
  }
}

/** Combine local and remote into the shape the UI renders. Pure, so the
 *  interesting cases are testable without a network or a repository. */
export function describe({ local, remote, checkedAt = null, enabled = true }) {
  const behind = !!(local?.supported && remote?.sha && local.sha && remote.sha !== local.sha);
  return {
    enabled,
    supported: !!local?.supported,
    channel: local?.branch || null,
    version: local?.version || null,
    sha: local?.sha ? local.sha.slice(0, 7) : null,
    date: local?.date || null,
    latestSha: remote?.sha ? remote.sha.slice(0, 7) : null,
    updateAvailable: behind,
    checkedAt,
    // "offline" is a state, not an error — it is what a laptop on a train
    // reports, and showing it as a failure teaches people to ignore the panel.
    error: remote?.error === "offline" ? null : (remote?.error || null),
    offline: remote?.error === "offline",
  };
}

/** The command that actually applies it. Shown rather than run — see the note
 *  on POST /api/chat/update/check in server.js. */
export function updateCommand(dir) {
  return `cd ${dir} && git pull --ff-only && ./menubar/install.sh && refugio restart`;
}

// ── Persistence ─────────────────────────────────────────────
//
// One small JSON file beside the chat database. Survives restarts so the
// daily check is daily rather than once-per-launch — which on a machine that
// restarts REFUGIO ten times a day would be ten requests.

export function readCache(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return {}; }
}

export function writeCache(path, data) {
  try { writeFileSync(path, JSON.stringify(data, null, 2)); } catch { /* read-only home; not fatal */ }
}

/** Is a background check due? Only ever true when the user has left checks on. */
export function isDue(cache, now = Date.now()) {
  if (!cache?.checkedAt) return true;
  const last = Date.parse(cache.checkedAt);
  return !Number.isFinite(last) || now - last >= CHECK_INTERVAL_MS;
}
