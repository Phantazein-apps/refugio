// First-run setup — the five screens.
//
// Frames 3a, 3b/3c, 3d + 3l + 3m, 3n and 3o of the wizard design. WhatsApp and
// email (3e–3k) are a live round trip that isn't built yet; their tiles say so
// and point at Settings, which is honest and is better than a switch that
// pretends.
//
// Everything is built with the same el() DOM builder the settings page uses,
// and every piece of text that came from outside — a model name, a connector
// error — goes in through `text`, never innerHTML.

const el = (spec, attrs = {}, ...kids) => {
  const [tag, ...classes] = spec.split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === "text") node.textContent = v;
    // `class` ADDS to what the "div.foo.bar" spec already set. Without this
    // branch it falls through to setAttribute and wipes it — which is how
    // every connector row rendered with no class at all, and therefore with
    // none of its styling.
    else if (k === "class") node.className = `${node.className} ${v}`.trim();
    else if (k in node && k !== "list") node[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const $ = (id) => document.getElementById(id);
const body = $("body");

const state = {
  setup: null,      // the last /api/chat/setup payload
  step: 0,
  // Everything chosen but not yet saved. Written on each Continue rather than
  // all at the end: someone who closes the window three screens in should keep
  // the three screens they answered.
  pending: {},
  // True once any save has landed. Drives the "restart to pick this up" line —
  // the supervisor read ~/.refugio.env when it launched.
  needsRestart: false,
  pull: null,       // in-flight model download
};

const STEPS = [
  { id: "welcome", label: "Welcome", render: renderWelcome },
  { id: "model", label: "Model", render: renderModel },
  { id: "connectors", label: "Connectors", render: renderConnectors },
  { id: "web", label: "Web search", render: renderWeb },
  { id: "done", label: "Done", render: renderDone },
];

/** The steps that apply to THIS machine.
 *
 *  Web search drops out entirely when an administrator has switched it off —
 *  a screen whose only control is disabled is a screen that wastes a step and
 *  invites someone to try anyway. */
function steps() {
  return STEPS.filter((s) => !(s.id === "web" && state.setup?.managed?.web));
}

// ── Saving ──────────────────────────────────────────────────

/** Send values to the server and report honestly on what it refused.
 *
 *  The allow-list lives on the server, so a rejection here is a real answer
 *  about a real value rather than a hint — and it is shown rather than
 *  swallowed, because a token that silently did not save is a connector that
 *  mysteriously does not work. */
async function save(values, extra = {}) {
  const res = await fetch("/api/chat/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values, ...extra }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Could not save (${res.status})`);
  if (data.restartNeeded) state.needsRestart = true;
  return data;
}

async function load() {
  const res = await fetch("/api/chat/setup");
  state.setup = await res.json();
}

// ── Chrome ──────────────────────────────────────────────────

function renderSteps() {
  const nav = $("steps");
  nav.replaceChildren();
  steps().forEach((s, i) => {
    nav.append(el("span", {
      text: `${String(i + 1).padStart(2, "0")} ${s.label}`,
      class: i === state.step ? "is-active" : i < state.step ? "is-done" : "",
    }));
  });
}

function go(delta) {
  const next = state.step + delta;
  if (next < 0 || next >= steps().length) return;
  state.step = next;
  draw();
}

function draw() {
  // The restart line goes ABOVE the step, on every step, once anything has
  // been written — rather than being repeated inside individual screens, where
  // it was reachable on two of the five and therefore usually unread.
  body.replaceChildren(...[restartNote(), steps()[state.step].render()].filter(Boolean));
  renderSteps();
  window.scrollTo(0, 0);
}

/** The bar at the bottom of every screen. */
function actions({ next = "Continue", onNext, back = true, extra = null } = {}) {
  return el("div.actions", {},
    back && state.step > 0
      ? el("button.btn.link", { type: "button", text: "Back", on: { click: () => go(-1) } })
      : null,
    el("div.spacer"),
    extra,
    el("button.btn.primary", { type: "button", text: next, on: { click: onNext || (() => go(1)) } }),
  );
}

/** Shown once anything has been written. Not decoration — connectors are
 *  started by the supervisor from ~/.refugio.env at launch, so a switch flipped
 *  here is saved and not yet running. */
function restartNote() {
  if (!state.needsRestart) return null;
  return el("div.restart-note", {},
    "Saved. Connectors are started when REFUGIO launches, so the ones you just switched on are ",
    el("strong", { text: "not running yet" }),
    ". Restart to pick them up: ", el("code", { text: "refugio restart" }),
    " — or quit and reopen from the menu bar.",
  );
}

// ── 3a · Welcome ────────────────────────────────────────────

function renderWelcome() {
  return el("section", {},
    el("div.eyebrow", { text: "01 / Welcome" }),
    el("h1", {}, "Your assistant runs ", el("span.em", { text: "here" }), "."),
    el("p.lede", {
      text: "The model, your messages, and every answer stay on this computer. " +
        "Nothing is sent anywhere — there is no account, no login, and no server to sign in to.",
    }),
    el("div.facts", {},
      el("div", {},
        el("span.k", { text: "Setup takes" }),
        el("span.v", { text: "About four minutes, plus a model download you can leave running." }),
      ),
      el("div", {},
        el("span.k", { text: "You can skip" }),
        el("span.v", { text: "Everything after this screen. It is all in Settings later." }),
      ),
    ),
    actions({
      next: "Set up REFUGIO →",
      back: false,
      extra: el("button.btn.link", {
        type: "button", text: "Skip setup, just start chatting",
        on: { click: skipSetup },
      }),
    }),
  );
}

async function skipSetup() {
  // Recorded before leaving. Without this the wizard reappears on the next
  // launch, and a welcome screen you have already declined is how people learn
  // to click through things without reading them.
  try { await save({}, { skipped: true }); } catch { /* the chat still opens */ }
  location.href = "/";
}

// ── 3b / 3c · Model ─────────────────────────────────────────

function renderModel() {
  const s = state.setup;
  const section = el("section", {},
    el("div.eyebrow", { text: "02 / The model" }),
  );

  if (!s.ollamaUp) {
    // The one blocking condition, and it is not the wizard's to fix.
    section.append(
      el("h1", {}, "No engine ", el("span.em", { text: "yet" }), "."),
      el("p.lede", {
        text: "REFUGIO answers with a model that runs on this machine, and the program that runs it — " +
          "Ollama — isn't running. Setup can continue; there just won't be anything to answer with until it is.",
      }),
      el("div.card.warn", {},
        el("h3", { text: "What to do" }),
        el("div.prose", { text: "Install Ollama from ollama.com and start it. REFUGIO will notice on its own — " +
          "no need to come back here." }),
      ),
      actions({}),
    );
    return section;
  }

  const active = s.model;
  const installed = s.models || [];
  const offered = s.downloadable || [];

  section.append(
    el("h1", {}, "Sized to ", el("span.em", { text: "this machine" }), "."),
    el("p.lede", {
      text: s.memory?.totalGb
        ? `This machine has about ${Math.round(s.memory.totalGb)} GB of memory. Models that fit are marked; ` +
          "one that can call your connectors matters more than one that is merely large."
        : "Models that fit the memory free right now are marked. One that can call your connectors matters " +
          "more than one that is merely large.",
    }),
  );

  if (installed.length) {
    const card = el("div.card", {}, el("h3", { text: "Installed" }));
    for (const m of installed) card.append(modelRow(m, active));
    section.append(card);
  } else {
    section.append(el("div.card.warn", {},
      el("h3", { text: "Nothing installed yet" }),
      el("div.prose", { text: "Ollama is running but has no models. Download one below — it continues in the " +
        "background, so you can carry on setting up while it runs." }),
    ));
  }

  if (offered.length) {
    const card = el("div.card", {}, el("h3", { text: "Available to download" }));
    for (const m of offered) card.append(downloadRow(m));
    section.append(card);
  }

  section.append(el("div", { id: "pull-progress" }));
  section.append(actions({ onNext: () => { chooseModel(); go(1); } }));
  return section;
}

function modelRow(m, active) {
  const chosen = (state.pending.REFUGIO_MODEL ?? active) === m.name;
  return el("label.row", {},
    el("div.row-main", {},
      el("div.row-name", { text: m.name }),
      el("div.row-blurb", {
        text: [
          m.tools === false ? "Cannot call your connectors" : m.tools === true ? "Can call your connectors" : null,
          m.needGb ? `${m.needGb} GB to run` : null,
          m.fits === false ? (m.everFits === false ? "too big for this machine" : "not enough free memory right now") : null,
        ].filter(Boolean).join(" · "),
      }),
    ),
    el("div.row-side", {},
      el("input", {
        type: "radio", name: "model", checked: chosen, value: m.name,
        on: { change: () => { state.pending.REFUGIO_MODEL = m.name; } },
      }),
    ),
  );
}

function downloadRow(m) {
  return el("div.row", {},
    el("div.row-main", {},
      el("div.row-name", { text: m.name }),
      el("div.row-blurb", {
        text: [
          m.needGb ? `about ${m.needGb} GB to run` : null,
          m.tools === false ? "cannot call connectors" : "can call your connectors",
        ].filter(Boolean).join(" · "),
      }),
    ),
    el("div.row-side", {},
      el("button.btn", { type: "button", text: "Download", on: { click: (e) => pull(m.name, e.currentTarget) } }),
    ),
  );
}

/** 3c — download without blocking. The design is explicit that this must not
 *  hold up setup, and it is right: this is gigabytes. */
function pull(name, btn) {
  btn.disabled = true;
  btn.textContent = "Downloading…";
  const box = $("pull-progress");
  box.replaceChildren();
  const bar = el("i", { style: "width:0%" });
  const line = el("div.dl-line", { text: "starting…" });
  box.append(el("div.card", {},
    el("h3", { text: "Downloading" }),
    el("div.row-name", { text: name }),
    el("div.bar", {}, bar),
    line,
    el("div.aside", { text: "This continues in the background. Carry on — the model does not have to finish " +
      "before you set up connectors." }),
  ));

  // The pull endpoint is a POST that streams SSE. EventSource can only issue a
  // GET, so the stream is read by hand off fetch instead.
  fetch("/api/chat/models/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then(async (res) => {
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop();
      for (const chunk of chunks) {
        const evName = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (!data) continue;
        const m = JSON.parse(data);
        if (evName === "progress" && m.total) {
          const pct = Math.min(100, Math.round((m.completed / m.total) * 100));
          bar.style.width = `${pct}%`;
          line.textContent = `${gb(m.completed)} of ${gb(m.total)} · ${pct}%`;
        } else if (evName === "done") {
          bar.style.width = "100%";
          line.textContent = "Downloaded.";
          btn.textContent = "Downloaded";
          state.pending.REFUGIO_MODEL = name;
          load().catch(() => {});
        } else if (evName === "error") {
          line.textContent = m.error || "Download failed.";
          btn.disabled = false;
          btn.textContent = "Try again";
        }
      }
    }
  }).catch((e) => {
    line.textContent = e.message;
    btn.disabled = false;
    btn.textContent = "Try again";
  });
}

