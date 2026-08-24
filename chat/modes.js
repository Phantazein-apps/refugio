// Private discussion modes — a conversation with a named frame around it.
//
// A mode is a bundle of system-prompt layers, guardrails and UI copy that a
// person switches on for one conversation: NVC Coach first, then style,
// language and life coaching. Web search is the UX template — off by default,
// enabled in the backend, one dependency-free module holding the definitions,
// the copy and the pure helpers — but the privacy polarity is inverted. Web
// search is the one thing that leaves this machine, so it warns loudly and
// arms per message. These are the most private conversations REFUGIO will
// hold, so the design errs the other way: fewer tools, no web, quiet titles.
//
// Three constraints shape everything below.
//
//   - A mode REMOVES capability rather than adding it. Coaching modes carry
//     no tools at all — memory included, because the memory connector can
//     persist and (in its GitHub-backed variant) upload what was said. Fewer
//     tools is also strictly better for the 3B-8B models REFUGIO targets.
//   - Prompt text is advisory; code is the guarantee. The guardrail sentences
//     are what actually shapes the model's replies, but "no web on a mode
//     turn" is enforced at the two places that act, and every guardrail
//     sentence is pinned verbatim by test/modes.test.js so a later edit to
//     the copy has to be deliberate.
//   - Tokens are latency. History is never truncated (store.js) and the
//     target models have ~8k contexts, so every mode token is paid again on
//     every turn of the conversation. Hard budget: 2000 characters (~500
//     tokens) for a mode's whole preamble, shared crisis layer included.

import { WEB_TOOL } from "./websearch.js";

/**
 * Every planned mode id, all off.
 *
 * All seven ids are declared here from the start even though only `nvc` has
 * content this session, because the settings merge keeps exactly the boolean
 * keys the defaults declare (server.js loadSettings) — an id that appears
 * later would silently drop a user's saved choice on the version that
 * introduced it. An id with no entry in MODES is simply hidden: defined
 * defaults are cheap, half-written coaching prompts are not.
 */
export const MODE_DEFAULTS = {
  nvc: false,
  styles: false,
  whatsapp: false,
  spanish: false,
  career: false,
  life: false,
  listener: false,
};

/** The planned ids, in the order they should be offered. */
export const MODE_IDS = Object.keys(MODE_DEFAULTS);

/**
 * The shared crisis layer, appended to every coaching mode's prompt.
 *
 * Single-sourced because seven modes with seven slightly different crisis
 * texts is seven chances for one of them to be the weak one. Written short
 * and imperative: this has to fire on a 3B model, and a small model follows a
 * blunt instruction far more reliably than a careful paragraph. It names a
 * concrete number because "seek help" is advice no one can act on, and names
 * the local-emergency fallback because most people reading this are not in
 * the US.
 */
export const CRISIS_LAYER =
  "If the person mentions wanting to hurt themselves or someone else, or " +
  "sounds in danger right now, stop the exercise. Say plainly that you are " +
  "concerned, that a program on their computer is not the right help for " +
  "this, and a person is. Give them a number: in the US, call or text 988; " +
  "anywhere else, a local crisis line or emergency number. Do not resume " +
  "coaching unless they tell you they are safe.";

/**
 * The mode table. Absent `tools` means no tools at all, which is the default
 * every coaching mode wants and the reason it is written as an absence.
 *
 * Only `nvc` is filled in this session. The rest of MODE_IDS ship as
 * enablement booleans with nowhere to go until their content lands.
 */
