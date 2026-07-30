// REFUGIO chat — purpose-built controller.
//
// Written fresh rather than adapted from SHERPA's chat-v2.js: that one is
// organised around an evidence/citation domain REFUGIO has no equivalent of,
// and is request/response. Streaming is the whole point here — a local model
// emits tokens slowly enough that waiting for a complete reply feels broken.

const $ = (id) => document.getElementById(id);
const els = {
  convos: $("convos"), thread: $("thread"), scroll: $("scroll"), empty: $("empty"),
  input: $("input"), send: $("send"), newChat: $("new-chat"),
  model: $("model-pick"), status: $("status"), statusText: $("status-text"),
  webArm: $("web-arm"), webWarn: $("web-warn"),
  rail: $("rail"), railToggle: $("rail-toggle"),
  gutter: $("gutter"), gutterRail: $("gutter-rail"), gutterX: $("gutter-x"),
  gutterBody: $("gutter-body"), gutterCount: $("gutter-count"),
};

const state = {
  conversationId: null, streaming: false, model: null, abort: null,
  // Two separate facts, deliberately. `web` is the standing permission from the
  // connectors panel; `webArmed` is this one message. The second is never
  // inferred from the first — that is the whole guarantee.
  web: { enabled: false }, webArmed: false,
  railCollapsed: false,
};

// Outcome of the last connector fix, rendered once on the next panel draw.
// Held outside the panel because the panel is destroyed and rebuilt to show
// fresh data, which is precisely what would otherwise swallow the message.
let pendingNotice = null;

// ── Rendering ───────────────────────────────────────────────

import { renderMarkdown } from "./md.js";

/** Model output is untrusted text; md.js escapes before adding any markup. */
const renderContent = (text) => renderMarkdown(text);

function addMessage(role, text) {
  els.empty?.remove();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  // avatar + a column for [tool chips, text] — the strip must stack ABOVE the
  // answer, and .msg itself is a flex row.
  wrap.innerHTML =
    `<div class="avatar">${role === "user" ? "You" : "R"}</div>` +
    `<div class="content"><div class="bubble"></div></div>`;
  const bubble = wrap.querySelector(".bubble");
  bubble.innerHTML = renderContent(text);
  els.thread.appendChild(wrap);
  scrollToEnd();
  return bubble;
}

/** Mark, in the thread, that this turn was allowed to search the web.
 *
 *  The composer warning disappears the moment the message is sent, so without
 *  this there is nothing in the scrollback saying which answer was the one
 *  that reached outside the machine. Not persisted — reopening the
 *  conversation won't show it, since the marker isn't part of the stored
 *  transcript. The tool chip on the answer itself is the durable record. */
function markWebTurn() {
  const d = document.createElement("div");
  d.className = "web-turn";
  d.textContent = "🌐 Web search allowed for this message";
  els.thread.appendChild(d);
}

function showError(msg) {
  els.empty?.remove();
  const d = document.createElement("div");
  d.className = "err";
  d.textContent = msg;
  els.thread.appendChild(d);
  scrollToEnd();
}

// ── Waiting states ──────────────────────────────────────────
//
// A local model is slow in a way a hosted one is not: several seconds can pass
// between pressing send and the first token, and a blank space for those
// seconds is indistinguishable from a hang. Both waits get something that
// moves — one for loading a conversation, one for the model composing.

/** Placeholder rows while a conversation's messages are fetched. */
function showThreadLoading() {
  els.thread.innerHTML =
    `<div class="skel" aria-busy="true" aria-label="Loading conversation">` +
    `<div class="skel-row w70"></div><div class="skel-row w40"></div>` +
    `<div class="skel-row w85"></div><div class="skel-row w55"></div></div>`;
}

/** The pause before the first token. Replaced by the answer itself, so it can
 *  never be left behind on a turn that did produce text. */
function setThinking(bubble, on) {
  bubble.classList.toggle("thinking", on);
  // Symmetric, so clearing it always removes the dots. Leaving that to the
  // caller meant a turn that produced no text at all kept animating under an
  // error message saying the response was empty.
  bubble.innerHTML = on ? `<span class="dots"><i></i><i></i><i></i></span>` : "";
}

// Only auto-scroll when the user is already near the bottom, so reading back
// through a long answer isn't yanked away by incoming tokens.
let stick = true;
els.scroll.addEventListener("scroll", () => {
  stick = els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight < 80;
});
function scrollToEnd() { if (stick) els.scroll.scrollTop = els.scroll.scrollHeight; }

// ── API ─────────────────────────────────────────────────────

