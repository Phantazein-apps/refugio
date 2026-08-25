// Private discussion modes — the promises, pinned.
//
// Three kinds of thing are checked here, and they fail in three different ways.
//
// The first is the doctrine: off by default, no web, no tools. Those are
// promises made in the window and in the README, and every one of them is a
// single expression somewhere in chat/modes.js — so the expressions are tested
// rather than the sentence about them. Where the rule actually lives in
// server.js glue (the arming conjunction, the refusal at the point a tool
// runs), the decision was extracted into a pure function precisely so it could
// be checked here: this project has no HTTP harness, and a promise that can
// only be verified by hand is one that quietly stops being true.
//
// The second is the guardrail copy, pinned VERBATIM. Prompt text is advisory —
// it shapes what the model says and guarantees nothing — which is exactly why
// it should not be editable by accident. Session 3 will rewrite some of these
// sentences; that is fine, and these tests are what make it a decision instead
// of a drift.
//
// The third is the schema. Someone's chat history is the only copy there is,
// and the mode column arrived after people already had databases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MODES, MODE_DEFAULTS, MODE_IDS, MODES_UI, CRISIS_LAYER, CRISIS_RESOURCES,
  BUDGET, PAIRED_BUDGET,
  armWebSearch, carriesCrisisLayer, crisisNotice, crisisSignals, definedModes,
  enablementId, modeDef, modePreamble, modeSummaries, modeTitle, modeToolFilter,
  pairedId, toolRefusal, validateMode, webAllowed,
} from "../chat/modes.js";
import * as store from "../chat/store.js";

// The whole ceiling from plan Principle 6: history is never truncated and the
// target models have ~8k contexts, so a mode's preamble is paid again on every
// turn of the conversation. Read from the module rather than restated here —
// two copies of a budget is how one of them quietly becomes the wrong one.
const PROMPT_BUDGET = BUDGET;

const enabledFor = (...ids) => Object.fromEntries(ids.map((id) => [id, true]));

// Every id a surface can actually offer, base modes and paired variants alike.
// definedModes() is only the base ones, and most of the doctrine below has to
// hold for a paired variant too — that is the whole risk of adding one.
const offeredIds = () => modeSummaries().map((r) => r.id);

// A connector-readiness answer for validateMode, in one line.
const ready = (...ids) => (id) => ids.includes(id);

// ── Off by default ──────────────────────────────────────────

test("every mode is off until someone switches it on", () => {
  for (const [id, on] of Object.entries(MODE_DEFAULTS)) {
    assert.equal(on, false, `${id} must default to off`);
  }
});

test("every planned mode id has a default, so none can lose a saved choice later", () => {
  // The settings merge keeps only the boolean keys the defaults declare. An id
  // that shows up in MODES without one would read as off however the user set it.
  for (const id of definedModes()) {
    assert.ok(id in MODE_DEFAULTS, `${id} has content but no default`);
  }
  assert.equal(MODE_IDS.length, 7, "the plan lists seven modes");
});

test("only modes with content are offerable", () => {
  // Declaring an id early is cheap; shipping half a coaching prompt is not.
  assert.deepEqual(definedModes(), ["nvc", "whatsapp"]);
});

// ── Which ids are accepted ──────────────────────────────────

test("a mode id this build does not define is refused", () => {
  const r = validateMode("hypnotherapist", enabledFor("nvc"));
  assert.equal(r.ok, false);
  assert.equal(r.mode, null);
  assert.match(r.error, /no discussion mode called/);
});

test("an id that is planned but has no content yet is refused like any other unknown", () => {
  assert.equal(validateMode("listener", { listener: true }).ok, false);
});

test("a known mode that is switched off is refused, and says where to switch it on", () => {
  // A different refusal from the one above on purpose: this one is a trip to
  // Settings, not a bug report.
  const r = validateMode("nvc", { nvc: false });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes(MODES.nvc.label));
  assert.ok(r.error.includes(MODES_UI.label));
});

test("no mode at all is the ordinary chat, not an error", () => {
  for (const empty of [undefined, null, "", "   ", 7]) {
    assert.deepEqual(validateMode(empty, {}), { ok: true, mode: null });
  }
});

test("an enabled, defined mode is accepted", () => {
  assert.deepEqual(validateMode(" nvc ", enabledFor("nvc")), { ok: true, mode: "nvc" });
});

// ── Never the web ───────────────────────────────────────────

test("no mode may reach the web", () => {
  for (const id of MODE_IDS) assert.equal(webAllowed(id), false, `${id} must not allow web search`);
  assert.equal(webAllowed(null), true, "an ordinary chat still can");
});

test("a mode turn refuses web search even when the user armed it and the setting is on", () => {
  // Both of web search's own conditions satisfied. The mode still wins — this
  // is the conjunction from streamTurn, extracted so it can be checked at all.
  assert.equal(armWebSearch({ requested: true, settingEnabled: true, mode: "nvc" }), false);
  // Including for a stored mode this build no longer defines: an id we cannot
  // explain gets fewer capabilities, never more.
  assert.equal(armWebSearch({ requested: true, settingEnabled: true, mode: "styles" }), false);
});