export const MODES = {
  nvc: {
    id: "nvc",
    label: "NVC Coach",
    icon: "🕊️",
    category: "coaching",
    hint:
      "Nonviolent Communication: think a situation through, or reword a " +
      "message into observation, feeling, need, request.",
    // Shown as a banner when the conversation starts, and said again inside
    // the prompt so the model describes itself the same way the UI does. A
    // disclosure only the interface knows about is one the model contradicts.
    disclosure:
      "Coaching practice with a local model — not therapy, not a " +
      "professional. Nothing here leaves this machine.",
    titleLabel: "NVC coaching",
    starters: [
      "Help me reword a message before I send it",
      "Something happened and I want to think it through",
      "Play the other person so I can practise the conversation",
    ],
    prompt:
      "You are a Nonviolent Communication (NVC) coach, working from Marshall " +
      "Rosenberg's model. You coach how things get said. You are not a " +
      "therapist and not a judge of who is right; say so if asked to be " +
      "either.\n\n" +
      "The four components. Observation: what a camera would have recorded, " +
      "minus the evaluation. Feeling: an emotion — \"I feel that you...\" is " +
      "a thought, and ignored, betrayed, manipulated are judgements wearing " +
      "a feeling's clothes, so name what is underneath. Need: the universal " +
      "thing at stake (safety, respect, rest, connection, autonomy, support, " +
      "fairness). Request: concrete, doable, present-tense and refusable. If " +
      "no is not an acceptable answer, it is a demand, not a request.\n\n" +
      "How to work. Reflect back what you heard. Separate observation from " +
      "evaluation. Offer feelings and needs as guesses the person can " +
      "correct, not verdicts. Then propose wording — when you reword a " +
      "message, give a softer and a more direct version and a line on what " +
      "changed. Ask one question at a time. Keep replies short: this is " +
      "practice, not a lecture.\n\n" +
      "NVC is not for every situation. If what is described is abuse, " +
      "coercion, or a threat to someone's safety, say so plainly: that is a " +
      "safety situation, not a communication-technique situation. Point " +
      "toward people who can help, not toward better phrasing.\n\n" +
      "NVC is not a way to make someone say yes. If the aim is to pressure, " +
      "corner or manage another person, name that gently — it is against the " +
      "method — and go back to the need underneath.\n\n" +
      "If asked what you are: communication coaching with a local model, not " +
      "therapy and not professional advice.",
  },
};

/**
 * Copy for the settings pane, served by the backend the way WEB_SEARCH_UI is.
 *
 * The browser gets these words from here rather than holding its own copy,
 * because two copies of a promise drift and the one in the window is the one
 * people read.
 */
export const MODES_UI = {
  label: "Discussion modes",
  hint:
    "Built-in coaching modes for private conversations. Off by default; " +
    "nothing appears in the composer until you switch one on.",
  note:
    "A mode belongs to one conversation and is chosen before the first " +
    "message. It cannot be changed afterwards — leaving a mode means " +
    "starting a new chat.",
  // Said in the settings pane, not only in the mode itself: the reason a
  // coaching conversation has no connectors and no web search is a promise,
  // and a promise the user only discovers by noticing an absence is not one.
  privacy:
    "Modes get no tools and no web search, whatever else is switched on. " +
    "The conversation stays on this computer.",
  empty: "No discussion modes are available in this build yet.",
};

/** Ids that actually have content, and are therefore offerable. */
export const definedModes = () => MODE_IDS.filter((id) => !!MODES[id]);

/**
 * The rows a picker or settings pane needs — never the prompt text.
 *
 * The prompt is the one part of a mode a surface has no business rendering:
 * it is instructions to the model, and pasting it into a window invites the
 * reader to treat it as a description of what the mode guarantees.
 */
export function modeSummaries() {
  return definedModes().map((id) => {
    const m = MODES[id];
    return {
      id: m.id,
      label: m.label,
      icon: m.icon,
      hint: m.hint,
      disclosure: m.disclosure,
      category: m.category,
      starters: [...m.starters],
      requiresConnector: m.requiresConnector ?? null,
      recommendedTier: m.recommendedTier ?? null,
    };
  });
}

/**
 * The system-prompt fragment for a mode, or "" when no mode is active.
 *
 * Returns "" for an id with no entry as well, so a conversation whose stored
 * mode this build no longer defines degrades to an ordinary chat rather than
 * failing — it still loses its tools and its web access, because every other
 * helper here treats an unknown id as a mode, and the safe direction for an
 * id we cannot explain is fewer capabilities, not more.
 */
