// The model catalog, guarded.
//
// Two different things are being protected here, and only one of them is a
// feature working:
//
//   1. The catalog is REMOTE INPUT that ends up in a download whitelist. A tag
//      that survives parseCatalog() is a tag the server will hand to Ollama, so
//      the pattern that admits it is a trust boundary and is tested as one.
//   2. The tool-calling floor. models.json can override the built-in ladder's
//      ratings, which means a careless edit to a JSON file could tell people a
//      model reaches their connectors when it does not — the exact failure
//      test/model-floor.test.js exists to prevent, arriving by a new road.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseOrigin, catalogUrl, parseCatalog, mergeIndex, newModels,
  recommend, estimateRamGb, toolsFromCapabilities, checkCatalog,
} from "../chat/model-catalog.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const memFit = createRequire(import.meta.url)(join(root, "scripts", "mem-fit.cjs"));
const shipped = parseCatalog(readFileSync(join(root, "models.json"), "utf8"));

const entry = (over = {}) => ({ tag: "qwen3:4b", ramGb: 3.3, tools: true, ...over });
const doc = (models) => JSON.stringify({ version: 1, models });

// ── Where a check is allowed to go ──────────────────────────

test("the catalog URL can only ever address raw.githubusercontent.com", () => {
  const url = catalogUrl({ remote: "https://github.com/Phantazein-apps/refugio.git", branch: "main" });
  assert.equal(url, "https://raw.githubusercontent.com/Phantazein-apps/refugio/main/models.json");
});

test("ssh and git remotes resolve to the same repository", () => {
  for (const remote of [
    "git@github.com:Phantazein-apps/refugio.git",
    "ssh://git@github.com/Phantazein-apps/refugio.git",
    "https://github.com/Phantazein-apps/refugio",
  ]) {
    assert.deepEqual(parseOrigin(remote), { owner: "Phantazein-apps", repo: "refugio" }, remote);
  }
});

test("a non-GitHub origin gets no URL rather than a guess", () => {
  for (const remote of [
    "https://gitlab.com/someone/refugio.git",
    "https://github.evil.com/a/b.git",
    "file:///tmp/refugio",
    "",
    null,
  ]) {
    assert.equal(catalogUrl({ remote, branch: "main" }), null, String(remote));
  }
});

test("a branch name cannot escape the path", () => {
  for (const branch of ["../../etc/passwd", "..", "main/../../x", "-x"]) {
    assert.equal(catalogUrl({ remote: "https://github.com/a/b.git", branch }), null, branch);
  }
});