const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;

function chooseModel() {
  if (!state.pending.REFUGIO_MODEL) return;
  save({ REFUGIO_MODEL: state.pending.REFUGIO_MODEL }, { step: "model" }).catch(() => {});
}

// ── 3d / 3l / 3m · Connectors ───────────────────────────────

function renderConnectors() {
  const s = state.setup;
  const rows = s.connectors || [];

  const section = el("section", {},
    el("div.eyebrow", { text: "03 / Connectors" }),
    el("h1", {}, "What may it ", el("span.em", { text: "read" }), "?"),
    el("p.lede", {
      text: "Each one is a separate program on this machine. Connect none, one, or all — " +
        "every one can be added or removed later, and each stays on this computer.",
    }),
  );

  if (rows.length) {
    const card = el("div.card", {});
    for (const r of rows) card.append(connectorRow(r));
    section.append(card);
  }

  if (s.managed?.connectors) {
    section.append(el("div.managed", {
      text: `Your organisation allows only: ${s.managed.connectors.join(", ")}.`,
    }));
  }

  // 3m — Notion. A token field, checked for shape before it is stored.
  const notionErr = el("div.err", { id: "notion-err" });
  section.append(el("div.card", {},
    el("h3", { text: "Notion" }),
    el("div.prose", { text: "REFUGIO can read only the pages you explicitly share with an integration. " +
      "Notion gives out a secret token per integration." }),
    el("div.field", {},
      el("label", { for: "notion", text: "Internal integration secret" }),
      el("input", { type: "password", id: "notion", placeholder: "ntn_…", autocomplete: "off" }),
      notionErr,
    ),
    el("div.aside", { text: "notion.so/profile/integrations → New integration. Leave blank to skip." }),
  ));

  // 3e/3f–3k are not built. Saying so beats a switch that pretends.
  section.append(el("div.card", {},
    el("h3", { text: "Needs a round trip — set these up in Settings" }),
    el("div.prose", { text: "WhatsApp is linked by scanning a code with your phone, and email needs a " +
      "sign-in in your browser. Neither fits in this window yet, so both live in Settings ▸ Connectors " +
      "whenever you want them." }),
  ));

  section.append(actions({ onNext: saveConnectors }));
  return section;
}

