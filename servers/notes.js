#!/usr/bin/env node
// Apple Notes — a stdio MCP server.
//
// ── Why JXA and not the database ────────────────────────────
//
// Notes keeps everything in
//   ~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite
// which is far faster to query than scripting the app. It is also the wrong
// choice here, twice over:
//
//   1. Note bodies are gzipped protobuf blobs in ZICNOTEDATA.ZDATA. Reading
//      them means reimplementing an undocumented format that Apple changes
//      between releases, and getting it subtly wrong means quietly returning
//      truncated notes — the worst failure mode for a tool whose entire job is
//      to report what you wrote.
//   2. That container is TCC-protected. Reading it needs FULL DISK ACCESS,
//      which is a far broader grant than this connector deserves and one the
//      user has to award in System Settings by hand.
//
// JXA asks Notes.app instead. It is slower, and the first call raises the
// standard macOS Automation prompt — the same one Reminders and Things 3
// already raise, so the permission story stays one story. Everything below is
// shaped around making "slower" not matter: filter inside the query, cap
// hard, and never fetch a body until someone asks for that note.
//
// This file owns the JXA layer and the MCP server. The tool definitions and
// everything between the model and the JXA layer — clamping, formatting, the
// dispatch — live in notes-tools.js, which the tests can import without the
// SDK; the query functions below are passed into callTool() as its seam.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "child_process";
import { pathToFileURL } from "url";
import { TOOLS, callTool } from "./notes-tools.js";

// A large Notes library is genuinely slow over Apple Events. These are the
// two things standing between "useful" and "the model gave up waiting".
const OSA_TIMEOUT_MS = parseInt(process.env.REFUGIO_NOTES_TIMEOUT_MS || "20000", 10);

const log = (m) => process.stderr.write(`[notes] ${m}\n`);

/**
 * Run a JXA script and parse its JSON stdout.
 *
 * The script is passed on stdin rather than as an argument: note titles and
 * search terms go INTO these scripts, and building a script by concatenating
 * user text is how you get an injection. Everything variable arrives through
 * `argv` instead — see jxa() below.
 */
function osascript(source, args = []) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "osascript",
      ["-l", "JavaScript", "-", ...args.map(String)],
      { timeout: OSA_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const text = String(stderr || err.message || "");
          // The Automation prompt: the connector is fine, the OS said no. Say
          // which, because "not authorised" sends someone to System Settings
          // and "Notes is not running" does not.
          if (/not allowed|not authori[sz]ed|-1743/i.test(text)) {
            return reject(new Error(
              "macOS has not granted REFUGIO permission to control Notes. " +
              "System Settings → Privacy & Security → Automation → REFUGIO, and enable Notes."));
          }
          if (err.killed) {
            return reject(new Error(
              `Notes did not answer within ${Math.round(OSA_TIMEOUT_MS / 1000)}s. ` +
              "A large library can be slow the first time; try a narrower search."));
          }
          return reject(new Error(text.split("\n")[0] || "osascript failed"));
        }
        try {
          resolve(JSON.parse(stdout || "null"));
        } catch {
          reject(new Error(`Notes returned something unreadable: ${String(stdout).slice(0, 200)}`));
        }
      },
    );
    child.stdin.end(source);
  });
}

/**
 * Wrap a JXA body so its arguments arrive as a real array and its result comes
 * back as JSON.
 *
 * `run(argv)` is JXA's entry point when a script is given arguments, which is
 * what keeps user text out of the source.
 */
const jxa = (body) => `
function run(argv) {
  var Notes = Application('Notes');
  Notes.includeStandardAdditions = true;
  function txt(s) { return s == null ? '' : String(s); }
  function iso(d) { try { return d ? d.toISOString() : null; } catch (e) { return null; } }
  ${body}
}`;

// ── Queries ─────────────────────────────────────────────────
//
// Each returns plain data. The shapes are small on purpose: a tool result is
// read by a model with a few thousand tokens of room, so a note summary is an
// id, a title, a folder and a date — never a body.

/** Notes whose TITLE matches, newest first. Filtering happens inside Notes. */
async function searchTitles(query, limit) {
  return osascript(jxa(`
    var q = argv[0], limit = parseInt(argv[1], 10);
    // whose() filters inside Notes rather than marshalling every note across
    // the Apple Event boundary — the difference between fast and unusable.
    var found = Notes.notes.whose({ name: { _contains: q } });
    var out = [];
    var n = found.length;
    for (var i = 0; i < n && out.length < limit; i++) {
      var note = found[i];
      out.push({
        id: txt(note.id()),
        title: txt(note.name()),
        folder: txt(note.container().name()),
        modified: iso(note.modificationDate()),
      });
    }
    return JSON.stringify(out);
  `), [query, limit]);
}

