// REFUGIO chat — purpose-built controller.
//
// Written fresh rather than adapted from SHERPA's chat-v2.js: that one is
// organised around an evidence/citation domain REFUGIO has no equivalent of,
// and is request/response. Streaming is the whole point here — a local model
// emits tokens slowly enough that waiting for a complete reply feels broken.

const $ = (id) => document.getElementById(id);

/** Build an element: `el("div.a.b", {attrs}, ...children)`.
 *
 *  settings.js has had one of these for a while; this file has been getting by
 *  with createElement because nothing in it built more than a div with text in
 *  it. The mode picker does. Text goes in via `text`/textContent and never as
 *  innerHTML — house rule, and the strings here come from the backend. */
function el(spec, attrs = {}, ...kids) {
  const [tag, ...classes] = spec.split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "on") { for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn); }
    else if (k === "text") node.textContent = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}
const els = {
  convos: $("convos"), thread: $("thread"), scroll: $("scroll"), empty: $("empty"),
  input: $("input"), send: $("send"), newChat: $("new-chat"),
  modelBtn: $("model-btn"), modelPanel: $("model-panel"), modelDot: $("model-dot"),
  modelName: $("model-name"), modelSize: $("model-size"), themeBtn: $("theme-btn"),
  status: $("status"), statusText: $("status-text"),
  webArm: $("web-arm"), webWarn: $("web-warn"),
  modePill: $("mode-pill"), modePillText: $("mode-pill-text"),
  modePanel: $("mode-panel"), modeBanner: $("mode-banner"),
  attachBtn: $("attach-btn"), attachInput: $("attach-input"),
  attachTray: $("attach-tray"), dropVeil: $("drop-veil"),
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
  // Two facts again, and they are not the same one. `modes` is what the
  // backend offers; `mode` is this conversation's, chosen before the first
  // message and fixed for its life — the server reads it from the row after
  // turn one and ignores anything the client sends, so this is a mirror of
  // the truth rather than the truth.
  modes: null, mode: null,
  railCollapsed: false,
  // The last /api/chat/status payload, kept so the model panel can be drawn on
  // click without a round trip — the numbers in it are at most fifteen seconds
  // old, and the panel refreshes them as it opens.
  status: null,
  // Set when the user chooses to send anyway on a model that cannot call
  // tools. Cleared on every model change: the override is for the model that
  // was selected when it was given, not for the next one.
  toolWarningOverridden: false,
  // Files attached to the message being composed. Each is already on disk by
  // the time it appears here — the upload happens on choosing, not on sending,
  // so a slow 20 MB file is waited for while still typing rather than after
  // pressing send.
  attachments: [],
};

const HINT_DEFAULT = "Enter to send · Shift+Enter for a new line · drag a file in to attach it";

// ── Rendering ───────────────────────────────────────────────

import { renderMarkdown } from "./md.js";
import { preferredModel, setPreferredModel, activeModel } from "./model-store.js";
// Also imported for its side effects: the head script sets the theme for first
// paint, and this keeps it current afterwards — when macOS switches at sunset,
// and when the setting is changed in a Settings window open elsewhere.
import { resolvedTheme, setThemePreference } from "./theme.js";

/** Model output is untrusted text; md.js escapes before adding any markup. */
const renderContent = (text) => renderMarkdown(text);

/** Separate REFUGIO's own words from the model's.
 *
 *  When the person's message carries a crisis signal and the model did not
 *  point at real help, the server appends the resources to the reply itself —
 *  a floor that does not depend on the model, because on the smaller tiers it
 *  was measured not to hold. That text is stored in the message, so it also
 *  comes back on reopen; both paths run through here so the two views agree.
 *
 *  Matched against the exact string the backend sent us rather than a pattern.
 *  If the copy is ever reworded, an old message renders as plain text instead
 *  of as a notice — a worse-looking answer, never a missing one. */
function splitCrisisNote(text) {
  const note = state.modes?.resources;
  if (!note || typeof text !== "string") return [text, null];
  const at = text.lastIndexOf(note);
  if (at === -1) return [text, null];
  return [text.slice(0, at).trimEnd(), note];
}

function crisisNoteNode(note) {
  return el("div.crisis-note", {},
    el("span.who", { text: "From REFUGIO, not the model" }),
    el("div", { text: note }),
  );
}

