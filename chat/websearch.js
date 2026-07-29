// Web search — the one thing REFUGIO does that leaves your computer.
//
// Everything else here is local by construction: the model runs on your
// machine, the connectors read your own data, nothing is sent anywhere. A web
// search cannot work that way — the query goes to a search engine, and that
// engine sees it. So this is built to be the exception rather than a feature
// that quietly erodes the promise:
//
//   - Off by default. It has to be switched on in the connectors panel.
//   - Even switched on, it is armed per message. It never carries over to the
//     next turn, so a search is always a thing the user just chose to do.
//   - The model is only offered the tool on a turn that was armed, so it
//     cannot decide on its own to reach the internet.
//
// DuckDuckGo's lite endpoint is used because it needs no account and no API
// key — an API key would mean an extra signup for the one feature people are
// most likely to leave off. It is HTML scraping and will break when they
// change their markup; a failure returns "no results" rather than an
// exception, so a broken parser costs the answer nothing else.

const ENDPOINT = "https://lite.duckduckgo.com/lite/";
const ENGINE = "DuckDuckGo";
const UA = "Mozilla/5.0 (compatible; REFUGIO/2.0; +https://github.com/Phantazein-apps/refugio)";

const log = (m) => console.log(`[chat:web] ${m}`);

/**
 * The stored setting, and the words shown next to it.
 *
 * Kept here rather than in connector-options.js because it is not a connector
 * option: those all narrow what a working connector may read, and every one of
 * them declares a mechanism (force / enumAdd / filter) that makes the narrowing
 * real. This is the opposite kind of switch — it widens REFUGIO's reach past
 * the machine — so it gets its own setting, its own route and its own section
 * in the panel instead of sitting in a list of scope checkboxes.
 */
export const WEB_DEFAULTS = { enabled: false };
export const WEB_SEARCH_UI = {
  label: "Allow web search",
  hint:
    `Off by default. When on, you still have to switch it on for each message ` +
    `— it never carries over to the next one.`,
  warning:
    `Your search words are sent to ${ENGINE}. Nothing else — not your messages, ` +
    `not your files, not the rest of the conversation — leaves this computer.`,
  engine: ENGINE,
};

/** The tool definition handed to the model, in Ollama's shape. */
export const WEB_TOOL = {
  type: "function",
  function: {
    name: "web__search",
    description:
      "Search the public web and return titles, links and snippets. Use for " +
      "current events, facts you are unsure of, or anything outside the user's " +
      "own data. Returns at most a handful of results.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
      },
      required: ["query"],
    },
  },
};

const stripTags = (s) => s.replace(/<[^>]*>/g, "");
const unescapeHtml = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ");
const clean = (s) => unescapeHtml(stripTags(s)).replace(/\s+/g, " ").trim();

/**
 * Run a search. Never throws — a failure is a result the model can work with
 * ("nothing came back"), not a reason to abandon the user's turn.
 *
 * Returns { results: [{ title, url, snippet }], error }.
 */
export async function webSearch(query, { max = 5, timeoutMs = 12000 } = {}) {
  const q = String(query || "").trim();
  if (!q) return { results: [], error: "empty query" };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let html;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
      },
      body: new URLSearchParams({ q }).toString(),
    });
    if (!res.ok) return { results: [], error: `search returned ${res.status}` };
    html = await res.text();
  } catch (e) {
    return { results: [], error: e.name === "AbortError" ? "search timed out" : e.message };
  } finally {
    clearTimeout(timer);
  }

  const results = parseResults(html, max);
  if (!results.length) {
    log(`no results parsed for "${q.slice(0, 60)}" — the page layout may have changed`);
  }
  return { results, error: null };
}

/**
 * Pull results out of the lite page's HTML.
 *
 * Exported so it can be tested against a saved page: this is the part that
 * breaks silently when DuckDuckGo changes their markup, and a scraper with no
 * test is a feature that stops working without telling anyone.
 */
export function parseResults(html, max = 5) {
  // The lite page is a table: a link row, then a snippet row, then some
  // trailing rows. Rather than trying to match that structure — which is what
  // changes when they redesign — cut the page at each result link and read
  // whatever belongs to that result out of its own slice.
  //
  // Neither attribute ORDER nor QUOTE STYLE is assumed, because the live page
  // matches neither obvious guess: it serves
  // `<a rel="nofollow" href="…" class='result-link'>` — double quotes on href,
  // single on class, class last. Nor is the DISTANCE between two results
  // bounded; an earlier version allowed 800 characters between them and found
  // nothing on a page where the gap is over a thousand. All three of those
  // failures look identical from outside: a search that found nothing.
  const CLASS = (name) => `class\\s*=\\s*["'][^"']*\\b${name}\\b[^"']*["']`;
  const LINK = `<a\\b[^>]*${CLASS("result-link")}`;
  const snippetRe = new RegExp(`${CLASS("result-snippet")}[^>]*>([\\s\\S]*?)<\\/td>`, "i");

  const results = [];
  // slice(1): everything before the first result link is the page header.
  const blocks = String(html ?? "").split(new RegExp(`(?=${LINK})`, "i")).slice(1);
  for (const block of blocks) {
    if (results.length >= max) break;
    const anchor = /^<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(block);
    if (!anchor) continue;
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(anchor[1])?.[1];
    if (!href) continue;
    const url = unescapeHtml(href);
    if (!/^https?:\/\//i.test(url)) continue;      // never surface non-http links
    const title = clean(anchor[2]);
    if (!title) continue;
    const rest = block.slice(anchor[0].length);
    const snippet = clean(rest.match(snippetRe)?.[1] ?? "").slice(0, 400);
    results.push({ title, url, snippet });
  }
  return results;
}

/** Format results for the model: compact, numbered, with the link on each. */
export function formatResults(query, { results, error }) {
  if (error) return `Web search for "${query}" failed: ${error}`;
  if (!results.length) return `Web search for "${query}" returned no results.`;
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join("\n\n");
}