async function refreshStatus() {
  try {
    const s = await (await fetch("/api/chat/status")).json();
    els.status.className = `status ${s.available ? "ok" : "down"}`;
    // Connectors, not tools. "35 tools" is an implementation detail; what a
    // person has is WhatsApp, Reminders and Things. A failure gets its own
    // clause rather than being folded into the total — a healthy-looking count
    // while WhatsApp was silently down is exactly what hid a real outage.
    const c = s.connectors || { ready: 0, failed: 0, connecting: 0, degraded: 0 };
    els.statusText.textContent = !s.available ? "no model"
      : c.failed ? `${c.ready} connected \u00b7 ${c.failed} failed`
      : c.degraded ? `${c.ready} connected \u00b7 ${c.degraded} offline`
      : c.connecting && !c.ready ? "connecting\u2026"
      : c.connecting ? `${c.ready} connector${c.ready === 1 ? "" : "s"} \u00b7 ${c.connecting} connecting`
      : c.ready ? `ready \u00b7 ${c.ready} connector${c.ready === 1 ? "" : "s"}`
      : "ready \u00b7 no connectors";
    if (s.available && (c.failed || c.degraded)) els.status.classList.add("warn");
    els.status.title = "Click for connector details";
    showModelWarning(s);
    // Label each model with what it needs against the RAM free right now.
    // Choosing a model is the main lever over speed, and picking one blind
    // means finding out it doesn't fit by watching the machine swap.
    els.model.innerHTML = "";
    for (const m of s.models || []) {
      const o = document.createElement("option");
      o.value = m.name;
      // Say whether you can use it, not how many gigabytes to conjure.
      // "free 2.6 GB more" was a quantity with no action attached — on macOS
      // you do not free memory by hand — and it read as a sum with the size
      // beside it. These two cases need opposite responses, so they are
      // worded as the two situations they are.
      const parts = [];
      if (m.needGb) parts.push(`${m.needGb} GB`);
      if (m.everFits === false) parts.push("\u26a0 too big for this Mac");
      else if (m.fits === false) parts.push("\u26a0 too big right now");
      o.textContent = m.name + (parts.length ? `  \u00b7 ${parts.join("  \u00b7 ")}` : "");
      if (m.fits === false) o.dataset.tight = "1";
      // The number lives here, for whoever wants it.
      if (m.fits === false) {
        o.title = m.everFits === false
          ? `${m.name} needs ${m.needGb} GB — more than this Mac has.`
          : `${m.name} needs ${m.freeUpGb} GB more than is free. Quit a few apps, then reopen this list.`;
      }
      if (m.name === s.model) o.selected = true;
      els.model.appendChild(o);
    }
    if (!s.models?.length) els.model.innerHTML = "<option>no models</option>";
    // Explains the labels rather than restating a number nobody asked for.
    els.model.title = s.freeGb != null
      ? `${s.freeGb} GB of memory free right now. A model marked "too big right ` +
        `now" would fit if you quit some other apps.`
      : "";
    state.model = s.model;
    applyWebSetting(s.web);
  } catch {
    els.status.className = "status down";
    els.statusText.textContent = "offline";
  }
}

/** Warn when the running model can't call tools.
 *
 *  This failure is invisible without help: the app looks healthy, the model
 *  answers fluently, and the connectors just never fire. The user concludes
 *  REFUGIO is broken — which, for what they installed it to do, it is. Say it
 *  where they are, in the chat, not only in a terminal they closed.
 *
 *  Only on an explicit false. A model we haven't rated is unknown, and warning
 *  about it would train people to ignore this bar. */
function showModelWarning(s) {
  // Three distinct problems, in the order they block you. "No model at all" is
  // where a fresh install lands when the download fails, and the UI used to
  // say "no models" in the picker and stop — naming the situation without
  // saying the one command that resolves it.
  let text = null;
  if (!s.ollamaUp) {
    text = "Ollama isn't running — REFUGIO can't answer anything. Start it: open -a Ollama";
  } else if (!s.model || !(s.models || []).length) {
    text = "No model installed. Download one: ollama pull qwen2.5:3b  " +
           "(2.6 GB — the smallest that can use your connectors)";
  } else if (s.modelTools === false) {
    text = `${s.model} can't use connectors — it will answer from memory and ` +
           `never read your data. Run: ollama pull qwen2.5:3b`;
  }

  let bar = document.getElementById("model-warn");
  if (!text) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "model-warn";
    bar.className = "model-warn";
    els.scroll.parentElement.insertBefore(bar, els.scroll);
  }
  bar.textContent = text;
}

// ── Web search ──────────────────────────────────────────────
//
// The only thing REFUGIO does that leaves the machine, so it is built as an
// exception rather than a feature: switched off until enabled in the panel,
// and then armed one message at a time. Two switches, not one — otherwise
// "enabled" quietly becomes "always searching", which is the promise this app
// is built on.

/** Reflect the standing permission. Off means the control isn't there at all —
 *  a visible toggle that does nothing is worse than no toggle. */
function applyWebSetting(web) {
  state.web = web || { enabled: false };
  els.webArm.hidden = !state.web.enabled;
  els.webArm.title = state.web.enabled
    ? `Search the web for the next message only. ${state.web.warning || ""}`.trim()
    : "";
  // Turning the permission off must also drop anything already armed, or the
  // next send would still reach the internet after the user said no.
  if (!state.web.enabled) setWebArmed(false);
}

function setWebArmed(on) {
  state.webArmed = !!on && !!state.web.enabled;
  els.webArm.classList.toggle("armed", state.webArmed);
  els.webArm.setAttribute("aria-pressed", String(state.webArmed));
  els.webWarn.hidden = !state.webArmed;
  // The warning is the point of the arming step. Say what is sent and what
  // isn't, every time, rather than assuming it was read once in the panel.
  els.webWarn.textContent = state.webArmed
    ? `Web search is on for this message. ${state.web.warning || ""}`.trim()
    : "";
}

