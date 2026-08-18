// REFUGIO settings — connectors, models, web search, appearance, data.
//
// Implements frames 4a, 4b, 4c and 4e of the Claude Design handoff. The rules
// the design states, which the code below is arranged to keep:
//
//   · A row states its condition once — one dot, one label, one coloured rule.
//   · Scope options exist only on a connector that works. "Off" must always
//     mean narrower, and a checkbox on a dead connector promises a narrowing
//     that isn't happening.
//   · Exactly one filled red button per situation, and it is the fix that can
//     actually work. Everything else is outlined or a text link.
//   · Every failure names the thing that refused and what was not read. If
//     REFUGIO cannot translate the output it quotes it and says so — it never
//     invents a cause.
//   · A connector being down is a normal state. It never takes over the window.
//
// Everything a connector or a child process said is inserted with textContent.
// This page renders the stderr of arbitrary local programs; none of it is
// trusted as markup.

import { preferredModel, setPreferredModel, activeModel } from "./model-store.js";
import { themePreference, setThemePreference } from "./theme.js";

const $ = (id) => document.getElementById(id);

/** Minimal DOM builder. `el("div.row.failed", {}, child, "text")`. */
function el(spec, attrs = {}, ...kids) {
  const [tag, ...classes] = spec.split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "on") { for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn); }
    else if (k === "text") node.textContent = v;
    else if (k === "class") node.className = `${node.className} ${v}`.trim();
    else if (k in node && k !== "list") node[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const state = {
  status: null,
  connectors: null,
  /** Rows the user has expanded or collapsed by hand, so a refresh doesn't
   *  slam shut a panel someone is reading. */
  open: new Map(),
  /** Failed rows whose verbatim output has been revealed. Collapsed by
   *  default — it is evidence, not the explanation. */
  showOutput: new Set(),
  pulling: new Map(),
  update: null,
  /** The last rescan's answer. Kept out of `status` because it is a record of
   *  something the user DID — it must not be wiped by the next poll. */
  rescan: null,
};

// ── Navigation ──────────────────────────────────────────────

function showPane(name) {
  for (const b of document.querySelectorAll(".snav-item")) {
    b.classList.toggle("is-active", b.dataset.pane === name);
  }
  for (const p of document.querySelectorAll(".pane")) {
    p.classList.toggle("is-active", p.id === `pane-${name}`);
  }
  // The hash makes a pane linkable — the chat's "fix this connector" link
  // lands on /settings#connectors rather than on whatever was open last.
  if (location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
  $("spane").scrollTop = 0;
  // Counted fresh each time it is opened rather than polled: the numbers are a
  // COUNT(*) over the whole database, and this pane is the one place they are
  // load-bearing — it offers to destroy exactly what it says it will.
  if (name === "data") renderData();
}

for (const b of document.querySelectorAll(".snav-item")) {
  b.addEventListener("click", () => showPane(b.dataset.pane));
}

// ── Connectors (4a, 4b, 4c) ─────────────────────────────────

const STATE_LABEL = {
  ok: "Ready",
  connecting: "Connecting",
  degraded: "Degraded",
  failed: "Failed",
};

/** The one-line condition, stated once, in the row header. */
function stateLabel(row) {
  if (row.state === "ok") return "READY";
  if (row.state === "connecting") return "CONNECTING";
  if (row.state === "degraded") {
    const off = row.accounts.filter((a) => !a.connected).length;
    // Name what is degraded, not just that something is. "One account
    // unreachable" is actionable; "degraded" is a status page word.
    if (off && row.accounts.length > 1) return `DEGRADED · ${off} OF ${row.accounts.length} ACCOUNTS UNREACHABLE`;
    if (off) return "DEGRADED · ACCOUNT UNREACHABLE";
    if (row.accountsUnknown) return "DEGRADED · NOT ANSWERING";
    return "DEGRADED";
  }
  if (row.conflict) return "FAILED · HELD BY ANOTHER PROGRAM";
  return `FAILED · ${(row.explanation?.summary || "did not start").toUpperCase()}`;
}

/** Right-hand meta: what this connector is currently worth to you. */
function rowMeta(row) {
  if (row.state === "connecting") return "starting…";
  if (row.state === "failed") return "no tools";
  const n = row.tools || 0;
  return `${n} tool${n === 1 ? "" : "s"}`;
}

function connectorRow(row) {
  const open = state.open.get(row.id) ?? (row.state === "degraded" || row.state === "failed");
  const hasBody = row.state !== "connecting" &&
    (row.state === "failed" || row.state === "degraded" || row.accounts.length > 0 || row.options.length > 0);

  const head = el("button.row-head", {
    type: "button",
    disabled: !hasBody,
    "aria-expanded": String(open && hasBody),
    on: { click: () => { state.open.set(row.id, !open); renderConnectors(); } },
  },
    el(`span.dot.${row.state === "ok" ? "ok" : row.state}`),
    el("span.row-name", { text: row.label }),
    el(`span.state-label.${row.state === "ok" ? "ok" : row.state}`, { text: stateLabel(row) }),
    el("span.row-meta", { text: rowMeta(row) }),
    hasBody ? el("span.row-caret", { text: open ? "▴" : "▾" }) : null,
  );

  const node = el(`div.row.${row.state === "ok" ? "ready" : row.state}`, {}, head);
  if (hasBody && open) node.append(connectorBody(row));
  return node;
}

function connectorBody(row) {
  if (row.state === "failed") return failedBody(row);
  if (row.state === "degraded") return degradedBody(row);
  return readyBody(row);
}

/** READY — accounts, then scope. Nothing to fix, so nothing to press. */
function readyBody(row) {
  const kids = [];
  if (row.accounts.length) kids.push(accountList(row));
  if (row.options.length) kids.push(scopeOptions(row));
  return el("div.row-body.indent", {}, kids);
}

/** DEGRADED — the reason in prose, then the one fix that can work.
 *
 *  No scope options here: this connector's tools already come back empty, and
 *  offering to narrow them further would be theatre. */
function degradedBody(row) {
  const kids = [];
  const off = row.accounts.filter((a) => !a.connected);

  if (off.length) {
    kids.push(el("div.prose", {},
      "The connector is running, but ",
      el("strong", { text: off.length === row.accounts.length && off.length === 1
        ? "its account is no longer linked"
        : `${off.length} of its ${row.accounts.length} accounts ${off.length === 1 ? "is" : "are"} no longer linked` }),
      " — the phone dropped this device. Anything that asks about it comes back empty " +
      "rather than failing, which is why it can look healthy."));
  } else if (row.accountsUnknown) {
    kids.push(el("div.prose", {},
      "The connector is running but ", el("strong", { text: "stopped answering" }),
      ". REFUGIO cannot tell which of its accounts are reachable, so it is not " +
      "treating any of them as working."));
  } else if (row.explanation?.headline) {
    kids.push(el("div.prose", { text: row.explanation.headline }));
  }

  if (row.accounts.length) kids.push(accountList(row));

  // The fix, and only the fix. Where re-linking is available it is the whole
  // answer and it lives on the account row above — so no retry button is
  // offered here at all. An outlined "Retry" underneath the sentence
  // "restarting will not help" is a contradiction the reader has to resolve,
  // and most will resolve it by pressing the button.
  const canRelink = row.accounts.some((a) => !a.connected) && !!row.setup;
  if (canRelink) {
    kids.push(el("div.aside", {
      text: "Restarting will not help: only re-linking can repair a device the phone has dropped.",
    }));
  } else if (row.setup) {
    kids.push(el("div.actions", {}, setupLink(row.setup, { primary: true })));
  } else {
    // Nothing to re-link against. Retrying is now the best available action,
    // so it becomes the primary one rather than a consolation beside it.
    kids.push(el("div.actions", {}, retryButton(row, { primary: true })));
  }
  return el("div.row-body.indent", {}, kids);
}

/** FAILED — say what happened, then prove it. */
function failedBody(row) {
  const ex = row.explanation || {};
  const main = [];

  if (ex.headline) {
    main.push(el("div.fail-head", { text: ex.headline }));
    if (ex.body) main.push(el("div.prose", { text: ex.body }));
  } else {
    // The honest fallback the design asks for by name. No cause is invented,
    // and the quotation carries the whole message.
    main.push(el("div.fail-head", { text: `This is unusual — ${row.label} said:` }));
  }

  // A blocking process is the one failure with a button that is certain to
  // help, so it goes above the general advice.
  if (row.conflict) {
    main.push(el("div.blocker", {},
      el("span.cmd", { text: row.conflict.command }),
      el("span.pid", { text: `pid ${row.conflict.pid}` }),
    ));
    main.push(el("div.actions", {},
      el("button.btn.primary", {
        type: "button",
        text: "Stop it and retry",
        on: { click: (e) => fixConnector(row.id, "resolve", e.currentTarget) },
      }),
      el("span.aside", { text: "Only the connector stops. The program holding it keeps running." }),
    ));
  }

  const advice = [];
  if (ex.advice?.length) {
    advice.push(el("div.t-label", { text: "Most likely fixes" }));
    advice.push(el("ul", {}, ex.advice.map((a) => el("li", { text: a }))));
  }
  const buttons = [];
  if (!row.conflict) buttons.push(retryButton(row, { primary: true }));
  if (row.setup) buttons.push(setupLink(row.setup));
  if (advice.length || buttons.length) {
    main.push(el("div.fixes", {}, advice, buttons.length ? el("div.actions", {}, buttons) : null));
  }

  const lines = row.output || [];
  const shown = state.showOutput.has(row.id) || !ex.headline;
  const quote = el("div.quote", {},
    el("div.quote-head", {},
      el("span.t-label", { text: `What ${row.label} printed` }),
      el("span.pill.plain", { text: "verbatim" }),
      lines.length
        ? el("button.btn.link", {
            type: "button",
            text: "Copy",
            on: { click: (e) => copyText(lines.join("\n"), e.currentTarget) },
          })
        : null,
    ),
    shown
      ? (lines.length
          ? el("div.verbatim", {}, lines.map((line, i) =>
              el("div.vline", {}, el("span.vn", { text: String(i + 1) }), el("span.vt", { text: line }))))
          : el("div.aside", { text: "It exited without printing anything." }))
      : el("div.actions", {}, el("button.btn.link", {
          type: "button",
          text: `Show what ${row.label} printed`,
          on: { click: () => { state.showOutput.add(row.id); renderConnectors(); } },
        })),
    shown && lines.length
      ? el("div.quote-note", { text: "The connector's own words, unedited. REFUGIO's explanation above is an interpretation of these lines." })
      : null,
  );

  return el("div.row-body.indent", {}, el("div.fail-grid", {}, el("div.fail-main", {}, main), quote));
}

function accountList(row) {
  return el("div.accounts", {}, row.accounts.map((a) => {
    const who = a.phone || a.id || "account";
    return el(`div.account${a.connected ? "" : ".off"}`, {},
      el(`span.dot.${a.connected ? "ok" : "degraded"}`, { style: "width:8px;height:8px" }),
      el("span.who", { text: who }),
      el(`span.pill.${a.connected ? "ok" : "degraded"}`, {
        text: a.connected ? "linked" : "unlinked by the phone",
      }),
      // One filled button, on the account that is actually broken.
      !a.connected && row.setup
        ? el("a.btn.primary", {
            href: row.setup.url,
            target: "_blank",
            rel: "noopener noreferrer",
            title: row.setup.hint || "",
            text: row.setup.label || "Scan to re-link",
          })
        : null,
    );
  }));
}

function scopeOptions(row) {
  return el("div.scopes", {},
    el("div.t-label", { text: "What it may read — off is always narrower" }),
    el("div.scope-list", {}, row.options.map((o) =>
      el("label.check", { title: o.hint || "" },
        el("input", {
          type: "checkbox",
          checked: o.value,
          on: { change: (e) => setOption(row.id, o.key, e.currentTarget.checked, e.currentTarget) },
        }),
        el("span.box"),
        o.label,
      ))),
    row.options.some((o) => o.hint)
      ? el("div.aside", { text: row.options.filter((o) => o.hint).map((o) => o.hint).join(" ") })
      : null,
  );
}

function retryButton(row, { primary = false } = {}) {
  return el(`button.btn${primary ? ".primary" : ""}`, {
    type: "button",
    text: "Retry this connector",
    on: { click: (e) => fixConnector(row.id, "retry", e.currentTarget) },
  });
}

/** `setup` is {url, label, hint} — the connector's own setup page, on its own
 *  port. Opened in the browser rather than in this window because it is the
 *  connector's UI, not REFUGIO's, and some of them (WhatsApp's QR pairing)
 *  need a camera-sized page. */
function setupLink(setup, { primary = false } = {}) {
  return el(`a.btn${primary ? ".primary" : ""}`, {
    href: setup.url,
    target: "_blank",
    rel: "noopener noreferrer",
    title: setup.hint || "",
    text: setup.label || "Open setup",
  });
}

async function fixConnector(id, action, btn) {
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = action === "resolve" ? "Stopping…" : "Retrying…";
  try {
    const res = await fetch(`/api/chat/connectors/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `failed (${res.status})`);
    markWrite();
    state.connectors = data;
    renderConnectors();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = was;
    toast(`Couldn't ${action === "resolve" ? "stop it" : "retry"}: ${e.message}`);
  }
}

async function setOption(server, key, value, box) {
  box.disabled = true;
  try {
    const res = await fetch("/api/chat/connectors/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server, key, value }),
    });
    if (!res.ok) throw new Error("failed");
    markWrite();
    state.connectors = await res.json();
    renderConnectors();
  } catch {
    box.checked = !value;
    box.disabled = false;
    toast("That setting didn't save.");
  }
}

function renderConnectors() {
  const data = state.connectors;
  const rows = $("connector-rows");
  const counts = $("connector-counts");
  rows.replaceChildren();
  counts.replaceChildren();
  $("connectors-foot").replaceChildren();

  if (!data) {
    rows.append(el("div.waiting", { text: "Reading what is running…" }));
    return;
  }
  if (data.starting) {
    $("connectors-sub").textContent = "Still starting — connectors take about fifteen seconds.";
  }

  const list = data.connectors || [];
  if (!list.length) {
    $("connectors-sub").textContent = data.starting
      ? "Still starting — connectors take about fifteen seconds."
      : "No connectors are configured.";
    rows.append(el("div.waiting", {
      text: data.starting
        ? "Nothing has reported in yet."
        : "Re-run the REFUGIO installer to add connectors — WhatsApp, Apple Reminders, Things 3, Notion and others are set up there.",
    }));
    return;
  }

  // All four counts, always, including the zeros. A page that hides "0 FAILED"
  // reassures by omission, and the reader cannot tell the difference between
  // "none failed" and "we didn't check".
  for (const [key, label, cls, glyph] of [
    ["ready", "ready", "ok", "●"],
    ["connecting", "connecting", "", "◌"],
    ["degraded", "degraded", "degraded", "●"],
    ["failed", "failed", "failed", "■"],
  ]) {
    const n = data[key] || 0;
    counts.append(el(`span.pill${cls ? `.${cls}` : ""}`, { text: `${glyph} ${n} ${label}` }));
  }

  const attention = (data.degraded || 0) + (data.failed || 0);
  $("connectors-sub").textContent =
    `${list.length} local program${list.length === 1 ? "" : "s"}. ` +
    (attention ? `${attention} need${attention === 1 ? "s" : ""} attention.` : "None need attention.");

  // Worst first. A failed connector at the bottom of a list of green rows is a
  // failure you scroll past.
  const order = { failed: 0, degraded: 1, connecting: 2, ok: 3 };
  for (const row of [...list].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9))) {
    rows.append(connectorRow(row));
  }

  $("connectors-foot").append(
    el("span.foot-note", {
      text: "Connectors are configured by the REFUGIO installer. Re-running it adds or removes them.",
    }),
  );
}

