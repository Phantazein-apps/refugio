// scripts/measure-models.cjs measures what a model occupies under Ollama, and
// scripts/memory-probe.cjs checks memory holds something before an eval spends
// model time on it. What is tested here is the part that decides things
// without a machine: which process holds the weights, what the script is
// allowed to delete, and what counts as memory having found something.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const m = require("../scripts/measure-models.cjs");
const probe = require("../scripts/memory-probe.cjs");

// Captured from `ps -axo pid,ppid,rss,command` on 2026-09-17, Ollama 0.34.0,
// with qwen2.5:3b loaded — plus the older runner name and two impostors.
const PS = `
  PID  PPID    RSS COMMAND
 1218  1183   7824 /Applications/Ollama.app/Contents/Resources/ollama serve
70988  1218 2029360 /Applications/Ollama.app/Contents/Resources/llama-server --model /Users/dk/.ollama/models/blobs/sha256-5ee4 --port 59946 -c 4096
71001  1218 1500000 /usr/local/bin/ollama runner --model /x/blob --ctx-size 4096
71002   900   1200 grep llama-server
71003   900   1300 vim notes-about-ollama runner.md
`;

test("the runner is the process holding the weights, under either name", () => {
  const found = m.runnerProcesses(PS);
  assert.deepEqual(found.map((p) => p.pid), [70988, 71001]);
  assert.equal(found[0].rssBytes, 2029360 * 1024);
});

test("ollama serve is not the runner, and neither is something that mentions one", () => {
  // Measuring `ollama serve` reads ~8 MB for a model holding ~2 GB, which is
  // how a first attempt at this got a number that looked like a result.
  const pids = m.runnerProcesses(PS).map((p) => p.pid);
  for (const pid of [1218, 71002, 71003]) assert.ok(!pids.includes(pid), `pid ${pid} counted as a runner`);
});

test("wired memory comes from vm_stat in bytes, and garbage is null rather than zero", () => {
  const vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages wired down:                             143807.\n";
  assert.equal(m.wiredBytes(vm), 143807 * 16384);
  for (const bad of ["", "no stats here", null]) assert.equal(m.wiredBytes(bad), null);
});

test("a partial GPU load is reported as a share, not rounded to done", () => {
  assert.equal(m.gpuPercent(2155169709, 2155169709), 100);
  assert.equal(m.gpuPercent(100, 86), 86);
  assert.equal(m.gpuPercent(0, 0), null);
  assert.equal(m.gpuPercent(100, undefined), null);
  assert.match(m.table([{ tag: "big:30b", shippedGb: 20.2, sizeBytes: 17e9, gpuPercent: 86, context: 4096,
    runnerRssBytes: 1, wiredDeltaBytes: 1, availBeforeGb: 20, availAfterGb: 3 }]), /\*\*86%\*\*/);
});

test("a missing model is skipped unless downloading was asked for", () => {
  const tags = ["have:1b", "want:3b"];
  assert.deepEqual(m.plan({ tags, installed: ["have:1b"], pull: false }).map((s) => s.action), ["measure", "skip"]);
  const pulled = m.plan({ tags, installed: ["have:1b"], pull: true });
  assert.deepEqual(pulled.map((s) => [s.action, s.pull]), [["measure", false], ["measure", true]]);
});

test("the script never deletes a model that was installed before it ran", () => {
  const pulledThisRun = new Set(["new:7b", "old:8b"]);   // even if it somehow re-pulled one
  const installedBefore = ["old:8b"];
  assert.equal(m.mayRemove({ tag: "old:8b", pulledThisRun, removePulled: true, installedBefore }), false);
  assert.equal(m.mayRemove({ tag: "new:7b", pulledThisRun, removePulled: true, installedBefore }), true);
  assert.equal(m.mayRemove({ tag: "new:7b", pulledThisRun, removePulled: false, installedBefore }), false);
});

test("an unknown argument is refused rather than ignored", () => {
  assert.throws(() => m.parseArgs(["--remove-all"]), /unknown argument/);
  assert.deepEqual(m.parseArgs(["--only", "a:1b, b:2b", "--pull"]).only, ["a:1b", "b:2b"]);
});

// ── memory-probe ────────────────────────────────────────────

test("memory has found something only when it returns text that is not an error", () => {
  assert.equal(probe.verdict({ content: [{ type: "text", text: "Decided 2026-08-28: Ollama is the default." }] }).ok, true);
  assert.equal(probe.verdict({ isError: true, content: [{ type: "text", text: "Memory error: spawn ENOENT" }] }).why, "error");
  assert.equal(probe.verdict({ content: [] }).why, "empty");
  assert.equal(probe.verdict(null).why, "empty");
});

test("MemPalace's no-palace message is a miss, though it arrives as ordinary text", () => {
  // The exact text all three models were handed on 2026-09-16, as a normal
  // result and not an error — which is why nothing flagged it until the
  // scorecards were read.
  const v = probe.verdict({ content: [{ type: "text", text: "No palace found — hint: Run: mempalace init <dir> && mempalace mine <dir>" }] });
  assert.equal(v.ok, false);
  assert.equal(v.why, "no palace");
});
