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
};

const state = { conversationId: null, streaming: false, model: null, abort: null };

// Outcome of the last connector fix, rendered once on the next panel draw.
// Held outside the panel because the panel is destroyed and rebuilt to show
// fresh data, which is precisely what would otherwise swallow the message.
let pendingNotice = null;

// ── Rendering ───────────────────────────────────────────────

/** Escape everything, then re-introduce only fenced/inline code. Keeps model
 *  output inert — it is untrusted text and must never become live markup. */
function renderContent(text) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const parts = text.split(/```/);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const body = part.replace(/^[a-zA-Z0-9_-]*\n/, "");
      return `<pre><button class="copy" title="Copy">copy</button><code>${esc(body)}</code></pre>`;
    }
    return md(esc(part));
  }).join("");
}

/** Small markdown subset, applied to ALREADY-escaped text so nothing the model
 *  emits can become live markup. Deliberately not a full parser — headings,
 *  emphasis, lists, links and rules cover what a chat answer actually uses. */
function md(t) {
  const lines = t.split("\n");
  const out = [];
  let list = null;               // 'ul' | 'ol' | null

  const inline = (s) => s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    // Links: only http(s) — never javascript: or data:.
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
             '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (/^\s*$/.test(line)) { closeList(); continue; }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      closeList();
      const lvl = Math.min(m[1].length + 2, 6);
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`); continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line)) { closeList(); out.push("<hr>"); continue; }
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}

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

function showError(msg) {
  els.empty?.remove();
  const d = document.createElement("div");
  d.className = "err";
  d.textContent = msg;
  els.thread.appendChild(d);
  scrollToEnd();
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
      const need = m.needGb ? `${m.needGb} GB` : null;
      o.textContent = m.name +
        (need ? `  \u00b7 ${need}${m.fits === false ? " \u26a0 won't fit" : ""}` : "");
      if (m.fits === false) o.dataset.tight = "1";
      if (m.name === s.model) o.selected = true;
      els.model.appendChild(o);
    }
    if (!s.models?.length) els.model.innerHTML = "<option>no models</option>";
    els.model.title = s.freeGb != null
      ? `${s.freeGb} GB RAM free right now`
      : "";
    state.model = s.model;
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
  const bad = s.modelTools === false && s.model;
  let bar = document.getElementById("model-warn");
  if (!bad) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "model-warn";
    bar.className = "model-warn";
    els.scroll.parentElement.insertBefore(bar, els.scroll);
  }
  bar.textContent =
    `${s.model} can't use connectors — it will answer from memory and never ` +
    `read your data. Run: ollama pull qwen2.5:3b`;
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

  if (!data.connectors?.length) {
    // An empty list right after launch means the pool hasn't read the config
    // yet, NOT that nothing is configured. Telling someone with three working
    // connectors to re-run the installer is worse than saying nothing.
    body.innerHTML = data.starting
      ? `<div class="conn-empty">Starting\u2026<br>
         <span class="conn-sub">Connectors take a few seconds to come up.</span></div>`
      : `<div class="conn-empty">No connectors configured.<br>
         <span class="conn-sub">Re-run the REFUGIO installer to add WhatsApp, reminders or notes.</span></div>`;
    return;
  }

  body.innerHTML = "";
  for (const c of data.connectors) {
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

async function loadConversations() {
  const list = await (await fetch("/api/chat/conversations")).json();
  els.convos.innerHTML = "";
  for (const c of list) {
    const row = document.createElement("div");
    row.className = "convo" + (c.id === state.conversationId ? " active" : "");
    row.innerHTML = `<span class="convo-title"></span><button class="convo-del" title="Delete">×</button>`;
    row.querySelector(".convo-title").textContent = c.title || "Untitled";
    row.onclick = (e) => {
      if (e.target.classList.contains("convo-del")) return;
      openConversation(c.id);
    };
    row.querySelector(".convo-del").onclick = async (e) => {
      e.stopPropagation();
      await fetch(`/api/chat/conversations/${c.id}`, { method: "DELETE" });
      if (state.conversationId === c.id) newChat();
      loadConversations();
    };
    els.convos.appendChild(row);
  }
}

async function openConversation(id) {
  const convo = await (await fetch(`/api/chat/conversations/${id}`)).json();
  state.conversationId = id;
  els.thread.innerHTML = "";
  for (const m of convo.messages) addMessage(m.role, m.content);
  stick = true; scrollToEnd();
  loadConversations();
}

function newChat() {
  state.conversationId = null;
  els.thread.innerHTML =
    `<div class="empty" id="empty"><h1>Your AI, on your machine</h1>` +
    `<div class="sub">Nothing leaves this computer. Ask anything to begin.</div></div>`;
  els.empty = $("empty");
  loadConversations();
  els.input.focus();
}

/** Send a turn and paint tokens as they arrive over SSE. */
async function send() {
  const text = els.input.value.trim();
  if (!text || state.streaming) return;

  els.input.value = "";
  els.input.style.height = "auto";
  addMessage("user", text);
  setStreaming(true);

  const bubble = addMessage("assistant", "");
  bubble.classList.add("cursor");
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

        if (ev === "start") state.conversationId = data.conversation_id;
        else if (ev === "tool") showTool(bubble, data.name, "running");
        else if (ev === "tool_result") showTool(bubble, data.name, data.ok ? "ok" : "failed");
        else if (ev === "token") { acc += data.t; bubble.innerHTML = renderContent(acc); scrollToEnd(); }
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
    chip = document.createElement("span");
    chip.className = "tool-chip"; chip.id = id;
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
els.status.addEventListener("click", showConnectors);
els.newChat.addEventListener("click", newChat);
els.model.addEventListener("change", () => { state.model = els.model.value; });

refreshStatus();
loadConversations();
setInterval(refreshStatus, 15000);