// ── Models (4e) ─────────────────────────────────────────────

function renderMemory() {
  const card = $("memcard");
  card.replaceChildren();
  const m = state.status?.memory;
  if (!m) {
    card.append(el("div.aside", { text: "Memory information isn't available on this machine." }));
    return;
  }

  const share = (gb) => Math.max(0, Math.min(100, (gb / m.totalGb) * 100));
  // Roughly the share below which the segment is narrower than its own label.
  const seg = (cls, gb, label) => el(`span.${cls}${share(gb) < 14 ? ".tight" : ""}`, {
    style: `width:${share(gb).toFixed(1)}%`,
    text: label,
    title: `${gb} GB — ${label}`,
  });

  card.append(
    el("div.memline", {},
      el("span.t-label", { text: "Memory on this Mac" }),
      el("span.memnums", {},
        `${m.totalGb} GB total · ${m.otherGb} GB in use by other apps · `,
        el("strong", { text: `${m.freeGb} GB free` }),
      ),
    ),
    el("div.membar", {},
      seg("seg-other", m.otherGb, "OTHER APPS"),
      m.activeGb ? seg("seg-model", m.activeGb, (m.activeModel || "").toUpperCase()) : null,
      el("span.seg-free", { text: "FREE" }),
    ),
    el("div.aside", {
      text: "This updates as you open and close applications, so a model that fits now may not in ten minutes. " +
        "The \"other apps\" figure is the remainder, not a measurement of any one program.",
    }),
  );
}

