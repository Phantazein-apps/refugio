// Apple Notes connector.
//
// The JXA layer needs macOS and a real Notes library, so it cannot be tested
// here. What CAN be tested is everything between the model and that layer:
// how arguments are clamped, how results are turned into something a 3B model
// can read, and — the part that matters most — whether a search that only
// looked at part of the library SAYS so. "No matches" after scanning 400 of
// 2,000 notes is a different fact from "no matches", and a model that cannot
// tell them apart will state the wrong one confidently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool } from "../servers/notes.js";

const NOTE = {
  id: "x-coredata://ABC/ICNote/p123",
  title: "Flat viewing",
  folder: "Home",
  modified: "2026-07-28T09:00:00.000Z",
};

test("title search returns ids the model can then read", async () => {
  const out = await callTool("notes_search", { query: "flat" }, {
    searchTitles: async () => [NOTE],
  });
  assert.match(out, /Flat viewing/);
  assert.match(out, /Home/);
  // The id has to survive verbatim — notes_read takes it back.
  assert.ok(out.includes(NOTE.id), "the id must be in the output");
});

test("title search says plainly when there is nothing", async () => {
  const out = await callTool("notes_search", { query: "zzz" }, { searchTitles: async () => [] });
  assert.match(out, /No note titles contain "zzz"/);
});

test("a search is capped, and the cap cannot be raised by the model", async () => {
  let asked = null;
  await callTool("notes_search", { query: "a", limit: 9999 }, {
    searchTitles: async (_q, limit) => { asked = limit; return []; },
  });
  // MAX_RESULTS is 40 by default. A model asking for 9,999 notes would
  // otherwise spend the whole context window on one tool result.
  assert.equal(asked, 40);
});

test("a missing query is refused rather than searching for nothing", async () => {
  await assert.rejects(() => callTool("notes_search", {}, { searchTitles: async () => [] }),
    /query is required/);
  await assert.rejects(() => callTool("notes_search", { query: "   " }, { searchTitles: async () => [] }),
    /query is required/);
});

test("full-text search admits when it only looked at part of the library", async () => {
  // The important case. Notes has no `whose` clause for body text, so this
  // walks notes and stops at a cap — and a caller told "no matches" would
  // otherwise report that as certainty.
  const out = await callTool("notes_search_text", { query: "landlord" }, {
    searchBodies: async () => ({ notes: [], scanned: 400, truncated: true }),
  });
  assert.match(out, /400 most recent notes/);
  assert.match(out, /notes_search/, "should point at the cheaper tool");
  assert.doesNotMatch(out, /^No notes contain/, "must not claim the library has no match");
});

test("full-text search is unqualified when it saw everything", async () => {
  const out = await callTool("notes_search_text", { query: "landlord" }, {
    searchBodies: async () => ({ notes: [], scanned: 12, truncated: false }),
  });
  assert.match(out, /No notes contain "landlord"/);
  assert.doesNotMatch(out, /most recent/);
});

test("full-text hits carry an excerpt so relevance needs no second call", async () => {
  const out = await callTool("notes_search_text", { query: "deposit" }, {
    searchBodies: async () => ({
      notes: [{ ...NOTE, excerpt: "the deposit is due on the 4th" }],
      scanned: 20, truncated: false,
    }),
  });
  assert.match(out, /deposit is due on the 4th/);
});

test("reading a note that is gone explains why rather than erroring", async () => {
  const out = await callTool("notes_read", { id: "nope" }, { readNote: async () => null });
  assert.match(out, /No note with id nope/);
  assert.match(out, /ids change/, "should say why a stale id fails");
});

test("a truncated note says so", async () => {
  const out = await callTool("notes_read", { id: NOTE.id }, {
    readNote: async () => ({ ...NOTE, body: "long…", truncated: true }),
  });
  assert.match(out, /Truncated at \d+ characters/);
});

test("a whole note does not claim to be truncated", async () => {
  const out = await callTool("notes_read", { id: NOTE.id }, {
    readNote: async () => ({ ...NOTE, body: "short", truncated: false }),
  });
  assert.doesNotMatch(out, /Truncated/);
});

test("create reports where the note went", async () => {
  const out = await callTool("notes_create", { title: "Groceries", body: "milk" }, {
    createNote: async (title, body, folder) => ({ title, folder: folder || "Notes" }),
  });
  assert.match(out, /Created "Groceries" in Notes/);
});

test("create refuses an empty title", async () => {
  await assert.rejects(() => callTool("notes_create", { body: "x" }, { createNote: async () => ({}) }),
    /title is required/);
});

test("an unknown tool is refused, not silently ignored", async () => {
  await assert.rejects(() => callTool("notes_delete", { id: "x" }), /Unknown tool/);
});

test("there is no tool that destroys a note", async () => {
  // Deliberate, and worth asserting: a model misreading "clear my notes about
  // the flat" must not be able to act on it. A note deleted this way has no
  // undo and no copy anywhere.
  for (const name of ["notes_delete", "notes_update", "notes_move", "notes_empty_trash"]) {
    await assert.rejects(() => callTool(name, {}), /Unknown tool/, `${name} must not exist`);
  }
});
