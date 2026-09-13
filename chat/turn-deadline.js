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

/** The sentence the window shows. Says what happened, that nothing written so
 *  far was lost, and what to try — not which variable to set, which belongs in
 *  the log for whoever runs the machine. */
export function deadlineMessage(ms) {
  return `This answer was still going after ${spell(ms)}, which is the limit for one turn, so it was stopped. ` +
    "What it had written so far is saved. A shorter or more specific question usually finishes sooner.";
}
