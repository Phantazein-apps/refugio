// Per-connector scope options — what the model is allowed to reach.
//
// Every option is OFF by default, and off means narrower. The defaults encode
// what people actually ask a chat assistant about: one-to-one WhatsApp threads,
// today's tasks, reminders still outstanding. Archived chats, group chats, the
// Someday list and completed reminders are all real data the user may want, but
// including them by default makes every answer noisier and every tool result
// larger — which on a local 3B model is directly slower, since tool output is
// prompt the model has to read before it can start replying.
//
// An option declares HOW it is enforced, because the three mechanisms have very
// different reliability and the difference must not be buried:
//
//   force   - override an argument on matching tools. Airtight: the model
//             cannot opt out, because we rewrite the call before it is made.
//   enum    - narrow an argument's allowed values in the schema the model sees.
//             Strong, but a determined model can still emit a value outside the
//             enum, so `force` also drops disallowed values at call time.
//   filter  - drop rows from the RESULT. Used only where the connector has no
//             parameter for it. Honest but imperfect: the tool applies its own
//             `limit` before we filter, so a page of 50 chats that is mostly
//             groups yields fewer than 50 one-to-one chats. We compensate by
//             asking for more when a filter is active, and say so here rather
//             than pretending the two mechanisms are equivalent.

/** @typedef {{key:string,label:string,hint?:string,force?:object,enumAdd?:string[],filter?:string}} Option */

export const CONNECTOR_OPTIONS = {
  whatsapp: [
    {
      key: "include_archived",
      label: "Include archived chats",
      hint: "Off by default — archived is where people put threads they are done with.",
      // Hermeneia excludes archived unless told otherwise, so OFF simply pins it.
      force: { tools: ["list_chats"], args: { include_archived: false } },
    },
    {
      key: "include_groups",
      label: "Include group chats",
      hint: "Off by default — most questions are about one-to-one conversations.",
      // No parameter exists for this, so it is enforced on results.
      filter: "groups",
    },
    {
      key: "unread_only",
      label: "Unread messages only",
      hint: "Narrows every lookup to chats with something new.",
      // Inverted: this one ADDS narrowing when ON, so nothing is forced when OFF.
      onlyWhenOn: true,
      force: { tools: ["list_chats"], args: { unread_only: true } },
    },
  ],

  things: [
    { key: "include_inbox",   label: "Include Inbox",   enumAdd: ["inbox"] },
    { key: "include_someday", label: "Include Someday", enumAdd: ["someday"] },
    { key: "include_logbook", label: "Include Logbook (completed)", enumAdd: ["logbook"] },
  ],

  notes: [
    {
      key: "titles_only",
      label: "Search titles only",
      hint: "Stops REFUGIO reading note bodies while searching. Opening one note still shows its text.",
      // Full-text search has to open every note it scans, so this is the one
      // option here that changes what gets READ rather than what gets
      // returned. Enforced by removing the tool, not by filtering results —
      // a body already read is already read.
      onlyWhenOn: true,
      dropTools: ["notes_search_text"],
    },
    {
      key: "read_only",
      label: "Never create notes",
      hint: "Removes the only tool that writes. REFUGIO can still read and search.",
      onlyWhenOn: true,
      dropTools: ["notes_create"],
    },
  ],

  reminders: [
    {
      key: "today_only",
      label: "Today's reminders only",
      hint: "Reminders has no date filter, so this is applied to results.",
      onlyWhenOn: true,
      filter: "today",
    },
    {
      key: "include_completed",
      label: "Include completed",
      force: { tools: ["reminders_get_reminders"], args: { completed: false } },
    },
  ],
};

// Things 3's `status` is a single enum. Off by default means the model may only
// ask for the two lists a person means by "my tasks"; each checkbox widens it.
export const THINGS_BASE_STATUSES = ["today", "upcoming", "anytime"];

/** Options for a connector, or [] for one we have no opinions about. */
export function optionsFor(server) {
  return CONNECTOR_OPTIONS[server] || [];
}

/** Defaults: every option off. */
export function defaultSettings() {
  const out = {};
  for (const [server, opts] of Object.entries(CONNECTOR_OPTIONS)) {
    out[server] = Object.fromEntries(opts.map((o) => [o.key, false]));
  }
  return out;
}

/**
 * Arguments this connector's settings force, given the tool being called.
 *
 * Returns an object to merge OVER the model's arguments — the model does not
 * get to opt out of the user's scope choice by passing its own value.
 */
export function forcedArgs(server, bareTool, settings = {}) {
  const out = {};
  for (const o of optionsFor(server)) {
    if (!o.force) continue;
    const on = !!settings[o.key];
    // `onlyWhenOn` options add narrowing when checked; the rest pin the narrow
    // value while unchecked and get out of the way once the user opts in.
    if (o.onlyWhenOn ? !on : on) continue;
    if (o.force.tools.includes(bareTool)) Object.assign(out, o.force.args);
  }
  return out;
}

/**
 * Tools this connector's settings remove entirely.
 *
 * A third kind of narrowing, alongside forcing an argument and filtering a
 * result. Some scopes cannot be expressed as either: "never create notes" is
 * not an argument to a create tool, and "don't read note bodies" cannot be a
 * result filter because by the time there is a result the body has been read.
 *
 * Removing the tool is the only honest enforcement for those — the model is
 * never offered it, and a call to it is refused if one arrives anyway.
 */
export function droppedTools(server, settings = {}) {
  const out = [];
  for (const o of optionsFor(server)) {
    if (!o.dropTools) continue;
    const on = !!settings[o.key];
    if (o.onlyWhenOn ? !on : on) continue;
    out.push(...o.dropTools);
  }
  return out;
}

/** Which result filters are active for this connector. */
export function activeFilters(server, settings = {}) {
  return optionsFor(server)
    .filter((o) => o.filter && (o.onlyWhenOn ? !!settings[o.key] : !settings[o.key]))
    .map((o) => o.filter);
}

/** Things 3: the `status` values the model may currently use. */
export function allowedStatuses(settings = {}) {
  const extra = optionsFor("things")
    .filter((o) => settings[o.key] && o.enumAdd)
    .flatMap((o) => o.enumAdd);
  return [...THINGS_BASE_STATUSES, ...extra];
}

/**
 * Where a connector sends the user to (re)authorise itself.
 *
 * A connector can be running perfectly while the account behind it is
 * unreachable — WhatsApp unlinks a device after long inactivity, and the fix
 * is to scan a QR code, not to restart anything. Without this the panel can
 * diagnose "offline" and then offer nothing, which is the dead end the whole
 * panel exists to avoid.
 *
 * `envPort` names the variable the supervisor sets when it writes the connector
 * config, so the URL follows a port change rather than hardcoding one.
 */
export const CONNECTOR_SETUP = {
  whatsapp: {
    envPort: "HERMENEIA_QR_PORT",
    defaultPort: 3456,
    path: "/setup",
    label: "Open WhatsApp setup",
    hint: "Shows a QR code to link (or re-link) this phone.",
  },
};

/** The setup URL for a connector, from its own configured environment. */
export function setupUrlFor(server, spec) {
  const cfg = CONNECTOR_SETUP[server];
  if (!cfg) return null;
  const port = parseInt(spec?.env?.[cfg.envPort], 10) || cfg.defaultPort;
  return { url: `http://127.0.0.1:${port}${cfg.path}`, label: cfg.label, hint: cfg.hint };
}