function modelRow(m, active) {
  const isActive = m.name === active;
  const cls = isActive ? "running" : m.tools === false ? "notools" : "";
  const tooBigEver = m.everFits === false;
  const tooBigNow = !tooBigEver && m.fits === false;

  const why = [];
  if (m.tools === false) {
    why.push(el("span", {}, "Chats fine, but ", el("strong", { text: "cannot reach your connectors at all" }), "."));
  } else if (tooBigEver) {
    why.push(el("span", {}, "Needs more memory than this Mac has. It will not load, whatever you close."));
  } else if (tooBigNow) {
    why.push(el("span", {}, "Needs ", el("strong", { text: `${m.freeUpGb} GB more` }),
      " than is free. Quitting a few applications would make room."));
  } else if (isActive) {
    why.push("Selected. This is the model your questions go to.");
  } else if (m.tools === null) {
    why.push("REFUGIO has not rated this model's tool calling. It may or may not reach your connectors.");
  } else if (m.source === "probe") {
    // Rated by Ollama rather than by REFUGIO. Worth saying: it is the
    // difference between "someone watched this drive a connector" and "the
    // model file claims the capability".
    why.push("Ollama reports this model can call tools. Nobody here has watched it drive a connector.");
  } else {
    why.push("Installed and usable.");
  }
  if (m.note && !tooBigEver) why.push(el("span.aside", { text: m.note }));

  return el(`div.mrow${cls ? `.${cls}` : ""}${tooBigEver ? ".dim" : ""}`, {},
    el(`span.dot.${isActive ? "ok" : tooBigEver ? "idle" : m.tools === false ? "degraded" : "idle"}`),
    el("div.mname", {},
      el("div.mtag", { text: m.name }),
      el("div.mstate", { text: isActive ? "Selected" : tooBigEver ? "Installed · will not load" : "Installed" }),
    ),
    el(`span.pill${m.tools === true ? ".ok" : m.tools === false ? ".degraded" : ".plain"}`, {
      text: m.tools === true ? "calls tools" : m.tools === false ? "no tool calling" : "unrated",
    }),
    el("div.mwhy", {}, why),
    el("div.msize", {},
      // A tilde, and a tooltip that says so: an estimate from the download
      // size is useful, and presenting it as a measurement is not.
      el("div.mgb", {
        text: m.needGb ? `${m.estimated ? "~" : ""}${m.needGb} GB` : "—",
        title: m.estimated ? "Estimated from the download size — nobody has measured this one." : "",
      }),
      el("div.mfit", {
        class: tooBigEver ? "never" : tooBigNow ? "no" : "ok",
        text: tooBigEver ? "too big" : tooBigNow ? "too big now" : "fits",
      }),
    ),
    // No button at all on a model that cannot load. A disabled "Use this" is
    // still an offer, and the rule this page is built on is that an action
    // appears only where it can actually work.
    isActive
      ? el("span.pill.ok.mpick", { text: "in use" })
      : tooBigEver
        ? el("span.aside.mpick", { text: "unusable here" })
        : el("button.btn.mpick", {
            type: "button",
            text: "Use this",
            title: tooBigNow ? "It will load, but this machine is short on memory right now." : "",
            on: { click: () => chooseModel(m.name) },
          }),
  );
}

