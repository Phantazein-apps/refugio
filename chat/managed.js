// Managed policy — settings an administrator sets, and a user cannot change.
//
// This is what separates "deployable by MDM" from "installable by MDM". A .pkg
// an admin can push but not configure is a silent installer; what an IT
// department actually asks for is the ability to say "web search off, and no
// update checks" and have that hold on 400 laptops whose users never see the
// decision.
//
// Three sources, one per platform, all of them the OS's own mechanism rather
// than a file of ours in a well-known place:
//
//   macOS    /Library/Managed Preferences/com.phantazein.refugio.plist
//            written by a configuration profile pushed from Jamf / Intune /
//            Kandji. Read through `plutil`, because a managed plist is binary
//            and a hand-rolled binary-plist parser is not something to own.
//   Windows  HKLM\SOFTWARE\Policies\Phantazein\REFUGIO
//            the Policies hive, so Group Policy and Intune's ADMX ingestion
//            both land in the right place and a standard user cannot write it.
//   Linux    /etc/refugio/managed.json
//            no equivalent OS mechanism, so a root-owned file it is.
//
// The rule everywhere: policy can only ever make REFUGIO do LESS. An admin can
// force web search off; there is deliberately no way to force it on for
// everyone, because the arming warning in the chat is a promise made to the
// person at the keyboard and an administrator is not the one it was made to.

import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";

export const MACOS_PLIST = "/Library/Managed Preferences/com.phantazein.refugio.plist";
export const LINUX_JSON = "/etc/refugio/managed.json";
export const WINDOWS_KEY = "HKLM\\SOFTWARE\\Policies\\Phantazein\\REFUGIO";

/** Every key an administrator may set, and what it does.
 *
 *  Exported because two other things need it and must not drift from it: the
 *  ADMX template Windows admins load into Group Policy, and the sample
 *  .mobileconfig macOS admins start from. A key here that is missing from
 *  those is a key nobody can discover. */
export const POLICY_KEYS = {
  webSearch: {
    type: "enum", values: ["user", "off"], default: "user",
    describes: "Whether the user may turn on web search at all.",
  },
  updateChecks: {
    type: "enum", values: ["user", "off"], default: "user",
    describes: "Whether REFUGIO may contact github.com to look for a newer version.",
  },
  attachments: {
    type: "enum", values: ["user", "off"], default: "user",
    describes: "Whether files may be attached to a message.",
  },
  allowedConnectors: {
    type: "list", default: null,
    describes: "If set, only these connector ids may run. Anything else is not started.",
  },
};

/** Read the policy the OS is publishing, or `{}` if there is none.
 *
 *  Never throws. A machine with no policy is the overwhelmingly common case
 *  and must cost nothing; a machine with a MALFORMED policy is the dangerous
 *  one, and the safe answer there is also `{}` — refusing to start because an
 *  administrator typed a bad plist key would turn a cosmetic mistake into a
 *  fleet-wide outage. What it does instead is say so in the log. */
export function readPolicy({ platform = process.platform, env = process.env, log = () => {} } = {}) {
  // An explicit path wins on every platform. This is how the packaging tests
  // exercise policy without a registry or a managed plist, and it gives an
  // admin on an unmanaged machine a way to try a policy before pushing it.
  const override = env.REFUGIO_MANAGED_POLICY;
  if (override) return fromJsonFile(override, log);
  if (platform === "darwin") return fromMacOS(log);
  if (platform === "win32") return fromWindows(log);
  return fromJsonFile(LINUX_JSON, log);
}

function fromJsonFile(path, log) {
  if (!existsSync(path)) return {};
  try {
    return normalise(JSON.parse(readFileSync(path, "utf-8")), log);
  } catch (e) {
    log(`managed policy at ${path} could not be read (${e.message}) — ignoring it`);
    return {};
  }
}

/** macOS: convert the managed plist to JSON with the OS's own tool.
 *
 *  `plutil` rather than `defaults read`: defaults prints its own format, which
 *  has to be parsed by eye, and it consults a preference domain rather than a
 *  file — so it can silently answer from a user-level preference when the
 *  question was about the managed one. */
function fromMacOS(log) {
  if (!existsSync(MACOS_PLIST)) return {};
  try {
    const json = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", MACOS_PLIST], {
      encoding: "utf-8", timeout: 5000,
    });
    return normalise(JSON.parse(json), log);
  } catch (e) {
    log(`managed profile could not be read (${e.message}) — ignoring it`);
    return {};
  }
}

