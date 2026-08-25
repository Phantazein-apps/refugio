// Managed policy.
//
// The thing worth testing here is not that a valid policy is read — it is what
// happens to an INVALID one. An administrator pushes a profile to 400 machines
// and does not get to watch them boot. A typo that makes REFUGIO refuse to
// start is a fleet outage; a typo that is silently ignored leaves an admin
// believing web search is off everywhere when it is on everywhere. Neither is
// acceptable, so the rule is: ignore what cannot be understood, keep running,
// and say in the log exactly what was dropped.
//
// The other rule with teeth: policy may only ever narrow. There is no value of
// any key that turns web search ON for a user who did not arm it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readPolicy, normalise, applyPolicy, connectorAllowed, modeAllowed, describePolicy, POLICY_KEYS,
} from "../chat/managed.js";
import { MODE_DEFAULTS, MODE_IDS } from "../chat/modes.js";

const SETTINGS = { web: { enabled: true }, updates: { enabled: true }, notes: { read_only: false } };

function withPolicyFile(obj, fn) {
  const dir = mkdtempSync(join(tmpdir(), "refugio-policy-"));
  const path = join(dir, "managed.json");
  writeFileSync(path, typeof obj === "string" ? obj : JSON.stringify(obj));
  try { return fn(path); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── Reading ─────────────────────────────────────────────────

test("an unmanaged machine costs nothing and reports nothing", () => {
  const p = readPolicy({ platform: "linux", env: { REFUGIO_MANAGED_POLICY: "/nowhere/at/all.json" } });
  assert.deepEqual(p, {});
  assert.equal(describePolicy(p), null);
});

test("a policy file is read on any platform when pointed at explicitly", () => {
  withPolicyFile({ webSearch: "off" }, (path) => {
    assert.deepEqual(readPolicy({ platform: "linux", env: { REFUGIO_MANAGED_POLICY: path } }), { webSearch: "off" });
    // The override wins on macOS and Windows too — that is how an admin tries
    // a policy before pushing it, and how these tests run at all.
    assert.deepEqual(readPolicy({ platform: "darwin", env: { REFUGIO_MANAGED_POLICY: path } }), { webSearch: "off" });
    assert.deepEqual(readPolicy({ platform: "win32", env: { REFUGIO_MANAGED_POLICY: path } }), { webSearch: "off" });
  });
});

test("a corrupt policy does not stop REFUGIO starting", () => {
  const said = [];
  withPolicyFile("{ this is not json", (path) => {
    const p = readPolicy({ platform: "linux", env: { REFUGIO_MANAGED_POLICY: path }, log: (m) => said.push(m) });
    assert.deepEqual(p, {});
  });
  // Silence here would be the worst outcome: the admin believes the policy
  // applied, and nothing anywhere says it didn't.
  assert.match(said.join("\n"), /could not be read/);
});

// ── Validation ──────────────────────────────────────────────

test("a misspelled key is dropped, and said out loud", () => {
  const said = [];
  const p = normalise({ webSerch: "off" }, (m) => said.push(m));
  assert.deepEqual(p, {});
  assert.match(said.join("\n"), /unknown key "webSerch"/);
});

test("a value outside the allowed set is dropped, and said out loud", () => {
  const said = [];
  const p = normalise({ webSearch: "disabled" }, (m) => said.push(m));
  assert.deepEqual(p, {});
  assert.match(said.join("\n"), /must be one of user \/ off/);
});

test("case does not decide whether a fleet policy applies", () => {
  assert.deepEqual(normalise({ webSearch: "OFF" }), { webSearch: "off" });
});

test("a boolean is read the way an admin meant it", () => {
  // A DWORD in the registry and a <true/> in a plist are both natural ways to
  // write "off". Rejecting them would be pedantry with a fleet-sized cost.
  assert.deepEqual(normalise({ webSearch: true }), { webSearch: "off" });
  assert.deepEqual(normalise({ webSearch: false }), { webSearch: "user" });
});

test("a connector list survives as a list, however it was written", () => {
  assert.deepEqual(normalise({ allowedConnectors: ["notes", "reminders"] }).allowedConnectors,
    ["notes", "reminders"]);
  // REG_SZ has no list type, so a Windows admin writes a string.
  assert.deepEqual(normalise({ allowedConnectors: "notes, reminders" }).allowedConnectors,
    ["notes", "reminders"]);
});

test("garbage in a list key is dropped rather than half-applied", () => {
  const said = [];
  assert.deepEqual(normalise({ allowedConnectors: 42 }, (m) => said.push(m)), {});
  assert.match(said.join("\n"), /should be a list/);
});

test("every documented key is one the reader accepts", () => {
  // POLICY_KEYS is what the ADMX template and the sample .mobileconfig are
  // generated from. A key documented there and rejected here would be a key an
  // administrator sets, sees accepted by Group Policy, and which does nothing.
  for (const [key, spec] of Object.entries(POLICY_KEYS)) {
    const value = spec.type === "list" ? ["x"] : spec.values.find((v) => v !== spec.default);
    assert.deepEqual(Object.keys(normalise({ [key]: value })), [key], `${key} must be readable`);
  }
});

// ── Applying ────────────────────────────────────────────────

test("policy turns web search off and marks it locked", () => {
  const { settings, locked } = applyPolicy(SETTINGS, { webSearch: "off" });
  assert.equal(settings.web.enabled, false);
  // Locked matters as much as off. A switch that flips back when you press it
  // reads as a bug in REFUGIO; a disabled switch reads as an administrator.
  assert.equal(locked.web, true);
});

test("policy can never turn web search on", () => {
  // There is deliberately no "on" — the arming warning in the composer is a
  // promise to the person at the keyboard, and an administrator is not who it
  // was made to. Assert the shape rather than trusting the enum stays small.
  assert.ok(!POLICY_KEYS.webSearch.values.includes("on"));
  const off = { web: { enabled: false }, updates: { enabled: false } };
  const { settings } = applyPolicy(off, normalise({ webSearch: "on" }));
  assert.equal(settings.web.enabled, false, "an unreadable value must not enable anything");
});

test("an unmanaged machine's settings come back untouched", () => {
  const { settings, locked } = applyPolicy(SETTINGS, {});
  assert.deepEqual(settings, SETTINGS);
  assert.deepEqual(locked, {});
});

test("update checks can be forced off", () => {
  const { settings, locked } = applyPolicy(SETTINGS, { updateChecks: "off" });
  assert.equal(settings.updates.enabled, false);
  assert.equal(locked.updates, true);
});

test("attachments lock without touching the settings file", () => {
  // Attachments are not a stored setting — there is nothing to clamp, only
  // something to refuse. So this locks and changes nothing else.
  const { settings, locked } = applyPolicy(SETTINGS, { attachments: "off" });
  assert.equal(locked.attachments, true);
  assert.deepEqual(settings.web, SETTINGS.web);
});

test("an allow-list permits what it names and nothing else", () => {
  const policy = { allowedConnectors: ["notes", "reminders"] };
  assert.equal(connectorAllowed("notes", policy), true);
  assert.equal(connectorAllowed("whatsapp", policy), false);
});

test("no allow-list means every connector runs", () => {
  assert.equal(connectorAllowed("whatsapp", {}), true);
  assert.equal(connectorAllowed("anything", {}), true);
});

// ── Discussion modes (Session 8) ────────────────────────────
//
// The mode allow-list differs from the connector one in the way that matters:
// a connector is a process you decline to start, and a mode is a boolean
// somebody already saved. So this list has to CLAMP as well as lock, or a
// laptop that had NVC Coach switched on last month keeps it after the policy
// lands — visible, working, and forbidden.

const MODE_SETTINGS = () => ({
  web: { enabled: true },
  modes: { ...MODE_DEFAULTS, nvc: true, career: true, life: true },
});

test("a mode allow-list turns off the modes it does not name", () => {
  const { settings, locked } = applyPolicy(MODE_SETTINGS(), { allowedModes: ["nvc"] });
  assert.equal(settings.modes.nvc, true, "a permitted mode keeps whatever the user chose");
  assert.equal(settings.modes.career, false, "a forbidden mode is turned off, not merely hidden");
  assert.equal(settings.modes.life, false);
  // The allow list itself, not `true`. A surface reading this as a boolean
  // would grey out every mode the moment an administrator permitted one.
  assert.deepEqual(locked.modes, ["nvc"]);
});

test("an empty allow-list takes the feature away entirely", () => {
  // `allowedModes: none` in a registry string, or an empty array in a plist.
  // An empty list is still a list, so this must not read as "no policy".
  const { settings, locked } = applyPolicy(MODE_SETTINGS(), { allowedModes: [] });
  for (const id of MODE_IDS) assert.equal(settings.modes[id], false, `${id} must be off`);
  assert.deepEqual(locked.modes, []);
});

test("no mode policy leaves every mode to the user", () => {
  const { settings, locked } = applyPolicy(MODE_SETTINGS(), {});
  assert.equal(settings.modes.nvc, true);
  assert.equal(settings.modes.career, true);
  assert.equal(locked.modes, undefined, "unmanaged must be absent, not an empty list");
});

test("a paired variant is governed by the mode it is a variant of", () => {
  // "NVC Coach + WhatsApp" is not a second mode with a second switch; it is a
  // way of holding an NVC conversation, and which connectors it may reach is
  // already `allowedConnectors`' answer.
  const policy = { allowedModes: ["nvc"] };
  assert.equal(modeAllowed("nvc", policy), true);
  assert.equal(modeAllowed("nvc+whatsapp", policy), true);
  assert.equal(modeAllowed("styles", policy), false);
  assert.equal(modeAllowed("spanish", policy), false);
});

test("no mode allow-list means every mode may be switched on", () => {
  for (const id of MODE_IDS) assert.equal(modeAllowed(id, {}), true);
  assert.equal(modeAllowed("nvc+whatsapp", {}), true);
});

test("the mode policy is a list, and a misspelled one is dropped by name", () => {
  const said = [];
  assert.deepEqual(normalise({ allowedModes: ["nvc", "career"] }).allowedModes, ["nvc", "career"]);
  // What a Windows administrator types into the Group Policy text box.
  assert.deepEqual(normalise({ allowedModes: "nvc, career" }).allowedModes, ["nvc", "career"]);
  assert.deepEqual(normalise({ allowedModes: 42 }, (m) => said.push(m)), {});
  assert.match(said.join(" "), /allowedModes/);
  // A mode id that does not exist is NOT rejected here on purpose: this file
  // does not know the registry, and an admin who writes "nvc, listener" on a
  // build where Listener has not shipped should get the mode that exists
  // rather than a policy that fails whole. It narrows, so an unknown id
  // permits nothing.
  assert.deepEqual(normalise({ allowedModes: "nvc, hypnotherapist" }).allowedModes,
    ["nvc", "hypnotherapist"]);
});

// ── The templates admins actually edit ──────────────────────
//
// Three files have to agree on the key names: this reader, the .mobileconfig a
// Mac admin starts from, and the .admx a Windows admin loads into Group
// Policy. Drift between them has no symptom. An administrator sets a policy,
// Group Policy accepts it, the registry holds it, and REFUGIO ignores it — and
// the only way anyone finds out is by testing whether web search still works
// on a machine that was supposed to have it disabled, which nobody does.

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf-8");

test("every key in the macOS profile is one REFUGIO reads", () => {
  const xml = read("../packaging/macos/profiles/com.phantazein.refugio.settings.mobileconfig");
  const body = xml.split("<key>mcx_preference_settings</key>")[1];
  assert.ok(body, "the sample profile must actually set some preferences");
  const keys = [...body.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  assert.ok(keys.length >= 4, `expected the profile to demonstrate every key, saw ${keys.length}`);
  for (const k of keys) {
    assert.ok(POLICY_KEYS[k], `the profile sets "${k}", which chat/managed.js does not read`);
  }
});

test("every key in the Group Policy template is one REFUGIO reads", () => {
  const admx = read("../packaging/windows/REFUGIO.admx");
  const keys = [...admx.matchAll(/valueName="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 4, `expected a policy per key, saw ${keys.length}`);
  for (const k of keys) {
    assert.ok(POLICY_KEYS[k], `the ADMX sets "${k}", which chat/managed.js does not read`);
  }
});

test("every key REFUGIO reads is discoverable in both templates", () => {
  // The other direction, and the one that matters more: a key nobody can find
  // in Group Policy or in the sample profile is a key nobody will ever set.
  const admx = read("../packaging/windows/REFUGIO.admx");
  const profile = read("../packaging/macos/profiles/com.phantazein.refugio.settings.mobileconfig");
  for (const key of Object.keys(POLICY_KEYS)) {
    assert.ok(admx.includes(`valueName="${key}"`), `${key} is missing from REFUGIO.admx`);
    assert.ok(profile.includes(`<key>${key}</key>`), `${key} is missing from the sample .mobileconfig`);
  }
});

test("the Group Policy template only ever narrows", () => {
  // Assert on the shipped file, not on intent. A future edit that adds
  // <enabledValue><string>on</string></enabledValue> would hand an
  // administrator the ability to turn web search on for someone who never
  // armed it, which is the one thing this design promises cannot happen.
  const admx = read("../packaging/windows/REFUGIO.admx");
  const enabled = [...admx.matchAll(/<enabledValue><string>([^<]*)<\/string><\/enabledValue>/g)].map((m) => m[1]);
  for (const v of enabled) {
    assert.equal(v, "off", `a policy enables "${v}" — policy may only ever take a capability away`);
  }
});

// ── Saying so ───────────────────────────────────────────────

test("a managed machine says so at startup", () => {
  // The hardest question on a managed-machine support call is "is a policy
  // even reaching this laptop?". One line at boot answers it.
  const line = describePolicy({ webSearch: "off", allowedConnectors: ["notes"] });
  assert.match(line, /web search off/);
  assert.match(line, /connectors limited to notes/);
  assert.match(describePolicy({ allowedModes: ["nvc"] }), /discussion modes limited to nvc/);
  // An empty list is the one policy whose meaning is not obvious from the
  // list, so it gets its own sentence rather than "limited to ".
  assert.match(describePolicy({ allowedModes: [] }), /discussion modes all locked off/);
});