function renderModels() {
  renderMemory();
  renderAdvice();
  renderRescanNote();
  const rows = $("model-rows");
  rows.replaceChildren();
  const s = state.status;
  if (!s) { rows.append(el("div.waiting", { text: "Asking Ollama what is installed…" })); return; }
  if (!s.ollamaUp) {
    rows.append(el("div.waiting", { text: "Ollama isn't running, so REFUGIO can't list or load any model. Start it and this page will fill in." }));
    return;
  }
  const models = s.models || [];
  if (!models.length) {
    rows.append(el("div.waiting", { text: "No models are installed. Download one below — REFUGIO cannot answer anything until there is one." }));
    renderDownloads(true);
    return;
  }
  const active = activeModel(s);
  // The model in use first — it is the row you opened this page to find —
  // then everything usable, then the ones that won't load. Inverse of the
  // connector list, where the broken rows are the ones you came for.
  const rank = (m) => (m.name === active ? -1 : m.everFits === false ? 2 : m.tools === false ? 1 : 0);
  for (const m of [...models].sort((a, b) => rank(a) - rank(b) || (a.needGb || 0) - (b.needGb || 0))) {
    rows.append(modelRow(m, active));
  }
}

function chooseModel(name) {
  setPreferredModel(name);
  renderModels();
  toast(`${name} is now the model REFUGIO uses. Open chats keep their history.`);
}

// ── "Is there something better?" ────────────────────────────
//
// The ladder REFUGIO ships with was frozen the day this copy was installed,
// and small models that can call tools keep getting better. Without a way to
// look, the only person who ever finds out is the one who reads release notes
// — everyone else runs whatever the installer picked, forever.
//
// Two halves, and the panel says which one ran:
//   · Ollama is asked about every installed model. No network. Always runs.
//   · The catalog is fetched from REFUGIO's repository — the only way a model
//     released after this build can be offered at all. Runs only when update
//     checks are on.

function renderAdvice() {
  const box = $("model-advice");
  box.replaceChildren();
  const r = state.status?.recommendation;
  if (!r) return;

  const gb = (n) => `${n} GB`;
  const head =
    r.kind === "tools" ? "The model you are using cannot reach your connectors"
      : r.kind === "lighter" ? "The same capability, for less memory"
        : "A better model fits right now";

  const prose =
    r.kind === "tools"
      ? el("span", {}, el("strong", { text: r.replaces || "The current model" }),
          " chats, but it cannot call tools, so every connector on this machine is doing nothing for it. ",
          el("strong", { text: r.tag }), " can, and needs ", gb(r.needGb),
          " — which fits in the memory free right now.")
      : r.kind === "lighter"
        ? el("span", {}, el("strong", { text: r.tag }), " is rated at least as capable as ",
            el("strong", { text: r.replaces }), " and needs ", el("strong", { text: gb(r.needGb) }),
            r.savesGb ? `, ${r.savesGb} GB less. ` : ". ",
            "That memory goes back to the rest of your machine.")
        : el("span", {}, el("strong", { text: r.tag }), " answers better than ",
            el("strong", { text: r.replaces }), ", needs ", el("strong", { text: gb(r.needGb) }),
            ", and fits in the memory free right now.");

  box.append(el(`div.card${r.kind === "tools" ? ".warn" : ""}`, {},
    el("h3", { text: head }),
    el("div.prose", {}, prose),
    r.note ? el("div.aside", { text: r.note }) : null,
    el("div.field", {},
      r.installed
        ? el("button.btn.primary", { type: "button", text: "Use this", on: { click: () => chooseModel(r.tag) } })
        : el("button.btn.primary", { type: "button", text: `Download ${r.tag}`, on: { click: () => startDownload(r.tag) } }),
      el("span.aside", {
        text: r.installed
          ? "Already downloaded. Switching takes effect on your next message."
          : `${gb(r.needGb)} once it is loaded. The download is roughly that size.`,
      }),
    ),
    r.isNew
      ? el("div.aside", { text: "This one is not in the list REFUGIO shipped with — it came from the catalog check." })
      : null,
    // Ranking is a judgement someone made, not a benchmark anyone ran, and
    // saying so is cheaper than being asked where the number came from.
    el("div.aside", { text: "\u201cBetter\u201d is REFUGIO\u2019s own rating of these models, kept in the catalog. It is a judgement, not a benchmark." }),
  ));
}

