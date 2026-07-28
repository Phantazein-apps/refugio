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
    // Show the connector count, not just "ready". Without it there is no way to
    // tell a model that ignored its tools from a model that was never given
    // any — the two look identical in the thread, and only one is fixable here.
    const n = s.tools?.length ?? 0;
    els.statusText.textContent = !s.available ? "no model"
      : n ? `ready · ${n} tool${n === 1 ? "" : "s"}`
      : "ready · no tools";
    els.status.title = n
      ? s.tools.join("\n")
      : "No MCP connectors loaded — check the chat server log for [chat:mcp].";
    els.model.innerHTML = "";
    for (const m of s.models || []) {
      const o = document.createElement("option");
      o.value = o.textContent = m;
      if (m === s.model) o.selected = true;
      els.model.appendChild(o);
    }
    if (!s.models?.length) {
      els.model.innerHTML = "<option>no models</option>";
    }
    state.model = s.model;
  } catch {
    els.status.className = "status down";
    els.statusText.textContent = "offline";
  }
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
  chip.textContent = (state === "running" ? "\u2699 " : state === "ok" ? "\u2713 " : "\u2717 ") +
    name.replace("__", " · ");
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
els.newChat.addEventListener("click", newChat);
els.model.addEventListener("change", () => { state.model = els.model.value; });

refreshStatus();
loadConversations();
setInterval(refreshStatus, 15000);