/** Persist the standing permission from the connectors panel. */
async function setWebEnabled(box, enabled) {
  box.disabled = true;
  try {
    const res = await fetch("/api/chat/web", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error("failed");
    const data = await res.json();
    applyWebSetting(data.web);
    // Redraw the row from the server's answer. Leaving it alone left the
    // header reading "off" beside a ticked box — the same row saying two
    // different things, which is exactly what this panel exists not to do.
    document.querySelector("#connectors .conn.web")?.replaceWith(webSection(data.web));
  } catch {
    box.checked = !enabled;
  } finally {
    box.disabled = false;
  }
}

/** The web-search section of the connectors panel.
 *
 *  Rendered apart from the connector list, and last. Everything above it reads
 *  the user's own data on this machine; this one doesn't, and putting it in the
 *  same list would quietly file it as one more local connector. */
function webSection(web) {
  const row = document.createElement("div");
  row.className = "conn web" + (web.enabled ? " on" : "");

  const head = document.createElement("div");
  head.className = "conn-head";
  const dot = document.createElement("span");
  dot.className = "conn-dot";
  const name = document.createElement("span");
  name.className = "conn-name";
  name.textContent = "Web search";
  const meta = document.createElement("span");
  meta.className = "conn-meta";
  meta.textContent = web.enabled ? `via ${web.engine || "a search engine"}` : "off";
  head.append(dot, name, meta);
  row.appendChild(head);

  const why = document.createElement("div");
  why.className = "conn-why";
  why.textContent = web.warning || "";
  row.appendChild(why);

  const label = document.createElement("label");
  label.className = "conn-opt";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = !!web.enabled;
  box.onchange = () => setWebEnabled(box, box.checked);
  const text = document.createElement("span");
  text.className = "conn-opt-text";
  const t1 = document.createElement("span");
  t1.textContent = web.label || "Allow web search";
  text.appendChild(t1);
  if (web.hint) {
    const hint = document.createElement("span");
    hint.className = "conn-opt-hint";
    hint.textContent = web.hint;
    text.appendChild(hint);
  }
  label.append(box, text);
  row.appendChild(label);
  return row;
}

/** The connectors panel: what REFUGIO is actually plugged into.
 *
 *  Built because the answer to "is WhatsApp working?" used to live only in a
 *  terminal the user had closed. Each connector states its own condition, and
 *  a failed one shows its reason verbatim instead of just going missing. */
async function showConnectors() {
  let panel = document.getElementById("connectors");
  if (panel) { panel.remove(); return; }          // click again to close

  panel = document.createElement("div");
  panel.id = "connectors";
  panel.className = "sheet";
  panel.innerHTML = `<div class="sheet-card"><div class="sheet-head">
      <strong>Connectors</strong><button class="sheet-x" title="Close">&times;</button>
    </div><div class="sheet-body">Checking\u2026</div></div>`;
  document.body.appendChild(panel);

  const close = () => panel.remove();
  panel.querySelector(".sheet-x").onclick = close;
  panel.onclick = (e) => { if (e.target === panel) close(); };   // backdrop
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  });

  const body = panel.querySelector(".sheet-body");
  let data;
  try {
    data = await (await fetch("/api/chat/connectors")).json();
  } catch {
    body.textContent = "Couldn\u2019t reach REFUGIO.";
    return;
  }

  body.innerHTML = "";
  if (!data.connectors?.length) {
    // An empty list right after launch means the pool hasn't read the config
    // yet, NOT that nothing is configured. Telling someone with three working
    // connectors to re-run the installer is worse than saying nothing.
    //
    // The web-search section is still appended below: with no connectors at
    // all it is the one thing here the user can actually switch on.
    const none = document.createElement("div");
    none.innerHTML = data.starting
      ? `<div class="conn-empty">Starting\u2026<br>
         <span class="conn-sub">Connectors take a few seconds to come up.</span></div>`
      : `<div class="conn-empty">No connectors configured.<br>
         <span class="conn-sub">Re-run the REFUGIO installer to add WhatsApp, reminders or notes.</span></div>`;
    body.appendChild(none);
  }
  for (const c of data.connectors || []) {
    const row = document.createElement("div");
    row.className = "conn " + (c.state || (c.ok ? "ok" : "failed"));

    const head = document.createElement("div");
    head.className = "conn-head";
    const dot = document.createElement("span");
    dot.className = "conn-dot";
    const name = document.createElement("span");
    name.className = "conn-name";
    name.textContent = c.label || c.id;
    const meta = document.createElement("span");
    meta.className = "conn-meta";
    const toolCount = `${c.tools} tool${c.tools === 1 ? "" : "s"}`;
    meta.textContent = c.state === "connecting" ? "connecting\u2026"
      : c.state === "degraded" ? `${toolCount} \u00b7 not reachable`
      : c.ok ? toolCount : "not working";
    head.append(dot, name, meta);
    row.appendChild(head);

    // Accounts are what makes a connector plural: two WhatsApp numbers are two
    // things the user thinks about, and an unpaired one is worth surfacing.
    for (const a of c.accounts || []) {
      const acc = document.createElement("div");
      // Paired-but-offline is not the same as never-paired, and calling both
      // "not linked" sends someone to re-scan a QR code they don't need.
      const paired = !!a.phone;
      const state = a.connected ? "" : paired ? " \u2014 offline" : " \u2014 not linked yet";
      acc.className = "conn-acct" + (a.connected ? "" : paired ? " idle" : " off");
      acc.textContent = (paired ? `+${a.phone}` : a.id || "account") + state;
      row.appendChild(acc);
    }

    if (!c.ok && c.error) {
      const err = document.createElement("div");
      err.className = "conn-err";
      err.textContent = c.error;   // textContent: this is a child process's stderr
      row.appendChild(err);
    }

    // Fixing a connector must not require a terminal. That was the whole point
    // of the native window, and it stops being true the moment something
    // breaks — which is exactly when a non-technical user is least able to
    // open one.
    // One primary action: the thing most likely to actually work, chosen from
    // the connector's state rather than from what is cheapest to run.
    if (c.state === "failed" || c.state === "degraded") {
      if (c.conflict) {
        // Name the process. It may be a leftover, or Claude Desktop
        // legitimately holding the same account — only the user knows which,
        // so show what is about to stop rather than just offering "Fix".
        const what = document.createElement("div");
        what.className = "conn-blocked";
        what.textContent = `Blocked by PID ${c.conflict.pid}: ${c.conflict.command}`;
        row.appendChild(what);
      }

      // Say what is wrong BEFORE anything is clicked. Making someone press a
      // button to learn why it won't help is a bad trade, and restarting is
      // exactly that here: the connector is running fine, so there is nothing
      // for a restart to repair.
      const relinkFirst = c.state === "degraded" && !c.conflict && !!c.setup;
      if (relinkFirst) {
        const why = document.createElement("div");
        why.className = "conn-why";
        why.textContent =
          "The connector is running, but this account isn't connected to WhatsApp. " +
          "That usually means the phone unlinked this device, which only re-linking fixes.";
        row.appendChild(why);
      }

      const actions = document.createElement("div");
      actions.className = "conn-actions";

      if (relinkFirst) {
        // Re-link leads. Reconnect was primary here and could never succeed —
        // a prominent button that cannot fix the problem it is offered for.
        const link = document.createElement("a");
        link.className = "conn-btn primary";
        link.href = c.setup.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = c.setup.label;
        actions.appendChild(link);
      }

      const btn = document.createElement("button");
      btn.className = "conn-btn" + (relinkFirst ? "" : " primary");
      // Restarting while something else holds the lock just fails again, so
      // when a blocker is identified that IS the action — not an extra option.
      btn.textContent = c.conflict ? "Stop it and restart"
        : c.state === "degraded" ? "Reconnect anyway" : "Restart";
      btn.onclick = () => runFix(btn, c.id, c.conflict ? "resolve" : "retry");
      actions.appendChild(btn);
      row.appendChild(actions);

      // The outcome belongs between the button that produced it and the next
      // step it recommends. Rendered after the fallback link, "re-link below"
      // pointed at a link that was above it.
      if (pendingNotice && pendingNotice.id === c.id) {
        const note = document.createElement("div");
        note.className = `conn-note ${pendingNotice.tone}`;
        note.textContent = pendingNotice.text;
        row.appendChild(note);
      }

      // Re-linking is the fallback, not the first thing to try: reconnecting is
      // instant and usually enough, while re-linking means getting the phone
      // out. Offer it as a next step for when the quick fix didn't work.
      if (c.setup && !relinkFirst) {
        const more = document.createElement("div");
        more.className = "conn-next";
        more.append(document.createTextNode("Still not working? "));
        const link = document.createElement("a");
        link.href = c.setup.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = c.setup.label;
        link.title = c.setup.hint || "";
        more.appendChild(link);
        row.appendChild(more);
      }
    }

    // Scope options only on a connector that works. Offering "include archived
    // chats" under a connector that cannot reach WhatsApp asks someone to tune
    // something that is not running — and buries the one control that matters
    // (the fix button) under settings that currently change nothing.
    for (const opt of (c.state === "ok" ? c.options || [] : [])) {
      const label = document.createElement("label");
      label.className = "conn-opt";

      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!opt.value;
      box.onchange = () => setConnectorOption(box, c.id, opt.key, box.checked);

      // Checkbox, then a COLUMN holding the label and its hint. Letting the
      // hint be a sibling of the label made it compete for the same row, which
      // crushed the label into a narrow stack of single words.
      const text = document.createElement("span");
      text.className = "conn-opt-text";

      const name = document.createElement("span");
      name.textContent = opt.label;
      text.appendChild(name);

      if (opt.hint) {
        const hint = document.createElement("span");
        hint.className = "conn-opt-hint";
        hint.textContent = opt.hint;
        text.appendChild(hint);
      }

      label.append(box, text);
      row.appendChild(label);
    }
    body.appendChild(row);
  }

  if (data.web) {
    applyWebSetting(data.web);
    body.appendChild(webSection(data.web));
  }
  pendingNotice = null;
}

