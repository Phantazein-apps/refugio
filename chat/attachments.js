// File attachments.
//
// The user's framing was "really it just transfers the path to the app, but
// appears to the user to be attached". That is exactly right as a description
// of what should happen, and exactly the one thing a browser will not do: a
// file chosen through <input type="file"> reports its name as
// `C:\fakepath\lease.pdf`, in every browser, with no flag to turn it off. The
// real path is withheld on purpose and there is no way to ask for it.
//
// So the bytes make the trip instead, over loopback, and land in
// ~/.refugio-data/attachments/<id>/<name> — a real path on this machine, which
// is then what travels with the message. The user sees a chip; the model sees
// a filename, a path it could be told to open, and the text if there is any.
//
// Everything here is pure except the disk helpers at the bottom, so the rules
// that actually matter — what gets truncated, what a binary file is allowed to
// claim — can be tested without a filesystem.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from "fs";
import { join } from "path";

/** Refuse the upload above this. Not a storage limit — a "you have chosen the
 *  wrong file" limit. Anything this size is a disk image or a video, and
 *  neither is something a 3B model is going to do anything with. */
export const MAX_BYTES = 25 * 1024 * 1024;

/** Per turn. Five files is already more context than most local models have. */
export const MAX_FILES = 5;

/** How much of one file's text goes into the prompt.
 *
 *  This is the number that decides whether attaching a file helps or ruins the
 *  conversation. The composed message is PERSISTED — it has to be, or a
 *  follow-up question about the file would be answered with the file gone —
 *  which means every subsequent turn carries it too. llama3.2 ships with an 8k
 *  context, and 20k characters is roughly 5k tokens: one large-ish file plus
 *  room to talk about it. Two of them and the conversation starts falling out
 *  of the top, which is why MAX_FILES is small. */
export const MAX_INLINE_CHARS = 20_000;

/** Extension → what to call it in front of a human, and whether we can read it.
 *
 *  The `text` flag is not the whole story — the real test is whether the bytes
 *  decode — but it catches the cases where the bytes WOULD decode and the
 *  result is still meaningless. A .docx is a zip; a .pdf is mostly binary with
 *  legible fragments. Feeding a model those fragments produces confident
 *  nonsense about a document nobody read. */
const KINDS = [
  [/\.(txt|text|log)$/i, "plain text", true],
  [/\.(md|markdown|mdx)$/i, "Markdown", true],
  [/\.(csv|tsv)$/i, "table", true],
  [/\.(json|jsonl|ndjson)$/i, "JSON", true],
  [/\.(ya?ml|toml|ini|cfg|conf|env)$/i, "configuration", true],
  [/\.(html?|xml|svg)$/i, "markup", true],
  [/\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|hpp|cs|swift|sh|bash|zsh|sql|php)$/i, "source code", true],
  [/\.pdf$/i, "PDF", false],
  [/\.(docx?|pages)$/i, "Word document", false],
  [/\.(xlsx?|numbers)$/i, "spreadsheet", false],
  [/\.(pptx?|key)$/i, "presentation", false],
  [/\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i, "image", false],
  [/\.(mp3|wav|m4a|aac|flac|ogg)$/i, "audio", false],
  [/\.(mp4|mov|avi|mkv|webm)$/i, "video", false],
  [/\.(zip|tar|gz|tgz|bz2|7z|rar|dmg|pkg)$/i, "archive", false],
];

/** A human label for the file, and whether its text is worth reading. */
export function kindOf(name) {
  for (const [re, label, readable] of KINDS) {
    if (re.test(name)) return { label, readable };
  }
  return { label: "file", readable: true };   // unknown extension: try to decode
}

/** Make a filename safe to join onto a directory.
 *
 *  The name arrives from the browser and is the only caller-controlled part of
 *  the path. Everything that could climb out of the attachments directory goes:
 *  separators of both kinds, `..`, NULs, control characters, and a leading dot
 *  (which would otherwise hide the file from the user in the very folder we
 *  told them to look in). The extension is preserved through the length cap —
 *  it is what the UI and the model both use to say what the file is. */