/** Windows: read the Policies hive.
 *
 *  `reg query` rather than PowerShell — it is a fraction of the startup cost,
 *  it is present on every SKU including Server Core, and it does not depend on
 *  an execution policy that an administrator may well have locked down. */
function fromWindows(log) {
  let out;
  try {
    out = execFileSync("reg", ["query", WINDOWS_KEY], { encoding: "utf-8", timeout: 5000 });
  } catch {
    return {};                       // no key at all — the normal case
  }
  const raw = {};
  // Lines look like:  "    webSearch    REG_SZ    off"
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s{4,}(\S+)\s+REG_(SZ|EXPAND_SZ|DWORD|MULTI_SZ)\s+(.*)$/);
    if (!m) continue;
    const [, name, type, value] = m;
    if (type === "DWORD") raw[name] = parseInt(value, 16) !== 0;
    else if (type === "MULTI_SZ") raw[name] = value.split("\\0").filter(Boolean);
    else raw[name] = value.trim();
  }
  return normalise(raw, log);
}

/** Keep only keys we know, with values we know, and say what was dropped.
 *
 *  Silently ignoring a misspelled key is how an administrator ends up believing
 *  web search is off across the fleet when it is on everywhere. The log line is
 *  the only chance anyone has of noticing. */
export function normalise(raw, log = () => {}) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    const spec = POLICY_KEYS[key];
    if (!spec) { log(`managed policy: ignoring unknown key "${key}"`); continue; }
    if (spec.type === "list") {
      const list = Array.isArray(value) ? value.map(String)
        : typeof value === "string" ? value.split(/[,\s]+/).filter(Boolean)
        : null;
      if (!list) { log(`managed policy: "${key}" should be a list — ignoring it`); continue; }
      out[key] = list;
      continue;
    }
    // A boolean is accepted for the enums too. An admin writing a DWORD in the
    // registry or a <true/> in a plist means "off", and refusing that reading
    // would be pedantry with a fleet-sized blast radius.
    const v = typeof value === "boolean" ? (value ? "off" : "user") : String(value).toLowerCase();
    if (!spec.values.includes(v)) {
      log(`managed policy: "${key}" must be one of ${spec.values.join(" / ")} — ignoring "${value}"`);
      continue;
    }
    out[key] = v;
  }
  return out;
}

/** Clamp a settings object to what policy allows.
 *
 *  Returns new settings plus which of them are locked, because the UI has to
 *  DISABLE a managed switch rather than let it be flipped and then quietly
 *  flip back. A control that reverts is read as a bug in REFUGIO; a control
 *  that is greyed out and says who set it is read as the truth. */
export function applyPolicy(settings, policy = {}) {
  const next = { ...settings };
  const locked = {};

  if (policy.webSearch === "off") {
    next.web = { ...next.web, enabled: false };
    locked.web = true;
  }
  if (policy.updateChecks === "off") {
    next.updates = { ...next.updates, enabled: false };
    locked.updates = true;
  }
  if (policy.attachments === "off") locked.attachments = true;

  if (policy.allowedConnectors) {
    const allow = new Set(policy.allowedConnectors);
    locked.connectors = [...allow];
  }
  return { settings: next, locked };
}

/** Is this connector permitted to run at all?
 *
 *  Enforced where connectors are STARTED, not where they are displayed. A
 *  connector that is merely hidden is still running, still holding a session
 *  to the user's WhatsApp, and still one prompt away from being read. */
export function connectorAllowed(id, policy = {}) {
  return !policy.allowedConnectors || policy.allowedConnectors.includes(id);
}

/** One line for the log at startup, or null when nothing is managed.
 *
 *  Worth printing every boot: the single hardest managed-machine question to
 *  answer from a support call is "is a policy even reaching this laptop?" */
export function describePolicy(policy = {}) {
  const parts = [];
  if (policy.webSearch === "off") parts.push("web search off");
  if (policy.updateChecks === "off") parts.push("update checks off");
  if (policy.attachments === "off") parts.push("attachments off");
  if (policy.allowedConnectors) parts.push(`connectors limited to ${policy.allowedConnectors.join(", ")}`);
  return parts.length ? `managed policy in effect — ${parts.join("; ")}` : null;
}