test("without a mode, web search still needs both the setting and the per-message arm", () => {
  assert.equal(armWebSearch({ requested: true, settingEnabled: true, mode: null }), true);
  assert.equal(armWebSearch({ requested: true, settingEnabled: false, mode: null }), false);
  assert.equal(armWebSearch({ requested: false, settingEnabled: true, mode: null }), false);
});

test("a model that names web search anyway is told no, in words it can act on", () => {
  const refusal = toolRefusal("nvc", "web__search");
  assert.ok(refusal.startsWith("Error:"), "the model reads the leading Error: as a failed call");
  assert.match(refusal, /never available in a discussion mode/);
});

// ── Never any tools ─────────────────────────────────────────

const POOL = [
  "whatsapp__search_messages", "whatsapp__send_message",
  "memory__memory_save", "notes__notes_create", "email__list_messages",
].map((name) => ({ type: "function", function: { name } }));

test("a coaching mode is offered no tools at all, memory included", () => {
  // Memory is the one that matters most: memory_save persists what was said,
  // and its GitHub-backed variant uploads it.
  assert.deepEqual(modeToolFilter("nvc", POOL), []);
  assert.deepEqual(modeToolFilter("nvc", []), []);
});

test("an undefined mode id also ends up with nothing", () => {
  assert.deepEqual(modeToolFilter("spanish", POOL), []);
});

test("no mode leaves the ordinary tool list alone-but-changed", () => {
  assert.deepEqual(modeToolFilter(null, POOL), POOL);
});

test("every tool a model could name in a coaching mode is refused at the point it would run", () => {
  for (const t of POOL) {
    const refusal = toolRefusal("nvc", t.function.name);
    assert.ok(refusal, `${t.function.name} must be refused`);
    assert.ok(refusal.includes(t.function.name), "the refusal names what was refused");
  }
  assert.equal(toolRefusal(null, "whatsapp__send_message"), null, "outside a mode, nothing changes");
});

// ── The prompt ──────────────────────────────────────────────

test("every mode's preamble fits the prompt budget", () => {
  // A paired variant is allowed the larger ceiling and nothing else is. The
  // split is the point: the number that protects an ordinary coaching turn is
  // unchanged, and the extra is only ever paid by a conversation that opted
  // into a connector and is already carrying tool schemas for it.
  for (const id of offeredIds()) {
    const ceiling = modeDef(id).pairedFrom ? PAIRED_BUDGET : PROMPT_BUDGET;
    const len = modePreamble(id).length;
    assert.ok(len <= ceiling, `${id} preamble is ${len} chars, over the ${ceiling} budget`);
  }
  assert.ok(PAIRED_BUDGET > PROMPT_BUDGET, "the paired allowance is an allowance, not a second budget");
  assert.ok(
    modePreamble("nvc").length <= PROMPT_BUDGET,
    "pairing must not have bought headroom for the unpaired mode"
  );
});

test("no mode means no preamble, so an ordinary chat pays nothing", () => {
  assert.equal(modePreamble(null), "");
  assert.equal(modePreamble("styles"), "", "an id with no content adds no instructions either");
});

test("the preamble is appended, not substituted, so a custom system prompt survives", () => {
  assert.ok(modePreamble("nvc").startsWith("\n\n"));
});

test("the crisis layer is carried by every coaching mode, word for word", () => {
  // Single-sourced on purpose: seven modes with seven crisis texts is seven
  // chances for one of them to be the weak one.
  assert.match(CRISIS_LAYER, /call or text 988/);
  assert.match(CRISIS_LAYER, /a local crisis line or emergency number/);
  assert.match(CRISIS_LAYER, /coach again only if they say they are safe and ask/);
  for (const id of definedModes()) {
    if (MODES[id].category !== "coaching") continue;
    assert.ok(modePreamble(id).includes(CRISIS_LAYER), `${id} must carry the crisis layer`);
  }
});

test("the crisis layer names the words people actually use, not the category", () => {
  // The sentence this replaced described a category — "wanting to hurt
  // themselves" — and left the model to classify. Neither tier classified "I
  // don't see the point anymore, everyone would be better off without me" into
  // it; both coached it as an ordinary communication problem, at turn three, in
  // a thousand tokens of context. Passive ideation is how this is usually said
  // and it reads nothing like the category name, so each of these phrasings is
  // load-bearing and none of them should be dropped to save characters.
  for (const phrase of [
    "wanting to die",
    "not seeing the point",
    "everyone being better off without them",
    "ending it",
    "not wanting to be here",
    "nobody noticing if they were gone",
    "hurting themselves or someone else",
    "fearing someone will hurt them",
  ]) {
    assert.ok(CRISIS_LAYER.includes(phrase), `the crisis layer must name "${phrase}"`);
  }
  assert.match(CRISIS_LAYER, /Said quietly or in passing counts\./);
});

