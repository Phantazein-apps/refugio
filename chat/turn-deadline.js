// How long one chat turn may run, and who gets to decide that.
//
// Node's http.Server closes any request that has not finished within
// `requestTimeout`, and the default is 300000 ms. For an SSE turn that is the
// wrong control in the wrong place: the server cannot say anything as it
// closes the socket, so `res.on("close")` aborts the Ollama request and the
// window sees a stream that simply stops — no `error`, no `done`. A 4B model on
// an 8 GB machine writing a long answer passes five minutes without being
// stuck, and it also meant `scripts/eval.cjs --timeout 600` could never take
// effect, because the server always hung up first.
//
// So the socket timer is switched off, and the ceiling moves into the turn,
// where it can explain itself before it closes the stream. The server only
// listens on loopback, so the slow-client protection requestTimeout exists for
// is not buying anything here; the controls that remain are the person (Stop,
// or closing the tab, which aborts upstream) and this deadline.

/** Generous on purpose. The ceiling is there for an Ollama that has wedged,
 *  not for a slow machine doing honest work across several tool rounds. */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

/** REFUGIO_TURN_TIMEOUT_MS, in milliseconds. 0 means no ceiling at all. Anything
 *  that is not a non-negative number falls back to the default rather than to
 *  0, because a typo should not quietly remove the limit. */
export function turnTimeoutMs(env = process.env) {
  const raw = env.REFUGIO_TURN_TIMEOUT_MS;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_TURN_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TURN_TIMEOUT_MS;
}

/** Take the socket-level request timer off a server. Separate from boot so a
 *  test can pin the value on a real http.Server rather than on a constant. */
export function configureServerTimeouts(server) {
  server.requestTimeout = 0;
  return server;
}

/** Arm a turn's ceiling against its AbortController. Aborting is what actually
 *  stops Ollama; `expired` is what lets the turn's catch tell this apart from a
 *  closed tab, which aborts the same controller and should stay silent. */
export function armTurnDeadline(ac, ms) {
  let expired = false;
  const timer = ms > 0
    ? setTimeout(() => { expired = true; ac.abort(); }, ms)
    : null;
  return {
    get expired() { return expired; },
    clear() { if (timer) clearTimeout(timer); },
  };
}

function spell(ms) {
  if (ms >= 60000) {
    const m = Math.round(ms / 60000);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  if (ms >= 1000) {
    const s = Math.round(ms / 1000);
    return `${s} second${s === 1 ? "" : "s"}`;
  }
  return `${ms} ms`;
}

// ── Keeping a quiet turn visibly alive ──────────────────────
//
// Taking requestTimeout off was not enough on its own. A thinking model can go
// minutes with no answer text, and until a `token` is due the turn wrote
// nothing at all. Node's fetch (undici) gives up on a response body that has
// been silent for 300000 ms, so scripts/eval.cjs reported `terminated` at five
// and a half minutes, closed the socket, and the server aborted Ollama — the
// same silent end #36 was meant to remove, reached from the other side. A
// browser has no such timer, but a proxy in front of the window may.
//
// So a turn writes an SSE comment on an interval for as long as it is open.
// Comments are part of the format and every SSE reader skips them: the window
// and the eval runner both ignore a frame with no `data:` line. It says nothing
// about progress — the `thinking` event does that — only that the server is
// still there.

/** Well under any idle timer worth worrying about, and cheap: one line, a few
 *  times a minute, only while a turn runs. */
export const DEFAULT_HEARTBEAT_MS = 15 * 1000;

export const HEARTBEAT = ": keep-alive\n\n";

/** REFUGIO_HEARTBEAT_MS, in milliseconds; 0 turns the heartbeat off. Same
 *  fallback rule as the ceiling, for the same reason. */
export function heartbeatMs(env = process.env) {
  const raw = env.REFUGIO_HEARTBEAT_MS;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_HEARTBEAT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_HEARTBEAT_MS;
}

/** Write HEARTBEAT to `res` every `ms` until cleared or the response closes.
 *  It clears itself on close as well as when the turn's `finally` does, because
 *  a tab closed during a slow tool call leaves the turn awaiting the tool, and
 *  an interval writing into a dead socket until then is a leak with a timer. */
export function armHeartbeat(res, ms) {
  if (!(ms > 0)) return { clear() {} };
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return clear();
    res.write(HEARTBEAT);
  }, ms);
  // Never the thing that keeps a process alive — a server shutting down should
  // not wait on a comment line.
  timer.unref?.();
  function clear() { clearInterval(timer); res.off?.("close", clear); }
  res.on("close", clear);
  return { clear };
}

/** How often a `thinking` event may be sent. It carries a count, not the
 *  reasoning, so there is nothing to gain from one per token and a browser
 *  repainting a counter hundreds of times a second has something to lose. */
export const THINKING_EVENT_MS = 1000;

/** When a model thought and then wrote nothing. Without this the window said
 *  "The model returned an empty response", which is true and useless: the model
 *  worked hard, and the likely reason — its reasoning filled the context before
 *  it reached an answer — is something the person can act on. */
export function thoughtWithoutAnswerMessage(tokens) {
  return `The model spent this turn thinking (about ${tokens.toLocaleString("en-US")} tokens) and stopped before it wrote an answer. ` +
    "Small models often run out of room this way. A shorter or more specific question, or a larger model, usually gets an answer.";
}

/** The sentence the window shows. Says what happened, that nothing written so
 *  far was lost, and what to try — not which variable to set, which belongs in
 *  the log for whoever runs the machine. */
export function deadlineMessage(ms) {
  return `This answer was still going after ${spell(ms)}, which is the limit for one turn, so it was stopped. ` +
    "What it had written so far is saved. A shorter or more specific question usually finishes sooner.";
}
