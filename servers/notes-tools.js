// Apple Notes — the model-facing half of the connector.
//
// servers/notes.js owns the other half: the JXA layer that needs macOS and a
// live Notes.app, and the MCP server wiring. What lives here is everything
// between the model and that layer — how arguments are clamped, how query
// results become text a small model can read, and how a partial scan is
// reported as partial. The JXA-backed query functions arrive as an argument
// to callTool() rather than being imported, which is the seam that makes
// this file testable.
//
// Nothing here imports beyond Node builtins, deliberately: CI runs the tests
// on a bare checkout with no `npm ci`, so the modules the tests import must
// not touch @modelcontextprotocol/sdk (see .github/workflows/ci.yml).
//
// ── Read-mostly, deliberately ───────────────────────────────
//
// There is a create tool and there is no delete, no overwrite, no move. A
// model that misreads "clear my notes about the flat" should not be able to
// destroy anything, and a note lost this way has no undo and no copy.

const MAX_RESULTS = parseInt(process.env.REFUGIO_NOTES_MAX || "40", 10);
// Bodies are returned as plain text; a long note would otherwise eat the whole
// context window of a 3B model in one tool result.
const MAX_BODY_CHARS = parseInt(process.env.REFUGIO_NOTES_BODY_CHARS || "6000", 10);

// ── Tools ───────────────────────────────────────────────────
//
// Six. The tool budget is 40 across every connector, and small models get
// worse at choosing as the list grows — so this is the smallest set that can
// answer "what did I write about X", not everything Notes can do.

export const TOOLS = [
  {
    name: "notes_search",
    description:
      "Search Apple Notes by title. Returns matching notes with their id, folder and " +
      "modification date — call notes_read with an id to get the text.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for in note titles." },
        limit: { type: "number", description: `Maximum results (default 20, max ${MAX_RESULTS}).` },
      },
      required: ["query"],
    },
  },
  {
    name: "notes_search_text",
    description:
      "Search the FULL TEXT of Apple Notes, not just titles. Slower than notes_search " +
      "because Notes cannot filter on body text — prefer notes_search when the words " +
      "are likely to be in the title. Returns an excerpt around each match.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for in note bodies." },
        limit: { type: "number", description: `Maximum results (default 10, max ${MAX_RESULTS}).` },
      },
      required: ["query"],
    },
  },
  {
    name: "notes_recent",
    description: "List recently modified Apple Notes, optionally within one folder.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: `How many (default 20, max ${MAX_RESULTS}).` },
        folder: { type: "string", description: "Restrict to this folder name." },
      },
    },
  },
  {
    name: "notes_read",
    description: "Read the full text of one Apple Note, by the id returned from a search.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The note's id." } },
      required: ["id"],
    },
  },
  {
    name: "notes_folders",
    description: "List Apple Notes folders and how many notes each holds.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "notes_create",
    description:
      "Create a new Apple Note. Cannot edit or delete existing notes — this only ever adds.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The note's title." },
        body: { type: "string", description: "The note's text." },
        folder: { type: "string", description: "Folder to create it in (default: the default folder)." },
      },
      required: ["title", "body"],
    },
  },
];

const clamp = (n, fallback) => {
  const v = parseInt(n, 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_RESULTS) : fallback;
};

/**
 * Dispatch one tool call.
 *
 * `queries` supplies the JXA-backed functions (searchTitles, searchBodies,
 * recentNotes, readNote, listFolders, createNote) — servers/notes.js passes
 * the real ones, the tests pass stubs.
 */
export async function callTool(name, args = {}, queries = {}) {
  const q = queries;

  switch (name) {
    case "notes_search": {
      const query = String(args.query || "").trim();
      if (!query) throw new Error("query is required");
      const rows = await q.searchTitles(query, clamp(args.limit, 20));
      if (!rows?.length) return `No note titles contain "${query}".`;
      return rows.map((r) =>
        `${r.title}\n  folder: ${r.folder}  ·  modified: ${(r.modified || "").slice(0, 10)}\n  id: ${r.id}`
      ).join("\n\n");
    }

    case "notes_search_text": {
      const query = String(args.query || "").trim();
      if (!query) throw new Error("query is required");
      const scanCap = parseInt(process.env.REFUGIO_NOTES_SCAN_CAP || "400", 10);
      const res = await q.searchBodies(query, clamp(args.limit, 10), scanCap);
      const rows = res?.notes || [];
      if (!rows.length) {
        // Say what was NOT looked at. "No results" after scanning 400 of 2,000
        // notes is a different fact from "no results", and the model should be
        // able to tell the user which one happened.
        return res?.truncated
          ? `No matches for "${query}" in the ${res.scanned} most recent notes. ` +
            `There are more notes than that — try notes_search on the title instead.`
          : `No notes contain "${query}".`;
      }
      const head = rows.map((r) =>
        `${r.title}\n  …${r.excerpt}…\n  folder: ${r.folder}  ·  id: ${r.id}`
      ).join("\n\n");
      return res.truncated
        ? `${head}\n\n(Searched the ${res.scanned} most recent notes only.)`
        : head;
    }

    case "notes_recent": {
      const rows = await q.recentNotes(clamp(args.limit, 20), args.folder);
      if (!rows?.length) return args.folder ? `No notes in "${args.folder}".` : "No notes found.";
      return rows.map((r) =>
        `${r.title}  ·  ${r.folder}  ·  ${(r.modified || "").slice(0, 10)}\n  id: ${r.id}`
      ).join("\n");
    }

    case "notes_read": {
      const id = String(args.id || "").trim();
      if (!id) throw new Error("id is required");
      const note = await q.readNote(id, MAX_BODY_CHARS);
      if (!note) return `No note with id ${id}. Search again — ids change if a note is moved.`;
      const parts = [
        note.title,
        `folder: ${note.folder}  ·  modified: ${(note.modified || "").slice(0, 10)}`,
        "",
        note.body,
      ];
      if (note.truncated) parts.push(`\n(Truncated at ${MAX_BODY_CHARS} characters.)`);
      return parts.join("\n");
    }

    case "notes_folders": {
      const rows = await q.listFolders();
      if (!rows?.length) return "No folders.";
      return rows.map((f) => `${f.name} — ${f.notes} note${f.notes === 1 ? "" : "s"}`).join("\n");
    }

    case "notes_create": {
      const title = String(args.title || "").trim();
      if (!title) throw new Error("title is required");
      const made = await q.createNote(title, String(args.body ?? ""), args.folder);
      return `Created "${made.title}" in ${made.folder}.`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