/** Persist one connector option. Reverts the box if the server refuses, so the
 *  UI can never show a scope that isn't actually in force. */
async function setConnectorOption(box, server, key, value) {
  box.disabled = true;
  try {
    const res = await fetch("/api/chat/connectors/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server, key, value }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed");
  } catch {
    box.checked = !value;
  } finally {
    box.disabled = false;
  }
}

/** Run a connector fix and redraw the panel with the result.
 *
 *  Redraws from the server's response rather than optimistically: the point of
 *  this panel is that it says what is actually true. */
async function runFix(btn, id, action) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = action === "resolve" ? "Stopping\u2026" : "Retrying\u2026";
  try {
    const res = await fetch(`/api/chat/connectors/${encodeURIComponent(id)}/${action}`,
      { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `failed (${res.status})`);

    // Say what happened. The panel redraws from fresh data, so a connector that
    // is still broken renders identically to before — the button appears to
    // simply revert, and the action looks like it did nothing. It ran; it just
    // did not help, and that is a different thing the user needs told.
    const row = (data.connectors || []).find((c) => c.id === id);
    pendingNotice = { id, ...describeOutcome(row, action) };
  } catch (e) {
    pendingNotice = { id, tone: "bad", text: String(e.message || e) };
  }
  document.getElementById("connectors")?.remove();
  await showConnectors();
  refreshStatus();
}

