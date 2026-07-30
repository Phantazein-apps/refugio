// Chat persistence — conversations and messages in SQLite.
//
// Uses node:sqlite (built into Node 22.5+), so there is no native module to
// compile and nothing to install. That matters: the whole point of serving the
// UI from Node is to delete the fragile parts of the install, so adding
// better-sqlite3 (a native build) would undo it.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

let db;

export function initStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);

  // WAL keeps reads from blocking on the write of a streaming turn.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      title       TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      pinned      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL
                        REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,          -- 'user' | 'assistant'
      content         TEXT NOT NULL,
      model           TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_convo
      ON messages(conversation_id, id);
  `);

  // Added after the first release, so ALTER rather than a column in the CREATE
  // above — an existing ~/.refugio-data/chat.db must keep working across an
  // update, and losing someone's chat history to a schema change would be the
  // worst possible way to ship a feature.
  //
  // Two columns, because a message with a file on it has two texts that are
  // both true. `content` is what the model was sent — the question plus the
  // file's contents — and it has to stay that way or a follow-up question
  // about the file would be answered with the file gone from history.
  // `display_content` is what the person typed, which is what belongs in the
  // scrollback; showing them 20,000 characters of their own CSV back is not a
  // transcript of the conversation they had.
  addColumn("messages", "display_content", "TEXT");
  addColumn("messages", "attachments", "TEXT");

  return db;
}

/** Add a column if this database predates it. SQLite has no IF NOT EXISTS for
 *  ALTER TABLE, and catching the error would also swallow real ones. */
function addColumn(table, name, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

const now = () => new Date().toISOString();

const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export function ensureConversation(id) {
  const existing = db.prepare("SELECT id FROM conversations WHERE id = ?").get(id);
  if (existing) return;
  const t = now();
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, NULL, ?, ?)"
  ).run(id, t, t);
}

export function addMessage(conversationId, role, content, model = null, extra = {}) {
  // Both null on an ordinary message, which is nearly all of them — the two
  // columns cost a message with no attachments nothing.
  const display = extra.display != null && extra.display !== content ? extra.display : null;
  const files = extra.attachments?.length ? JSON.stringify(extra.attachments) : null;
  db.prepare(
    `INSERT INTO messages (conversation_id, role, content, model, created_at, display_content, attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(conversationId, role, content, model, now(), display, files);
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
    .run(now(), conversationId);
}

/** Messages in the shape Ollama's /api/chat expects. */
export function historyFor(conversationId) {
  return db.prepare(
    "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id"
  ).all(conversationId).map((r) => ({ role: r.role, content: r.content }));
}

export function listConversations(limit = 200) {
  return db.prepare(
    `SELECT id, title, created_at, updated_at, pinned
     FROM conversations
     ORDER BY pinned DESC, updated_at DESC
     LIMIT ?`
  ).all(limit).map((r) => ({ ...r, pinned: !!r.pinned }));
}

export function getConversation(id) {
  const convo = db.prepare(
    "SELECT id, title, created_at, updated_at, pinned FROM conversations WHERE id = ?"
  ).get(id);
  if (!convo) return null;
  const messages = db.prepare(
    `SELECT id, role, content, model, created_at, display_content, attachments
     FROM messages WHERE conversation_id = ? ORDER BY id`
  ).all(id).map((m) => ({
    id: m.id,
    role: m.role,
    // The transcript shows what was typed. `content` — question plus inlined
    // file — is the model's copy and stays out of the window.
    content: m.display_content ?? m.content,
    model: m.model,
    created_at: m.created_at,
    attachments: parseJson(m.attachments) ?? [],
  }));
  return { ...convo, pinned: !!convo.pinned, messages };
}

export function deleteConversation(id) {
  const info = db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  return info.changes > 0;
}

/** Delete every conversation, returning what was destroyed.
 *
 *  The count is read BEFORE the delete and returned, because the settings page
 *  has to say what it is about to do ("delete 41 conversations") and then
 *  confirm what it did. An unconfirmed wipe of the only copy of someone's chat
 *  history is not a thing to be casual about — nothing here is synced anywhere,
 *  so this is genuinely the last copy.
 *
 *  Pinned conversations are included. A pin marks importance, not immunity, and
 *  a "delete everything" that quietly kept some of it would be the worse
 *  surprise of the two. */
export function deleteAllConversations() {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM conversations").get();
  // messages cascade via the foreign key declared on conversation_id.
  db.prepare("DELETE FROM conversations").run();
  return n;
}

/** Every attachment id any message still refers to.
 *
 *  Used to sweep uploads that were chosen and then abandoned — the window was
 *  closed between picking a file and pressing send. Those are copies of the
 *  user's own documents that nothing can ever reach again, and without this
 *  they would sit in the data directory forever. */
export function referencedAttachmentIds() {
  const ids = new Set();
  for (const r of db.prepare("SELECT attachments FROM messages WHERE attachments IS NOT NULL").all()) {
    for (const f of parseJson(r.attachments) ?? []) if (f?.id) ids.add(f.id);
  }
  return ids;
}

/** How much history exists, for a settings page that must not guess. */
export function historyStats() {
  const { conversations } = db.prepare("SELECT COUNT(*) AS conversations FROM conversations").get();
  const { messages } = db.prepare("SELECT COUNT(*) AS messages FROM messages").get();
  const { oldest } = db.prepare("SELECT MIN(created_at) AS oldest FROM conversations").get();
  return { conversations, messages, oldest: oldest || null };
}

export function setPinned(id, pinned) {
  db.prepare("UPDATE conversations SET pinned = ? WHERE id = ?")
    .run(pinned ? 1 : 0, id);
}

export function setTitle(id, title) {
  db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
}

export function getTitle(id) {
  return db.prepare("SELECT title FROM conversations WHERE id = ?").get(id)?.title ?? null;
}

/** Drop the last assistant turn (regenerate), or the last user turn and
 *  everything after it (edit). Returns how many rows went. */
export function truncateFrom(conversationId, { lastAssistant = false } = {}) {
  const rows = db.prepare(
    "SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY id DESC"
  ).all(conversationId);
  if (!rows.length) return 0;

  let cutoff = null;
  if (lastAssistant) {
    const last = rows.find((r) => r.role === "assistant");
    if (last) cutoff = last.id;
  } else {
    const lastUser = rows.find((r) => r.role === "user");
    if (lastUser) cutoff = lastUser.id;
  }
  if (cutoff === null) return 0;

  const info = db.prepare(
    "DELETE FROM messages WHERE conversation_id = ? AND id >= ?"
  ).run(conversationId, cutoff);
  return info.changes;
}

export function closeStore() {
  try { db?.close(); } catch {}
}
