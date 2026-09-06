// The product split: REFUGIO and REFUGIO Listener, one repository, two installs.
//
// What this file is for is the half of the split that is not a feature. The
// modes themselves are tested in modes.test.js and are unchanged by any of
// this — both editions compile every mode, every guardrail and every crisis
// layer, and the tests that pin them run once for both. What is tested HERE is
// that the two products cannot be confused for one another:
//
//   - Nothing in the table is shared. Two installs that agreed about the port,
//     the data directory or the login item would be one install with two names,
//     and the failure would be a person's private coaching conversation opening
//     in the window they thought was the other product.
//   - Every mode belongs to exactly one of them, and asking the wrong install
//     for it is refused with the name of the right one — not with "unknown
//     mode", which reads as a bug, and not silently.
//   - The one place a fact about an edition is duplicated (install-node.cjs,
//     which runs before the repository it would read from exists) agrees with
//     the table.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import {
  MODES, definedModes, modeOffered, modeSummaries, modesUi, offeredModes,
  offeredSummaries, ownerEdition, pairedId, validateMode,
} from "../chat/modes.js";
import { EDITIONS, DEFAULT_EDITION, editionFor, isEdition, resolveEdition } from "../chat/edition.js";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IDS = Object.keys(EDITIONS);

// ── The table ───────────────────────────────────────────────

test("there are two products and standard is the one nothing has to ask for", () => {
  assert.deepEqual(IDS, ["standard", "listener"]);
  assert.equal(DEFAULT_EDITION, "standard");
  // Every install that predates the split resolves to this one, so it must
  // keep the paths those installs already have.
  const s = EDITIONS.standard;
  assert.equal(s.installDir, "refugio");
  assert.equal(s.dataDir, ".refugio-data");
  assert.equal(s.envFile, ".refugio.env");
  assert.equal(s.logDir, ".refugio-logs");
  assert.equal(s.chatPort, 8090);
  assert.equal(s.agentLabel, "com.phantazein.refugio");
});

test("nothing a person's data lives in is shared between the two", () => {
  // Not a style rule. A shared port means the other product's leftover process
  // answers as this one; a shared data directory means one SQLite file holding
  // two products' conversations; a shared login item means whichever installed
  // last silently supervises the other's directory.
  const mustDiffer = [
    "installDir", "dataDir", "envFile", "logDir", "chatPort",
    "agentLabel", "macApp", "cli", "bootstrap",
  ];
  for (const field of mustDiffer) {
    const values = IDS.map((id) => String(EDITIONS[id][field]));
    assert.equal(new Set(values).size, IDS.length,
      `${field} is shared between editions: ${values.join(", ")}`);
  }
});

test("every edition names itself and says what it is", () => {
  for (const id of IDS) {
    const e = EDITIONS[id];
    assert.equal(e.id, id, "the row knows its own key");
    assert.ok(e.product.startsWith("REFUGIO"), "both are REFUGIO");
    assert.ok(e.summary.length > 20, `${id} needs a sentence of its own`);
    assert.ok(Array.isArray(e.modeCategories) && e.modeCategories.length,
      `${id} must offer some category of mode, or it is not a product`);
  }
});

test("an unknown edition resolves to standard rather than throwing", () => {
  // A typo in an environment variable must not be able to stop a machine
  // starting. It gets the edition that has always existed, and the caller is
  // free to say so in a log.
  assert.equal(editionFor("lisener").id, "standard");
  assert.equal(editionFor(undefined).id, "standard");
  assert.equal(editionFor("").id, "standard");
  assert.equal(isEdition("listener"), true);
  assert.equal(isEdition("lisener"), false);
});

// ── How a process finds out which one it is ─────────────────

test("the environment wins, then the marker beside the code, then standard", () => {
  assert.equal(resolveEdition({ env: { REFUGIO_EDITION: "listener" }, marker: null }), "listener");
  assert.equal(resolveEdition({ env: {}, marker: "listener" }), "listener");
  // The marker is what an install IS; the variable is an override. A launchd
  // job carries no environment, which is exactly why the marker exists.
  assert.equal(resolveEdition({ env: { REFUGIO_EDITION: "standard" }, marker: "listener" }), "standard");
  assert.equal(resolveEdition({ env: {}, marker: null }), "standard");
  assert.equal(resolveEdition({ env: { REFUGIO_EDITION: "  " }, marker: "listener" }), "listener");
  // Garbage in either place is standard, not a crash and not the other one.
  assert.equal(resolveEdition({ env: { REFUGIO_EDITION: "nonsense" }, marker: "listener" }), "standard");
  assert.equal(resolveEdition({ env: {}, marker: "nonsense" }), "standard");
});

