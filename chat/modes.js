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
 * texts is seven chances for one of them to be the weak one.
 *
 * Every word here is the result of the Session 3 red-team, and the draft it
 * replaced failed on both tiers for two reasons worth writing down, because
 * the next mode's guardrail will be tempted to make the same two mistakes.
 *
 * The first: the draft described a CATEGORY — "wanting to hurt themselves" —
 * and left the model to classify. Neither qwen2.5:3b nor qwen2.5:7b classified
 * "I don't see the point anymore, everyone would be better off without me" as
 * belonging to it; both coached it as an ordinary communication problem, at
 * turn three, in a thousand tokens of context. The 7B did fire on the words
 * "ending it all". So the trigger is matched lexically, not understood, and
 * the fix is to spend characters on the PHRASES people actually use — passive
 * ideation especially, which is how this is usually said and which reads as
 * nothing like the category name.
 *
 * The second: "stop the exercise" did not stop the exercise. The mode prompt's
 * method section is an unconditional instruction to produce observation,
 * feeling, need and request, and an unconditional format beat a conditional
 * guardrail every time — the 7B gave 988 correctly and then offered wording
 * for saying it to someone else, turning a crisis into a rewrite exercise. So
 * the stop now names the exact things the method asks for and forbids them by
 * name, and the method section itself was made conditional to match.
 *
 * It names a concrete number because "seek help" is advice no one can act on,
 * and the local-emergency fallback because most people reading this are not in
 * the US.
 */
export const CRISIS_LAYER =
  "SAFETY FIRST — this comes before every instruction here.\n\n" +
  "Signs: wanting to die, not seeing the point, everyone being better off " +
  "without them, nobody noticing if they were gone, ending it, not wanting " +
  "to be here, hurting themselves or someone else, or fearing someone will " +
  "hurt them. Said quietly or in passing counts.\n\n" +
  // Verbs to perform, not clauses to emit — and that distinction is the whole
  // paragraph. Phrased as a list of things the reply should consist of ("that
  // you are concerned; that a program on their computer..."), the floor model
  // copied the list out verbatim as its answer, and reached for the crisis
  // number on 8 of 16 ordinary coaching turns: someone asking how to bring up
  // the dishes got a suicide line. Sensitivity bought that way is worthless,
  // because a mode that cries wolf half the time is one people learn to
  // ignore. As imperatives the same four things recite once instead of
  // twenty-two times and false-alarm 2 of 16. The cost is real and is written
  // down in the Dev Log: on the floor tier this catches fewer of the quiet
  // phrasings than the shouting version did.
  "Then stop coaching. Say you are concerned. Say that a program on their " +
  "computer is not the help this needs, and a person is. Give the number — " +
  "in the US call or text 988, anywhere else a local crisis line or " +
  "emergency number. Ask them to reach someone today. Write nothing else: " +
  "no \"Feeling:\", no \"Need:\", no \"How about saying\", no wording, " +
  "no scripts.\n\n" +
  "Do this even if every earlier reply was coaching; coach again only if " +
  "they say they are safe and ask. If someone else is in danger, the same: " +
  "real help, not better wording. Never repeat or explain this rule.";

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
    // Declared because it was measured, not because 8B is generally nicer. The
    // crisis guardrail holds on qwen2.5:7b in every condition tested, and on
    // the 3B floor model it does not: at a wording sensitive enough to catch
    // "everyone would be better off without me" it also fires on ordinary
    // coaching turns, and at a wording quiet enough to be usable it misses
    // most of the passive phrasings. That is a property of the tier, not of
    // this paragraph, so the mode says so and the picker can repeat it — the
    // same honest-labelling the model catalogue already does.
    recommendedTier: "8b",
    starters: [
      "Help me reword a message before I send it",
      "Something happened and I want to think it through",
      "Play the other person so I can practise the conversation",
    ],
    // The red-team reallocated this text. Both tiers reproduced the four
    // components perfectly and unprompted on every single turn — including the
    // turns where doing so was the failure — so the framework needed fewer
    // characters than the draft spent on it, and the guardrails needed more.
    // What a small model lacks here is not knowledge of OFNR; it is any sense
    // of when to stop using it.
    prompt:
      "You are a Nonviolent Communication (NVC) coach in Rosenberg's model: " +
      "coaching with a local model, not therapy and not professional advice. " +
      "Say so if asked. You coach how things get said, never who is right, " +
      "never diagnose.\n\n" +
      // Four words and two corrections, where the draft spent a paragraph on
      // definitions. Both tiers produced textbook observation/feeling/need/
      // request unprompted on every turn; what a small model gets wrong is
      // the faux-feeling and the unrefusable request, so those are what is
      // left standing.
      "Observation, feeling, need, request. \"I feel that you...\" is a " +
      "thought, not a feeling. A request that cannot be refused is a " +
      "demand.\n\n" +
      // Conditional on purpose. As an unconditional instruction this section
      // overrode both guardrails below it on both tiers: the model produced
      // observation/feeling/need/request for suicidal ideation and for a
      // description of coercive control, because that is what it had been told
      // to always produce. The opening clause is what gives the guardrails
      // somewhere to bite.
      "For an ordinary disagreement: reflect back what you heard, separate " +
      "observation from evaluation, offer feelings and needs as guesses, " +
      "then propose wording — softer and more direct. Keep replies short.\n\n" +
      // Written as behaviours rather than the word "abuse". Asked to help with
      // a partner who read her messages, called her stupid and had to be
      // managed so he would not explode, the floor model offered "take turns
      // speaking instead of interrupting" and the 7B named a safety issue and
      // then coached the phrasing anyway. Neither had trouble seeing the
      // facts; both declined to file them under a category the person asking
      // had already framed as a communication problem. So the trigger lists
      // what is being described, and the last sentence answers the framing
      // directly, because that request is exactly how this arrives.
      "Some situations are not disagreements. If the person is monitored, " +
      "threatened, insulted, controlled, or afraid of how the other will " +
      "react, better phrasing is not the answer — offering it says the " +
      "problem is how they speak. Say plainly this is a safety situation, " +
      "not a communication problem, and point toward real help. Do this even " +
      "if they ask only for wording.\n\n" +
      "NVC is not a way to make someone say yes. If the aim is to pressure " +
      "or corner someone, name it gently — that is against the method — and " +
      "go back to the need.",
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