/** The line under the buttons: when this was last checked, and what a check
 *  sends. Stated before the button is pressed, not after. */
function renderRescanNote() {
  const c = state.status?.catalog;
  const note = $("rescan-note");
  if (!c) { note.textContent = "A check asks GitHub for one public list of models — nothing about this machine is sent."; return; }
  const when = c.checkedAt ? `Last checked ${new Date(c.checkedAt).toLocaleString()}.` : "Never checked.";
  const known = c.count ? ` ${c.count} model${c.count === 1 ? "" : "s"} in the catalog.` : "";
  note.textContent = `${when}${known} A check asks GitHub for one public list — nothing about this machine is sent.`;
}

function renderRescan() {
  const box = $("rescan-result");
  box.replaceChildren();
  const r = state.rescan;
  if (!r) return;

  const kids = [];
  const n = r.network || {};

  if (n.blocked) {
    kids.push(el("div.card.warn", {},
      el("h3", { text: "Only the offline half ran" }),
      el("div.prose", { text: "Update checks are switched off, and this uses the same switch — so REFUGIO " +
        "did not ask GitHub for the catalog. It did re-read every model installed here, which is the part " +
        "that needs no network." }),
      el("div.field", {},
        el("button.btn", { type: "button", text: "Open Updates", on: { click: () => showPane("updates") } }),
        el("span.aside", { text: "Turning checks on there makes this button able to find models released since you installed." }),
      ),
    ));
  } else if (n.offline) {
    kids.push(el("div.card", {},
      el("h3", { text: "Couldn't reach the network" }),
      el("div.prose", { text: "The catalog could not be fetched, so this is only what is already on this machine. " +
        "Nothing is wrong with your models — try again when you are online." }),
    ));
  } else if (n.attempted && !n.ok) {
    kids.push(el("div.card.warn", {},
      el("h3", { text: "The catalog check failed" }),
      el("div.prose", {}, "GitHub was asked for the model list and did not give one: ",
        el("strong", { text: n.error || "unknown error" }), ". Everything below is from this machine."),
      n.url ? el("div.path", { text: n.url }) : null,
    ));
  }

  const added = r.added || [];
  if (added.length) {
    kids.push(el("div.card", {},
      el("h3", { text: added.length === 1 ? "One model this build didn\u2019t know about" : `${added.length} models this build didn\u2019t know about` }),
      el("div.prose", { text: "Added to the catalog since REFUGIO was released. They are on the download list now." }),
      el("div.rows", {}, added.map((m) => el("div.drow", {},
        el("div.dtag", { text: m.tag }),
        el("div.dsize", { text: `${m.needGb} GB` }),
        el("div.dprog", { text: m.installed ? "Already installed" : (m.note || (m.verified ? "Rated and ready to download" : "Listed, not yet verified here")) }),
        m.installed
          ? el("button.btn", { type: "button", text: "Use this", on: { click: () => chooseModel(m.tag) } })
          : el("button.btn", { type: "button", text: "Download", on: { click: () => startDownload(m.tag) } }),
      ))),
    ));
  } else if (n.ok) {
    kids.push(el("div.card", {},
      el("h3", { text: "Nothing new" }),
      el("div.prose", {}, "REFUGIO\u2019s catalog has ",
        el("strong", { text: String(r.catalog?.count || 0) }),
        " models and none of them are new to this copy",
        r.catalog?.updated ? el("span", {}, ". The list was last edited ", el("strong", { text: r.catalog.updated }), ".") : ".",
      ),
    ));
  }

  kids.push(el("div.card", {},
    el("h3", { text: "What the scan read here" }),
    el("div.kv", {},
      el("span.k", { text: "installed models re-read" }), el("span", { text: String(r.probed || 0) }),
      el("span.k", { text: "memory free" }), el("span", { text: r.freeGb == null ? "—" : `${r.freeGb} GB` }),
      el("span.k", { text: "catalog" }), el("span", { text: n.ok ? "fetched just now" : (r.catalog?.checkedAt ? "from the last check" : "built-in list only") }),
    ),
    el("div.aside", { text: "Sizes for models nobody has measured are estimated from their download size and shown with a ~." }),
    el("div.field", {},
      el("button.btn.link", { type: "button", text: "Hide this", on: { click: () => { state.rescan = null; renderRescan(); } } }),
    ),
  ));

  box.replaceChildren(...kids);
}

