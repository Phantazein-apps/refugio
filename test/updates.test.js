// The update check. The parts worth testing are the ones that decide whether
// to tell someone their copy is old — a false positive trains people to ignore
// the notice, and a false negative is a user on a known-broken build.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLsRemote, describe as describeUpdate, isDue, CHECK_INTERVAL_MS } from "../chat/updates.js";

const SHA_A = "1a0f599032b4b2aaf3e093b8c8a2462d3c55a21c";
const SHA_B = "9c4d1e77bb2f3a0e5d6c8b9a0f1e2d3c4b5a6978";

test("a branch ref is read from ls-remote output", () => {
  const out = `${SHA_A}\trefs/heads/v2.0.0-beta.2`;
  assert.equal(parseLsRemote(out, "v2.0.0-beta.2"), SHA_A);
});

test("a branch wins over a tag of the same name", () => {
  // This repo names releases as BRANCHES, and a tag with the same name would
  // otherwise silently decide what "latest" means.
  const out = [
    `${SHA_B}\trefs/tags/v2.0.0-beta.2`,
    `${SHA_A}\trefs/heads/v2.0.0-beta.2`,
  ].join("\n");
  assert.equal(parseLsRemote(out, "v2.0.0-beta.2"), SHA_A);
});

test("an annotated tag resolves to the commit it points at", () => {
  const out = [
    `${SHA_B}\trefs/tags/v1.0.3`,
    `${SHA_A}\trefs/tags/v1.0.3^{}`,
  ].join("\n");
  assert.equal(parseLsRemote(out, "v1.0.3"), SHA_A);
});

test("garbage and empty output yield no sha rather than a wrong one", () => {
  assert.equal(parseLsRemote("", "main"), null);
  assert.equal(parseLsRemote("fatal: repository not found", "main"), null);
  assert.equal(parseLsRemote("notasha\trefs/heads/main", "main"), null);
});

test("differing hashes mean an update is available", () => {
  const s = describeUpdate({
    local: { supported: true, sha: SHA_A, branch: "v2.0.0-beta.2", version: "2.0.0-beta.2", date: null },
    remote: { sha: SHA_B, error: null },
  });
  assert.equal(s.updateAvailable, true);
  assert.equal(s.channel, "v2.0.0-beta.2");
  assert.equal(s.sha, SHA_A.slice(0, 7));
  assert.equal(s.latestSha, SHA_B.slice(0, 7));
});

test("matching hashes mean no update", () => {
  const s = describeUpdate({
    local: { supported: true, sha: SHA_A, branch: "main", version: "2", date: null },
    remote: { sha: SHA_A, error: null },
  });
  assert.equal(s.updateAvailable, false);
});

test("a checkout git cannot describe never claims an update", () => {
  // Installed from a zip, or a detached HEAD. Saying "up to date" would be a
  // guess; saying "update available" would be worse.
  const s = describeUpdate({
    local: { supported: false, sha: null, branch: null, version: "2", date: null },
    remote: { sha: SHA_B, error: null },
  });
  assert.equal(s.supported, false);
  assert.equal(s.updateAvailable, false);
});

test("no remote answer is not an update", () => {
  const s = describeUpdate({
    local: { supported: true, sha: SHA_A, branch: "main", version: "2", date: null },
    remote: { sha: null, error: "offline" },
  });
  assert.equal(s.updateAvailable, false);
});

test("offline is a state, not an error", () => {
  // A laptop on a train must not show a red failure; it shows nothing.
  const s = describeUpdate({
    local: { supported: true, sha: SHA_A, branch: "main", version: "2", date: null },
    remote: { sha: null, error: "offline" },
  });
  assert.equal(s.offline, true);
  assert.equal(s.error, null);
});

test("a real failure is reported as one", () => {
  const s = describeUpdate({
    local: { supported: true, sha: SHA_A, branch: "wip", version: "2", date: null },
    remote: { sha: null, error: 'origin has no branch "wip"' },
  });
  assert.equal(s.offline, false);
  assert.match(s.error, /no branch/);
});

test("a check is due when never run, and not again within a day", () => {
  const now = Date.parse("2026-07-30T12:00:00Z");
  assert.equal(isDue({}, now), true);
  assert.equal(isDue({ checkedAt: "not a date" }, now), true);
  assert.equal(isDue({ checkedAt: new Date(now - 1000).toISOString() }, now), false);
  assert.equal(isDue({ checkedAt: new Date(now - CHECK_INTERVAL_MS + 1000).toISOString() }, now), false);
  assert.equal(isDue({ checkedAt: new Date(now - CHECK_INTERVAL_MS).toISOString() }, now), true);
});
