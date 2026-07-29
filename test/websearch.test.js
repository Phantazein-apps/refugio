// Web search — the one feature that leaves the machine.
//
// Two things are worth pinning down here. The first is the promise: off by
// default, and never reachable by the model on a turn the user didn't arm. The
// second is the scraper, which is the part that breaks silently — DuckDuckGo
// changes their markup, results quietly become zero, and nothing says so.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WEB_TOOL, WEB_DEFAULTS, WEB_SEARCH_UI, parseResults, formatResults, webSearch,
} from "../chat/websearch.js";

test("web search is off until switched on", () => {
  assert.equal(WEB_DEFAULTS.enabled, false);
});

test("the tool is namespaced like every other, and asks for a query", () => {
  // The UI splits `server__tool` to label chips and to decide which preamble
  // sentence to write; a bare name would land in the wrong half of both.
  assert.match(WEB_TOOL.function.name, /^web__/);
  assert.deepEqual(WEB_TOOL.function.parameters.required, ["query"]);
});

test("the warning names what is sent", () => {
  // Shown on every armed message. If it stops mentioning the engine it stops
  // being a warning and becomes decoration.
  assert.ok(WEB_SEARCH_UI.warning.includes(WEB_SEARCH_UI.engine));
});

// A real page, captured verbatim. Written from a guess, this parser found
// nothing at all on the live site three times over — wrong attribute order,
// wrong quote style, and a distance between results larger than the window it
// allowed. Each of those looked exactly like "no results", so the fixture is a
// real capture rather than markup invented to match the code.
const REAL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ddg-lite.html"), "utf-8");

test("parses the page DuckDuckGo actually serves", () => {
  const r = parseResults(REAL);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, "2024 Tour de France - Wikipedia");
  assert.equal(r[0].url, "https://en.wikipedia.org/wiki/2024_Tour_de_France");
  assert.match(r[0].snippet, /^The 111th edition of the Tour de France started/);
  assert.doesNotMatch(r[0].snippet, /<b>/, "markup must be stripped from snippets");
  assert.ok(r[1].url.startsWith("https://www.letour.fr/"));
});

const PAGE = `
<table>
<tr><td><a rel="nofollow" href="https://example.com/one" class="result-link">First &amp; best</a></td></tr>
<tr><td class="result-snippet">A snippet with <b>markup</b> in it.</td></tr>
<tr><td><a href="https://example.org/two" class="result-link">Second</a></td></tr>
<tr><td class="result-snippet">Another snippet.</td></tr>
</table>`;

test("results are parsed out of the lite page", () => {
  const r = parseResults(PAGE);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, "First & best");     // entities decoded
  assert.equal(r[0].url, "https://example.com/one");
  assert.equal(r[0].snippet, "A snippet with markup in it.");   // tags stripped
  assert.equal(r[1].url, "https://example.org/two");
});

test("non-http links are dropped", () => {
  // A result URL is put in front of the model and then, often, in front of the
  // user as a link. `javascript:` must never survive that trip.
  const r = parseResults(
    `<a href="javascript:alert(1)" class="result-link">Bad</a>
     <a href="https://ok.example" class="result-link">Good</a>`);
  assert.deepEqual(r.map((x) => x.url), ["https://ok.example"]);
});

test("max is respected", () => {
  assert.equal(parseResults(PAGE, 1).length, 1);
});

test("a layout change reads as no results, not a crash", () => {
  assert.deepEqual(parseResults("<html>nothing familiar here</html>"), []);
});

test("failures come back as text the model can act on", () => {
  // Never an exception: a broken search must cost the answer nothing more than
  // the search itself.
  assert.match(formatResults("q", { results: [], error: "timed out" }), /failed: timed out/);
  assert.match(formatResults("q", { results: [], error: null }), /no results/);
  const out = formatResults("q", { results: [{ title: "T", url: "https://u", snippet: "S" }] });
  assert.match(out, /1\. T/);
  assert.match(out, /https:\/\/u/);
});

test("an empty query never reaches the network", async () => {
  // Guards the case where a model calls the tool with nothing in it — there is
  // no reason to send a blank request to a search engine.
  assert.deepEqual(await webSearch("   "), { results: [], error: "empty query" });
});