export function modePreamble(mode) {
  const def = MODES[mode];
  if (!def) return "";
  const layers = [def.prompt];
  if (def.category === "coaching") layers.push(CRISIS_LAYER);
  // Leading blank line: this is concatenated onto SYSTEM_PROMPT, which the
  // user may have replaced entirely via REFUGIO_SYSTEM_PROMPT. Mode text is
  // written to stand on its own so it composes with whatever came before it
  // instead of assuming it.
  return "\n\n" + layers.join("\n\n");
}

/**
 * May this turn reach the web?
 *
 * One expression rather than a condition repeated wherever the question comes
 * up. A mode conversation never searches: the whole point is that it does not
 * leave the machine, and "the composer hid the button" is not a guarantee.
 */
export function webAllowed(mode) {
  return !mode;
}

/**
 * The arming decision, extracted so it can be tested without an HTTP harness.
 *
 * Three conditions and they mean three different things: the setting is "I am
 * willing to search the web at all", the flag is "search on THIS message",
 * and the mode is "not in this conversation, whatever the other two say".
 */
export function armWebSearch({ requested, settingEnabled, mode }) {
  return !!requested && !!settingEnabled && webAllowed(mode);
}

/**
 * Apply a mode's allowlist to the tool definitions about to be offered.
 *
 * Filtering happens here, at the point the array is assembled for one turn,
 * rather than by narrowing the shared MCP pool: the pool's settings are
 * global and two conversations stream at once, so a per-turn mutation there
 * would let one conversation's mode strip another conversation's tools.
 */
export function modeToolFilter(mode, toolDefs = []) {
  if (!mode) return toolDefs;
  const allow = MODES[mode]?.tools?.allow;
  if (!allow?.length) return [];
  return toolDefs.filter((t) => allow.includes(t?.function?.name));
}

/**
 * Why a tool call must be refused, or null if it may run.
 *
 * The offered list is not the enforcement — a model can name a tool it was
 * never handed, by copying one out of the history or by inventing it — so the
 * same question is asked again at the only place that actually runs anything.
 * The refusal is a sentence rather than a silent drop because the model reads
 * it and needs to know it was refused, not that the tool failed.
 */
export function toolRefusal(mode, name) {
  if (!mode) return null;
  if (name === WEB_TOOL.function.name) {
    return "Error: web search is never available in a discussion mode. " +
      "This conversation stays on the user's computer. Answer from what you " +
      "have, and say plainly if you do not know something.";
  }
  const allow = MODES[mode]?.tools?.allow ?? [];
  if (!allow.includes(name)) {
    return `Error: ${name} is not available in this mode. Answer without it.`;
  }
  return null;
}

/**
 * The sidebar title for a mode conversation.
 *
 * Generated titles run a completion over the first message and put the result
 * in the sidebar, which for a private conversation means the thing the person
 * came here to say quietly ends up as a label anyone glancing at the window
 * can read. So mode conversations get the registry's label and the date, and
 * skip generation entirely.
 */
export function modeTitle(mode, date = new Date()) {
  const label = MODES[mode]?.titleLabel || "Private conversation";
  return `${label} — ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

/**
 * Validate a mode id off the request body.
 *
 * Two different refusals, because they send the user to two different places:
 * an id this build has never heard of is a bug or a stale page, while a known
 * id that is switched off is a settings trip. Saying "unknown mode" for both
 * would send someone looking for the wrong problem.
 */
export function validateMode(requested, enabled = {}) {
  const id = typeof requested === "string" ? requested.trim() : "";
  if (!id) return { ok: true, mode: null };
  if (!MODES[id]) {
    return { ok: false, mode: null, error: `There is no discussion mode called "${id.slice(0, 40)}".` };
  }
  if (!enabled?.[id]) {
    return {
      ok: false,
      mode: null,
      error: `${MODES[id].label} is switched off. Turn it on in Settings, under ${MODES_UI.label}.`,
    };
  }
  return { ok: true, mode: id };
}
