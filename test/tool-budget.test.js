// What tool results may take of a turn's context.
//
// The case this exists for, measured on 2026-09-18 and written up in
// docs/gaps.md §12: three memory searches of ~5,250 characters each put
// muse-glimmer:30b's round-two prompt at 3,775 tokens against Ollama's
// 4,096-token default. It generated the 321 tokens that were left and stopped
// at done=length with no answer. The models that passed the same tasks did so
// by searching once.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyBudget, toolResultBudget, DEFAULT_TOOL_RESULT_BUDGET, MIN_USEFUL_CHARS,
} from "../chat/tool-budget.js";

test("a result inside the budget is handed over whole and untouched", () => {
  const r = applyBudget("a stored note", 8000);
  assert.deepEqual(r, { content: "a stored note", kept: "a stored note".length, truncated: false });
});

test("a result that overruns keeps its start, and says what was cut", () => {
  const text = "x".repeat(5000);
  const r = applyBudget(text, 2000);
  assert.equal(r.kept, 2000);
  assert.equal(r.truncated, true);
  assert.ok(r.content.startsWith("x".repeat(2000)));
  // Said in the tool message itself: a result quietly shortened is worse than
  // one refused, because the model answers confidently from half a note.
  assert.match(r.content, /kept the first 2000 of 5000 characters/);
  assert.match(r.content, /ask for something narrower/i);
});

test("a scrap of a note is refused rather than handed over as if it were one", () => {
  const text = "y".repeat(5000);
  const r = applyBudget(text, MIN_USEFUL_CHARS - 1);
  assert.equal(r.kept, 0);
  assert.equal(r.truncated, true);
  assert.doesNotMatch(r.content, /yyy/);
  assert.match(r.content, /dropped this result \(5000 characters\)/);
  assert.match(r.content, /answer from what you already have/i);
});

test("no budget means what REFUGIO did before: the whole result, every time", () => {
  const text = "z".repeat(50000);
  const r = applyBudget(text, Infinity);
  assert.equal(r.content, text);
  assert.equal(r.kept, 50000);
  assert.equal(r.truncated, false);
});

test("the measured case: three searches now leave room to answer", () => {
  // The exact shape of the 2026-09-18 run — three memory searches, ~5,250
  // characters each — against the default budget.
  const search = "n".repeat(5250);
  let spent = 0;
  const rounds = [];
  for (let i = 0; i < 3; i++) {
    const r = applyBudget(search, Math.max(0, DEFAULT_TOOL_RESULT_BUDGET - spent));
    spent += r.kept;
    rounds.push(r);
  }
  // First whole, second truncated at the boundary, third refused outright.
  assert.deepEqual(rounds.map((r) => r.truncated), [false, true, true]);
  assert.equal(rounds[0].kept, 5250);
  assert.equal(rounds[1].kept, DEFAULT_TOOL_RESULT_BUDGET - 5250);
  assert.equal(rounds[2].kept, 0);
  assert.equal(spent, DEFAULT_TOOL_RESULT_BUDGET);
  // 15,750 characters of tool results before; 8,000 now, and the model is told
  // about the rest instead of silently losing it.
  assert.ok(spent < search.length * 3);
});

test("the budget is read from the environment, and nonsense does not disable it", () => {
  assert.equal(toolResultBudget({}), DEFAULT_TOOL_RESULT_BUDGET);
  assert.equal(toolResultBudget({ REFUGIO_TOOL_RESULT_BUDGET: "" }), DEFAULT_TOOL_RESULT_BUDGET);
  assert.equal(toolResultBudget({ REFUGIO_TOOL_RESULT_BUDGET: "12000" }), 12000);
  // 0 is a real choice — the old behaviour — and must survive.
  assert.equal(toolResultBudget({ REFUGIO_TOOL_RESULT_BUDGET: "0" }), 0);
  // These are mistakes, and a mistake must not quietly remove the rail.
  for (const bad of ["lots", "-1", "NaN", "8k"]) {
    assert.equal(toolResultBudget({ REFUGIO_TOOL_RESULT_BUDGET: bad }), DEFAULT_TOOL_RESULT_BUDGET, bad);
  }
});

test("a tool that returns nothing costs nothing", () => {
  for (const empty of ["", null, undefined]) {
    const r = applyBudget(empty, 100);
    assert.equal(r.kept, 0);
    assert.equal(r.truncated, false);
    assert.equal(r.content, "");
  }
});