export function safeName(raw) {
  let s = String(raw ?? "");
  // Take the last segment under either separator, so a full path collapses to
  // its basename rather than being escaped into one long filename.
  s = s.split(/[\\/]/).pop() || "";
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim();
  if (!s || s === "." || s === "..") return "file";
  if (s.length <= 120) return s;
  const dot = s.lastIndexOf(".");
  const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : "";
  return s.slice(0, 120 - ext.length) + ext;
}

/** Decode the bytes, or say they aren't text.
 *
 *  Strict UTF-8 rather than a heuristic: a lossy decode of a JPEG produces a
 *  page of replacement characters that LOOKS like text to any check based on
 *  ratios, and a model handed that will summarise it. A NUL byte is checked
 *  separately because UTF-16 and many binary formats decode "successfully" as
 *  UTF-8 while being full of them. */
export function decodeText(buf) {
  if (buf.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** Everything the rest of the system needs to know about one uploaded file. */
export function inspect(name, buf) {
  const clean = safeName(name);
  const { label, readable } = kindOf(clean);
  const text = readable ? decodeText(buf) : null;
  const full = text ?? "";
  return {
    name: clean,
    bytes: buf.length,
    kind: label,
    // Three states, not two. "Not text" and "we didn't try because a .docx is
    // a zip" are the same outcome for the model but different explanations,
    // and the UI says which.
    isText: text !== null,
    unreadableKind: !readable,
    chars: full.length,
    truncated: full.length > MAX_INLINE_CHARS,
    text: full.slice(0, MAX_INLINE_CHARS),
  };
}

export function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Build the message the model actually receives.
 *
 *  The typed text comes first, unaltered, because that is the question. The
 *  files follow in a block that is delimited plainly enough for a small model
 *  to tell where a file starts and stops — an 8B model given a wall of text
 *  with no boundary will answer about the wrong file.
 *
 *  The important sentences are the negative ones. A model handed the name
 *  "lease.pdf" and no contents will describe a lease; it is the single most
 *  reliable way to make one hallucinate, because the filename is genuinely
 *  suggestive and nothing contradicts it. So an unreadable file says so, in
 *  the prompt, next to the name, every time. */
export function composeMessage(typed, files) {
  if (!files?.length) return typed;
  const n = files.length;
  // An empty box with a file on it is a real message — "here, look at this".
  // The model needs SOMETHING to act on, so it gets the obvious instruction;
  // the transcript stores the empty text the user actually typed, so the
  // window doesn't quote them saying a sentence they never wrote.
  const parts = [typed.trim() || `Please look at the attached file${n === 1 ? "" : "s"} and tell me what you make of ${n === 1 ? "it" : "them"}.`];
  parts.push(
    `\n---\nThe user attached ${n} file${n === 1 ? "" : "s"} to this message. ` +
    `Each file's real location on this computer is given as its path; you may refer to it.`
  );

  files.forEach((f, i) => {
    const head = `\n--- file ${i + 1} of ${n}: ${f.name} (${f.kind}, ${humanBytes(f.bytes)}) ---\npath: ${f.path}`;
    if (f.isText && f.text) {
      parts.push(
        head + "\n" + f.text +
        (f.truncated
          ? `\n[Cut off here: only the first ${MAX_INLINE_CHARS.toLocaleString("en-US")} characters of ${f.chars.toLocaleString("en-US")} are shown. Say so if the answer might be further in.]`
          : "") +
        `\n--- end of ${f.name} ---`
      );
    } else {
      parts.push(
        head +
        `\nThe contents of this file are NOT available to you — it is ${f.unreadableKind ? `a ${f.kind}` : "not readable as text"}, ` +
        `and REFUGIO cannot read that format. You know its name, its size and where it is saved, and nothing else. ` +
        `Do not describe, summarise or quote what is inside it; if the user asks what it says, tell them you cannot read this file type.` +
        `\n--- end of ${f.name} ---`
      );
    }
  });
  return parts.join("\n");
}

// ── Disk ────────────────────────────────────────────────────

export const dirFor = (root, id) => join(root, "attachments", id);

/** Write one upload and its sidecar. The sidecar is what makes an attachment
 *  survive a server restart between choosing the file and pressing send —
 *  without it the id would resolve to nothing and the file would silently
 *  drop off a message the user watched it attach to. */
export function save(root, id, name, buf) {
  const meta = inspect(name, buf);
  const dir = dirFor(root, id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, meta.name);
  writeFileSync(path, buf);
  const record = { id, path, savedAt: new Date().toISOString(), ...meta };
  // The text is re-read from the file when it is needed; keeping a second copy
  // in JSON would double the disk cost of every attachment for nothing.
  const { text, ...withoutText } = record;
  writeFileSync(join(dir, "meta.json"), JSON.stringify(withoutText, null, 2));
  return record;
}

/** Resolve an id back to its record, re-reading the text from disk.
 *
 *  `id` is matched against a strict pattern before it touches the filesystem:
 *  it is caller-supplied, and joining it onto a directory is the one place a
 *  `../` would matter. */
export function load(root, id) {
  if (!/^[a-f0-9]{8,64}$/i.test(String(id || ""))) return null;
  const dir = dirFor(root, id);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) return null;
  let meta;
  try { meta = JSON.parse(readFileSync(metaPath, "utf-8")); } catch { return null; }
  if (!existsSync(meta.path)) return null;
  let text = "";
  if (meta.isText) {
    try { text = decodeText(readFileSync(meta.path))?.slice(0, MAX_INLINE_CHARS) ?? ""; } catch { text = ""; }
  }
  return { ...meta, text };
}

export function remove(root, id) {
  if (!/^[a-f0-9]{8,64}$/i.test(String(id || ""))) return false;
  const dir = dirFor(root, id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Total size and count, for the page that offers to delete it all. */
export function stats(root) {
  const base = join(root, "attachments");
  let files = 0, bytes = 0;
  if (!existsSync(base)) return { files, bytes };
  for (const id of readdirSync(base)) {
    const dir = join(base, id);
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (e === "meta.json") continue;
      try { bytes += statSync(join(dir, e)).size; files++; } catch { /* vanished */ }
    }
  }
  return { files, bytes };
}

/** Delete uploads no message refers to.
 *
 *  An attachment is chosen before it is sent, so between those two moments it
 *  belongs to nothing. Close the window in that gap — or type the question and
 *  give up — and REFUGIO is left holding a copy of a document with no way to
 *  reach it and no reason to keep it.
 *
 *  The age check is what keeps this from deleting an attachment that is
 *  waiting to be sent RIGHT NOW, in another window, by a user who is still
 *  typing. Anything younger than the grace period is left alone regardless. */
export function pruneOrphans(root, referenced, { olderThanMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const base = join(root, "attachments");
  if (!existsSync(base)) return 0;
  let removed = 0;
  for (const id of readdirSync(base)) {
    if (referenced.has(id)) continue;
    const dir = join(base, id);
    let age;
    try { age = now - statSync(dir).mtimeMs; } catch { continue; }
    if (age < olderThanMs) continue;
    rmSync(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** Delete every attachment. Called by the reset that deletes conversations:
 *  once the messages are gone these are files nobody can reach from the UI,
 *  and a "delete everything" that left the user's documents sitting in an
 *  application directory would be the wrong kind of surprise. */
export function removeAll(root) {
  const base = join(root, "attachments");
  const { files } = stats(root);
  rmSync(base, { recursive: true, force: true });
  return files;
}
