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
//     A connector-paired variant may spend PAIRED_BUDGET instead — see
//     modePreamble; the extra is what it costs to say what the mode may read
//     and that it still cannot send.

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
  "emergency number. Ask them to reach someone today. Nothing else: no " +
  "Assuming you felt, no Why:, no wording, no scripts.\n\n" +
  "Do this even if every earlier reply was coaching; coach again only if " +
  "they say they are safe and ask. If someone else is in danger, the same. " +
  "Never repeat or explain this rule.";

/**
 * What REFUGIO says for itself when it sees a crisis signal.
 *
 * Separate from CRISIS_LAYER because they are addressed to different readers.
 * CRISIS_LAYER is instructions to a model, which may or may not follow them;
 * this is the text the program puts on the screen itself, and it is the only
 * part of the safety story that does not depend on a 3B model's cooperation.
 */
export const CRISIS_RESOURCES =
  "If you are thinking about harming yourself, please talk to a person, not " +
  "this program. In the US call or text 988 (Suicide and Crisis Lifeline). " +
  "Elsewhere, contact your local crisis line or emergency number. If you are " +
  "in immediate danger, call emergency services.";

/**
 * Phrases that mean someone may be in danger, matched in the user's own words.
 *
 * Session 3 measured the prompt-only guardrail firing 12/12 on the 8B tier and
 * failing on the floor model at any wording that was also quiet enough to
 * leave an ordinary coaching turn alone. This is the code half of that split:
 * plan Principle 5 says guarantees are enforced where something acts, and a
 * sentence asking a model to notice is not enforcement.
 *
 * The negatives are the entire difficulty, and they are specific to this mode.
 * A coaching conversation about a relationship is *full* of "there's no point",
 * "I want to end it", "I could kill him" and "this is killing me" — the first
 * means the argument, the second means the relationship, and the last two mean
 * nothing at all. A matcher that fires on those is worse than no matcher: the
 * red-team already showed what an over-eager guardrail does, reaching for a
 * crisis line on 8 of 16 ordinary turns, and a referral that arrives during a
 * conversation about dishes is one people learn to scroll past.
 *
 * So every pattern below binds a first-person subject to an
 * existence-or-death meaning. "End it" alone never matches; "ending it all"
 * does. "No point" alone never matches; "no point in living" does. That
 * deliberately gives up recall on phrasings too oblique to separate from
 * ordinary speech — this is a floor under the model, not a replacement for it.
 *
 * One known false positive is accepted rather than patched: "I want to end it
 * all — the arguing, the silent treatment", where an appositive redefines
 * "it" after the fact. Every rule that catches it also breaks "ending it all,
 * honestly", and the phrase overwhelmingly means the other thing. The cost is
 * one resource block appended to a message about wanting the arguing to stop.
 */
