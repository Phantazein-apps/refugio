// The tool-calling floor, guarded.
//
// REFUGIO is connectors: a local model reading your own data. A model that
// can't call tools turns it into a chat window whose connectors silently do
// nothing — the failure that motivated these rules, and one that produces no
// error anywhere. It reappeared once already because install-node.cjs carried
// the comment "All are tool-calling capable" above a list that included
// llama3.2:1b, which isn't. Prose can't hold this line; these tests can.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const memFit = createRequire(import.meta.url)(join(root, "scripts", "mem-fit.cjs"));

/** The tags pickModelForRam() can return, read from the source rather than
 *  duplicated here — a copy would drift exactly as the comment did. */
function installerTiers() {
  const src = readFileSync(join(root, "install-node.cjs"), "utf8");
  const body = src.slice(src.indexOf("function pickModelForRam"));
  const end = body.indexOf("\n}");
  return [...body.slice(0, end).matchAll(/return "([\w.:-]+)"/g)].map((m) => m[1]);
}

test("every model the installer can choose can call tools", () => {
  const tiers = installerTiers();
  assert.ok(tiers.length >= 4, `expected several tiers, parsed ${tiers.length}`);
  for (const tag of tiers) {
    assert.equal(memFit.supportsTools(tag), true,
      `${tag} is offered by the installer but cannot call tools`);
  }
});

test("the ladder's floor is the smallest tool-capable model", () => {
  const first = memFit.MODEL_LADDER.find((m) => m.tools);
  assert.equal(memFit.TOOL_FLOOR.tag, first.tag);
  // Anything below the floor must be flagged incapable, not merely smaller.
  const below = memFit.MODEL_LADDER.slice(0, memFit.ladderIndex(first.tag));
  for (const m of below) assert.equal(m.tools, false, `${m.tag} should be tools:false`);
});

test("the companion model never drops below the floor", () => {
  for (const m of memFit.MODEL_LADDER.filter((x) => x.tools)) {
    const { current } = memFit.installPair(m.tag);
    if (current) {
      assert.equal(memFit.supportsTools(current), true,
        `installPair(${m.tag}) offers ${current}, which cannot call tools`);
    }
  }
});

test("a busy machine keeps a tool-capable model instead of downgrading", () => {
  // The reported case: 8 GB Mac, ~1.1 GB free, all three models installed.
  const pick = memFit.pickInstalledModel({
    availableGb: 1.1,
    owuiOverheadGb: 0.05,
    installedTags: ["qwen2.5:3b", "qwen2.5:0.5b", "llama3.2:1b"],
  });
  assert.equal(pick.tag, "qwen2.5:3b");
  assert.equal(pick.tools, true);
  assert.equal(pick.fits, false, "should report the squeeze rather than hide it");
});

test("only tool-blind models installed is reported, not silently accepted", () => {
  const pick = memFit.pickInstalledModel({
    availableGb: 8,
    installedTags: ["qwen2.5:0.5b", "llama3.2:1b"],
  });
  assert.equal(pick.tools, false, "callers rely on this to warn the user");
});

test("an unrated model is unknown, not incapable", () => {
  // Warning about models we've never tested would train users to ignore the bar.
  assert.equal(memFit.supportsTools("mistral-nemo:latest"), null);
});

test("machineSupport separates a hardware limit from a busy machine", () => {
  const small = memFit.machineSupport({ totalGb: 4, freeGb: 2 });
  assert.equal(small.supported, false);
  assert.equal(small.transient, false, "4 GB cannot be fixed by closing apps");

  const busy = memFit.machineSupport({ totalGb: 8, freeGb: 1.1 });
  assert.equal(busy.supported, false);
  assert.equal(busy.transient, true, "8 GB can be fixed by closing apps");

  const idle = memFit.machineSupport({ totalGb: 8, freeGb: 5 });
  assert.equal(idle.supported, true, "8 GB idle must stay supported");
});
