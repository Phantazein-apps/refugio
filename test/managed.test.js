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
  readPolicy, normalise, applyPolicy, connectorAllowed, describePolicy, POLICY_KEYS,
} from "../chat/managed.js";

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
});