/** Turn the post-fix state into a sentence.
 *
 *  A failed fix is not a failed action — "reconnected, still offline" points at
 *  re-linking, while "could not reach it at all" points somewhere else. */
function describeOutcome(row, action) {
  if (!row) return { tone: "bad", text: "That connector is no longer listed." };
  if (row.state === "ok") {
    return { tone: "good", text: action === "resolve" ? "Stopped it — connector is working." : "Working now." };
  }
  if (row.state === "connecting") return { tone: "info", text: "Restarted — still starting up." };
  if (row.state === "degraded") {
    return { tone: "warn", text: row.setup
      ? "Restarted, and the account is still unreachable — as expected when the device has been unlinked. Use Open WhatsApp setup to re-link."
      : "Restarted, but the account is still unreachable." };
  }
  return { tone: "bad", text: "Still not working." };
}

// ── History rail ────────────────────────────────────────────
//
// Grouping, pinning and the collapsed glyph rail are SHERPA's, ported here.
// A flat list ordered by recency stops being navigable at about thirty
// conversations: everything looks equally important and the one being looked
// for is somewhere in the middle. Date buckets give the list a shape that
// matches how people remember ("that was last week"), and pinning is the
// escape hatch for the handful that must not drift down it.

const RAIL_KEY = "refugio.rail.collapsed";
const DAY = 86_400_000;
const GROUPS = [
  ["today", "Today"], ["yesterday", "Yesterday"],
  ["past7", "Past 7 days"], ["past30", "Past 30 days"], ["older", "Older"],
];

/** Bucket by age, measured from the start of today rather than from now — so
 *  a message sent five minutes ago and one sent this morning are both "Today",
 *  which is what a person means by the word. */
function groupConversations(list) {
  const b = { today: [], yesterday: [], past7: [], past30: [], older: [] };
  const n = new Date();
  const startOfToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  for (const c of list) {
    const t = new Date(c.updated_at || c.created_at).getTime();
    if (Number.isNaN(t)) { b.older.push(c); continue; }
    const ageDays = (startOfToday - t) / DAY;
    if (t >= startOfToday) b.today.push(c);
    else if (ageDays < 1) b.yesterday.push(c);
    else if (ageDays < 7) b.past7.push(c);
    else if (ageDays < 30) b.past30.push(c);
    else b.older.push(c);
  }
  return GROUPS.filter(([k]) => b[k].length).map(([key, label]) => ({ key, label, items: b[key] }));
}

// One character for the collapsed rail. Skipping the words that start most
// questions is the whole trick — otherwise half the rail reads "W" for "What…"
// and the glyphs distinguish nothing.
const STOPWORDS = new Set((
  "a an the this that these those " +
  "what who why how when where which " +
  "is are was were be been am do does did can could should would will " +
  "for of in to on at by with from about and or but not " +
  "i me my we our you your it its"
).split(" "));
function convGlyph(title) {
  const t = (title || "").trim();
  if (!t) return "·";
  let tokens = t.split(/[\s\-_:/]+/).filter((w) => w && !STOPWORDS.has(w.toLowerCase()));
  if (!tokens.length) tokens = t.split(/\s+/);
  return (tokens[0] || "").charAt(0).toUpperCase() || "·";
}

/** Time for today, date for anything older — a bare clock time on a chat from
 *  March is worse than useless. */
function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const n = new Date();
  const startOfToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  return d.getTime() >= startOfToday
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

const PIN_PATH = "M12 2.5 17.5 8l-3.2 1-2 6-3.6-3.6L3 18l5.7-5.6L5 8.7l6.3-2L12 2.5Z";
const PIN_FILLED =
  `<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="${PIN_PATH}"/></svg>`;
const PIN_OUTLINE =
  `<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" ` +
  `stroke-linejoin="round" aria-hidden="true"><path d="${PIN_PATH}"/></svg>`;