async function rescanModels(btn) {
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Checking\u2026";
  try {
    const res = await fetch("/api/chat/models/rescan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ network: true }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `failed (${res.status})`);
    markWrite();
    state.rescan = d;
    // The poll would bring these along in fifteen seconds; folding them in now
    // is what makes the page change the moment the button is released.
    if (state.status) {
      state.status = { ...state.status, models: d.models, downloadable: d.downloadable,
        recommendation: d.recommendation, catalog: d.catalog, memory: d.memory, freeGb: d.freeGb };
    }
    renderModels();
    renderRescan();
    if (!d.recommendation && !(d.added || []).length && d.network?.ok) {
      toast("Nothing better than what you are running.");
    }
  } catch (e) {
    toast(`The check didn't finish: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
}

/** Reveal the download list and start one, so a "Download X" button somewhere
 *  else on the page lands the user where the progress bar is. */
function startDownload(name) {
  const box = $("downloads");
  box.hidden = false;
  renderDownloads(true);
  pull(name);
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderDownloads(force = false) {
  const box = $("downloads");
  const list = state.status?.downloadable || [];
  if (!force && box.hidden) return;
  box.hidden = false;
  box.replaceChildren();
  if (!list.length) {
    box.append(el("div.waiting", { text: "Nothing else on REFUGIO's list fits this machine — the models it offers are already installed." }));
    return;
  }
  // This warning used to live in the pane footer, which the rescan note now
  // occupies. It belongs here anyway — next to the thing it is about.
  box.append(el("div.drow", {},
    el("span.aside", { text: "Downloads run in the background. Closing this window cancels one in progress." })));
  for (const m of list) {
    const live = state.pulling.get(m.name);
    const prog = el("div.dprog", { text: live?.text || "Not installed" });
    const bar = el("div.pbar", { hidden: !live }, el("i", { style: `width:${live?.pct || 0}%` }));
    box.append(el("div.drow", {},
      el("div.dtag", { text: m.name }),
      el("div.dsize", { text: `${m.needGb} GB download` }),
      // Two things a row has to admit: that REFUGIO learned about this model
      // after it shipped, and that nobody here has watched it call a
      // connector. Both are reasons to try it, and neither is a secret.
      m.isNew ? el("span.pill.plain", { text: "new" }) : null,
      m.verified === false ? el("span.pill.degraded", { text: "unverified", title: m.note || "Listed, but not yet observed calling a REFUGIO connector." }) : null,
      el("div", {}, prog, bar),
      live
        ? el("button.btn", { type: "button", text: "Cancel", on: { click: () => cancelPull(m.name) } })
        : el("button.btn.primary", { type: "button", text: "Download", on: { click: () => pull(m.name) } }),
    ));
  }
}

$("rescan-models").addEventListener("click", (e) => rescanModels(e.currentTarget));

$("show-downloads").addEventListener("click", () => {
  const box = $("downloads");
  box.hidden = !box.hidden;
  if (!box.hidden) renderDownloads(true);
});

async function pull(name) {
  const ac = new AbortController();
  state.pulling.set(name, { text: "Starting…", pct: 0, ac });
  renderDownloads(true);

  const gb = (n) => (n / 1024 ** 3).toFixed(1);
  try {
    const res = await fetch("/api/chat/models/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error((await res.json().catch(() => ({}))).error || `failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const ev = /^event: (.+)$/m.exec(frame)?.[1];
        const raw = /^data: (.+)$/m.exec(frame)?.[1];
        if (!ev || !raw) continue;
        let d; try { d = JSON.parse(raw); } catch { continue; }
        if (ev === "progress") {
          state.pulling.set(name, {
            ac,
            pct: d.total ? (d.completed / d.total) * 100 : 0,
            text: d.total ? `${gb(d.completed)} of ${gb(d.total)} GB` : `${d.status || "working"}…`,
          });
          renderDownloads(true);
        } else if (ev === "error") {
          throw new Error(d.error);
        } else if (ev === "done") {
          state.pulling.delete(name);
          toast(`${name} downloaded. Choose "Use this" to switch to it.`);
          await refresh();
          renderDownloads(true);
          return;
        }
      }
    }
    // The stream ended without a done event — the server went away mid-pull.
    state.pulling.delete(name);
    renderDownloads(true);
  } catch (e) {
    state.pulling.delete(name);
    renderDownloads(true);
    if (e.name !== "AbortError") toast(`Couldn't download ${name}: ${e.message}`);
  }
}

function cancelPull(name) {
  // Aborting the request closes the socket; the server aborts its own pull on
  // 'close', so nothing keeps downloading in the background.
  state.pulling.get(name)?.ac?.abort();
  state.pulling.delete(name);
  renderDownloads(true);
}

// ── Web search ──────────────────────────────────────────────

function renderWeb() {
  const box = $("web-body");
  box.replaceChildren();
  const web = state.connectors?.web || state.status?.web;
  if (!web) { box.append(el("div.waiting", { text: "Checking…" })); return; }

  const card = el("div.card.warn", {},
    el("h3", { text: "Web search" }),
    el("div.prose", {
      text: web.hint || "Lets REFUGIO look something up on the public web when an answer needs " +
        "information it doesn't have locally.",
    }),
    el("div.prose", {}, el("strong", { text: web.warning || "" })),
    el("label.check", {},
      el("input", {
        type: "checkbox",
        checked: !!web.enabled,
        on: { change: (e) => setWebEnabled(e.currentTarget.checked, e.currentTarget) },
      }),
      el("span.box"),
      web.label || "Allow web search",
    ),
    el("div.aside", {
      text: "Turning this on does not start searching. Every message you want searched has to be " +
        "armed on its own, in the chat, with the warning shown at the time. Off is the default, " +
        "and it is the only setting under which nothing at all leaves this machine.",
    }),
  );
  box.append(card);

  if (web.engine) {
    box.append(el("div.card", {},
      el("h3", { text: "Where the search goes" }),
      el("div.kv", {}, el("span.k", { text: "engine" }), el("span", { text: web.engine })),
      el("div.aside", { text: "Your search words are sent there. Your conversation is not." }),
    ));
  }
}

