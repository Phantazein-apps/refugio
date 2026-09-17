// How much of a turn's context tool results are allowed to take.
//
// Measured on 2026-09-18 (docs/gaps.md §12): one memory search returned about
// 5,200 characters, muse-glimmer:30b searched three times in a turn, and round
// two opened at 3,775 prompt tokens against Ollama's 4,096-token default. It
// generated exactly the 321 tokens left and stopped at `done=length` with no
// answer written. lfm2.5:8b and gemma4:e4b passed the same tasks only because
// they searched once. So a model that uses its tools thoroughly was punished
// for it, and the failure looked like weakness in the model.
//
// Of the three ways out — a larger num_ctx, a cap on what memory returns, a cap
// on tool results per turn — this is the third. It is the general one: memory
// is where it was found, but any verbose connector can do the same, and this
// holds for all of them without re-opening every RAM figure in §12, which were
// all measured at 4096.
//
// What it does NOT touch: what the person sees. The browser still receives the
// result up to REFUGIO_SOURCE_CHARS, because "where did this come from?" is the
// first question anyone asks of an answer built from their own data. The budget
// is about what the model is handed, which is what has to fit.

/** Characters of tool result one turn may put in front of the model.
 *
 *  8,000 characters is roughly 2,000 tokens. Against the 4,096-token default
 *  and the ~700 tokens a turn's system prompt and tool list cost, that leaves
 *  room to answer from what came back. Deliberately in characters, not tokens:
 *  the tokeniser is the model's, this is a guard rail, and a rail that needs a
 *  tokeniser to compute is a rail that can be wrong in a new way. */
export const DEFAULT_TOOL_RESULT_BUDGET = 8000;

/** Below this, a truncated result is not worth handing over: a couple of lines
 *  of someone's note is not an answer, and pretending otherwise invites the
 *  model to answer from a fragment. Whole result dropped instead, and said so. */
export const MIN_USEFUL_CHARS = 200;

/** REFUGIO_TOOL_RESULT_BUDGET, in characters. 0 means no budget — every result
 *  goes to the model whole, which is what REFUGIO did before this existed.
 *  Anything unparseable falls back to the default rather than to no limit. */
export function toolResultBudget(env = process.env) {
  const raw = env.REFUGIO_TOOL_RESULT_BUDGET;
  if (raw == null || raw === "") return DEFAULT_TOOL_RESULT_BUDGET;
  // Whole string or nothing. parseInt("8k") is 8, and an 8-character budget is
  // a far worse outcome than the typo it came from — every tool result refused,
  // for a value that looks like it means eight thousand.
  if (!/^\d+$/.test(String(raw).trim())) return DEFAULT_TOOL_RESULT_BUDGET;
  return parseInt(raw, 10);
}

/**
 * Fit one tool result into what is left of the turn's budget.
 *
 * The rule, which is the part worth arguing with: earlier results are kept
 * whole and later ones pay. A turn's first search is the one the model chose
 * with the most context about what it wanted, and a rule that shaved every
 * result equally would hand back three fragments instead of one usable answer
 * and two honest refusals.
 *
 * Whatever is cut, the model is TOLD, in the tool message itself. A result that
 * is quietly shortened is worse than one that is refused: the model answers
 * confidently from half a note and nobody can see why.
 *
 *   result    - the tool's own text
 *   remaining - characters left in this turn's budget; Infinity for no budget
 *
 * Returns { content, kept, truncated }, where `content` is what goes to the
 * model and `kept` is what to charge against the budget.
 */
export function applyBudget(result, remaining) {
  const text = typeof result === "string" ? result : "";
  if (remaining === Infinity || text.length <= remaining) {
    return { content: text, kept: text.length, truncated: false };
  }
  if (remaining < MIN_USEFUL_CHARS) {
    return {
      content: `[REFUGIO dropped this result (${text.length} characters): this turn's budget for tool results is spent. Answer from what you already have, or ask for something narrower.]`,
      kept: 0,
      truncated: true,
    };
  }
  return {
    content: `${text.slice(0, remaining)}\n\n[REFUGIO kept the first ${remaining} of ${text.length} characters: this turn's budget for tool results is spent. Ask for something narrower if you need the rest.]`,
    kept: remaining,
    truncated: true,
  };
}