function convoRow(c) {
  const title = c.title || "Untitled";
  const row = document.createElement("div");
  row.className = "convo" + (c.id === state.conversationId ? " active" : "") +
    (c.pinned ? " pinned" : "");
  row.dataset.cid = c.id;
  // Collapsed, the tooltip is the only label there is.
  row.title = title;
  row.onclick = () => openConversation(c.id);

  const glyph = document.createElement("span");
  glyph.className = "convo-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = convGlyph(title);

  const text = document.createElement("span");
  text.className = "convo-text";
  const t = document.createElement("span");
  t.className = "convo-title";
  t.textContent = title;
  const when = document.createElement("span");
  when.className = "convo-when";
  when.textContent = fmtWhen(c.updated_at || c.created_at);
  text.append(t, when);

  const pin = document.createElement("button");
  pin.className = "convo-pin";
  pin.type = "button";
  pin.title = c.pinned ? "Unpin" : "Pin to top";
  pin.setAttribute("aria-label", pin.title);
  pin.innerHTML = c.pinned ? PIN_FILLED : PIN_OUTLINE;   // our own static markup
  pin.onclick = (e) => { e.stopPropagation(); togglePin(c.id, !c.pinned); };

  const del = document.createElement("button");
  del.className = "convo-del";
  del.type = "button";
  del.title = "Delete";
  del.textContent = "×";
  del.onclick = async (e) => {
    e.stopPropagation();
    await fetch(`/api/chat/conversations/${c.id}`, { method: "DELETE" });
    if (state.conversationId === c.id) newChat();
    else loadConversations();
  };

  row.append(glyph, text, pin, del);
  return row;
}