async function setWebEnabled(enabled, box) {
  box.disabled = true;
  try {
    const res = await fetch("/api/chat/web", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error("failed");
    markWrite();
    state.connectors = await res.json();
    renderWeb();
  } catch {
    box.checked = !enabled;
    box.disabled = false;
    toast("That didn't save.");
  }
}

// ── Appearance ──────────────────────────────────────────────

const TEXT_KEY = "refugio.textScale";
const MOTION_KEY = "refugio.reduceMotion";

function applyAppearance() {
  const scale = localStorage.getItem(TEXT_KEY) || "1";
  document.documentElement.style.fontSize = `${16 * parseFloat(scale)}px`;
}

function renderAppearance() {
  const box = $("appearance-body");
  box.replaceChildren();
  const scale = localStorage.getItem(TEXT_KEY) || "1";
  const motion = localStorage.getItem(MOTION_KEY) === "1";
  const theme = themePreference();

  box.append(
    el("div.card", {},
      el("h3", { text: "Theme" }),
      el("div.field", {},
        el("div.seg", {}, [["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([v, label]) =>
          el(`button${theme === v ? ".is-on" : ""}`, {
            type: "button",
            text: label,
            on: { click: () => { setThemePreference(v); renderAppearance(); } },
          }))),
      ),
      el("div.aside", {
        text: "System follows your Mac and switches with it. Applies to the chat window too, " +
          "and takes effect immediately — nothing needs restarting.",
      }),
    ),
    el("div.card", {},
      el("h3", { text: "Text size" }),
      el("div.field", {},
        el("div.seg", {}, [["0.9", "Small"], ["1", "Normal"], ["1.15", "Large"]].map(([v, label]) =>
          el(`button${scale === v ? ".is-on" : ""}`, {
            type: "button",
            text: label,
            on: { click: () => { localStorage.setItem(TEXT_KEY, v); applyAppearance(); renderAppearance(); } },
          }))),
      ),
      el("div.aside", { text: "Applies to this window and the chat. Stored on this machine only." }),
    ),
    el("div.card", {},
      el("h3", { text: "Motion" }),
      el("label.check", {},
        el("input", {
          type: "checkbox",
          checked: motion,
          on: { change: (e) => {
            localStorage.setItem(MOTION_KEY, e.currentTarget.checked ? "1" : "0");
            document.documentElement.classList.toggle("reduce-motion", e.currentTarget.checked);
          } },
        }),
        el("span.box"),
        "Reduce animation",
      ),
      el("div.aside", { text: "REFUGIO already follows your system's reduce-motion setting. This turns it off here regardless." }),
    ),
  );
}

// ── Updates ─────────────────────────────────────────────────
//
// Deliberately shaped like the web-search pane: this is a network request, so
// it says what it sends before it says what it found.

function renderUpdates() {
  const box = $("updates-body");
  const u = state.update;
  if (!u) { box.replaceChildren(el("div.waiting", { text: "Checking what's installed…" })); return; }

  const kids = [];

  if (!u.supported) {
    kids.push(el("div.card", {},
      el("h3", { text: "Not available for this install" }),
      el("div.prose", { text: "REFUGIO can only tell you about updates when it was installed with git — " +
        "this copy wasn't, or its checkout has moved. Re-running the installer restores it." }),
      el("div.path", { text: u.dir || "" }),
    ));
    box.replaceChildren(...kids);
    return;
  }

  // The state card. What you have, and whether there is more.
  const head = u.updateAvailable
    ? el("div.card.warn", {},
        el("h3", { text: "An update is available" }),
        el("div.prose", {},
          "Your copy is at ", el("strong", { text: u.sha }),
          ". The ", el("strong", { text: u.channel }), " branch has moved to ",
          el("strong", { text: u.latestSha }), "."),
        el("div.prose", { text: "REFUGIO does not update itself. Applying one means a code update, a rebuild " +
          "of the menu-bar app and a restart of the stack — and this window is part of what restarts, so it is " +
          "not a thing to run from inside itself. Run this in a terminal:" }),
        commandBlock(u.command),
      )
    : el("div.card", {},
        el("h3", { text: "Up to date" }),
        el("div.prose", {}, "Your copy matches the ", el("strong", { text: u.channel }), " branch."),
      );
  kids.push(head);

  kids.push(el("div.card", {},
    el("h3", { text: "This copy" }),
    el("div.kv", {},
      el("span.k", { text: "version" }), el("span", { text: u.version || "—" }),
      el("span.k", { text: "commit" }), el("span", { text: u.sha || "—" }),
      el("span.k", { text: "channel" }), el("span", { text: u.channel || "—" }),
      u.date ? el("span.k", { text: "dated" }) : null,
      u.date ? el("span", { text: new Date(u.date).toLocaleDateString() }) : null,
    ),
    el("div.field", {},
      el("button.btn", {
        type: "button",
        text: "Check now",
        disabled: !u.enabled,
        title: u.enabled ? "" : "Update checks are switched off.",
        on: { click: (e) => checkForUpdate(e.currentTarget) },
      }),
      el("span.aside", {
        text: u.offline ? "Last check couldn't reach the network."
          : u.error ? `Last check failed: ${u.error}`
          : u.checkedAt ? `Last checked ${new Date(u.checkedAt).toLocaleString()}`
          : "Not checked yet.",
      }),
    ),
  ));

  kids.push(el("div.card.warn", {},
    el("h3", { text: "What a check sends" }),
    el("div.prose", {}, "A connection to github.com asking what commit a public branch points at. ",
      el("strong", { text: "No data of yours is sent" }),
      " — not your messages, not your version, not an identifier. GitHub learns that an IP address asked."),
    el("label.check", {},
      el("input", {
        type: "checkbox",
        checked: !!u.enabled,
        on: { change: (e) => setUpdatesEnabled(e.currentTarget.checked, e.currentTarget) },
      }),
      el("span.box"),
      "Check for updates automatically",
    ),
    el("div.aside", { text: "At most once a day, never in the first minute after launch. Switched off, " +
      "REFUGIO makes no update requests at all — including the Check now button above." }),
  ));

  box.replaceChildren(...kids);
}

function commandBlock(command) {
  const pre = el("div.verbatim", {},
    el("div.vline", {}, el("span.vt", { text: command })));
  return el("div", {},
    el("div.quote-head", {},
      el("span.t-label", { text: "Run this" }),
      el("button.btn.link", { type: "button", text: "Copy", on: { click: (e) => copyText(command, e.currentTarget) } }),
    ),
    pre,
  );
}

async function checkForUpdate(btn) {
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    const res = await fetch("/api/chat/update/check", { method: "POST" });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `failed (${res.status})`);
    markWrite();
    state.update = d;
    renderUpdates();
    updateBadge();
    if (!d.updateAvailable && !d.offline && !d.error) toast("You're on the latest version.");
    if (d.offline) toast("Couldn't reach the network.");
  } catch (e) {
    btn.disabled = false;
    btn.textContent = was;
    toast(`Check failed: ${e.message}`);
  }
}

