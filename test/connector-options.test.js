// Connector scope options.
//
// Three enforcement mechanisms with very different guarantees (forced
// arguments, narrowed enums, result filtering) is exactly where a wrong default
// hides quietly: the UI would show a checkbox that reads correctly while the
// tool call ignores it. These assert the mapping in both directions — that off
// really narrows, and that on really widens.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTOR_OPTIONS, defaultSettings, optionsFor,
  forcedArgs, activeFilters, allowedStatuses, THINGS_BASE_STATUSES,
} from "../chat/connector-options.js";

test("every option is off by default", () => {
  const d = defaultSettings();
  for (const [server, opts] of Object.entries(CONNECTOR_OPTIONS)) {
    for (const o of opts) {
      assert.equal(d[server][o.key], false, `${server}.${o.key} must default to off`);
    }
  }
});

test("every option declares how it is enforced", () => {
  // An option with no mechanism would render as a checkbox that does nothing —
  // worse than not offering it, because the user believes the scope changed.
  for (const [server, opts] of Object.entries(CONNECTOR_OPTIONS)) {
    for (const o of opts) {
      assert.ok(o.force || o.filter || o.enumAdd,
        `${server}.${o.key} has no force/filter/enumAdd`);
    }
  }
});

test("WhatsApp: archived is excluded until asked for", () => {
  const off = forcedArgs("whatsapp", "list_chats", { include_archived: false });
  assert.equal(off.include_archived, false, "off must pin the narrow value");

  const on = forcedArgs("whatsapp", "list_chats", { include_archived: true });
  assert.equal("include_archived" in on, false, "on must stop forcing anything");
});

test("WhatsApp: unread-only only narrows when switched on", () => {
  assert.equal("unread_only" in forcedArgs("whatsapp", "list_chats", {}), false);
  assert.equal(forcedArgs("whatsapp", "list_chats", { unread_only: true }).unread_only, true);
});

test("WhatsApp: groups are filtered out by default, kept when enabled", () => {
  assert.deepEqual(activeFilters("whatsapp", {}), ["groups"]);
  assert.deepEqual(activeFilters("whatsapp", { include_groups: true }), []);
});

test("forced arguments only apply to the tools that accept them", () => {
  // include_archived belongs to list_chats; sending it to send_message would be
  // a schema violation the connector is entitled to reject.
  assert.deepEqual(forcedArgs("whatsapp", "send_message", {}), {});
});

test("Things 3: defaults to the lists people mean by 'my tasks'", () => {
  assert.deepEqual(allowedStatuses({}), THINGS_BASE_STATUSES);
  assert.equal(allowedStatuses({}).includes("someday"), false);
  assert.equal(allowedStatuses({}).includes("logbook"), false);
  assert.equal(allowedStatuses({}).includes("inbox"), false);
});

test("Things 3: each checkbox widens the allowed statuses", () => {
  assert.ok(allowedStatuses({ include_inbox: true }).includes("inbox"));
  assert.ok(allowedStatuses({ include_someday: true }).includes("someday"));
  assert.ok(allowedStatuses({ include_logbook: true }).includes("logbook"));

  const all = allowedStatuses({ include_inbox: true, include_someday: true, include_logbook: true });
  for (const s of ["inbox", "someday", "logbook", ...THINGS_BASE_STATUSES]) {
    assert.ok(all.includes(s), `${s} missing`);
  }
});

test("Reminders: completed excluded by default, included when asked", () => {
  assert.equal(forcedArgs("reminders", "reminders_get_reminders", {}).completed, false);
  assert.equal(
    "completed" in forcedArgs("reminders", "reminders_get_reminders", { include_completed: true }),
    false);
});

test("Reminders: today-only is a result filter, off unless chosen", () => {
  // Reminders has no date parameter, so this cannot be a forced argument.
  assert.deepEqual(activeFilters("reminders", {}), []);
  assert.deepEqual(activeFilters("reminders", { today_only: true }), ["today"]);
});

test("a connector with no declared options is left alone", () => {
  assert.deepEqual(optionsFor("notion"), []);
  assert.deepEqual(forcedArgs("notion", "search", {}), {});
  assert.deepEqual(activeFilters("notion", {}), []);
});