function connectorRow(r) {
  const available = r.available;
  return el("label.row", { class: available ? "" : "unavailable" },
    el("div.row-main", {},
      el("div.row-name", { text: r.label }),
      el("div.row-blurb", { text: available ? r.blurb : r.why }),
    ),
    el("div.row-side", {},
      available
        ? el("span.switch", {},
            el("input", {
              type: "checkbox",
              checked: state.pending[r.key] ?? r.value,
              on: { change: (e) => { state.pending[r.key] = e.currentTarget.checked; } },
            }),
            el("span.track"),
          )
        : null,
    ),
  );
}

async function saveConnectors() {
  const values = {};
  for (const r of state.setup.connectors || []) {
    if (r.available) values[r.key] = !!(state.pending[r.key] ?? r.value);
  }
  const token = $("notion")?.value.trim();
  if (token) values.NOTION_TOKEN = token;

  const err = $("notion-err");
  if (err) err.textContent = "";
  try {
    const out = await save(values, { step: "connectors" });
    const bad = (out.rejected || []).find((r) => r.key === "NOTION_TOKEN");
    if (bad) {
      // Stay on the screen. Moving on would leave someone believing Notion was
      // connected when the token was never stored.
      if (err) err.textContent = `That doesn't look like a Notion token — ${bad.why}. It starts with ntn_.`;
      return;
    }
    await load();
    go(1);
  } catch (e) {
    if (err) err.textContent = e.message;
  }
}