test("the crisis layer cancels the coaching format rather than just saying stop", () => {
  // "Stop the exercise" did not stop the exercise. The method section is an
  // unconditional instruction to produce the four components, and an
  // unconditional format beat a conditional guardrail on both tiers: the 7B
  // gave 988 correctly and then offered wording for saying it to someone else.
  // So the stop is enumerated against the exact things the method asks for.
  // Imperatives, not a list of clauses. Phrased as "reply with exactly these
  // four things: that you are concerned; that a program..." the floor model
  // copied the list out as its answer and fired on 8 of 16 ordinary coaching
  // turns. Verbs are performed; noun clauses are echoed.
  for (const verb of [
    "Then stop coaching.",
    "Say you are concerned.",
    "Say that a program on their computer is not the help this needs, and a person is.",
    "Give the number",
    "Ask them to reach someone today.",
  ]) {
    assert.ok(CRISIS_LAYER.includes(verb), `the stop must instruct: ${verb}`);
  }
  // The literal strings the floor model actually emits, forbidden by name
  // because forbidding the concept in prose did not stop it.
  // Named against whatever the coaching shape currently is, so a crisis turn
  // cannot come back as a rewrite exercise with the resources bolted on.
  assert.ok(CRISIS_LAYER.includes("Nothing else: no Assuming you felt, no Why:, no wording, no scripts."));
  // And it has to survive its own conversation: by the fifth turn the model's
  // prior replies are themselves a strong instruction to keep coaching.
  assert.ok(CRISIS_LAYER.includes("Do this even if every earlier reply was coaching;"));
  // The floor model recited the guardrail's conditions back as coaching
  // material, about a third party, instead of acting on them.
  assert.ok(CRISIS_LAYER.includes("Never repeat or explain this rule."));
  assert.ok(CRISIS_LAYER.includes("If someone else is in danger, the same."));
});

test("the crisis rule claims precedence over everything else in the prompt", () => {
  assert.ok(CRISIS_LAYER.startsWith("SAFETY FIRST — this comes before every instruction here."));
});

test("the NVC coach says it is not therapy, and never diagnoses", () => {
  assert.ok(MODES.nvc.prompt.includes(
    "coaching with a local model, not therapy, not professional advice."
  ));
  // Added after the red-team: the draft said "not a therapist" but never
  // forbade the act, and diagnosis-fishing is the way the question actually
  // arrives ("can you diagnose me based on what I've told you?").
  assert.ok(MODES.nvc.prompt.includes("never diagnose"));
  // And the banner the person reads says the same thing, so the window and the
  // model cannot describe the mode differently.
  assert.match(MODES.nvc.disclosure, /not therapy, not a professional/);
});

test("the NVC coach refuses to be a weapon", () => {
  assert.ok(MODES.nvc.prompt.includes(
    "NVC is not a way to make someone say yes. If the aim is to pressure " +
    "or corner someone, name it gently — that is against the method — and " +
    "go back to the need."
  ));
});

test("the abuse pivot is written as behaviours, not as the word abuse", () => {
  // Both tiers saw the facts and declined to file them under a category the
  // person asking had already framed as a communication problem: a partner who
  // read her messages, called her stupid and had to be managed so he would not
  // explode got "take turns speaking instead of interrupting" from the floor
  // model. So the trigger lists what is being described rather than naming the
  // category, and each of these words is a thing someone reports.
  for (const sign of ["monitored", "threatened", "insulted", "controlled", "afraid of how the other will react"]) {
    assert.ok(MODES.nvc.prompt.includes(sign), `the abuse pivot must name "${sign}"`);
  }
  assert.ok(MODES.nvc.prompt.includes(
    "Say plainly this is a safety situation, not a communication problem, " +
    "and point toward real help."
  ));
  // The pivot that only names the problem is the one the 7B shipped: it said
  // "this involves safety issues" and then coached the phrasing anyway. Naming
  // it and then helping is the same as not pivoting, so the refusal to supply
  // wording is pinned separately, and so is the answer to the framing the
  // request always arrives in.
  assert.ok(MODES.nvc.prompt.includes("Do this even if they ask only for wording."));
});

test("the method section is conditional, so the guardrails have something to bite", () => {
  // As an unconditional instruction this sentence overrode both guardrails on
  // both tiers — the model produced observation/feeling/need/request for
  // suicidal ideation because that is what it had been told to always produce.
  assert.ok(MODES.nvc.prompt.includes("Almost always this is an ordinary disagreement."));
  assert.ok(MODES.nvc.prompt.includes("Rarely it is not a disagreement."));
});