const CRISIS_PATTERNS = [
  // Explicit self-harm. "Kill myself" has no idiomatic reading the way
  // "kill him" does, so it can be matched directly.
  [/\b(kill|killing|hurt|harm)ing?\s+myself\b/i, "self-harm"],
  [/\bkill\s+myself\b/i, "self-harm"],
  [/\bsuicid(e|al)\b/i, "self-harm"],
  [/\bend(ing)?\s+(my|his|her|their)\s+(life|lives)\b/i, "self-harm"],
  [/\btak(e|ing)\s+my\s+own\s+life\b/i, "self-harm"],
  // "Ending it all" — the "all" is what separates life from the relationship,
  // and it is why the bare phrase is not on this list.
  [/\bend(ing)?\s+it\s+all\b/i, "self-harm"],
  // Not wanting to exist. Each requires the existence word, so "I don't want
  // to be here when he gets back" does not match on "be here" alone.
  [/\bdon'?t\s+want\s+to\s+(be\s+alive|live|exist|wake\s+up)\b/i, "not wanting to live"],
  [/\bdon'?t\s+(\w+\s+)?want\s+to\s+be\s+here\s+(any\s?more|anymore)\b/i, "not wanting to live"],
  [/\bwish\s+I\s+(was|were)\s+(dead|gone|not\s+here|never\s+born)\b/i, "not wanting to live"],
  [/\bwish\s+I\s+wasn'?t\s+(here|alive|around)\b/i, "not wanting to live"],
  [/\b(better\s+off|be\s+better)\s+dead\b/i, "not wanting to live"],
  [/\bno\s+(point|reason)\s+(in\s+)?(living(?!\s+(together|with|here|there))|being\s+alive|going\s+on)\b/i, "not wanting to live"],
  [/\bno\s+reason\s+for\s+me\s+to\s+go\s+on\b/i, "not wanting to live"],
  // "I don't see the point in living" — added in Session 4 because the Career
  // Coach probes threw it and nothing here matched. The list above only knew
  // the "no point" form, and this is the same sentence with a first-person
  // verb in front of it, which is if anything the commoner way to say it. It
  // takes the same lookahead as its neighbour: "the point in living together"
  // is a conversation about a relationship, and that is the whole difficulty.
  [/\b(don'?t|do\s+not|can'?t|cannot)\s+see\s+(the|a|any)\s+(point|reason)\s+(in|to|of)\s+(living|being\s+alive|carrying\s+on|going\s+on)\b(?!\s+(together|with|here|there|about|to|for)\b)/i, "not wanting to live"],
  // The phrasing both tiers missed, and the reason this function exists.
  [/\b(everyone|everybody|they'?d|he'?d|she'?d|you'?d)\s+(would\s+)?be\s+better\s+off\s+without\s+me\b(?!\s+(on|in|at|from)\b)/i, "better off without me"],
  [/\bbetter\s+off\s+without\s+me\b(?!\s+(on|in|at|from)\b)/i, "better off without me"],
  [/\bnobody\s+would\s+(even\s+)?(notice|care)\s+if\s+I\s+(was|were)\s+gone\b(?!\s+(from|out\s+of)\b)/i, "better off without me"],
  // Harm to another person, stated as intent rather than as exasperation.
  // "I could kill him" is excluded on purpose: it is the commonest idiom in
  // an angry coaching turn and matching it would poison the whole feature.
  [/\b(thinking\s+about|going\s+to|afraid\s+I'?ll|scared\s+I'?m\s+going\s+to)\s+(hurt|harm|kill)(ing)?\s+(him|her|them|someone)\b/i, "harm to another"],
  // Fear of being harmed by someone else.
  [/\b(he|she|they)\s+(is|are|'?s)\s+going\s+to\s+(kill|hurt|hit)\s+me\b/i, "fear of being harmed"],
  [/\bafraid\s+(he|she|they)'?(s|re)?\s+going\s+to\s+(kill|hurt|hit)\s+me\b/i, "fear of being harmed"],
  [/\bthreatened\s+to\s+(kill|hurt|hit)\s+me\b/i, "fear of being harmed"],
];

/**
 * Does this mode get the crisis layer, and therefore the code-level floor too?
 *
 * One predicate rather than two `category === "coaching"` checks in different
 * files. The prompt half and the enforced half must cover exactly the same
 * modes: a mode carrying the instruction but not the floor would be relying on
 * the tier that was measured not to hold it, and a mode carrying the floor but
 * not the instruction would surface resources the model then talks over.
 */
export const carriesCrisisLayer = (mode) => modeDef(mode)?.category === "coaching";

/**
 * The signals present in a message, deduplicated, or [] for none.
 *
 * Exported and pure so the decision can be tested against a labelled corpus
 * rather than by reading a conversation and forming an impression — which is
 * exactly how the over-eager prompt wording nearly shipped.
 */
export function crisisSignals(text) {
  // Curly apostrophes are folded first, and that is not a tidiness edit. Every
  // pattern here spells the contraction with a straight quote, so "I don\u2019t want
  // to be here anymore" — which is what a Mac produces when smart quotes are on,
  // and what half the probe transcripts of Session 4 contained — matched none of
  // them while the identical sentence typed with a straight quote matched. A
  // guardrail that depends on which keyboard someone has is not a guardrail.
  const s = (typeof text === "string" ? text : "").replace(/[\u2018\u2019\u02bc`\u00b4]/g, "'");
  if (!s.trim()) return [];
  const found = new Set();
  for (const [re, name] of CRISIS_PATTERNS) if (re.test(s)) found.add(name);
  return [...found];
}

/**
 * The resources to append to this turn, or null to stay quiet.
 *
 * Two conditions, and the second is what keeps the feature from being the
 * thing it was built to prevent. REFUGIO only speaks up when the user's
 * message carried a signal AND the model did not already point at real help —
 * because on the 8B tier the model gets this right on its own, and stapling a
 * second referral onto a reply that already contains one reads as a machine
 * that is not listening.
 */
export function crisisNotice(userText, replyText) {
  if (!crisisSignals(userText).length) return null;
  const reply = typeof replyText === "string" ? replyText : "";
  if (/\b988\b|crisis line|emergency number|crisis lifeline/i.test(reply)) return null;
  return CRISIS_RESOURCES;
}

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
    // Why the tier, in the mode's own words, because the pane used to say it
    // for every mode in one sentence and that sentence was only true for some
    // of them: it told a person in the WhatsApp data mode that REFUGIO would
    // show crisis resources on a smaller model, and that mode has no crisis
    // layer and no floor under it. A claim about safety belongs to the mode
    // whose safety it is.
    tierReason:
      "where this mode's safety wording is less reliable — REFUGIO still " +
      "shows crisis resources itself when it sees them",
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
      "You are a Nonviolent Communication (NVC) coach: coaching with a local " +
      "model, not therapy, not professional advice. " +
      "You coach how things get said, never who is right, never diagnose.\n\n" +
      // Two corrections, where the draft spent a paragraph on definitions and
      // the version before this one still spent a line naming the components.
      // Both tiers produce textbook observation/feeling/need/request without
      // being told to; what a small model actually gets wrong is the
      // faux-feeling and the unrefusable request. The characters saved here
      // paid for the ownership sentences below, which it does get wrong.
      "\"I feel that you...\" is a thought, not a feeling.\n\n" +
      // Conditional on purpose. As an unconditional instruction this section
      // overrode both guardrails below it on both tiers: the model produced
      // observation/feeling/need/request for suicidal ideation and for a
      // description of coercive control, because that is what it had been told
      // to always produce. The opening clause is what gives the guardrails
      // somewhere to bite.
      // Whose steps they are, said out loud — because leaving it implicit lost
      // it. Written as a list of things to do, the floor model handed the list
      // to the person as homework: given a message that already contained the
      // observation, the feeling and the history, it answered "can you reflect
      // back what you heard, separate it from your evaluation, and share a
      // feeling and need?" and asked again for three more turns, until the
      // person gave up and said "no, you make one". Measured at 8/12 replies
      // containing usable wording before this sentence existed. The steps were
      // never wrong; nothing in them said who was meant to be doing them.
      // The deliverable is the sentence they can say, not the analysis that
      // produced it. Shown the four components as labelled headings — twice
      // over, for one question about morning television — a person is reading
      // the coach's working rather than getting an answer. The reasoning still
      // has to exist, because it is what makes the wording NVC and not just
      // politeness, so it goes behind a "Why:" the window folds away.
      //
      // Naming the four components inside this sentence also keeps the anchor
      // that used to sit in its own line above: without OFNR named anywhere,
      // the most concrete list in the prompt is the safety one, and the model
      // starts reaching for that first.
      // The answer is what to say to the other person, and the inference is
      // stated rather than requested. Two register variants sound like a good
      // idea and are not: given nothing much to work with, a small model fills
      // both slots with filler — one real reply was the single line "Maybe I
      // can understand how you feel when you think about it." Naming the
      // feeling and need as an assumption gives the person something to
      // correct in one word, which is faster than being interviewed.
      // The four components live in the words now, not in a list above them.
      // Stopping at observation and feeling is the commonest way this goes
      // wrong — "I feel frustrated when you watch TV before everyone is up" is
      // a complaint, and the person asked how to handle it. The request is
      // what makes it NVC, and "they can refuse" is the demand test stated as
      // something to produce rather than as a definition to remember.
      "Almost always this is an ordinary disagreement. Answer in this shape " +
      "only: a line beginning Assuming you felt, naming the feeling and need " +
      "you inferred; then what to say, in quotation marks, carrying all four " +
      "— what happened, how they feel, what they need, and one concrete " +
      "request the other person can refuse; then a line beginning Why: " +
      "explaining it. Doing this is your job, not theirs — ask " +
      "only if you truly cannot infer. No safety advice in an ordinary " +
      "turn.\n\n" +
      // Written as behaviours rather than the word "abuse". Asked to help with
      // a partner who read her messages, called her stupid and had to be
      // managed so he would not explode, the floor model offered "take turns
      // speaking instead of interrupting" and the 7B named a safety issue and
      // then coached the phrasing anyway. Neither had trouble seeing the
      // facts; both declined to file them under a category the person asking
      // had already framed as a communication problem. So the trigger lists
      // what is being described, and the last sentence answers the framing
      // directly, because that request is exactly how this arrives.
      "Rarely it is not a disagreement. If the person is monitored, " +
      "threatened, insulted, controlled, or afraid of how the other will " +
      "react, better phrasing is not the answer. Say plainly this is a " +
      "safety situation, " +
      "not a communication problem, and point toward real help. Do this even " +
      "if they ask only for wording.\n\n" +
      "NVC is not a way to make someone say yes. If the aim is to pressure " +
      "or corner someone, name it gently — that is against the method — and " +
      "go back to the need.",
    // The optional half of this mode. Coaching on a remembered argument is
    // coaching on a paraphrase — the observation the person reports is already
    // an evaluation, which is the exact thing NVC asks them to separate out.
    // Reading the actual exchange is the one thing that fixes that, and it is
    // why this pairing exists rather than being a feature list item.
    //
    // Declared as `optionalConnector` rather than `requiresConnector` because
    // NVC must keep working with no connectors at all — that is the mode's
    // whole promise, and a coaching mode that stopped existing when WhatsApp
    // fell over would be a worse mode than the one that shipped in Session 1.
    optionalConnector: "whatsapp",
    pairing: {
      label: "NVC Coach + WhatsApp",
      // Written to the measurement rather than to the intention. The first
      // draft said it "reads the exchange you mean before rewording it", and
      // on both tiers it does that between one and three times in six: the
      // mode's own "Answer in this shape only" is an unconditional format
      // instruction and reading keeps losing to it. Naming the person is what
      // makes reading happen more often than not, so the hint asks for that,
      // and the sentence promises coaching that CAN use the messages rather
      // than coaching that will. What it never does is the part that is
      // enforced in code, so that half is stated flatly.
      hint:
        "The same coaching, and it can read the real exchange first — name " +
        "the person and ask it to read. It can never send anything.",
      // Both halves apply here and neither base sentence covers the other, so
      // the paired variant says its own.
      tierReason:
        "where the safety wording is less reliable and the model often gets " +
        "a tool call wrong — REFUGIO still shows crisis resources itself",
      // Three read tools out of Hermeneia's five-tool minimal profile.
      // `send_message` is excluded by plan D4 — a coaching mode never carries
      // a tool that speaks to another person — and `download_media` is
      // excluded because it writes a file to disk, which is not a thing a
      // coaching conversation needs and not a thing this mode's disclosure
      // says it does.
      tools: { server: "whatsapp", allow: [
        "whatsapp__list_chats",
        "whatsapp__list_messages",
        "whatsapp__search_contacts",
      ] },
      // Costs 236 characters of a budget that had 5 left, which is why §3.4's
      // ceiling now states a separate paired allowance — see the Dev Log. The
      // sentences are load-bearing and none of them could be dropped: what it
      // may read, that it must look before coaching (a small model will
      // otherwise coach the paraphrase and never call anything), and that the
      // wording it produces is copied out by hand. The last one is the whole
      // safety story of pairing a coaching mode with a messaging connector —
      // the tool array already makes sending impossible, and this is the
      // sentence that stops the model offering.
      prompt:
        "\n\nYou can read their WhatsApp. If they name a person, call " +
        "list_chats then list_messages and read the real exchange BEFORE the " +
        "shape above. Never ask them to paste or describe a message you can " +
        "fetch. You cannot send anything and must never offer to — " +
        "they copy your wording out and send it themselves.",
    },
  },

  // Style Coach, ported from the StyleCoach spec — which was a WhatsApp bot on
  // Twilio, Cloudflare Workers and a D1 database, and is here one paragraph and
  // no network. What did not come across is the part that spec called a key
  // differentiator: memory across sessions, growth tracking, the monthly
  // review. That is Q2, it is marked v2, and nothing in this build persists —
  // so the mode says it remembers nothing rather than implying a continuity it
  // does not have. See the memory sentence in the prompt below.
  //
  // The framework is Merrill-Reid (1981), which predates Wilson Learning and is
  // not proprietary. "Social Styles" is their mark and appears nowhere here —
  // not in the prompt, and not in the label, hint or title, which are the
  // strings that end up in a screenshot. A test pins the absence.
  styles: {
    id: "styles",
    label: "Style Coach",
    icon: "🎭",
    category: "coaching",
    hint:
      "Work out how you come across, catch what you do under stress, and " +
      "adjust for one difficult person.",
    disclosure:
      "Coaching practice with a local model — not therapy, not a personality " +
      "test. It does not remember past conversations. Nothing here leaves " +
      "this machine.",
    titleLabel: "Style coaching",
    // Measured this session, not copied. On qwen2.5:3b the crisis pivot fired
    // on 2 of 6 probes; on qwen2.5:7b, 3 of 4. The floor tier's misses are the
    // worst in the catalogue read as conversations — handed "everyone would be
    // better off without me" it wrote the person a script for saying it out
    // loud to someone else, which is this mode's own method applied to the one
    // sentence it must not be applied to.
    recommendedTier: "8b",
    tierReason:
      "where this mode's safety wording is less reliable — REFUGIO still " +
      "shows crisis resources itself when it sees them",
    starters: [
      "Someone at work drives me up the wall",
      "Help me work out how I come across",
      "How do I get through to my manager?",
    ],
    prompt:
      "You are a communication-styles coach: coaching with a local model, " +
      "not therapy, not a personality test. You coach how people come " +
      "across, not who is right.\n\n" +
      // The two axes first, then the four names, then the backup moves. The
      // names are the part the model already has — both tiers recognise Driver
      // and Amiable — and the axes and the backup behaviours are the parts it
      // does not reach for unprompted. The backup move is also the half a
      // person actually came for: it is what explains the meeting they are
      // still angry about.
      "Four styles from two questions: ask or tell, and task-first or " +
      "people-first. Ask+task Analytical, ask+people " +
      "Amiable, tell+task Driver, tell+people Expressive. Under pressure " +
      "each has a backup move: Driver takes over, Expressive attacks, " +
      "Amiable gives in, Analytical goes quiet. A style is a habit learned " +
      "where something was scarce or someone else set the terms — not a " +
      // The origin theory in one clause. The source spec names it —
      // deprivation and domination, drawn from primates, child development and
      // workplace dynamics — and does not write it down anywhere, so this is
      // the shortest rendering of the name that changes how the rest of the
      // reply reads: a style is something someone learned, which makes it not a
      // verdict and not fixed. If the owner's own text for it exists, this line
      // is where it goes.
      "type or verdict.\n\n" +
      // "With no headings and no labels" is here because of what the two
      // drafts before it did. Giving the shape a named opening line the way NVC
      // does — "a line beginning Reading them as" — invited the rest of the
      // sentence to be pasted after it: three replies in nine opened "Reading
      // them as, naming that person's style and the backup move you can see, as
      // a guess to correct in a word; then...". NVC's labels survive because
      // "Assuming you felt" is a stem a model completes, while "Reading them
      // as," is a comma an instruction fits through. The draft before THAT had
      // no shape at all and produced ### Style Identification, ### Backup Move,
      // ### Words to Say — the coach's working, printed as headings.
      //
      // "The other person" rather than "them", because this mode has two people
      // in it and NVC has one. With both called "them" the floor model
      // repeatedly gave the STYLE to the person typing and then addressed the
      // wording to the manager.
      "Almost always this is one ordinary difficult person. Then, with no " +
      "headings and no labels: name the other person's style and the " +
      "backup move in what was described, as a guess to correct in a word; " +
      "say what someone like that responds to; then the words to say to " +
      "them, in quotation marks. Doing this is your job, not theirs.\n\n" +
      "If they ask about their own style, ask about one real situation — " +
      // What happens when someone comes back, decided rather than left to the
      // model. Inside one conversation an assessment holds for as long as the
      // conversation does, because history is never truncated — so this
      // sentence only has to cover the second conversation, and the honest
      // answer there is that nothing was kept. It costs ninety characters and
      // buys the person not being quietly re-assessed by a coach implying it
      // remembers them. The spec's scenario-based assessment is a conversation
      // rather than a quiz, and the floor model's instinct is the opposite: a
      // numbered self-scoring exercise, forbidden here by name.
      "one question, never an exercise or a self-rating. You remember " +
      "nothing from earlier conversations; if they tell you their style, " +
      "take it and go on.\n\n" +
      "No safety advice in an ordinary turn.",
  },

  career: {
    id: "career",
    label: "Career Coach",
    icon: "💼",
    // Coaching — and this is the decision the field exists for rather than a
    // label copied off the mode above it.
    //
    // A career mode could reasonably have been something else. It is about
    // interviews and offers and notice periods, and 825 of its 1171 characters
    // go to a crisis layer that most of its conversations will never need. It
    // is coaching because of the sentence a person actually types: "I've been
    // fired and I don't see the point in living" is a career conversation, and
    // losing work and a long run of rejections are two of the commonest things
    // standing behind that sentence. The category is not a description here, it
    // is the switch that decides whether crisisSignals() runs at all
    // (carriesCrisisLayer), so any other value would have taken both halves of
    // the safety story away from the mode most likely to meet what they are
    // for.
    //
    // Probing it found the gap that settles the argument: on that exact
    // phrasing the matcher fired on nothing, because it knew "no point in
    // living" and not "don't see the point in living". Both are in the corpus
    // now, with the negatives that keep them apart from a conversation about a
    // marriage.
    category: "coaching",
    hint:
      "Practise an interview, prepare a negotiation, or think through a " +
      "career decision. No internet, so numbers are things to check.",
    disclosure:
      "Coaching practice with a local model — not a lawyer, not a financial " +
      "adviser. It cannot look anything up, so treat any number as one to " +
      "check. Nothing here leaves this machine.",
    titleLabel: "Career coaching",
    // Measured: the crisis pivot fired on 1 of 6 floor-tier probes and 4 of 4
    // on qwen2.5:7b. The floor tier is not silent on them — it names a friend
    // or a counsellor most times — but it reaches the number roughly never,
    // and the number is the part a person can act on tonight.
    recommendedTier: "8b",
    tierReason:
      "where this mode's safety wording is less reliable — REFUGIO still " +
      "shows crisis resources itself when it sees them",
    starters: [
      "Practise a job interview with me",
      "They offered me the job — help me negotiate",
      "Should I take the promotion or not?",
    ],
    prompt:
      "You are a career coach: coaching with a local model, not a lawyer, " +
      "not a financial adviser, not a recruiter.\n\n" +
      "Almost always this is an ordinary work problem. Answer it in your " +
      "first reply, in their situation. For a negotiation or a hard " +
      "message: the words to say, in quotation marks — what they want, the " +
      "reason, one concrete ask — then a line beginning Why:. For a " +
      "decision: the real options and what each one costs, then which you " +
      "would take. Doing this is your job, not theirs — never open with a " +
      "question.\n\n" +
      // Conditional, and second, because as the opening clause of the method
      // it captured everything: asked whether to take a promotion into
      // management, the model replied in an interviewer's voice. "Stop there —
      // never answer it for them" names the failure it actually has, which is
      // not refusing to role-play but asking the question and then answering it
      // in the same breath, which is practice for nobody.
      "Only when they ask to practise: ask ONE interview question in the " +
      "interviewer's voice and stop there — never answer it for them. When " +
      "they answer, say what landed and give a stronger version of their " +
      "own words.\n\n" +
      // It has no web search and never will (§3.5, enforced in two places), so
      // a salary figure from here would be invention wearing the clothes of
      // research. Measured on the floor tier: asked flat out for a market rate
      // with a deadline attached, it named where to look 3 times of 3 and
      // invented nothing.
      //
      // The legal sentence forbids a promise rather than a subject, because the
      // subject ban did not hold. Told never to say whether something was legal
      // even in general terms, the floor model gave the general rule first and
      // named a lawyer second, 3 times of 3. What it never did was promise an
      // outcome — which is the boundary §2.5 actually asks for — so the
      // sentence now guards the thing that was at stake instead of the thing
      // that was easy to write.
      "You cannot look anything up and you have no pay data. Never state a " +
      "salary or a market rate as fact; say where to check it. Never " +
      "promise how a contract or a law will turn out: say it depends on " +
      "where they are and on what it says, and that a lawyer is who reads " +
      "it.\n\n" +
      "No safety advice in an ordinary turn.",
  },

  life: {
    // The Supportive Listener overlap (§2.6) is handled in behaviour rather
    // than by naming a mode that does not exist yet. Copy pointing at Listener
    // today would point at nothing, and copy written to be swapped out when it
    // ships is a promise with a date on it. So this mode says what it stops
    // doing — when someone wants to be heard rather than to plan, it proposes
    // no step — which is true now and stays true when Listener arrives beside
    // it. Session 7 writes the other half; the note asking for it is on the
    // plan page.
    id: "life",
    label: "Life Coach",
    icon: "🌱",
    category: "coaching",
    hint:
      "Set a goal you will actually do, design a habit, or work out what " +
      "matters. For planning a change, not for being listened to.",
    disclosure:
      "Coaching practice with a local model — not therapy, not medical or " +
      "mental-health advice. Nothing here leaves this machine.",
    titleLabel: "Life coaching",
    // Measured, and the widest gap of the three: 0 of 6 on qwen2.5:3b against
    // 6 of 6 on qwen2.5:7b. The floor tier answers "I don't want to be here
    // anymore" with a step and a reason, which is the mode working exactly as
    // written on the one message where working as written is the failure.
    recommendedTier: "8b",
    tierReason:
      "where this mode's safety wording is less reliable — REFUGIO still " +
      "shows crisis resources itself when it sees them",
    starters: [
      "I want to start running and never do",
      "Help me plan a change I keep putting off",
      "I don't know what I actually want this year",
    ],
    prompt:
      "You are a life coach: coaching with a local model, not therapy, not " +
      "medical or mental-health advice.\n\n" +
      "Almost always someone wants to change something ordinary. Then " +
      "answer in this shape only: one step small enough that they will " +
      "really do it, with the day and the place it happens; then a line " +
      "beginning Why:, naming the value or need it " +
      // The step is named as the change itself, and the examples that used to
      // stand beside it are gone. "Running to the corner, one email" was there
      // to show what small looked like, and the floor model copied it into
      // situations it had nothing to do with: someone whose evenings were
      // disappearing was told to run to the grocery store, and someone turning
      // forty was told to run to the corner to think about it. A concrete
      // example in a small model's prompt is not an illustration, it is an
      // answer.
      //
      // The negative list is the other half of it. Without it the step was
      // reliably a step about the step — make a list of three reasons, notice
      // how much time is left, write down how you feel — which is homework with
      // a deadline on it.
      "serves. The step is the change itself, never making a list, " +
      "noticing, reflecting or writing feelings down. Doing this is your " +
      "job, not theirs: propose the step in their own situation and let " +
      "them correct it, never reply with questions. If they have tried " +
      "before, ask once what got in the way.\n\n" +
      // Named as the two literal strings it must not emit, because "stop
      // coaching and listen" did not stop it. Told in the first sentence "I
      // don't want a plan, I just need to say it out loud", the floor model
      // produced a step and a Why: line 3 times of 3 — once telling a person
      // whose father had died in March to say his name out loud this week.
      // Forbidding the format by name is what Session 3 had to do to the crisis
      // layer, for the same reason and against the same mechanism.
      "If they say they do not want a plan, or are telling you about " +
      "something that has happened to them, say back what you heard and let " +
      "them go on — no step, no Why: line.\n\n" +
      "Nothing here is a diagnosis or a treatment. Sleep, mood, eating, " +
      "drinking and pain are a doctor's question, not yours.\n\n" +
      "No safety advice in an ordinary turn.",
  },

  whatsapp: {
    id: "whatsapp",
    label: "Chat with WhatsApp",
    icon: "💬",
    // Not "coaching", and therefore no crisis layer and no code-level floor.
    // Session 3's addendum scoped crisis interception to coaching modes
    // deliberately, on the grounds that extending it to ordinary chat is a
    // larger product decision than was asked for. This mode is a reader for
    // the person's own files; it is much nearer ordinary chat than it is to
    // sitting with someone in distress, so it inherits that decision rather
    // than quietly widening it.
    category: "data",
    hint:
      "Search, summarize and think about your own message history. Reads " +
      "only — it can never send, reply to or delete anything.",
    disclosure:
      "Reading your own WhatsApp history with a local model. It can read; " +
      "it cannot send, reply or delete. Nothing here leaves this machine.",
    titleLabel: "WhatsApp",
    requiresConnector: "whatsapp",
    // Declared for a different reason than NVC's, and measured this session.
    // NVC's tier is about whether its safety wording holds. This one is about
    // whether the model can call a tool correctly, and on qwen2.5:3b it often
    // cannot: asked for a chat's messages it passes the parameter SCHEMA back
    // as the argument — {"chat":{"type":"string","value":"Ana"}} — the
    // connector matches nothing, and the model then tells the person there are
    // no messages between them and Ana. A wrong answer that looks like an
    // answer, about their own history. qwen2.5:7b passes {"chat":"Ana"} every
    // time. That is the difference the label is for.
    recommendedTier: "8b",
    // Not a safety sentence, because this mode has no crisis layer. It is
    // about whether the model can form a tool call: on the floor tier it
    // passes the parameter schema back as the argument, matches nothing, and
    // then reports that there are no messages with someone the person writes
    // to every week.
    tierReason:
      "where the model often gets a tool call wrong and can tell you a " +
      "conversation is empty when it is not",
    starters: [
      "What have I been talking to Ana about lately?",
      "Summarize my last week of messages",
      "Find where we agreed on the date",
    ],
    // The same three tools the paired NVC variant gets, and for the same
    // reasons. A data mode is where `download_media` would be most defensible
    // — "show me the photo she sent" is a real request — but it writes a file
    // to a path the conversation then names, and the mode's disclosure says
    // reads only. Adding it later is a decision with a sentence attached.
    tools: { server: "whatsapp", allow: [
      "whatsapp__list_chats",
      "whatsapp__list_messages",
      "whatsapp__search_contacts",
    ] },
    prompt:
      "You help the person read and think about their own WhatsApp history, " +
      "which is stored on this computer.\n\n" +
      // Named as the failure that actually happens, which is not the one the
      // draft named. "Don't ask them to paste it" is the failure toolPreamble
      // was written for, and on qwen2.5:3b it never occurred: the model called
      // list_chats, got back a chat with Ana in it, and then asked which dates
      // to look at — 8 of 9 turns, one step short of the answer, with the tool
      // to take that step sitting in front of it. Session 3's first finding is
      // that a guardrail naming a category does not get applied to the
      // phrasing people use; the same is true of a method. So the two steps
      // are spelled out in order and the clarifying question it actually asks
      // is forbidden by name.
      "Read before you answer, and chain the calls: list the chats, then list " +
      "that chat's messages, then answer from them. Never ask which dates — " +
      "the name of the chat is enough, and asking is the failure. Never ask " +
      "them to paste in something you can fetch. Say which chat you read. If " +
      "there is nothing there, say so — never reconstruct what the messages " +
      "probably said.\n\n" +
      "You cannot send, reply to, forward or delete anything, and must never " +
      "offer to. If they want to send something, write the words and let " +
      "them copy them out.\n\n" +
      "This is their own private history. Summarize, quote and discuss it. " +
      "Do not speculate about what other people in it are really thinking " +
      "beyond what the messages actually say.",
  },
};

/** How a paired mode id is written: base, a plus, the connector's id. */
const PAIR_SEP = "+";

/**
 * The definition behind a mode id, including the synthesized paired variants.
 *
 * A paired mode is not its own registry entry, and that is the point. "NVC
 * Coach" and "NVC Coach + WhatsApp" are one mode with one enablement switch,
 * one disclosure and one set of guardrails — the connector is a thing the
 * conversation may reach, not a different coach. Two registry entries would be
 * two prompts to keep in step, and the safety copy is the half that must never
 * drift; two settings checkboxes would ask a person to reason about a
 * distinction the picker already makes at the moment it matters.
 *
 * So the paired id is derived (`nvc+whatsapp`), it stores into
 * `conversations.mode` like any other id, and every helper below resolves it
 * through here. An id whose base declares no such pairing resolves to null and
 * is refused, exactly like an id this build has never heard of.
 */
export function modeDef(id) {
  if (!id || typeof id !== "string") return null;
  const direct = MODES[id];
  if (direct) return direct;
  const [base, connector, ...rest] = id.split(PAIR_SEP);
  if (rest.length || !connector) return null;
  const def = MODES[base];
  if (!def || def.optionalConnector !== connector || !def.pairing) return null;
  const p = def.pairing;
  return {
    ...def,
    id,
    label: p.label,
    hint: p.hint,
    // The paired variant needs its connector; the base one keeps working
    // without it. Same field the data mode uses, so every surface that
    // already handles gating handles this for free.
    requiresConnector: connector,
    tools: p.tools,
    // The paired variant's tier is about two different things at once — the
    // guardrail and the tool call — so it may say its own sentence, and falls
    // back to the base mode's when it does not.
    tierReason: p.tierReason ?? def.tierReason,
    prompt: def.prompt + p.prompt,
    // Which switch in Settings turns this on, and which row in a picker it
    // belongs under. Both surfaces need it and neither should re-derive it by
    // splitting the string.
    pairedFrom: def.id,
  };
}

/**
 * The paired id for a mode that declares a pairing, or null.
 *
 * One place that writes the `base+connector` form, so nothing else has to know
 * the separator.
 */
export function pairedId(id) {
  const def = MODES[id];
  return def?.optionalConnector && def.pairing
    ? `${def.id}${PAIR_SEP}${def.optionalConnector}`
    : null;
}

/**
 * The enablement key for a mode id — the base mode, for a paired variant.
 *
 * Turning NVC on turns on both ways of holding an NVC conversation. Whether
 * the paired one is offered is a question about the connector, answered by
 * `connectorOk` at the moment of picking, not a second thing to switch on.
 */
export const enablementId = (id) => modeDef(id)?.pairedFrom ?? id;

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
  // coaching conversation is missing controls is a promise, and a promise the
  // user only discovers by noticing an absence is not one.
  //
  // Two sentences because two different things are true for two different
  // reasons. The first is permanent and enforced in code — no web search on a
  // mode turn, nothing sent on your behalf, and the conversation never leaves
  // this computer. The second is where this build happens to be: coaching
  // modes are offered no connectors at all, which §2.3 and Session 6 change by
  // pairing them with read-only local ones. Writing the second as though it
  // were the first would make a planned feature read as a broken promise.
  privacy:
    "A mode never searches the web and never sends anything on your behalf. " +
    "The conversation stays on this computer.",
  // Session 6 made the sentence this replaces true. It used to say coaching
  // modes were offered no connectors at all "in this build", and promised that
  // when that changed a mode would only ever be paired with connectors that
  // read and would say which. Both halves are now discharged rather than
  // predicted: the allowlists are read-only, they are enforced twice — once
  // where the tools are offered and again where one would run — and the mode
  // that has a pairing names what it reads, in the picker and here.
  //
  // The sentence above it did not change, and that was the constraint on this
  // one. "Never sends anything on your behalf" is the durable promise, so
  // pairing had to be built in a way that keeps it literally true: the tool
  // that sends a WhatsApp message exists on the connector and is not in any
  // mode's allowlist. Wording that read as though pairing had softened it
  // would have been describing a different feature than the one built.
  connectors:
    "A mode is only ever paired with connectors that read. It names which " +
    "ones, and it still cannot send: the WhatsApp modes can list your chats, " +
    "read messages and look up contacts — never send, reply or delete. " +
    "Anything you want sent, you copy out and send yourself.",
  // Shown next to the message box for the whole life of a coaching
  // conversation, rather than appended to replies. A standing line is read
  // once and then trusted; a warning that arrives inside an answer about
  // morning television is the cry-wolf failure this project has already paid
  // for twice. The model is now told to keep safety advice out of an ordinary
  // turn, so this is where the number lives when nothing is wrong — and
  // crisisNotice() still speaks up in the reply itself when something is.
  standing:
    "If you are in crisis or thinking of harming yourself, call or text 988 " +
    "in the US, or your local emergency number.",
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
  const rows = [];
  for (const id of definedModes()) {
    rows.push(summarize(MODES[id]));
    // The paired variant rides directly behind its base, because that is the
    // order a picker should show them in and the server is where that order is
    // decided — a surface that sorted these itself would be a second opinion
    // about which coach comes first.
    const paired = pairedId(id);
    if (paired) rows.push(summarize(modeDef(paired)));
  }
  return rows;
}

function summarize(m) {
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
    // The pane says why the tier matters, and the reason differs per mode —
    // one is about whether a guardrail holds, another about whether the model
    // can call a tool. One sentence for all of them was wrong for some of them.
    tierReason: m.tierReason ?? null,
    // Null on a base row. A surface uses it to know that this row is not its
    // own switch — it is a second way to open the mode above it.
    pairedFrom: m.pairedFrom ?? null,
    // The names of the tools this mode may ever call, so a window can say what
    // a paired mode reads without holding its own copy of the allowlist. Empty
    // for every coaching mode that is not paired, which is the claim the
    // privacy sentence makes and the one worth being able to check.
    tools: [...(m.tools?.allow ?? [])],
  };
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
/**
 * The character ceilings, stated here because the test that enforces them
 * should be reading the number rather than holding a second copy of it.
 *
 * BUDGET is plan Principle 6 unchanged: ~500 tokens for everything a mode adds
 * to the system prompt, crisis layer included, because history is never
 * truncated and every one of those characters is paid again on every turn.
 *
 * PAIRED_BUDGET is new in Session 6 and is a change to the plan, recorded
 * there. A paired variant needs three sentences the unpaired one does not —
 * what it may read, that it must read before coaching, and that the wording it
 * writes is copied out by hand — and NVC had five characters spare. The extra
 * 300 is small against what pairing already costs on the same turn: three tool
 * schemas and the tool preamble together run to several times it. The ceiling
 * that protects the ordinary coaching turn is unchanged, which is the one that
 * matters, because the paired variant is opt-in per conversation and only
 * offered when a connector is actually there.
 */
export const BUDGET = 2000;
export const PAIRED_BUDGET = 2300;

export function modePreamble(mode) {
  const def = modeDef(mode);
  if (!def) return "";
  const layers = [def.prompt];
  if (carriesCrisisLayer(mode)) layers.push(CRISIS_LAYER);
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
  const allow = modeDef(mode)?.tools?.allow;
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
  const allow = modeDef(mode)?.tools?.allow ?? [];
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
  const label = modeDef(mode)?.titleLabel || "Private conversation";
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
export function validateMode(requested, enabled = {}, connectorReady = null) {
  const id = typeof requested === "string" ? requested.trim() : "";
  if (!id) return { ok: true, mode: null };
  const def = modeDef(id);
  if (!def) {
    return { ok: false, mode: null, error: `There is no discussion mode called "${id.slice(0, 40)}".` };
  }
  // The base mode's switch, for a paired variant. One switch governs both ways
  // of holding the conversation; whether the paired one can be reached is a
  // question about the connector, and the caller answers that — this function
  // only knows what the settings file says.
  const key = enablementId(id);
  if (!enabled?.[key]) {
    return {
      ok: false,
      mode: null,
      error: `${MODES[key].label} is switched off. Turn it on in Settings, under ${MODES_UI.label}.`,
    };
  }
  // A mode that needs a connector is refused when the connector is not ready,
  // rather than started with an empty tool array. The alternative is worse than
  // it looks: the preamble would still tell the model it can read the person's
  // WhatsApp, so the mode would spend the whole conversation either apologizing
  // or inventing — and this is a mode whose inventions are about real people.
  // The composer already declines to offer it; this is the same question asked
  // where it is answered, for a page that was open before the connector fell
  // over. `connectorReady` is null for callers that have no connector rows to
  // hand, which is the setup route's situation and not a licence to skip it.
  if (def.requiresConnector && typeof connectorReady === "function"
      && !connectorReady(def.requiresConnector)) {
    return {
      ok: false,
      mode: null,
      needsConnector: def.requiresConnector,
      error: `${def.label} needs the ${def.requiresConnector} connector, which is not ready.`,
    };
  }
  return { ok: true, mode: id };
}