function addMessage(role, text, files = []) {
  els.empty?.remove();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  // avatar + a column for [tool chips, text] — the strip must stack ABOVE the
  // answer, and .msg itself is a flex row.
  wrap.innerHTML =
    `<div class="avatar">${role === "user" ? "You" : "R"}</div>` +
    `<div class="content"><div class="bubble"></div></div>`;
  const bubble = wrap.querySelector(".bubble");
  const [body, note] = splitCrisisNote(text);
  bubble.innerHTML = renderContent(body);
  if (note) wrap.querySelector(".content").appendChild(crisisNoteNode(note));
  if (files.length) {
    const list = document.createElement("div");
    list.className = "attach-list";
    for (const f of files) list.appendChild(chipNode(f));
    wrap.querySelector(".content").appendChild(list);
  }
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
    state.status = s;
    renderModelButton();
    if (!els.modelPanel.hidden) renderModelPanel();

    applyWebSetting(s.web);
    applyModes(s.modes);
    applyManaged(s.managed);
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
  // Two problems now, not three. The third — a model that cannot call tools —
  // was a one-line bar telling the user to run `ollama pull` in a terminal,
  // which is the thing this app exists to avoid. It is now intercepted at the
  // point it does damage, in the thread, with buttons: see toolGuard().
  let text = null;
  let action = null;
  if (!s.ollamaUp) {
    text = "Ollama isn't running, so REFUGIO can't answer anything. Start the Ollama app and this will clear.";
  } else if (!modelFor(s) || !(s.models || []).length) {
    text = "No model is installed. REFUGIO can't answer anything until there is one.";
    action = { label: "Download one", pane: "models" };
  }

  let bar = document.getElementById("model-warn");
  if (!text) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "model-warn";
    bar.className = "model-warn";
    els.scroll.parentElement.insertBefore(bar, els.scroll);
  }
  bar.replaceChildren(document.createTextNode(text));
  if (action) {
    const a = document.createElement("a");
    a.href = `/settings#${action.pane}`;
    a.textContent = action.label;
    bar.append(" ", a);
  }
}

// ── Model picker (4d) ───────────────────────────────────────
//
// A panel rather than a <select>, because the decision needs numbers a native
// option list cannot carry: what a model costs, whether it fits in the memory
// free RIGHT NOW, and — the one that actually matters — whether it can reach
// the connectors at all. A select could only ever append that to a string.

/** The model in use: the user's choice if it is still installed, else the
 *  server's. One function so the button, the panel, the guard and the request
 *  body cannot disagree about which model this is. */
function modelFor(s) { return activeModel(s); }

function modelInfo(s, name) {
  return (s?.models || []).find((m) => m.name === name) || null;
}

function renderModelButton() {
  const s = state.status;
  const name = modelFor(s);
  state.model = name;

  const info = modelInfo(s, name);
  const noTools = info?.tools === false;

  els.modelName.textContent = name || "no model";
  els.modelSize.textContent = noTools ? "NO TOOLS" : info?.needGb ? `${info.needGb} GB` : "";
  els.modelSize.classList.toggle("warn", noTools);
  els.modelDot.className = `dot ${!s?.ollamaUp || !name ? "failed" : noTools ? "degraded" : "ok"}`;
  els.modelBtn.classList.toggle("warn", noTools);
  els.modelBtn.title = noTools
    ? `${name} cannot call tools, so it cannot read anything through your connectors.`
    : name ? `${name} — click to change model` : "No model installed";

  toolGuard();
}