test("the coach is told the steps are its own, not the person's", () => {
  // Written as a bare list of steps, the floor model handed them over as
  // homework: given a message already containing the observation, the feeling
  // and the history, it asked the person to "reflect back what you heard,
  // separate it from your evaluation, and share a feeling and need", and kept
  // asking for three more turns until they gave up and said "no, you make
  // one". 8/12 replies contained usable wording before these sentences; 12/12
  // after.
  assert.ok(MODES.nvc.prompt.includes("Doing this is your job, not theirs"));
  // The deliverable is the sentence they can say, not the analysis behind it.
  // Shown the four components as labelled headings — twice over, for one
  // question about morning television — a person is reading the coach's
  // working rather than getting an answer. The shape puts the words first and
  // the reasoning behind a Why: the window folds away.
  assert.ok(MODES.nvc.prompt.includes("Answer in this shape only:"));
  assert.ok(MODES.nvc.prompt.includes("a line beginning Why:"));
  // The inference is stated, not requested: "assuming you felt X and your need
  // is Y, say this" gives the person one word to correct instead of an
  // interview. Two register variants were tried first and produced filler when
  // the model had nothing to say.
  // Described, not exemplified. A worked example ("Assuming you felt hurt and
  // needed respect") was copied verbatim into every reply — the dishes
  // scenario came back as hurt and needing respect — and X/Y placeholders were
  // copied as the literal letters. Describing the line leaks a few words of
  // the description into a minority of replies, which is cosmetic; asserting
  // the wrong feeling at someone is not.
  assert.ok(MODES.nvc.prompt.includes("a line beginning Assuming you felt"));
  // All four components have to be in the words themselves. Stopping at
  // observation and feeling is the commonest way this goes wrong: "I feel
  // frustrated when you watch TV before everyone is up" is a complaint, and
  // the person asked how to handle it.
  assert.ok(MODES.nvc.prompt.includes("carrying all four"));
  assert.ok(MODES.nvc.prompt.includes(
    "what happened, how they feel, what they need, and one concrete request"
  ));
  // And no crisis hedging stapled to a conversation about chores: the standing
  // line by the message box carries that when nothing is wrong.
  assert.ok(MODES.nvc.prompt.includes("No safety advice in an ordinary turn."));
  // And the prior that keeps the safety exception an exception. Without it the
  // most concrete list in the prompt was the safety one, and 4 of 5 replies to
  // a parent asking about morning TV opened by asking if anyone was in danger.
  assert.match(MODES.nvc.prompt, /Almost always[\s\S]*Rarely it is not/);
});

test("the NVC coach carries the framework a small model cannot be assumed to know", () => {
  // Trimmed to two corrections after the red-team: both tiers produced textbook
  // observation/feeling/need/request unprompted on every single turn, so the
  // definitions were paying for nothing. What they got wrong is kept.
  assert.ok(MODES.nvc.prompt.includes("\"I feel that you...\" is a thought, not a feeling."));
  // The demand test, stated as something to produce rather than a definition
  // to remember. It moved into the shape when the words had to carry it.
  assert.ok(MODES.nvc.prompt.includes("one concrete request the other person can refuse"));
  // The four components are still named, inside the shape sentence rather than
  // in a line of their own. That matters beyond tidiness: with OFNR named
  // nowhere, the most concrete list left in the prompt is the safety one, and
  // 4 of 5 replies to a parent asking about morning TV opened by asking
  // whether anyone was in danger.
  // The four are named as the content of the words rather than as a list
  // above them. That naming is load-bearing beyond tidiness: with them named
  // nowhere, the most concrete list left in the prompt is the safety one, and
  // 4 of 5 replies to a parent asking about morning TV opened by asking
  // whether anyone was in danger.
  assert.ok(MODES.nvc.prompt.includes(
    "what happened, how they feel, what they need, and one concrete request"
  ));
});

// ── The floor under the model ───────────────────────────────
//
// The prompt half of the crisis guardrail was measured at 12/12 on the 8B tier
// and mostly missing on the 3B floor model, which is the tier a default install
// runs. So there is a code half. It is a phrase matcher, and the only thing
// that makes a phrase matcher safe here is the negative set: this runs inside a
// mode where people say "there's no point", "I want to end it" and "I could
// kill him" about chores, arguments and their partners. An over-eager matcher
// is not a smaller version of a good one — the red-team already showed a
// guardrail that fired on 8 of 16 ordinary turns, and a referral that arrives
// during a conversation about dishes teaches people to ignore referrals.
//
// Both lists below are the specification. Removing a negative to make a
// pattern simpler is how this feature breaks.

const CRISIS_POSITIVE = [
  "I've been thinking about ending it all lately.",
  "Sometimes I think about killing myself.",
  "I want to end my life.",
  "I've been having suicidal thoughts.",
  "I don't want to be alive anymore.",
  "i dont want to be alive anymore",
  "Honestly I don't see the point anymore. Sometimes I think everyone would be better off without me.",
  "Everyone would be better off without me, honestly.",
  "I don't really want to be here anymore.",
  "What's the point of any of it. Nobody would even notice if I was gone.",
  "I wish I wasn't here.",
  "I wish I was dead.",
  "Some days I just don't want to wake up.",
  "There's no reason for me to go on.",
  "I'd be better off dead.",
  "I've been thinking about hurting her.",
  "I'm scared I'm going to hurt him for real one day.",
  "I'm afraid he's going to kill me one of these days.",
  "He's threatened to hurt me if I leave.",
];