// ── 3n · Web search ─────────────────────────────────────────

function renderWeb() {
  const w = state.setup.web || {};
  return el("section", {},
    el("div.eyebrow", { text: "04 / Web search" }),
    el("h1", {}, "The only thing that ", el("span.em", { text: "leaves" }), "."),
    el("p.lede", {
      text: "Everything else in REFUGIO stays on this machine. Web search does not: your query goes to a " +
        "search engine. It is off, and even switched on it does nothing until you arm it on a specific message.",
    }),
    el("div.card.warn", {},
      el("h3", { text: "Allow web search" }),
      el("label.switch", {},
        el("input", {
          type: "checkbox",
          checked: !!w.enabled,
          on: { change: (e) => setWeb(e.currentTarget) },
        }),
        el("span.track"),
      ),
      el("div.prose", { style: "margin-top:12px", text: w.warning ||
        "Turning this on only makes the option available. It never runs by itself." }),
      el("div.aside", { style: "margin-top:8px",
        text: `What is sent: the words of the query, and nothing else${w.engine ? ` — to ${w.engine}` : ""}. ` +
          "No message history, no files, no connector data." }),
    ),
    actions({}),
  );
}

async function setWeb(input) {
  const enabled = input.checked;
  try {
    const res = await fetch("/api/chat/web", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "could not save");
    state.setup.web = { ...state.setup.web, enabled };
  } catch (e) {
    input.checked = !enabled;                    // put the switch back
    input.closest(".card")?.append(el("div.managed", { text: e.message }));
  }
}