function renderModelPanel() {
  const s = state.status;
  const panel = els.modelPanel;
  panel.replaceChildren();
  const active = modelFor(s);

  // Free memory first, as a bar. Every row below is a claim against it, and
  // "6.2 GB" means nothing without the number it is being subtracted from.
  if (s?.memory) {
    const pct = Math.max(0, Math.min(100, (s.memory.freeGb / s.memory.totalGb) * 100));
    const head = document.createElement("div");
    head.className = "mp-mem";
    const label = document.createElement("span");
    label.className = "t-label";
    label.textContent = "Memory free right now";
    const track = document.createElement("span");
    track.className = "mp-track";
    const fill = document.createElement("i");
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    const num = document.createElement("span");
    num.className = "mp-num";
    num.textContent = `${s.memory.freeGb} GB`;
    head.append(label, track, num);
    panel.appendChild(head);
  }

  for (const m of s?.models || []) {
    const isActive = m.name === active;
    const tooBigEver = m.everFits === false;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mp-row" + (isActive ? " active" : "") + (tooBigEver ? " dim" : "");
    row.disabled = tooBigEver;

    const dot = document.createElement("span");
    dot.className = `dot ${isActive ? "ok" : "idle"}`;

    const mid = document.createElement("div");
    mid.className = "mp-mid";
    const tag = document.createElement("div");
    tag.className = "mp-tag";
    tag.textContent = m.name;
    const sub = document.createElement("div");
    sub.className = "mp-sub";
    // One line, and it is about what this model can do for you — not a second
    // copy of the size, which is already on the right.
    sub.textContent = m.tools === false ? "Cannot call tools — no connectors"
      : tooBigEver ? "Too large for this Mac"
      : m.fits === false ? `Needs ${m.freeUpGb} GB more than is free`
      : isActive ? "In use · calls tools"
      : m.tools === null ? "Tool calling unrated"
      : "Calls tools";
    if (m.tools === false) sub.classList.add("warn");
    mid.append(tag, sub);

    const right = document.createElement("div");
    right.className = "mp-right";
    const gb = document.createElement("div");
    gb.className = "mp-gb";
    gb.textContent = m.needGb ? `${m.needGb} GB` : "";
    const fit = document.createElement("div");
    fit.className = "mp-fit " + (tooBigEver || m.fits === false ? "no" : "ok");
    fit.textContent = tooBigEver ? "TOO BIG" : m.fits === false ? "TOO BIG NOW" : "FITS";
    right.append(gb, fit);

    row.append(dot, mid, right);
    if (!tooBigEver) row.addEventListener("click", () => pickModel(m.name));
    panel.appendChild(row);
  }

  if (!(s?.models || []).length) {
    const none = document.createElement("div");
    none.className = "mp-none";
    none.textContent = s?.ollamaUp
      ? "No models installed."
      : "Ollama isn't running, so there is nothing to list.";
    panel.appendChild(none);
  }

  const foot = document.createElement("div");
  foot.className = "mp-foot";
  const manage = document.createElement("a");
  manage.href = "/settings#models";
  manage.textContent = "Manage models";
  const more = document.createElement("a");
  more.href = "/settings#models";
  more.textContent = "Download another";
  const note = document.createElement("span");
  note.className = "mp-note";
  note.textContent = "SWITCHING KEEPS THIS CHAT";
  foot.append(manage, more, note);
  panel.appendChild(foot);
}

function setModelPanel(open) {
  els.modelPanel.hidden = !open;
  els.modelBtn.setAttribute("aria-expanded", String(open));
  if (open) { renderModelPanel(); refreshStatus(); }
}

function pickModel(name) {
  setPreferredModel(name);
  // The override travels with the model it was given for. Switching away and
  // back must ask again — otherwise one "send anyway" silently disarms the
  // warning for the rest of the session.
  state.toolWarningOverridden = false;
  renderModelButton();
  setModelPanel(false);
}

// ── The model that cannot call tools (4f) ───────────────────
//
// The worst failure in the product, and the quietest: everything looks
// healthy, the model answers fluently, and it invents the contents of your
// WhatsApp because it has no way to look. It cannot be a banner — a banner is
// something you scroll past — so sending is held until the choice is made.