/**
 * Notes whose BODY matches. There is no `whose` clause for note text, so this
 * walks them — which is why it is a separate tool the user can switch off, and
 * why it stops at a hard cap rather than scanning a whole library.
 */
async function searchBodies(query, limit, scanCap) {
  return osascript(jxa(`
    var q = argv[0].toLowerCase(), limit = parseInt(argv[1], 10), cap = parseInt(argv[2], 10);
    var all = Notes.notes;
    var out = [];
    var n = Math.min(all.length, cap);
    for (var i = 0; i < n && out.length < limit; i++) {
      var note = all[i];
      var text = '';
      try { text = txt(note.plaintext()); } catch (e) { continue; }
      var hit = text.toLowerCase().indexOf(q);
      if (hit < 0) continue;
      out.push({
        id: txt(note.id()),
        title: txt(note.name()),
        folder: txt(note.container().name()),
        modified: iso(note.modificationDate()),
        // The matching line, so the model can judge relevance without a read.
        excerpt: text.substr(Math.max(0, hit - 60), 200).replace(/\\s+/g, ' ').trim(),
      });
    }
    return JSON.stringify({ notes: out, scanned: n, truncated: all.length > cap });
  `), [query, limit, scanCap]);
}

async function recentNotes(limit, folder) {
  return osascript(jxa(`
    var limit = parseInt(argv[0], 10), folder = argv[1] || '';
    var src = folder
      ? Notes.folders.whose({ name: folder })[0].notes
      : Notes.notes;
    var out = [];
    var n = Math.min(src.length, limit);
    for (var i = 0; i < n; i++) {
      var note = src[i];
      out.push({
        id: txt(note.id()),
        title: txt(note.name()),
        folder: txt(note.container().name()),
        modified: iso(note.modificationDate()),
      });
    }
    return JSON.stringify(out);
  `), [limit, folder || ""]);
}

async function readNote(id, maxChars) {
  return osascript(jxa(`
    var id = argv[0], max = parseInt(argv[1], 10);
    var matches = Notes.notes.whose({ id: id });
    if (matches.length === 0) return JSON.stringify(null);
    var note = matches[0];
    var body = txt(note.plaintext());
    return JSON.stringify({
      id: txt(note.id()),
      title: txt(note.name()),
      folder: txt(note.container().name()),
      created: iso(note.creationDate()),
      modified: iso(note.modificationDate()),
      body: body.substr(0, max),
      truncated: body.length > max,
    });
  `), [id, maxChars]);
}

async function listFolders() {
  return osascript(jxa(`
    var out = [];
    var fs = Notes.folders;
    for (var i = 0; i < fs.length; i++) {
      out.push({ name: txt(fs[i].name()), notes: fs[i].notes.length });
    }
    return JSON.stringify(out);
  `));
}

async function createNote(title, body, folder) {
  return osascript(jxa(`
    var title = argv[0], body = argv[1], folderName = argv[2] || '';
    var target = null;
    if (folderName) {
      var f = Notes.folders.whose({ name: folderName });
      if (f.length === 0) throw new Error('No folder named "' + folderName + '"');
      target = f[0];
    } else {
      target = Notes.defaultAccount.defaultFolder();
    }
    // Notes treats the body as HTML and uses its first line as the title, so
    // the title is prepended as a heading rather than passed separately —
    // passing both gives you a note whose title appears twice.
    var esc = function (s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    var html = '<div><h1>' + esc(title) + '</h1></div>' +
      String(body).split('\\n').map(function (line) {
        return '<div>' + esc(line) + '</div>';
      }).join('');
    var note = Notes.Note({ body: html });
    target.notes.push(note);
    return JSON.stringify({ id: txt(note.id()), title: txt(note.name()), folder: txt(target.name()) });
  `), [title, body, folder || ""]);
}

// The queries above, in the shape callTool() expects them.
const QUERIES = { searchTitles, searchBodies, recentNotes, readNote, listFolders, createNote };

// ── Server ──────────────────────────────────────────────────

async function main() {
  if (process.platform !== "darwin") {
    log("Apple Notes is macOS only — exiting.");
    process.exit(1);
  }

  const server = new Server(
    { name: "refugio-notes", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const text = await callTool(name, args || {}, QUERIES);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      // Returned as content, not thrown. A thrown error reaches the model as a
      // protocol failure it cannot reason about; this way "macOS has not
      // granted permission" is something it can pass on to the user.
      log(`${name} failed: ${e.message}`);
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  log("ready");
}

// Only when run directly. Compared as resolved URLs rather than by filename
// suffix — a suffix match calls any script ending in "notes.js" this file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { log(`fatal: ${e.message}`); process.exit(1); });
}