// ── Which product owns which mode ───────────────────────────

test("every mode in the build belongs to exactly one product", () => {
  // The split is by category, so the risk is a mode declaring a category no
  // edition offers — it would compile, test, and then be unreachable from
  // either install with nothing saying why.
  for (const id of definedModes()) {
    const owners = IDS.filter((e) => modeOffered(id, e));
    assert.equal(owners.length, 1,
      `${id} (category ${MODES[id].category}) is offered by ${owners.length} editions: ${owners.join(", ") || "none"}`);
  }
});

test("the two catalogues partition the build with nothing left over", () => {
  const union = IDS.flatMap((id) => offeredModes(id));
  assert.deepEqual([...union].sort(), [...definedModes()].sort());
  assert.equal(new Set(union).size, union.length, "no mode is in both");
  // And the split is the one the products were separated on.
  assert.deepEqual(offeredModes("standard"), ["whatsapp"]);
  assert.deepEqual(offeredModes("listener"), ["nvc", "styles", "spanish", "career", "life"]);
});

test("a paired variant goes with its base mode", () => {
  // The connector is not what decides: `nvc+whatsapp` is a coaching
  // conversation that may read WhatsApp, so it is the Listener's, even though
  // the connector it reads is REFUGIO's flagship.
  const paired = pairedId("nvc");
  assert.equal(paired, "nvc+whatsapp");
  assert.equal(modeOffered(paired, "listener"), true);
  assert.equal(modeOffered(paired, "standard"), false);
});

test("ownerEdition names the product that would in fact have the mode", () => {
  // The refusal copy is generated from this, so a wrong answer here sends
  // someone to install the wrong product.
  assert.equal(ownerEdition("coaching").id, "listener");
  assert.equal(ownerEdition("data").id, "standard");
  assert.equal(ownerEdition("no-such-category"), null);
});

// ── What each install offers ────────────────────────────────

test("a surface is never handed the other product's modes", () => {
  for (const edition of IDS) {
    const rows = offeredSummaries(edition);
    assert.ok(rows.length, `${edition} offers nothing at all`);
    for (const row of rows) {
      assert.equal(modeOffered(row.id, edition), true,
        `${edition} offered ${row.id}, which belongs to the other product`);
    }
  }
  // And together they are the registry view, which is what modeSummaries() is
  // still for: the doctrine tests check every mode in the build, not half.
  const both = IDS.flatMap((e) => offeredSummaries(e).map((r) => r.id));
  assert.deepEqual([...both].sort(), modeSummaries().map((r) => r.id).sort());
});

test("entering the other product's mode is refused by name, not as an unknown id", () => {
  // Three refusals that read as three different problems. This is the third,
  // and the thing that makes it useful is that it says where the mode went —
  // "not available" with no destination is how a feature reads as broken.
  const r = validateMode("nvc", { nvc: true }, null, "standard");
  assert.equal(r.ok, false);
  assert.equal(r.mode, null);
  assert.equal(r.wrongEdition, "listener");
  assert.ok(r.error.includes("NVC Coach"), "names the mode");
  assert.ok(r.error.includes("REFUGIO Listener"), "names the product that has it");
  assert.doesNotMatch(r.error, /no discussion mode called/, "not the unknown-id refusal");
  assert.doesNotMatch(r.error, /switched off/, "not the Settings trip either");

  // Both directions, and the connector mode is refused by the Listener the
  // same way.
  const back = validateMode("whatsapp", { whatsapp: true }, null, "listener");
  assert.equal(back.wrongEdition, "standard");
  assert.ok(back.error.includes("REFUGIO,"), "names REFUGIO");
});

test("a saved switch for the other product's mode is kept, not honoured", () => {
  // The settings file is not rewritten when a machine changes products: a
  // person who ran the Listener and now runs REFUGIO gets their choices back
  // if they go the other way. So `nvc: true` sitting in the file is normal,
  // and must be refused rather than obeyed.
  const stale = { nvc: true, styles: true, whatsapp: true };
  for (const id of ["nvc", "styles"]) {
    assert.equal(validateMode(id, stale, null, "standard").ok, false, `${id} must not run in REFUGIO`);
  }
  assert.equal(validateMode("whatsapp", stale, () => true, "standard").ok, true);
});

// ── What each install says ──────────────────────────────────