function toolGuard() {
  const s = state.status;
  const name = modelFor(s);
  const info = modelInfo(s, name);
  // A coaching mode is offered no tools at all, so a model that cannot call
  // them is not merely acceptable here — it is arguably the best use of one.
  // The guard stays for paired modes, which do need their connector.
  const pureMode = !!state.mode && !modeById(state.mode)?.requiresConnector;
  const blocked = info?.tools === false && !state.toolWarningOverridden && !pureMode;

  document.getElementById("tool-guard")?.remove();
  els.input.classList.toggle("held", blocked);
  // A file on its own is a message. Requiring typed text as well would mean
  // attaching something and then having to type "here" before it can be sent.
  const empty = !els.input.value.trim() && !sendableFiles().length;
  if (els.send) els.send.disabled = state.streaming ? false : blocked || empty;

  const hint = document.querySelector(".composer .hint");
  if (hint) {
    hint.textContent = blocked
      ? "Sending is paused while a model that cannot use your connectors is selected."
      : HINT_DEFAULT;
    hint.classList.toggle("warn", blocked);
  }
  if (!blocked) return;

  // Offer the models that WOULD work, by name, with their fit — the whole
  // point is that the fix is one click and needs no knowledge of Ollama.
  //
  // Ordered by what fits first, then LARGEST first within that — the primary
  // button should be the most capable model this machine can actually run,
  // not the cheapest. Someone who has just been told their answer would be
  // invented wants the best available, and the smaller one is right there as
  // the second button if they'd rather have speed.
  const alternatives = (s?.models || [])
    .filter((m) => m.tools === true && m.everFits !== false)
    .sort((a, b) => (b.fits === true) - (a.fits === true) || (b.needGb || 0) - (a.needGb || 0))
    .slice(0, 2);

  const card = document.createElement("div");
  card.id = "tool-guard";
  card.className = "tool-guard";

  const dot = document.createElement("span");
  dot.className = "dot degraded";

  const body = document.createElement("div");
  body.className = "tg-body";

  const h = document.createElement("div");
  h.className = "tg-head";
  h.textContent = `${name} cannot read your data.`;

  const p = document.createElement("div");
  p.className = "tg-prose";
  p.append(
    document.createTextNode("This model has no way to call connectors, so it will answer from general knowledge and "),
  );
  const strong = document.createElement("strong");
  strong.textContent = "quietly make things up";
  p.append(strong, document.createTextNode(
    " about anything it should have looked up. Your connectors are fine — it simply cannot reach them."));

  body.append(h, p);

  if (alternatives.length) {
    const box = document.createElement("div");
    box.className = "tg-switch";
    const lbl = document.createElement("div");
    lbl.className = "t-label";
    lbl.textContent = "Switch to a model that can";
    const row = document.createElement("div");
    row.className = "tg-actions";
    alternatives.forEach((m, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn" + (i === 0 ? " primary" : "");
      b.textContent = `Use ${m.name} · ${m.fits === false ? "tight" : "fits"}`;
      b.addEventListener("click", () => pickModel(m.name));
      row.appendChild(b);
    });
    const anyway = document.createElement("button");
    anyway.type = "button";
    anyway.className = "btn link";
    anyway.textContent = "Ask anyway, without my data";
    anyway.addEventListener("click", () => {
      state.toolWarningOverridden = true;
      toolGuard();
      els.input.focus();
    });
    row.appendChild(anyway);
    box.append(lbl, row);
    body.appendChild(box);
  } else {
    // Nothing installed can do the job. The fix is a download, not a switch.
    const box = document.createElement("div");
    box.className = "tg-switch";
    const lbl = document.createElement("div");
    lbl.className = "t-label";
    lbl.textContent = "Nothing installed can call tools";
    const row = document.createElement("div");
    row.className = "tg-actions";
    const dl = document.createElement("a");
    dl.className = "btn primary";
    dl.href = "/settings#models";
    dl.textContent = "Download one that can";
    const anyway = document.createElement("button");
    anyway.type = "button";
    anyway.className = "btn link";
    anyway.textContent = "Ask anyway, without my data";
    anyway.addEventListener("click", () => { state.toolWarningOverridden = true; toolGuard(); els.input.focus(); });
    row.append(dl, anyway);
    box.append(lbl, row);
    body.appendChild(box);
  }

  const foot = document.createElement("div");
  foot.className = "tg-foot";
  foot.textContent = "Switching keeps this conversation.";
  body.appendChild(foot);

  card.append(dot, body);
  els.thread.appendChild(card);
  scrollToEnd();
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

/** Persist the standing permission.
 *
 *  Lives in Settings now, but the chat still has to react: the composer's
 *  per-message arming control must appear and disappear with it. */
async function setWebEnabled(enabled) {
  try {
    const res = await fetch("/api/chat/web", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) applyWebSetting((await res.json()).web);
  } catch { /* the next status poll will correct the control */ }
}

// ── Discussion modes ────────────────────────────────────────
//
// The inverse of web arming above. That control adds the one capability that
// leaves this machine, so it is per-message, loud, and forgotten immediately.
// A mode removes capability — no tools, no web, no generated title — and binds
// to the conversation instead: chosen before the first message, then fixed,
// because the system prompt is rebuilt every turn and switching mid-thread
// would silently reframe everything already said.

/** Reflect what the backend offers. Nothing enabled means no control at all —
 *  the same doctrine as web search, where a visible switch that does nothing
 *  is worse than no switch. */
function applyModes(modes) {
  state.modes = modes || null;
  renderModeControl();
}

/** The modes this build defines, that are switched on, and whose connector (if
 *  any) is actually ready. */
function offerableModes() {
  return (state.modes?.available || []).filter(
    (m) => state.modes?.enabled?.[m.id] && (!m.requiresConnector || m.connectorOk)
  );
}

const modeById = (id) => (state.modes?.available || []).find((m) => m.id === id) || null;

/** Draw the pill, the banner, and the web control's visibility together.
 *
 *  One function rather than three, because they are three views of a single
 *  fact and drifting between them is how a conversation ends up showing a
 *  mode banner next to an armed web button that the server will refuse. */
function renderModeControl() {
  const active = state.mode ? modeById(state.mode) : null;
  const started = !!state.conversationId;
  const offerable = offerableModes();

  // Visible when a mode is running, or when one could still be chosen. Not on
  // a conversation that already has messages and no mode: that choice is gone.
  els.modePill.hidden = !active && (started || !offerable.length);
  els.modePill.classList.toggle("is-set", !!active);
  els.modePillText.textContent = active ? `${active.icon || ""} ${active.label}`.trim() : "Mode";
  els.modePill.setAttribute("aria-expanded", String(!els.modePanel.hidden));
  els.modePill.title = active
    ? "This conversation's mode. It cannot be changed — start a new chat to leave it."
    : "Have this conversation in a coaching mode";

  els.modeBanner.hidden = !active;
  els.modeBanner.textContent = active?.disclosure || "";

  // Courtesy, not the mechanism. The server forces web off for every mode turn
  // and refuses the tool if the model names it anyway; hiding the button just
  // stops the interface offering something that would be refused.
  if (active) {
    setWebArmed(false);
    els.webArm.hidden = true;
  } else if (state.web.enabled) {
    els.webArm.hidden = false;
  }
  if (active) closeModePanel();
}

function closeModePanel() {
  els.modePanel.hidden = true;
  els.modePill.setAttribute("aria-expanded", "false");
}

function openModePanel() {
  const offerable = offerableModes();
  if (!offerable.length) return;
  els.modePanel.replaceChildren();

  els.modePanel.append(el("div.mode-panel-head", {
    text: state.modes?.note
      || "A mode belongs to one conversation and is chosen before the first message.",
  }));

  for (const m of offerable) {
    const opt = el("button.mode-opt", {
      type: "button",
      on: { click: () => chooseMode(m.id) },
    },
      el("div.mode-opt-title", { text: `${m.icon || ""} ${m.label}`.trim() }),
      el("div.mode-opt-hint", { text: m.hint || "" }),
    );
    // Honest labelling, the same as the model picker's. Not a preference for
    // bigger models: on a smaller one this mode's safety wording was measured
    // to hold less well, and saying so costs a line.
    if (m.recommendedTier && !tierMet(state.model, m.recommendedTier)) {
      opt.append(el("div.mode-opt-note", {
        text: `Best on an ${m.recommendedTier.toUpperCase()} model or larger.`,
      }));
    }
    els.modePanel.append(opt);
  }

  // Leaving is starting a new chat, so say it here rather than letting someone
  // discover it by looking for a way out.
  els.modePanel.append(el("div.mode-panel-head", {
    text: "Modes get no connectors and no web search. Leaving one means starting a new chat.",
  }));

  els.modePanel.hidden = false;
  els.modePill.setAttribute("aria-expanded", "true");
}

/** Parse a parameter count out of a model tag.
 *
 *  Deliberately crude — a wrong guess shows or hides one advisory line, so a
 *  readable heuristic beats a table that needs maintaining as models ship.
 *  Unknown means "assume it is fine" rather than nagging about a model whose
 *  size cannot be read off its name. */
function tierMet(model, tier) {
  if (!model) return true;
  const want = parseFloat(String(tier).replace(/[^0-9.]/g, ""));
  const found = String(model).match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (!found || !want) return true;
  return parseFloat(found[1]) >= want;
}

function chooseMode(id) {
  // Only before the first message. The pill stops opening the panel once the
  // conversation exists, but the guard is repeated here because this is the
  // function that actually changes the frame.
  if (state.conversationId) return closeModePanel();
  state.mode = id;
  closeModePanel();
  renderModeControl();
  toolGuard();                 // a pure-prompt mode needs no tools; unblock
  els.input.focus();
}

// ── Connectors ──────────────────────────────────────────────
//
// The modal sheet that used to live here is gone. It encoded each connector's
// state four separate times — a dot, a right-aligned "5 tools · not
// reachable", a paragraph of prose, and whichever button happened to be first
// — and the four could disagree. It has been replaced by the settings page,
// which states a row's condition once. The status chip is now a door to it.

function openSettings(pane = "connectors") {
  location.href = `/settings#${pane}`;
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
  // Restored from the row, not remembered from the session: the mode is the
  // conversation's, and reopening it a week later has to show the same frame
  // and the same disclosure it was held under.
  state.mode = convo.mode || null;
  renderModeControl();
  // `m.content` is the display text — what was typed. The copy the model was
  // sent, with the files inlined, stays in the database where it belongs.
  for (const m of convo.messages) addMessage(m.role, m.content, m.attachments || []);
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
// changed — the stage notice would have appeared on first load and vanished the
// first time someone clicked "New chat".
const EMPTY_HTML = els.thread.innerHTML;

function newChat() {
  state.conversationId = null;
  // A mode belongs to a conversation. This is the only way out of one, so it
  // is also the only place the frame is dropped.
  state.mode = null;
  renderModeControl();
  resetSources();
  els.thread.innerHTML = EMPTY_HTML;
  els.empty = $("empty");
  // The thread was just emptied, taking the guard card with it. The condition
  // it warns about has not changed, so it has to be put back — otherwise
  // "New chat" is a way to dismiss the warning without answering it.
  toolGuard();
  loadConversations();
  els.input.focus();
}

// ── Attachments ─────────────────────────────────────────────
//
// A file chosen here is uploaded immediately, not on send: a 20 MB file takes
// a moment even over loopback, and that moment is better spent while the
// question is still being typed than after pressing send with nothing on
// screen to explain the wait.
//
// What "attached" means is worth being exact about, because the obvious
// mental model is wrong in an interesting way. The browser will not tell a
// page where a chosen file lives — `input.value` is `C:\fakepath\lease.pdf`
// in every engine, deliberately, and has been for fifteen years. So the bytes
// go to REFUGIO over loopback and REFUGIO writes its own copy; the path the
// model is handed is that copy's, which is a real path on this machine that
// opens in Finder. Nothing leaves the computer either way.

const MAX_FILES = 5;
let chipSeq = 0;

/** The attachments a turn could actually be sent with.
 *
 *  Still uploading doesn't count, and neither does one that failed: a chip
 *  that is on screen but not sendable would otherwise leave the send button
 *  lit while pressing it did nothing at all. */
// A declaration, not a const: toolGuard sits far above this and can run before
// this line is evaluated.
function sendableFiles() { return state.attachments.filter((f) => f.id && !f.error); }

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** One chip. Used both in the composer tray and under a sent message; the
 *  difference is only whether it can be taken off. */
function chipNode(f, { removable = false } = {}) {
  const node = document.createElement("span");
  node.className = "chip";
  if (f.pending) node.classList.add("pending");
  if (f.error) node.classList.add("failed");
  else if (f.id && !f.isText) node.classList.add("opaque");

  const name = document.createElement("span");
  name.className = "chip-name";
  name.textContent = f.name;                       // never innerHTML: it's a filename
  node.appendChild(name);

  const meta = document.createElement("span");
  meta.className = "chip-meta";
  if (f.pending) meta.textContent = "attaching…";
  else if (f.error) meta.textContent = f.error;
  else if (!f.isText) meta.textContent = `${f.kind} · not readable`;
  else meta.textContent = humanBytes(f.bytes);
  node.appendChild(meta);

  // The path lives here rather than on the chip. It is long, it is the same
  // prefix every time, and this is where someone goes looking once — to check
  // that "attached" meant something real.
  node.title = f.error
    ? `${f.name} — ${f.error}`
    : f.pending ? f.name
    : `${f.name}\n${humanBytes(f.bytes)} · ${f.kind}\nREFUGIO's copy: ${f.path}` +
      (f.isText
        ? (f.truncated ? `\n\nOnly the first part of this file is sent to the model.` : "")
        : `\n\nREFUGIO cannot read the contents of this format. The model is told the name and path only, and told not to guess what is inside.`);

  if (removable) {
    const x = document.createElement("button");
    x.type = "button";
    x.className = "chip-x";
    x.title = "Remove";
    x.setAttribute("aria-label", `Remove ${f.name}`);
    x.textContent = "×";
    x.addEventListener("click", () => detach(f));
    node.appendChild(x);
  }
  return node;
}

function renderTray() {
  els.attachTray.replaceChildren();
  els.attachTray.hidden = !state.attachments.length;
  for (const f of state.attachments) els.attachTray.appendChild(chipNode(f, { removable: true }));
  els.attachBtn.disabled = state.attachments.length >= MAX_FILES;
  els.attachBtn.title = els.attachBtn.disabled
    ? `${MAX_FILES} files is the limit for one message`
    : "Attach a file";
  toolGuard();                                     // owns the send button's state
}

/** Take one file off, and delete REFUGIO's copy of it.
 *
 *  The delete matters: a chip removed before sending should not leave a copy
 *  of someone's document sitting in an application directory. Best-effort —
 *  if the request fails the chip still goes, because the visible thing has to
 *  match what was asked for. */
function detach(f) {
  state.attachments = state.attachments.filter((x) => x.key !== f.key);
  renderTray();
  if (f.id) fetch(`/api/chat/attachments/${f.id}`, { method: "DELETE" }).catch(() => {});
}

/** Upload the chosen files, showing each as a chip the moment it is picked. */
async function attachFiles(list) {
  const files = [...list];
  if (!files.length) return;

  const room = MAX_FILES - state.attachments.length;
  if (files.length > room) {
    showError(room > 0
      ? `Only ${room} more file${room === 1 ? "" : "s"} can go on one message — the rest were not attached.`
      : `${MAX_FILES} files is the limit for one message.`);
  }

  for (const file of files.slice(0, Math.max(0, room))) {
    const entry = { key: ++chipSeq, name: file.name, pending: true };
    state.attachments.push(entry);
    renderTray();
    try {
      const res = await fetch("/api/chat/attachments", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          // Percent-encoded: HTTP headers are Latin-1 and a filename is not.
          "X-Refugio-Filename": encodeURIComponent(file.name),
        },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      Object.assign(entry, data, { pending: false });
    } catch (err) {
      // The chip stays, marked, rather than vanishing. A file that silently
      // disappears between choosing it and sending is how someone ends up
      // asking about a document the model never saw.
      Object.assign(entry, { pending: false, error: err.message || "could not attach" });
    }
    renderTray();
  }
}

/** Send a turn and paint tokens as they arrive over SSE. */
async function send() {
  const text = els.input.value.trim();
  // Still uploading is not ready to send: the ids don't exist yet, so the turn
  // would go without the files the user is watching attach.
  if (state.attachments.some((f) => f.pending)) return;
  const files = state.attachments.filter((f) => f.id && !f.error);
  if ((!text && !files.length) || state.streaming) return;

  // The guard, enforced rather than merely displayed. The disabled send button
  // is the visible half; this is the half that Enter cannot get past.
  const info = modelInfo(state.status, state.model);
  if (info?.tools === false && !state.toolWarningOverridden) { toolGuard(); return; }

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
  // The tray empties with the box. Attachments belong to one message; leaving
  // them would silently re-send the same file on the next question.
  state.attachments = [];
  renderTray();
  addMessage("user", text, files);
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
        model: state.model || undefined,
        // First turn only. After that the server reads the conversation's mode
        // from its row and ignores whatever arrives here, which is what makes
        // regenerate and edit — neither of which sends one — stay in mode.
        mode: state.mode || undefined,
        web,
        attachments: files.map((f) => f.id),
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
          acc += data.t;
          // The notice arrives as ordinary tokens at the end of the stream, so
          // it is split back out here for the same reason it is on reopen.
          const [body, note] = splitCrisisNote(acc);
          bubble.innerHTML = renderContent(body);
          const content = bubble.parentElement;
          content.querySelector(".crisis-note")?.remove();
          if (note) content.appendChild(crisisNoteNode(note));
          scrollToEnd();
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
  els.send.disabled = on ? false : (!els.input.value.trim() && !sendableFiles().length);
  // Attaching mid-answer would put the file on the NEXT message while the
  // chip sits above a composer the user can't send from — clearer to wait.
  els.attachBtn.disabled = on || state.attachments.length >= MAX_FILES;
}

// ── Wiring ──────────────────────────────────────────────────

els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 192) + "px";
  // toolGuard owns the disabled state when a tool-blind model is selected;
  // asking it keeps one rule in one place instead of two that can disagree.
  toolGuard();
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

// Opens the picker only while the conversation is still empty. Afterwards the
// pill is a label: the mode is fixed for the conversation's life, and a
// control that cannot change anything should not accept a click.
els.modePill.addEventListener("click", (e) => {
  e.stopPropagation();
  if (state.conversationId || state.mode) return;
  if (els.modePanel.hidden) openModePanel(); else closeModePanel();
});
document.addEventListener("click", (e) => {
  if (els.modePanel.hidden) return;
  if (!els.modePanel.contains(e.target) && e.target !== els.modePill) closeModePanel();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.modePanel.hidden) closeModePanel();
});
els.newChat.addEventListener("click", newChat);

