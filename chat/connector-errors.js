// Turn a connector's failure into something a person can act on.
//
// The design rule this implements, verbatim from the handoff: every failure
// names THE THING THAT REFUSED and WHAT WAS NOT READ. No "something went
// wrong". And the harder half — if REFUGIO cannot translate the output, it
// shows the connector's own words alone, prefaced with "this is unusual", and
// never invents a cause. A confident wrong explanation sends someone to fix a
// thing that isn't broken, which is worse than no explanation at all.
//
// So this module only ever returns a translation it can justify from the text.
// `headline` null means "we don't recognise this" and the UI falls back to the
// quotation.

/** @typedef {{ headline: string|null, body: string|null, advice: string[], summary: string }} Explanation */

// Each rule owns one recognisable failure. `test` must be specific enough that
// a match is evidence, not a guess — this is why there is no catch-all rule at
// the bottom.
const RULES = [
  {
    // Connection refused: something should be listening on a port and isn't.
    test: /ECONNREFUSED(?:\s|,|:)*\s*(?:connect\s+)?(?:to\s+)?([\w.-]+):(\d+)|connect ECONNREFUSED ([\d.]+):(\d+)/i,
    build: (m, ctx) => {
      const host = m[1] || m[3] || "";
      const port = m[2] || m[4] || "";
      const where = host && port ? `${host}:${port}` : "the address it was given";
      return {
        headline: `Nothing is listening on ${where}.`,
        body: `${ctx.label} tried to reach a program on this machine and the connection was refused, ` +
          "which means that program is not running — or is running on a different port. " +
          "Nothing was read, and nothing was sent anywhere.",
        advice: [
          "Start the program this connector talks to, then retry.",
          "If it runs on a different port, correct the address in mcpo-config.json.",
          `If you never set up ${ctx.label}, leaving this connector off is a fine answer.`,
        ],
        summary: "did not start",
      };
    },
  },
  {
    // The command itself is missing — a bad path in mcpo-config.json, or a
    // connector that was never installed.
    test: /ENOENT|no such file or directory|cannot find module ['"]?([^'"\s]+)|command not found|spawn .* ENOENT/i,
    build: (m, ctx) => ({
      headline: m[1]
        ? `${ctx.label} is missing a file it needs: ${m[1]}.`
        : `The program behind ${ctx.label} is not where REFUGIO expects it.`,
      body: "The connector could not be started at all, so none of its tools exist this session. " +
        "Nothing was read. This is usually an incomplete install rather than anything you did.",
      advice: [
        "Re-running the REFUGIO installer reinstalls the connectors and usually fixes this.",
        "If you moved the connector, correct its path in mcpo-config.json.",
      ],
      summary: "did not start",
    }),
  },
  {
    // macOS privacy prompts land here: the connector is fine, the OS said no.
    test: /EACCES|EPERM|permission denied|operation not permitted|not authori[sz]ed to/i,
    build: (_m, ctx) => ({
      headline: `macOS refused ${ctx.label} access to the data it reads.`,
      body: "The connector started, but the system denied it permission, so every one of its " +
        "tools would come back empty. Nothing was read.",
      advice: [
        "System Settings → Privacy & Security, then grant access and retry.",
        "If REFUGIO was never prompted, the permission may be recorded as a refusal — toggling it off and on again re-asks.",
      ],
      summary: "was refused permission",
    }),
  },
  {
    // Single-instance connectors refuse rather than fight over the session.
    // The PID path is handled separately (see `conflict` on the row, which
    // carries a verified process and a real Stop button); this is the text.
    test: /already running \(PID (\d+)\)/i,
    build: (m, ctx) => ({
      headline: `Another program is already holding ${ctx.label}.`,
      body: `There is one session per machine, and the process with PID ${m[1]} has it. ` +
        `REFUGIO cannot read anything through ${ctx.label} until that process releases it.`,
      advice: ["Stopping that process frees the session. It affects only the connector, not the app holding it."],
      summary: "is held by another program",
    }),
  },
  {
    test: /\b(401|403)\b|unauthori[sz]ed|invalid[_ ]?(?:api[_ ]?key|token|credentials)|authentication failed/i,
    build: (_m, ctx) => ({
      headline: `${ctx.label} rejected the credentials it was given.`,
      body: "The connector reached the service and was turned away, so nothing was read. " +
        "The credential is either wrong, expired, or was revoked.",
      advice: ["Re-run this connector's setup to supply a fresh credential."],
      summary: "was rejected",
    }),
  },
  {
    // Our own withTimeout(), or the child's.
    test: /timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT/i,
    build: (_m, ctx) => ({
      headline: `${ctx.label} did not answer in time.`,
      body: "The connector was started but never finished handshaking, so REFUGIO gave up on it " +
        "rather than hold the whole chat open. Nothing was read. This is sometimes just a slow " +
        "first launch.",
      advice: ["Retry — a second attempt often succeeds once the connector has warmed up."],
      summary: "did not answer",
    }),
  },
];

/**
 * Explain one failed connector.
 *
 * @param {{ error?: string|null, output?: string|null, label?: string }} row
 * @returns {Explanation}
 */
export function explain(row) {
  const label = row?.label || "This connector";
  // Both are searched: `error` is the message the pool composed (which already
  // folds in firstCause), `output` is everything the child said. A cause can
  // sit in either — the module name in a Node stack trace is in the output
  // only, while a timeout REFUGIO imposed is in the error only.
  const text = `${row?.error || ""}\n${row?.output || ""}`;

  for (const rule of RULES) {
    const m = rule.test.exec(text);
    if (m) return rule.build(m, { label });
  }

  return {
    headline: null,
    body: null,
    advice: [],
    // Used for the row's own one-line state label. "Did not start" is a fact
    // regardless of whether we understood why.
    summary: "did not start",
  };
}

/**
 * The connector's own words, split into numbered lines for quoting.
 *
 * Deduplicated and trimmed, because a crashing child often repeats itself, and
 * capped at `max` lines — this is a quotation, not a log viewer. Blank lines
 * go: they carry nothing and each one costs a numbered row.
 *
 * @returns {string[]}
 */
export function outputLines(row, max = 12) {
  const raw = String(row?.output || "").trim();
  // Fall back to the composed error so a connector that died before writing
  // anything to stderr still shows something under "what it printed", rather
  // than an empty frame implying it said nothing.
  const source = raw || String(row?.error || "").trim();
  if (!source) return [];

  const seen = new Set();
  const lines = [];
  for (const line of source.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    lines.push(t.slice(0, 400));
    if (lines.length >= max) break;
  }
  return lines;
}