test("the pane names the product's own kind of mode and points at the other", () => {
  const s = modesUi("standard");
  const l = modesUi("listener");
  assert.notEqual(s.label, l.label, "two products, two names for the pane");
  assert.ok(s.otherProduct.includes("REFUGIO Listener"), "REFUGIO says where the coaching went");
  assert.ok(l.otherProduct.includes("REFUGIO"), "the Listener says where the connectors are");
  // The promises are the shared half and must not have drifted into two
  // versions — they are the same guarantees, enforced by the same code.
  assert.equal(s.privacy, l.privacy);
  assert.equal(s.connectors, l.connectors);
  assert.equal(s.note, l.note);
});

test("the standing crisis line appears only where a coaching mode can be entered", () => {
  // A hotline notice under a WhatsApp chat is a warning attached to nothing,
  // and warnings attached to nothing are how people learn to stop reading
  // them. REFUGIO offers no coaching mode, so it shows no standing line.
  assert.equal(modesUi("standard").standing, "");
  assert.match(modesUi("listener").standing, /988/);
  const coaching = offeredModes("listener").filter((id) => MODES[id].category === "coaching");
  assert.ok(coaching.length, "the Listener is the coaching product");
  assert.equal(offeredModes("standard").filter((id) => MODES[id].category === "coaching").length, 0);
});

// ── The one duplicated fact ─────────────────────────────────

test("the installer's bootstrap table agrees with editions.cjs", () => {
  // install-node.cjs is downloaded on its own and run before anything is
  // cloned, so it cannot read the table it must agree with. It carries three
  // fields — where to install, what to print, which port to check — and
  // asserts them itself once the clone lands. This is the same assertion made
  // early enough to catch the drift before anyone runs it.
  const src = readFileSync(join(ROOT, "install-node.cjs"), "utf-8");
  const m = src.match(/const EDITION_BOOT = (\{[\s\S]*?\n\})/);
  assert.ok(m, "EDITION_BOOT is no longer where this test can read it");
  const boot = new Function(`return ${m[1]}`)();
  assert.deepEqual(Object.keys(boot).sort(), IDS.slice().sort());
  for (const id of IDS) {
    assert.equal(boot[id].dir, EDITIONS[id].installDir, `${id}: install directory`);
    assert.equal(boot[id].product, EDITIONS[id].product, `${id}: product name`);
    assert.equal(boot[id].chatPort, EDITIONS[id].chatPort, `${id}: chat port`);
  }
});

test("the uninstaller falls back to the standard edition's own paths", () => {
  // It reads the table through node when it can. When it cannot — no node on
  // PATH, a copy of the script on its own — the defaults written into it must
  // still remove REFUGIO correctly, because that is every install that
  // predates the split.
  const src = readFileSync(join(ROOT, "uninstall-refugio"), "utf-8");
  const s = EDITIONS.standard;
  for (const [name, value] of [
    ["PRODUCT", s.product], ["INSTALL_DIR", s.installDir], ["DATA_DIR", s.dataDir],
    ["ENV_FILE", s.envFile], ["LOG_DIR", s.logDir], ["AGENT_LABEL", s.agentLabel],
    ["MAC_APP", s.macApp], ["CLI", s.cli], ["BOOTSTRAP", s.bootstrap],
  ]) {
    assert.ok(src.includes(`${name}="${value}"`), `uninstall-refugio's ${name} default is not ${value}`);
  }
});

test("each edition has a bootstrap that installs it and nothing else", () => {
  for (const id of IDS) {
    const src = readFileSync(join(ROOT, EDITIONS[id].bootstrap), "utf-8");
    assert.ok(src.includes("REFUGIO_EDITION"), `${EDITIONS[id].bootstrap} never mentions the edition`);
  }
  // The Listener's bootstrap presets the edition rather than reimplementing
  // the installer; the shared one defaults to standard so an existing command
  // line keeps meaning what it meant.
  assert.match(readFileSync(join(ROOT, "install-listener"), "utf-8"),
    /export REFUGIO_EDITION=listener/);
  assert.match(readFileSync(join(ROOT, "install-refugio"), "utf-8"),
    /REFUGIO_EDITION="\$\{REFUGIO_EDITION:-standard\}"/);
});

test("the runtime table is loadable from CommonJS as well as from here", () => {
  // Three consumers in two module systems read this file: the installer and
  // the supervisor with require(), the chat server with import. A change that
  // broke either half would be found at install time, on someone's machine.
  const cjs = require(join(ROOT, "editions.cjs"));
  assert.deepEqual(Object.keys(cjs.EDITIONS), IDS);
  assert.equal(cjs.editionFor("listener").product, "REFUGIO Listener");
  assert.equal(cjs.MARKER_FILE, ".refugio-edition");
});