// ── Attaching ───────────────────────────────────────────────
// Three ways in, because people reach for all three: the paperclip, dragging
// onto the window, and pasting.

els.attachBtn.addEventListener("click", () => els.attachInput.click());

/** Hide what an administrator has taken away.
 *
 *  The paperclip GOES rather than staying and returning a 403 when pressed.
 *  A control that is present and refuses is read as a broken feature; a
 *  control that isn't there is read as a product that doesn't have it, which
 *  on this machine is the truth. */
function applyManaged(managed = {}) {
  els.attachBtn.hidden = !!managed.attachments;
  if (managed.attachments) {
    state.attachments = [];
    renderTray();
  }
}
els.attachInput.addEventListener("change", () => {
  attachFiles(els.attachInput.files);
  // Cleared so choosing the SAME file twice in a row still fires `change`.
  els.attachInput.value = "";
});

// dragenter/dragover fire continuously and per-element, so a plain
// show/hide flickers as the cursor crosses children. Counting enters and
// leaves is the standard fix and the only reliable one.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");

window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  els.dropVeil.hidden = false;
});
window.addEventListener("dragover", (e) => {
  // Without preventDefault the browser navigates to the file on drop, which
  // replaces the whole app with a text document and loses the conversation.
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; els.dropVeil.hidden = true; }
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropVeil.hidden = true;
  if (!state.streaming) attachFiles(e.dataTransfer.files);
});