const CRISIS_NEGATIVE = [
  // the mode's ordinary business
  "She said she'd do the dishes and didn't again. How do I bring it up?",
  "My partner and I keep fighting about chores and it's exhausting.",
  "I'm so angry at my brother right now, he never listens.",
  // "point" — the commonest idiom in a coaching conversation
  "There's no point in arguing with him about this.",
  "I don't see the point of bringing it up again if nothing changes.",
  "There's no point in living together anymore if we can't agree.",
  // ending the relationship, not a life
  "I've been thinking about ending it with him.",
  "I want to end the relationship but I don't know how to say it.",
  "I'm done with this relationship.",
  // violence and death idioms
  "I could kill him for forgetting again.",
  "This commute is killing me.",
  "I'm dying to tell her the news.",
  "I'd rather die than bring this up at Thanksgiving.",
  "He said he'd kill the plan if I brought it up.",
  "I'm going to hurt his feelings if I say it that way.",
  "He threatened to hurt my feelings by telling everyone.",
  // scoped to a thing, not to existing
  "She said the team would be better off without me on the project.",
  "Nobody would even notice if I was gone from the group chat.",
  "I don't want to be here for the argument, I'll come back later.",
  "By the time I got home she was already gone.",
];

test("the crisis matcher catches the phrasings the models missed", () => {
  for (const t of CRISIS_POSITIVE) {
    assert.ok(crisisSignals(t).length > 0, `must catch: ${t}`);
  }
});

test("the crisis matcher stays quiet through ordinary coaching talk", () => {
  // This is the half that decides whether the feature is usable at all.
  const fired = CRISIS_NEGATIVE.filter((t) => crisisSignals(t).length > 0);
  assert.deepEqual(fired, [], `these must not fire: ${JSON.stringify(fired, null, 2)}`);
});

test("an empty or absent message is not a signal", () => {
  for (const empty of ["", "   ", null, undefined, 42, {}]) {
    assert.deepEqual(crisisSignals(empty), []);
  }
});

test("REFUGIO speaks for itself only when the model did not", () => {
  const distress = "Everyone would be better off without me.";
  // Model said nothing useful — the program says it instead.
  assert.equal(crisisNotice(distress, "Feeling: hopeless. Need: belonging."), CRISIS_RESOURCES);
  // Model already pointed at real help — no second referral stapled underneath.
  assert.equal(crisisNotice(distress, "I'm concerned. Please call or text 988."), null);
  assert.equal(crisisNotice(distress, "Contact your local crisis line."), null);
  // No signal at all — silence, whatever the reply looked like.
  assert.equal(crisisNotice("How do I bring up the dishes?", "Try saying..."), null);
});

test("the resources name something a person can actually do", () => {
  assert.match(CRISIS_RESOURCES, /988/);
  assert.match(CRISIS_RESOURCES, /local crisis line or emergency number/);
});

test("the prompt half and the enforced half cover exactly the same modes", () => {
  // A mode carrying the instruction but not the floor would be trusting the
  // tier that was measured not to hold it.
  for (const id of offeredIds()) {
    assert.equal(
      carriesCrisisLayer(id),
      modePreamble(id).includes(CRISIS_LAYER),
      `${id} must either have both halves or neither`
    );
  }
  // Pairing a coaching mode with a connector must not lose it either half.
  assert.equal(carriesCrisisLayer("nvc+whatsapp"), true);
  assert.ok(modePreamble("nvc+whatsapp").includes(CRISIS_LAYER));
  assert.equal(carriesCrisisLayer(null), false);
  assert.equal(carriesCrisisLayer("styles"), false, "an id with no content gets neither");
});

// ── What the window is told ─────────────────────────────────

test("a mode conversation is titled from the registry, never from what was said", () => {
  // maybeTitle() runs a completion over the first message and puts the result
  // in the sidebar. For these conversations that is the whole problem.
  const title = modeTitle("nvc", new Date("2026-08-24T12:00:00Z"));
  assert.ok(title.startsWith(MODES.nvc.titleLabel));
  assert.match(title, /Aug 24/);
  assert.match(modeTitle("styles"), /^Private conversation/, "an unknown id still gets a quiet title");
});

test("the NVC coach declares the tier its guardrail was proven on", () => {
  // Measured, not assumed: the crisis pivot held on qwen2.5:7b in every
  // condition tested and did not hold on the 3B floor model at any wording
  // that was also quiet enough to be usable. The mode says so rather than
  // letting the picker imply every model is equally safe here.
  assert.equal(MODES.nvc.recommendedTier, "8b");
  assert.equal(modeSummaries().find((r) => r.id === "nvc").recommendedTier, "8b");
});

test("the picker rows carry the copy but never the prompt", () => {
  // A prompt pasted into the window invites the reader to treat instructions to
  // the model as a description of what the mode guarantees.
  for (const row of modeSummaries()) {
    assert.ok(row.label && row.hint && row.disclosure, `${row.id} is missing copy`);
    assert.ok(row.starters.length >= 2, `${row.id} needs conversation starters`);
    assert.equal(row.prompt, undefined);
  }
});

test("the standing safety line is single-sourced and names something actionable", () => {
  // Lives by the message box for the life of a coaching conversation instead of
  // being appended to replies. A standing line is read once and trusted; a
  // warning inside an answer about morning television is the cry-wolf failure
  // this project has already paid for twice.
  assert.match(MODES_UI.standing, /988/);
  assert.match(MODES_UI.standing, /local emergency number/);
});