async function setUpdatesEnabled(enabled, box) {
  box.disabled = true;
  try {
    const res = await fetch("/api/chat/update/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error("failed");
    markWrite();
    state.update = await res.json();
    renderUpdates();
    updateBadge();
  } catch {
    box.checked = !enabled;
    box.disabled = false;
    toast("That didn't save.");
  }
}

/** A dot on the nav item, so an update is visible without opening the pane. */
function updateBadge() {
  $("update-dot").hidden = !state.update?.updateAvailable;
}

// ── Data & reset ────────────────────────────────────────────

async function renderData() {
  const box = $("data-body");
  box.replaceChildren(el("div.waiting", { text: "Counting…" }));
  let d;
  try {
    const res = await fetch("/api/chat/data");
    d = await res.json();
    if (!res.ok) throw new Error(d.error || "failed");
  } catch {
    box.replaceChildren(el("div.waiting", { text: "Couldn't read the chat database." }));
    return;
  }

  box.replaceChildren(
    el("div.card", {},
      el("h3", { text: "What is stored" }),
      el("div.kv", {},
        el("span.k", { text: "conversations" }), el("span", { text: String(d.conversations) }),
        el("span.k", { text: "messages" }), el("span", { text: String(d.messages) }),
        d.oldest ? el("span.k", { text: "since" }) : null,
        d.oldest ? el("span", { text: new Date(d.oldest).toLocaleDateString() }) : null,
      ),
      el("div.t-label", { text: "On disk" }),
      el("div.path", { text: d.dbPath }),
      el("div.aside", { text: "Nothing here is synced anywhere. This file is the only copy — copy the folder before erasing if you want to keep it." }),
    ),
    eraseCard(d),
  );
}

function eraseCard(d) {
  const input = el("input", { type: "text", placeholder: "delete", "aria-label": 'Type the word delete to confirm' });
  const btn = el("button.btn.primary", {
    type: "button",
    text: `Erase ${d.conversations} conversation${d.conversations === 1 ? "" : "s"}`,
    disabled: true,
    on: { click: () => eraseHistory(btn) },
  });
  // A typed confirmation, not a second "are you sure". The uninstaller learned
  // this the hard way: a yes/no asked twice trains people to say yes twice.
  input.addEventListener("input", () => { btn.disabled = input.value.trim() !== "delete"; });

  return el("div.card.danger", {},
    el("h3", { text: "Erase chat history" }),
    el("div.prose", {},
      "Deletes every conversation and message, including pinned ones. ",
      el("strong", { text: "This cannot be undone" }),
      " and there is no copy anywhere else.",
    ),
    el("div.aside", { text: "Your connectors, models and settings are untouched — this is only the chat history." }),
    el("div.field", {},
      el("label", { text: "Type delete to confirm" }),
      input,
      btn,
    ),
  );
}

async function eraseHistory(btn) {
  btn.disabled = true;
  btn.textContent = "Erasing…";
  try {
    const res = await fetch("/api/chat/data/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "delete" }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "failed");
    toast(`Erased ${d.deleted} conversation${d.deleted === 1 ? "" : "s"}.`);
    renderData();
  } catch (e) {
    btn.disabled = false;
    toast(`Couldn't erase: ${e.message}`);
  }
}

// ── Shared ──────────────────────────────────────────────────

function copyText(text, btn) {
  navigator.clipboard?.writeText(text).then(
    () => { btn.textContent = "Copied"; setTimeout(() => (btn.textContent = "Copy"), 1400); },
    () => toast("Couldn't copy — your browser blocked it."),
  );
}

let toastTimer;
function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = el("div.toast", { text: message, role: "status" });
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 5000);
}

/** When the user last changed something here.
 *
 *  The fifteen-second poll and a settings write race, and the poll wins by
 *  default because it lands last. Switching web search on and watching the
 *  checkbox flip itself back a moment later is indistinguishable from the
 *  setting not saving — and on this page, of all pages, a control that appears
 *  to revert is not a cosmetic bug. Any poll ISSUED before the write is stale
 *  by definition, so it is dropped rather than applied. */
let lastWriteAt = 0;
const markWrite = () => { lastWriteAt = Date.now(); };

async function refresh() {
  const issuedAt = Date.now();
  const [status, connectors, update] = await Promise.all([
    fetch("/api/chat/status").then((r) => r.json()).catch(() => null),
    fetch("/api/chat/connectors").then((r) => r.json()).catch(() => null),
    // Reads the cached answer only — this never opens a socket to github.com.
    fetch("/api/chat/update").then((r) => r.json()).catch(() => null),
  ]);
  if (issuedAt < lastWriteAt) return;   // answered a question we've since changed
  if (update) state.update = update;
  if (status) {
    state.status = status;
    $("version").textContent = status.version ? `v${status.version}` : "";
  }
  if (connectors) state.connectors = connectors;
  renderConnectors();
  renderModels();
  renderWeb();
  renderUpdates();
  updateBadge();
}

applyAppearance();
if (localStorage.getItem(MOTION_KEY) === "1") document.documentElement.classList.add("reduce-motion");
renderAppearance();

const PANES = ["connectors", "models", "web", "appearance", "updates", "data"];
showPane(PANES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "connectors");

// A link to /settings#models has to work when this window is ALREADY open —
// which is the normal case, since the chat keeps it around. Without this the
// address bar changed and the page did not, and the chat's "fix this" links
// silently did nothing on the second click.
window.addEventListener("hashchange", () => {
  const name = location.hash.slice(1);
  if (PANES.includes(name)) showPane(name);
});

refresh();
// Connectors change state on their own — one that was CONNECTING becomes READY,
// one whose phone dropped it becomes DEGRADED. A settings page left open must
// not keep asserting what was true when it loaded.
setInterval(refresh, 15000);