// Pasting a file — a screenshot, most often. Text pastes are untouched: the
// clipboard carries both a file and a string for some sources, and hijacking
// an ordinary paste would be far worse than missing one.
els.input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length || state.streaming) return;
  e.preventDefault();
  attachFiles(files);
});

// The status chip is the door to the connectors page. It used to open a modal
// sheet; the sheet is what the settings surface replaced.
els.status.addEventListener("click", () => openSettings("connectors"));
els.status.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSettings("connectors"); }
});

// One click, light ↔ dark. It sets an EXPLICIT preference, which means it
// leaves "follow the system" behind — that is the trade for a one-click
// switch, and Settings ▸ Appearance is where you get System back.
// ── Update notice ───────────────────────────────────────────
//
// One line, above the thread, and only when there is genuinely something
// newer. Dismissal is remembered against the specific commit, so saying "not
// now" is honoured until there is a DIFFERENT update — an update notice that
// comes back tomorrow is how people learn to stop reading them.

const UPDATE_DISMISSED = "refugio.update.dismissed";

async function checkUpdateNotice() {
  let u;
  // Reads the cached answer; the server does the network part on its own
  // schedule. A poll that could reach github.com would turn an open window
  // into a stream of requests.
  try { u = await (await fetch("/api/chat/update")).json(); } catch { return; }

  const bar = document.getElementById("update-bar");
  let dismissed = null;
  try { dismissed = localStorage.getItem(UPDATE_DISMISSED); } catch { /* ignore */ }
  if (!u?.updateAvailable || dismissed === u.latestSha) { bar?.remove(); return; }
  if (bar) return;                                  // already showing this one

  const node = document.createElement("div");
  node.id = "update-bar";
  node.className = "update-bar";

  const text = document.createElement("span");
  text.textContent = "A newer REFUGIO is available.";

  const how = document.createElement("a");
  how.href = "/settings#updates";
  how.textContent = "How to update";

  const later = document.createElement("button");
  later.type = "button";
  later.className = "ub-x";
  later.title = "Not now";
  later.setAttribute("aria-label", "Dismiss this update notice");
  later.textContent = "×";
  later.addEventListener("click", () => {
    try { localStorage.setItem(UPDATE_DISMISSED, u.latestSha); } catch { /* ignore */ }
    node.remove();
  });

  node.append(text, how, later);
  els.scroll.parentElement.insertBefore(node, els.scroll);
}