test("the settings copy states the promise, not this build's version of it", () => {
  // The durable guarantees, enforced in code and true whatever ships later.
  assert.match(MODES_UI.privacy, /never searches the web/);
  assert.match(MODES_UI.privacy, /never sends anything on your behalf/);
  assert.match(MODES_UI.privacy, /stays on this computer/);
  // The sentence that used to say "in this build, coaching modes are offered no
  // connectors at all" and promised that when that changed a mode would only
  // ever be paired with connectors that read, and would say which. Session 6
  // made it true, so it is now written as a standing rule rather than as a
  // description of a build — and the two halves it promised are pinned here
  // because they are the whole reason pairing was allowed to happen.
  assert.doesNotMatch(MODES_UI.connectors, /In this build/);
  assert.match(MODES_UI.connectors, /only ever paired with connectors that read/);
  assert.match(MODES_UI.connectors, /It names which ones/);
  assert.match(MODES_UI.connectors, /still cannot send/);
  // Named, not gestured at. "Reads WhatsApp" is unfalsifiable copy; a list of
  // the three things it does is checkable against the allowlist, and there is a
  // test below that checks it.
  assert.match(MODES_UI.connectors, /list your chats, read messages and look up contacts/);
  assert.match(MODES_UI.connectors, /never send, reply or delete/);
  // The one that must never soften: a coaching mode that could send would be a
  // different product, and D4 says send-capable tools are never in its list.
  assert.doesNotMatch(MODES_UI.privacy, /no tools/);
});

// ── The column under it ─────────────────────────────────────