// ── 3o · Done ───────────────────────────────────────────────

const ASKS = {
  reminders: ["What is due today?", "Apple Reminders"],
  notes: ["Find my notes about the flat", "Apple Notes"],
  things: ["What is in my Things inbox?", "Things 3"],
};

function renderDone() {
  const s = state.setup;
  const on = (s.connectors || []).filter((r) => state.pending[r.key] ?? r.value);

  const asks = el("div.asks", {});
  for (const r of on) {
    const ask = ASKS[r.id];
    if (ask) asks.append(el("button.ask", {
      type: "button",
      on: { click: () => startWith(ask[0]) },
    }, ask[0], el("span.tag", { text: ask[1] })));
  }
  if (!on.length) {
    asks.append(el("button.ask", { type: "button", on: { click: () => startWith("What can you help me with?") } },
      "What can you help me with?", el("span.tag", { text: "no connectors yet" })));
  }

  return el("section", {},
    el("div.eyebrow", { text: "05 / Ready" }),
    el("h1", {}, "Ask it something ", el("span.em", { text: "real" }), "."),
    el("p.lede", { text: on.length
      ? `${on.map((r) => r.label).join(", ")} ${on.length === 1 ? "is" : "are"} set up. Click one to start.`
      : "No connectors yet — that is fine, REFUGIO still answers. Add them any time in Settings." }),
    asks,
    !s.model ? el("div.card.warn", {},
      el("h3", { text: "No model yet" }),
      el("div.prose", { text: "REFUGIO cannot answer anything until a model is installed. Its window will " +
        "tell you the same thing, with the fix." }),
    ) : null,
    el("div.actions", {},
      el("div.spacer"),
      el("button.btn.primary", { type: "button", text: "Start using REFUGIO", on: { click: () => finish() } }),
    ),
  );
}

function startWith(question) { finish(question); }

async function finish(question) {
  try { await save({}, { completed: true, step: "done" }); } catch { /* still let them in */ }
  // Handed to the chat through sessionStorage rather than the URL: it is one
  // hop within the same tab, and a question in the address bar would sit in
  // history for anyone who later opens that machine's browser.
  if (question) {
    try { sessionStorage.setItem("refugio.firstAsk", question); } catch { /* ignore */ }
  }
  location.href = "/";
}

// ── Boot ────────────────────────────────────────────────────

$("exit").addEventListener("click", (e) => { e.preventDefault(); skipSetup(); });

load()
  .then(() => draw())
  .catch(() => {
    body.replaceChildren(el("div.card.warn", {},
      el("h3", { text: "Could not read this machine's setup" }),
      el("div.prose", { text: "REFUGIO is running but did not answer. Nothing is broken — go straight to the " +
        "chat, and Settings has everything this screen would have offered." }),
      el("div.actions", {}, el("div.spacer"),
        el("a.btn.primary", { href: "/", text: "Open REFUGIO" })),
    ));
  });