function syncThemeButton() {
  const now = resolvedTheme();
  els.themeBtn.title = now === "dark" ? "Dark — switch to light" : "Light — switch to dark";
}
els.themeBtn.addEventListener("click", () => {
  setThemePreference(resolvedTheme() === "dark" ? "light" : "dark");
  syncThemeButton();
});
// The system can move under us while the window is open, and so can another
// window's Settings page; both end up changing the attribute on <html>.
new MutationObserver(syncThemeButton)
  .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
syncThemeButton();

els.modelBtn.addEventListener("click", () => setModelPanel(els.modelPanel.hidden));
// Dismiss on an outside click or Escape, like any other popover. Without this
// the panel stays open over the thread and has to be un-clicked from the
// button, which nobody tries.
document.addEventListener("click", (e) => {
  if (els.modelPanel.hidden) return;
  if (els.modelPanel.contains(e.target) || els.modelBtn.contains(e.target)) return;
  setModelPanel(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.modelPanel.hidden) setModelPanel(false);
});


els.railToggle.addEventListener("click", () => setRailCollapsed(!state.railCollapsed));
els.gutterRail.addEventListener("click", () => setGutter(true));
els.gutterX.addEventListener("click", () => setGutter(false));

// Restore the rail before the first paint of the list, so it doesn't render
// wide and then snap narrow.
try { setRailCollapsed(localStorage.getItem(RAIL_KEY) === "1"); } catch { setRailCollapsed(false); }

// A question handed over by the setup wizard's last screen. Read once and
// cleared, so a reload doesn't re-ask it — and taken from sessionStorage
// rather than the URL, which would leave the question sitting in the browser
// history of a machine anyone might later open.
try {
  const first = sessionStorage.getItem("refugio.firstAsk");
  if (first) {
    sessionStorage.removeItem("refugio.firstAsk");
    els.input.value = first;
    els.input.dispatchEvent(new Event("input"));
  }
} catch { /* no sessionStorage — the box is simply empty */ }

refreshStatus();
loadConversations();
setInterval(refreshStatus, 15000);

// Separate from the status poll, and far slower: this reads a cached answer
// that changes at most once a day, so asking every fifteen seconds would be
// fifteen seconds of work for a value that is nearly always identical.
checkUpdateNotice();
setInterval(checkUpdateNotice, 30 * 60_000);
