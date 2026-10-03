// Which model the user chose, remembered across windows.
//
// Shared by the chat and the settings page so the two cannot disagree about
// what is selected — before this, picking a model in the chat lasted until the
// next fifteen-second status poll, which overwrote it with whatever Ollama
// happened to list first. The pick has to outlive the poll, and it has to be
// the same pick on both surfaces.
//
// localStorage rather than the server: this is a preference belonging to the
// person at the keyboard, it must survive the server restarting, and it must
// not need a round trip to read during first paint.

const KEY = "refugio.model";

/** The chosen model, or null if the user has never chosen one. */
export function preferredModel() {
  try { return localStorage.getItem(KEY) || null; } catch { return null; }
}

export function setPreferredModel(name) {
  try {
    if (name) localStorage.setItem(KEY, name);
    else localStorage.removeItem(KEY);
  } catch { /* private mode, or storage disabled — the pick lasts the session */ }
}

/**
 * Resolve what to actually use this session.
 *
 * A remembered model that is no longer installed must not win: someone can
 * delete a model in Ollama, and a stale preference would leave every turn
 * failing with "model not found" and no obvious cause. Fall back to whatever
 * the server resolved.
 */
export function activeModel(status) {
  // A Claude model counts as "installed" while the server offers it — that is,
  // while Claude is switched on and Claude Code is here. Switched off, the
  // remembered pick is dropped like a deleted local model, so the next message
  // goes to a local model rather than to a refusal.
  const local = (status?.models || []).map((m) => m.name);
  const installed = [...local, ...(status?.cloudModels || []).map((m) => m.name)];
  const pref = preferredModel();
  if (pref && installed.includes(pref)) return pref;
  if (pref && !installed.includes(pref)) setPreferredModel(null);
  // The fallback is local only. Claude is used when someone picks it, never
  // because nothing else was installed — that would send a conversation off
  // the machine without anyone having chosen to.
  return status?.model || local[0] || null;
}