test("checkCatalog reports a missing origin instead of reaching for a default", async () => {
  const res = await checkCatalog({
    remote: "https://gitlab.com/a/b.git",
    branch: "main",
    fetchImpl: () => { throw new Error("the network must not be touched"); },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /GitHub origin/);
});

test("a branch with no catalog falls back to main", async () => {
  const seen = [];
  const res = await checkCatalog({
    remote: "https://github.com/a/b.git",
    branch: "v2.0.0-beta.2",
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.includes("v2.0.0-beta.2")) return { status: 404, ok: false, headers: new Headers() };
      return { status: 200, ok: true, headers: new Headers(), text: async () => doc([entry()]) };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.branch, "main");
  assert.equal(seen.length, 2);
});

test("an unreachable host is offline, not an error", async () => {
  const res = await checkCatalog({
    remote: "https://github.com/a/b.git",
    branch: "main",
    fetchImpl: async () => { const e = new TypeError("fetch failed"); e.cause = { code: "ENOTFOUND" }; throw e; },
  });
  assert.equal(res.ok, false);
  assert.equal(res.offline, true);
  assert.equal(res.error, null);
});

// ── What a catalog is allowed to contain ────────────────────

test("a document that is not a catalog is rejected whole", () => {
  for (const bad of ["not json", "[]", '{"models":"soon"}', JSON.stringify({ models: {} })]) {
    assert.throws(() => parseCatalog(bad), /catalog/, bad);
  }
});

test("one bad entry is dropped, the rest survive", () => {
  const parsed = parseCatalog(doc([entry(), { tag: "broken" }, entry({ tag: "llama3.2:3b", ramGb: 3 })]));
  assert.equal(parsed.models.length, 2);
  assert.equal(parsed.skipped, 1);
});

test("a tag that is not an Ollama model name never reaches the download list", () => {
  const hostile = [
    "https://evil.example/x:1",
    "../../../etc/passwd:1",
    "qwen2.5:3b;rm -rf /",
    "qwen2.5",                       // no explicit size tag
    "-leading-dash:1",
    "a".repeat(200) + ":1",
    "qwen2.5:3b\nllama3.2:1b",
  ];
  for (const tag of hostile) {
    const parsed = parseCatalog(doc([entry({ tag })]));
    assert.equal(parsed.models.length, 0, `${tag} was admitted`);
  }
});

test("an entry that does not state its tool calling is dropped", () => {
  for (const tools of [undefined, null, "yes", 1]) {
    const parsed = parseCatalog(doc([{ tag: "qwen3:4b", ramGb: 3.3, tools }]));
    assert.equal(parsed.models.length, 0, String(tools));
  }
});

test("absurd or missing memory figures are dropped", () => {
  for (const ramGb of [0, -1, 4096, "3.3", NaN, undefined]) {
    const parsed = parseCatalog(doc([entry({ ramGb })]));
    assert.equal(parsed.models.length, 0, String(ramGb));
  }
});

test("a duplicate tag cannot shadow the first one", () => {
  const parsed = parseCatalog(doc([entry({ ramGb: 3.3 }), entry({ ramGb: 0.1 })]));
  assert.equal(parsed.models.length, 1);
  assert.equal(parsed.models[0].ramGb, 3.3);
});

// ── The catalog REFUGIO ships ───────────────────────────────

test("the shipped catalog parses with nothing skipped", () => {
  assert.ok(shipped.models.length >= memFit.MODEL_LADDER.length);
  assert.equal(shipped.skipped, 0);
});

test("the shipped catalog never contradicts the ladder about tool calling", () => {
  for (const m of shipped.models) {
    const builtin = memFit.MODEL_LADDER.find((b) => b.tag === m.tag);
    if (!builtin) continue;
    assert.equal(m.tools, builtin.tools,
      `models.json and the ladder disagree about whether ${m.tag} can call tools`);
  }
});

test("nothing in the shipped catalog claims tools below the floor's size", () => {
  const floor = memFit.TOOL_FLOOR;
  for (const m of shipped.models) {
    if (!m.tools) continue;
    assert.ok(m.ramGb >= floor.ramGb - 1.0,
      `${m.tag} claims tool calling at ${m.ramGb} GB, well under the observed floor ${floor.tag} at ${floor.ramGb} GB`);
  }
});

test("every unverified entry says why in its note", () => {
  for (const m of shipped.models.filter((x) => !x.verified)) {
    assert.ok(m.note && m.note.length > 20, `${m.tag} is unverified with no explanation`);
  }
});

// ── Merging the three sources ───────────────────────────────

const LADDER = memFit.MODEL_LADDER;

test("the catalog corrects the ladder rather than sitting beside it", () => {
  const index = mergeIndex({ builtin: LADDER, catalog: [entry({ tag: "qwen2.5:3b", ramGb: 2.2, tools: true })] });
  assert.equal(index.get("qwen2.5:3b").ramGb, 2.2);
  assert.equal(index.get("qwen2.5:3b").source, "catalog");
  // Shipped in the ladder, so not a discovery — the panel must not announce it.
  assert.equal(index.get("qwen2.5:3b").isNew, false);
});

test("a model the build never shipped is marked new", () => {
  const index = mergeIndex({ builtin: LADDER, catalog: [entry()] });
  assert.deepEqual(newModels(index).map((m) => m.tag), ["qwen3:4b"]);
});

test("a probe fills a gap and never overwrites a measurement", () => {
  const index = mergeIndex({
    builtin: LADDER,
    probes: [
      { tag: "qwen2.5:3b", ramGb: 99, tools: false },      // must not win
      { tag: "mystery:7b", ramGb: 4.4, tools: true, parameterSize: "7B", quantization: "Q4_K_M" },
    ],
  });
  assert.equal(index.get("qwen2.5:3b").ramGb, 2.6);
  assert.equal(index.get("qwen2.5:3b").tools, true);
  const probed = index.get("mystery:7b");
  assert.equal(probed.estimated, true);
  assert.equal(probed.rank, null);          // unranked: describable, never recommended
  assert.equal(probed.verified, false);
  assert.equal(probed.note, "7B · Q4_K_M");
});

test("an ollama name carrying a digest still matches its rating", () => {
  const index = mergeIndex({ builtin: LADDER, probes: [{ tag: "qwen2.5:3b@sha256:abc", ramGb: 2.5, tools: null }] });
  assert.equal(index.size, LADDER.length);
});

// ── The recommendation ──────────────────────────────────────

const big = { freeGb: 24, totalGb: 32 };

test("nothing is recommended when the best model is already running", () => {
  const index = mergeIndex({ builtin: LADDER });
  assert.equal(recommend({ index, installed: ["gpt-oss:20b"], active: "gpt-oss:20b", ...big }), null);
});

test("a lighter model of equal rating is the answer this button was asked for", () => {
  const index = mergeIndex({
    builtin: LADDER,
    catalog: [{ tag: "glimmer:4b", ramGb: 3.4, tools: true, rank: 60, verified: true, nativeTools: true }],
  });
  // A 14 GB machine: big enough for the 14B being run, too small for anything
  // ranked above it — so the only possible improvement is a lighter equal.
  const r = recommend({ index, installed: ["qwen2.5:14b"], active: "qwen2.5:14b", freeGb: 12, totalGb: 14 });
  assert.equal(r.kind, "lighter");
  assert.equal(r.tag, "glimmer:4b");
  assert.equal(r.savesGb, 6.1);
  assert.equal(r.installed, false);
  assert.equal(r.isNew, true);
});

test("a more capable model that fits is an upgrade", () => {
  const index = mergeIndex({ builtin: LADDER });
  const r = recommend({ index, installed: ["qwen2.5:3b", "llama3.1:8b"], active: "qwen2.5:3b", ...big });
  assert.equal(r.kind, "upgrade");
  assert.equal(r.tag, "gpt-oss:20b");
  assert.equal(r.replaces, "qwen2.5:3b");
});

test("a model that cannot call tools is always worth replacing", () => {
  const index = mergeIndex({ builtin: LADDER });
  const r = recommend({ index, installed: ["qwen2.5:0.5b"], active: "qwen2.5:0.5b", ...big });
  assert.equal(r.kind, "tools");
  assert.equal(r.tag, "gpt-oss:20b");
});

test("nothing is ever recommended that does not fit the memory free right now", () => {
  const index = mergeIndex({ builtin: LADDER });
  // 4 GB free on a 16 GB machine, running the 3B: budget is 4 - 1.05 + 2.6.
  const r = recommend({ index, installed: ["qwen2.5:3b"], active: "qwen2.5:3b", freeGb: 4, totalGb: 16 });
  assert.ok(r === null || r.needGb <= 5.6, JSON.stringify(r));
});

test("nothing is recommended that this machine could never load", () => {
  const index = mergeIndex({ builtin: LADDER });
  const r = recommend({ index, installed: ["qwen2.5:3b"], active: "qwen2.5:3b", freeGb: 7.5, totalGb: 8 });
  assert.ok(r === null || r.needGb <= 6.5, JSON.stringify(r));
});

test("an unverified model is listed but never recommended", () => {
  const index = mergeIndex({
    builtin: LADDER,
    catalog: [{ tag: "hearsay:3b", ramGb: 2.0, tools: true, rank: 999, verified: false }],
  });
  const r = recommend({ index, installed: ["qwen2.5:3b"], active: "qwen2.5:3b", ...big });
  assert.notEqual(r?.tag, "hearsay:3b");
});

test("an unrated model that is working is left alone", () => {
  const index = mergeIndex({ builtin: LADDER, probes: [{ tag: "mystery:7b", ramGb: 4.4, tools: true }] });
  assert.equal(recommend({ index, installed: ["mystery:7b"], active: "mystery:7b", ...big }), null);
});

// ── Rating what is already installed ────────────────────────

test("an estimate from download size lands near the measured ladder figures", () => {
  const cases = [["qwen2.5:0.5b", 0.4], ["qwen2.5:3b", 1.9], ["llama3.1:8b", 4.7], ["qwen2.5:14b", 9.0]];
  for (const [tag, fileGb] of cases) {
    const measured = memFit.modelRamGb(tag);
    const guess = estimateRamGb(fileGb * 1024 ** 3);
    assert.ok(Math.abs(guess - measured) <= 0.9, `${tag}: estimated ${guess}, measured ${measured}`);
  }
});

test("an unusable size estimates to nothing rather than to zero-fits-everywhere", () => {
  for (const bad of [0, -1, null, undefined, NaN, "big"]) assert.equal(estimateRamGb(bad), 0);
});

test("an Ollama that does not report capabilities leaves tool calling unknown", () => {
  assert.equal(toolsFromCapabilities(undefined), null);
  assert.equal(toolsFromCapabilities(null), null);
  assert.equal(toolsFromCapabilities(["completion"]), false);
  assert.equal(toolsFromCapabilities(["completion", "tools"]), true);
});