async function togglePin(id, pinned) {
  try {
    await fetch(`/api/chat/conversations/${encodeURIComponent(id)}/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned }),
    });
  } catch { /* the reload below will show the unchanged state */ }
  loadConversations();
}

async function loadConversations() {
  let list;
  try { list = await (await fetch("/api/chat/conversations")).json(); }
  catch { return; }

  els.convos.innerHTML = "";
  if (!list.length) {
    const e = document.createElement("div");
    e.className = "convos-empty";
    e.textContent = "No conversations yet.";
    els.convos.appendChild(e);
    return;
  }

  // Pinned conversations render once, at the top, and are removed from their
  // date group — appearing in both would double every pinned row and make the
  // counts lie.
  const pinned = list.filter((c) => c.pinned);
  const sections = [
    ...(pinned.length ? [{ key: "pinned", label: "Pinned", items: pinned }] : []),
    ...groupConversations(list.filter((c) => !c.pinned)),
  ];

  for (const g of sections) {
    const head = document.createElement("div");
    head.className = "convo-group";
    head.dataset.group = g.key;
    const label = document.createElement("span");
    label.className = "cg-label";
    label.textContent = g.label;
    const count = document.createElement("span");
    count.className = "cg-count";
    count.textContent = String(g.items.length);
    head.append(label, count);
    els.convos.appendChild(head);
    for (const c of g.items) els.convos.appendChild(convoRow(c));
  }
}

/** Move the highlight without rebuilding the list.
 *
 *  The active row has to move the instant a conversation is opened, not when
 *  the reload happens to come back — otherwise the rail spends the load still
 *  pointing at the chat the user just left. */
function highlightActive() {
  for (const r of els.convos.querySelectorAll(".convo.active")) r.classList.remove("active");
  if (!state.conversationId) return;
  for (const r of els.convos.querySelectorAll(".convo")) {
    if (r.dataset.cid === state.conversationId) r.classList.add("active");
  }
}

function setRailCollapsed(on) {
  state.railCollapsed = !!on;
  els.rail.classList.toggle("collapsed", state.railCollapsed);
  els.railToggle.textContent = state.railCollapsed ? "»" : "«";
  const label = state.railCollapsed ? "Expand history" : "Collapse history";
  els.railToggle.title = label;
  els.railToggle.setAttribute("aria-label", label);
  try { localStorage.setItem(RAIL_KEY, state.railCollapsed ? "1" : "0"); } catch {}
}

async function openConversation(id) {
  state.conversationId = id;
  highlightActive();                       // before the fetch, not after
  // Sources aren't persisted, so a reopened conversation has none. Showing the
  // previous chat's would be worse than showing nothing.
  resetSources();
  showThreadLoading();
  let convo;
  try { convo = await (await fetch(`/api/chat/conversations/${id}`)).json(); }
  catch { showError("Couldn’t load that conversation."); return; }
  els.thread.innerHTML = "";
  for (const m of convo.messages) addMessage(m.role, m.content);
  stick = true; scrollToEnd();
  loadConversations();
}

// ── Sources ─────────────────────────────────────────────────
//
// SHERPA's right-hand gutter, pointed at what REFUGIO actually has. There, a
// source is a retrieved document the model cited by token. Here there are no
// citation tokens and a 3B model would not emit them reliably if there were —
// what exists is the tool calls the answer was built from: the chats read, the
// reminders listed, the web results fetched.
//
// So this panel does not claim the model cited anything. It shows the evidence
// the answer had in front of it, which is the honest form of the question
// people actually ask — "where did this come from?" — and the one thing a
// local assistant reading your own data owes you.
//
// Live for the session only. Persisting sources would mean writing every tool
// result — other people's messages, in full — into the chat database to power
// a side panel. The answer is stored; the raw dump behind it is not.

let sources = [];

const CONNECTOR_NAMES = {
  whatsapp: "WhatsApp", reminders: "Apple Reminders", things: "Things 3",
  notion: "Notion", memory: "Memory", email: "Email", web: "Web search",
};
function splitToolName(name) {
  const [server, ...rest] = String(name).split("__");
  return { server, tool: rest.join("__") || server,
           label: CONNECTOR_NAMES[server] || server };
}

function resetSources() {
  sources = [];
  renderSources();
}

function addSource(entry) {
  sources.push(entry);
  renderSources();
  // Never steals focus by opening itself. A panel that springs out mid-answer
  // moves the text being read; the count on the tab is enough of an invitation.
}

function sourceCard(s, n) {
  const { tool, label } = splitToolName(s.name);
  const card = document.createElement("div");
  card.className = "src" + (s.ok ? "" : " failed");
  card.dataset.tool = s.name;

  const head = document.createElement("div");
  head.className = "src-head";
  const num = document.createElement("span");
  num.className = "src-n";
  num.textContent = String(n);
  const title = document.createElement("span");
  title.className = "src-title";
  title.textContent = `${label} · ${tool}`;
  head.append(num, title);
  card.appendChild(head);

  // What was actually asked for. Without it two calls to the same tool are
  // indistinguishable, which is exactly the case where it matters.
  const argText = Object.entries(s.args || {})
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ·  ");
  if (argText) {
    const args = document.createElement("div");
    args.className = "src-args";
    args.textContent = argText;
    card.appendChild(args);
  }

  // Web results are real links and deserve to be openable, not buried in the
  // text blob the model was given.
  if (s.links?.length) {
    const list = document.createElement("div");
    list.className = "src-links";
    for (const l of s.links) {
      const a = document.createElement("a");
      a.href = /^https?:\/\//i.test(l.url) ? l.url : "#";   // the server filters; belt and braces
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = l.title || l.url;
      a.title = l.url;
      list.appendChild(a);
    }
    card.appendChild(list);
  }

  const body = document.createElement("pre");
  body.className = "src-body";
  body.textContent = s.text || (s.ok ? "(empty result)" : "(no detail)");
  card.appendChild(body);

  if (s.truncated) {
    const more = document.createElement("div");
    more.className = "src-trunc";
    more.textContent = "Result truncated.";
    card.appendChild(more);
  }

  // Long results collapse, with a toggle that only appears when there is
  // something to reveal.
  //
  // Decided from the text, not from measuring the rendered element: cards are
  // built while the panel is collapsed (display:none), where every height is
  // zero — so a measurement said "nothing to reveal" about every card, and the
  // toggle was never added to any of them.
  const text = body.textContent;
  if (text.length > 600 || text.split("\n").length > 12) {
    const btn = document.createElement("button");
    btn.className = "src-more";
    btn.type = "button";
    btn.textContent = "Show all";
    btn.onclick = () => {
      const open = card.classList.toggle("expanded");
      btn.textContent = open ? "Show less" : "Show all";
    };
    // After the result, before the truncation note. insertBefore(null) appends.
    card.insertBefore(btn, card.querySelector(".src-trunc"));
  }

  return card;
}

function renderSources() {
  els.gutter.hidden = !sources.length;
  els.gutterCount.textContent = String(sources.length);
  els.gutterBody.innerHTML = "";
  sources.forEach((s, i) => els.gutterBody.appendChild(sourceCard(s, i + 1)));
  if (!sources.length) setGutter(false);
}

function setGutter(open) {
  els.gutter.classList.toggle("is-collapsed", !open);
}

/** Open the panel at the newest card for one tool — what a tool chip means. */
function revealSource(name) {
  setGutter(true);
  const cards = els.gutterBody.querySelectorAll(`.src[data-tool="${CSS.escape(name)}"]`);
  const card = cards[cards.length - 1];
  if (!card) return;
  card.scrollIntoView({ block: "nearest" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 900);
}

// The empty state is written once, in index.html, and captured here. It used to
// be spelled out again in newChat(), so the two drifted the moment either
// changed — the beta notice would have appeared on first load and vanished the
// first time someone clicked "New chat".
const EMPTY_HTML = els.thread.innerHTML;

function newChat() {
  state.conversationId = null;
  resetSources();
  els.thread.innerHTML = EMPTY_HTML;
  els.empty = $("empty");
  loadConversations();
  els.input.focus();
}

/** Send a turn and paint tokens as they arrive over SSE. */
async function send() {
  const text = els.input.value.trim();
  if (!text || state.streaming) return;

  // Consume the arming here, before anything is sent. Clearing it in `finally`
  // would leave it set for as long as the answer takes to stream — and if the
  // turn failed, still set afterwards, so the next message would search
  // without the user asking twice.
  const web = state.webArmed;
  setWebArmed(false);

  // Sources belong to the answer on screen. Carrying the previous turn's into
  // this one would attribute an answer to evidence it never saw.
  resetSources();

  els.input.value = "";
  els.input.style.height = "auto";
  addMessage("user", text);
  if (web) markWebTurn();
  setStreaming(true);

  const bubble = addMessage("assistant", "");
  bubble.classList.add("cursor");
  setThinking(bubble, true);
  let acc = "";

  try {
    state.abort = new AbortController();
    const res = await fetch("/api/chat/ask", {
      method: "POST",
      signal: state.abort.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        conversation_id: state.conversationId,
        model: els.model.value || undefined,
        web,
      }),
    });

    if (!res.ok || !res.body) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      // SSE frames are separated by a blank line; keep any partial frame.
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";

      for (const frame of frames) {
        const ev = /^event: (.+)$/m.exec(frame)?.[1];
        const raw = /^data: (.+)$/m.exec(frame)?.[1];
        if (!ev || !raw) continue;
        let data; try { data = JSON.parse(raw); } catch { continue; }

        if (ev === "start") { state.conversationId = data.conversation_id; highlightActive(); }
        else if (ev === "tool") showTool(bubble, data.name, "running");
        else if (ev === "tool_result") {
          showTool(bubble, data.name, data.ok ? "ok" : "failed");
          addSource(data);
        }
        else if (ev === "token") {
          if (!acc) setThinking(bubble, false);
          acc += data.t; bubble.innerHTML = renderContent(acc); scrollToEnd();
        }
        else if (ev === "error") throw new Error(data.error);
        else if (ev === "done") { state.conversationId = data.conversation_id; loadConversations(); }
      }
    }
    if (!acc) showError("The model returned an empty response.");
  } catch (err) {
    // Aborting is a deliberate user action, not an error worth shouting about.
    if (err.name !== "AbortError") showError(err.message || String(err));
  } finally {
    state.abort = null;
    if (!acc) setThinking(bubble, false);
    bubble.classList.remove("cursor");
    setStreaming(false);
    els.input.focus();
  }
}

// Show which tools a turn used, inline above the answer. Local models are
// slow enough that silence during a tool call reads as a hang.
function showTool(bubble, name, state) {
  const content = bubble.parentElement;          // .content column
  let strip = content.querySelector(".tools");
  if (!strip) {
    strip = document.createElement("div");
    strip.className = "tools";
    content.insertBefore(strip, bubble);
  }
  const id = "t-" + name.replace(/[^a-z0-9]/gi, "-");
  let chip = strip.querySelector("#" + id);
  if (!chip) {
    chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tool-chip"; chip.id = id;
    // The chip is the way into the sources panel: it names the tool that ran,
    // so it is the obvious thing to press to ask what that tool returned.
    chip.title = "Show what this returned";
    chip.onclick = () => revealSource(name);
    strip.appendChild(chip);
  }
  chip.dataset.state = state;
  const label = name.replace("__", " \u00b7 ");

  clearInterval(chip._timer);
  if (state !== "running") {
    chip.textContent = (state === "ok" ? "\u2713 " : "\u2717 ") + label;
    scrollToEnd();
    return;
  }

  // Count up while the tool runs. Reading a WhatsApp history takes real time,
  // and a chip that sits unchanged is indistinguishable from a hang \u2014 which
  // is what anyone concludes after ten silent seconds of nothing moving.
  const t0 = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    chip.textContent = "\u2699 " + label + (s ? ` ${s}s` : "");
  };
  tick();
  chip._timer = setInterval(tick, 1000);
  scrollToEnd();
}

function setStreaming(on) {
  state.streaming = on;
  // The send button doubles as Stop. With a slow local model, being unable to
  // interrupt a wrong answer is the single most frustrating thing a chat UI
  // can do — so this is never disabled while streaming.
  els.send.textContent = on ? "\u25A0" : "\u2191";
  els.send.title = on ? "Stop" : "Send";
  els.send.classList.toggle("stopping", on);
  els.send.disabled = on ? false : !els.input.value.trim();
}

// ── Wiring ──────────────────────────────────────────────────

els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 192) + "px";
  els.send.disabled = state.streaming || !els.input.value.trim();
});
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
els.send.addEventListener("click", () => {
  if (state.streaming) { state.abort?.abort(); return; }
  send();
});

// Copy buttons on code blocks (delegated — blocks are re-rendered every token).
els.thread.addEventListener("click", (e) => {
  const btn = e.target.closest(".copy");
  if (!btn) return;
  const code = btn.parentElement.querySelector("code");
  navigator.clipboard?.writeText(code.textContent).then(() => {
    btn.textContent = "copied"; setTimeout(() => (btn.textContent = "copy"), 1200);
  });
});
els.webArm.addEventListener("click", () => setWebArmed(!state.webArmed));
els.status.addEventListener("click", showConnectors);
els.newChat.addEventListener("click", newChat);
els.model.addEventListener("change", () => { state.model = els.model.value; });

els.railToggle.addEventListener("click", () => setRailCollapsed(!state.railCollapsed));
els.gutterRail.addEventListener("click", () => setGutter(true));
els.gutterX.addEventListener("click", () => setGutter(false));

// Restore the rail before the first paint of the list, so it doesn't render
// wide and then snap narrow.
try { setRailCollapsed(localStorage.getItem(RAIL_KEY) === "1"); } catch { setRailCollapsed(false); }

refreshStatus();
loadConversations();
setInterval(refreshStatus, 15000);
