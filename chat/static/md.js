// Markdown rendering, ported from SHERPA's chat-v2.js (_renderMd family).
//
// Same block grammar — tables, headings, ordered/unordered lists, paragraphs
// with soft line breaks — so an answer formats here the way it does there.
//
// Two deliberate departures, both because of who is writing the text. SHERPA
// renders output from a hosted model over a trusted API; REFUGIO renders output
// from whatever model the user happens to be running locally, plus tool results
// containing other people's WhatsApp messages. That is untrusted input:
//
//   1. Link URLs are restricted to http(s). The upstream regex accepts any
//      scheme, which would let `[click](javascript:...)` become a live link.
//   2. Fenced code blocks are handled here rather than left to the paragraph
//      path, so a message containing ``` cannot leak markup out of its block.
//
// Everything is escaped first and markup re-introduced afterwards, so nothing
// a model emits can become live HTML.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Inline markup, applied to ALREADY-escaped text. */
function inline(s) {
  return s
    // Links: http(s) only. Never javascript:, data:, or a bare path that could
    // be read as a scheme.
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
             '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

const tableCells = (line) =>
  line.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim());
const isTableSep = (line) =>
  /^\s*\|?\s*:?-{3,}:?(\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/.test(line);
const isTableRow = (line) => /\|/.test(line) && !isTableSep(line);

/**
 * Render markdown to HTML.
 *
 * `text` is untrusted. Every path escapes before adding markup.
 */
export function renderMarkdown(text) {
  const src = String(text ?? "");
  const out = [];

  // Fenced code first: split on ``` so an unterminated fence swallows the rest
  // as code rather than spilling half-parsed markup into the page.
  const chunks = src.split(/```/);
  chunks.forEach((chunk, i) => {
    if (i % 2 === 1) {
      const body = chunk.replace(/^[a-zA-Z0-9_+-]*\n/, "");
      out.push(
        `<pre><button class="copy" title="Copy">copy</button><code>${esc(body)}</code></pre>`
      );
    } else {
      out.push(renderBlocks(chunk));
    }
  });
  return out.join("");
}

function renderBlocks(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;
  let listKind = null;
  let para = [];

  const closeList = () => { if (listKind) { out.push(`</${listKind}>`); listKind = null; } };
  const flushPara = () => {
    if (!para.length) return;
    // Soft line breaks inside a paragraph become <br>, matching SHERPA — a
    // model that wraps a sentence mid-thought shouldn't lose the break.
    out.push(`<p>${para.map((l) => inline(esc(l))).join("<br>")}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const ln = lines[i];

    // Table: a row followed by a separator row.
    if (isTableRow(ln) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara(); closeList();
      const header = tableCells(ln);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) { rows.push(tableCells(lines[i])); i++; }
      let html = "<div class=\"table-wrap\"><table><thead><tr>";
      for (const c of header) html += `<th>${inline(esc(c))}</th>`;
      html += "</tr></thead><tbody>";
      for (const cells of rows) {
        html += "<tr>";
        for (const c of cells) html += `<td>${inline(esc(c))}</td>`;
        html += "</tr>";
      }
      out.push(html + "</tbody></table></div>");
      continue;
    }

    const h = ln.match(/^\s*(#{1,4})\s+(.+?)\s*$/);
    if (h) {
      flushPara(); closeList();
      // h1/h2 are oversized inside a chat bubble, so the ramp starts lower.
      const lvl = Math.min(h[1].length + 2, 6);
      out.push(`<h${lvl}>${inline(esc(h[2]))}</h${lvl}>`);
      i++; continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(ln)) {
      flushPara(); closeList(); out.push("<hr>"); i++; continue;
    }

    const b = ln.match(/^\s*[-*+]\s+(.+)/);
    if (b) {
      flushPara();
      if (listKind !== "ul") { closeList(); out.push("<ul>"); listKind = "ul"; }
      out.push(`<li>${inline(esc(b[1]))}</li>`);
      i++; continue;
    }

    const n = ln.match(/^\s*\d+[.)]\s+(.+)/);
    if (n) {
      flushPara();
      if (listKind !== "ol") { closeList(); out.push("<ol>"); listKind = "ol"; }
      out.push(`<li>${inline(esc(n[1]))}</li>`);
      i++; continue;
    }

    if (/^\s*$/.test(ln)) { flushPara(); closeList(); i++; continue; }

    para.push(ln); i++;
  }

  flushPara(); closeList();
  return out.join("");
}