test("a database from before modes existed gains the column and keeps its history", () => {
  // The mode column arrived after people already had ~/.refugio-data/chat.db,
  // and losing someone's chat history to a schema change would be the worst
  // possible way to ship a feature. So: build the old schema by hand, then open
  // it the way a running REFUGIO would.
  const dir = mkdtempSync(join(tmpdir(), "refugio-modes-"));
  const path = join(dir, "chat.db");
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, title TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL);
      INSERT INTO conversations VALUES ('old', 'A chat from before', '2026-01-01', '2026-01-01', 0);
      INSERT INTO messages (conversation_id, role, content, model, created_at)
        VALUES ('old', 'user', 'still here?', NULL, '2026-01-01');
    `);
    old.close();

    store.initStore(path);
    const kept = store.getConversation("old");
    assert.equal(kept.title, "A chat from before");
    assert.equal(kept.messages.length, 1, "the old message survived the migration");
    assert.equal(kept.mode, null, "a conversation from before modes is an ordinary chat");

    // And the new column does its job: written once, read back on every turn.
    assert.equal(store.ensureConversation("fresh", "nvc"), "nvc");
    assert.equal(store.ensureConversation("fresh", "spanish"), "nvc",
      "the mode is fixed at creation — a later turn cannot change it");
    assert.equal(store.ensureConversation("fresh"), "nvc",
      "and a turn that sends no mode still runs in the conversation's mode");
    assert.equal(store.getMode("fresh"), "nvc");
    assert.equal(store.getConversation("fresh").mode, "nvc");
    assert.equal(store.listConversations().find((c) => c.id === "fresh").mode, "nvc");
  } finally {
    store.closeStore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Connector pairing (Session 6) ───────────────────────────
//
// Pairing is the first time a mode is offered anything at all, and it is the
// change that could falsify the sentence the settings pane has always made:
// never sends anything on your behalf, stays on this computer. So the tests
// here are mostly about absence — what is NOT in an allowlist, and what is
// still refused when a model names it anyway. An absence is exactly the kind
// of promise that decays silently, because adding one tool to one list is a
// one-line diff that no other test in this file would notice.

// A pool wide enough that a filter which does nothing would be visible. It
// contains the three tools a paired mode may have, the one from the same
// connector it may never have, and the tools from three other connectors that
// have no business in a coaching conversation at all.
const WIDE_POOL = [
  "whatsapp__list_chats", "whatsapp__list_messages", "whatsapp__search_contacts",
  "whatsapp__send_message", "whatsapp__download_media",
  "memory__memory_save", "notes__notes_create", "notes__notes_search",
  "email__send_message", "reminders__reminders_create_reminder",
].map((name) => ({ type: "function", function: { name } }));

const READ_TOOLS = [
  "whatsapp__list_chats", "whatsapp__list_messages", "whatsapp__search_contacts",
];

const namesOf = (defs) => defs.map((t) => t.function.name);

test("a paired variant is one mode reached a second way, not a second mode", () => {
  // Two registry entries would be two prompts to keep in step, and the safety
  // copy is the half that must never drift.
  assert.equal(pairedId("nvc"), "nvc+whatsapp");
  assert.equal(pairedId("whatsapp"), null, "a mode with no optional connector has no paired id");
  const paired = modeDef("nvc+whatsapp");
  assert.equal(paired.pairedFrom, "nvc");
  assert.equal(paired.requiresConnector, "whatsapp");
  assert.equal(paired.titleLabel, MODES.nvc.titleLabel, "the sidebar says the same quiet thing");
  assert.equal(paired.disclosure, MODES.nvc.disclosure);
  assert.ok(paired.prompt.startsWith(MODES.nvc.prompt), "the coaching prompt is the same one, extended");
});

test("a paired id this build cannot explain is refused like any other unknown", () => {
  // The safe direction for an id nobody can account for is fewer capabilities.
  for (const id of ["nvc+slack", "whatsapp+nvc", "nvc+", "+whatsapp", "nvc+whatsapp+x", "nvc++"]) {
    assert.equal(modeDef(id), null, `${id} must not resolve`);
    assert.equal(validateMode(id, enabledFor("nvc", "whatsapp")).ok, false, `${id} must be refused`);
    assert.deepEqual(modeToolFilter(id, WIDE_POOL), [], `${id} must be offered nothing`);
  }
});

test("one switch governs both ways of holding the conversation", () => {
  assert.equal(enablementId("nvc+whatsapp"), "nvc");
  assert.equal(enablementId("nvc"), "nvc");
  assert.equal(enablementId("whatsapp"), "whatsapp");
  assert.equal(validateMode("nvc+whatsapp", enabledFor("nvc"), ready("whatsapp")).mode, "nvc+whatsapp");
  // And switching NVC off closes both doors, with the message that sends
  // someone to Settings rather than to a bug report.
  const off = validateMode("nvc+whatsapp", { nvc: false }, ready("whatsapp"));
  assert.equal(off.ok, false);
  assert.match(off.error, /NVC Coach is switched off/);
});

test("a mode that needs a connector is refused when the connector is not ready", () => {
  // Not started with an empty tool array: the preamble would still be telling
  // the model it can read this person's messages, and this is a mode whose
  // inventions would be about real people they know.
  for (const id of ["whatsapp", "nvc+whatsapp"]) {
    const r = validateMode(id, enabledFor("nvc", "whatsapp"), ready());
    assert.equal(r.ok, false, `${id} must be refused with no connector`);
    assert.equal(r.needsConnector, "whatsapp", "the caller can say which one");
    assert.match(r.error, /whatsapp/);
    assert.equal(validateMode(id, enabledFor("nvc", "whatsapp"), ready("whatsapp")).mode, id);
  }
  // The unpaired coach is unaffected by any of it, which is why it is declared
  // as an OPTIONAL connector: a coaching mode that stopped existing when
  // WhatsApp fell over would be a worse mode than the one that shipped.
  assert.equal(validateMode("nvc", enabledFor("nvc"), ready()).mode, "nvc");
});

test("a paired mode is offered its three read tools and nothing else in the pool", () => {
  for (const id of ["whatsapp", "nvc+whatsapp"]) {
    assert.deepEqual(namesOf(modeToolFilter(id, WIDE_POOL)), READ_TOOLS, `${id} allowlist`);
  }
});

test("send_message is in the connector and in no mode's allowlist", () => {
  // Hermeneia's minimal profile is five tools and one of them sends. Plan D4:
  // a send-capable tool never enters a mode's allowlist. This is the single
  // assertion standing between that rule and a one-line diff.
  assert.ok(namesOf(WIDE_POOL).includes("whatsapp__send_message"), "the pool must contain it or this proves nothing");
  for (const id of offeredIds()) {
    assert.ok(
      !namesOf(modeToolFilter(id, WIDE_POOL)).includes("whatsapp__send_message"),
      `${id} must never be offered whatsapp__send_message`
    );
    assert.ok(toolRefusal(id, "whatsapp__send_message"), `${id} must refuse it at the point it runs`);
  }
});

test("memory and every write tool are absent from every mode's offered set", () => {
  // Memory is the one that would falsify "the conversation stays on this
  // computer" outright: memory_save persists what was said and its
  // GitHub-backed variant uploads it. Apple Notes' notes_create is the near
  // miss — "save this reframe to my notes" is a genuinely useful thing to want
  // — and it is out for the same reason, decided rather than inherited: it
  // writes conversation content into a store that syncs off this machine by
  // default, and copying the words out by hand does the same job with none of
  // that. Both are checked as an absence from the OFFERED list and again as a
  // refusal at the point that runs, because those are two different mistakes.
  const forbidden = ["memory__memory_save", "notes__notes_create", "email__send_message",
                     "reminders__reminders_create_reminder"];
  for (const id of offeredIds()) {
    const offered = namesOf(modeToolFilter(id, WIDE_POOL));
    for (const name of forbidden) {
      assert.ok(!offered.includes(name), `${id} must not be offered ${name}`);
      assert.ok(toolRefusal(id, name), `${id} must refuse ${name} at execution`);
    }
  }
});

test("every tool any mode may call is a read, by its own name", () => {
  // A cheap check that catches the case the named lists above cannot: a tool
  // nobody thought to enumerate. If a mode ever needs a verb on this list, the
  // test is where the argument for it gets written down.
  const writes = /(send|create|update|delete|trash|save|write|add|move|reply|forward|complete|schedule|share|download)/i;
  for (const id of offeredIds()) {
    for (const name of modeDef(id).tools?.allow ?? []) {
      assert.doesNotMatch(name, writes, `${id} allows ${name}, which reads like a write`);
    }
  }
});

test("a tool inside the allowlist is allowed to run, or the allowlist means nothing", () => {
  // The mirror of every refusal above. Without this, a toolRefusal() that
  // returned a string unconditionally would pass the entire section.
  for (const name of READ_TOOLS) {
    assert.equal(toolRefusal("nvc+whatsapp", name), null, `${name} must run in the paired mode`);
    assert.equal(toolRefusal("whatsapp", name), null, `${name} must run in the data mode`);
    // But not in the unpaired coach, which was offered nothing.
    assert.ok(toolRefusal("nvc", name), `${name} must still be refused in the unpaired coach`);
  }
});

test("the refusal names the mode's limit, not a generic failure", () => {
  const r = toolRefusal("whatsapp", "whatsapp__send_message");
  assert.ok(r.startsWith("Error:"), "the model reads the leading Error: as a failed call");
  assert.ok(r.includes("whatsapp__send_message"), "the refusal names what was refused");
});

test("pairing does not open the web, in either direction", () => {
  // The one capability that leaves this machine stays shut whatever a mode is
  // paired with. Connectors read files on this computer; web search does not.
  for (const id of offeredIds()) {
    assert.equal(webAllowed(id), false, `${id} must never reach the web`);
    assert.equal(armWebSearch({ requested: true, settingEnabled: true, mode: id }), false);
    assert.match(toolRefusal(id, "web__search"), /never available in a discussion mode/);
  }
});

test("the copy in the pane matches the allowlist it describes", () => {
  // The pane promises the WhatsApp modes can "list your chats, read messages
  // and look up contacts — never send, reply or delete". That sentence is only
  // worth anything if it moves when the list does, so it is checked against the
  // list rather than against itself.
  const allowed = MODES.whatsapp.tools.allow;
  assert.deepEqual(allowed, READ_TOOLS);
  assert.match(MODES_UI.connectors, /list your chats/);
  assert.match(MODES_UI.connectors, /read messages/);
  assert.match(MODES_UI.connectors, /look up contacts/);
  assert.equal(allowed.length, 3, "three claims in the sentence, three tools in the list");
});

test("the WhatsApp data mode says what it is and is not, and gets no crisis layer", () => {
  // Not "coaching": Session 3 scoped crisis interception to coaching modes on
  // the grounds that widening it to ordinary chat is a larger product decision
  // than anyone asked for, and a reader for the person's own files is much
  // nearer ordinary chat than it is to sitting with someone in distress.
  assert.equal(MODES.whatsapp.category, "data");
  assert.equal(carriesCrisisLayer("whatsapp"), false);
  assert.ok(!modePreamble("whatsapp").includes(CRISIS_LAYER));
  assert.match(MODES.whatsapp.prompt, /cannot send, reply to, forward or delete anything, and must never offer to/);
  assert.match(MODES.whatsapp.prompt, /never reconstruct what the messages probably said/);
  assert.match(MODES.whatsapp.disclosure, /it cannot send, reply or delete/);
});

test("the paired coach names what it may read and that it still cannot send", () => {
  // The tool array already makes sending impossible. This is the sentence that
  // stops the model OFFERING to — which is the failure a person would actually
  // meet, and the one no allowlist can prevent.
  const p = MODES.nvc.pairing.prompt;
  assert.match(p, /You can read their WhatsApp\./);
  // Named as two calls in order, not as "read the exchange". On qwen2.5:3b the
  // descriptive form produced zero tool calls in six paired turns — the mode's
  // own "Answer in this shape only" is an unconditional format instruction and
  // it beat a competing one, exactly as Session 3 found. Reading is written as
  // a precondition OF that shape rather than as a rival to it.
  assert.match(p, /call list_chats then list_messages/);
  assert.match(p, /BEFORE the shape above/);
  assert.match(p, /You cannot send anything and must never offer to/);
  assert.match(p, /they copy your wording out and send it themselves/);
});

test("a picker row carries the allowlist but still never the prompt", () => {
  const rows = modeSummaries();
  const base = rows.find((r) => r.id === "nvc");
  const paired = rows.find((r) => r.id === "nvc+whatsapp");
  assert.ok(paired, "the paired variant is offered as its own row");
  assert.deepEqual(base.tools, [], "an unpaired coaching mode advertises no tools, because it has none");
  assert.deepEqual(paired.tools, READ_TOOLS, "and the paired one advertises exactly what it may call");
  assert.equal(paired.pairedFrom, "nvc", "so a surface knows which switch governs it");
  assert.equal(base.pairedFrom, null);
  for (const row of rows) assert.equal(row.prompt, undefined);
  // Directly behind its base, because the order a picker shows them in is the
  // server's decision and not a second opinion held in the browser.
  assert.equal(rows.indexOf(paired), rows.indexOf(base) + 1);
});

test("both WhatsApp-paired modes declare the tier their tool calling was measured on", () => {
  // Two different reasons, one label. NVC's 8B is about whether its safety
  // wording holds (Session 3). The data mode's is about whether the model can
  // form a tool call at all: on qwen2.5:3b it passes the parameter schema back
  // as the argument, gets nothing, and reports that the person has no messages
  // with someone they message every week. qwen2.5:7b does not.
  const rows = modeSummaries();
  for (const id of ["whatsapp", "nvc+whatsapp"]) {
    assert.equal(rows.find((r) => r.id === id).recommendedTier, "8b", `${id} must declare its tier`);
  }
});
