// Which product this process is — REFUGIO, or REFUGIO Listener.
//
// The table itself lives in ../editions.cjs, because the installer and the
// supervisor are CommonJS and this is the one format all three can read. This
// module is the ESM view of it plus the one thing the table cannot know: which
// edition the process that imported it is running as.
//
// Resolution order, and each step is answering a different question:
//
//   1. REFUGIO_EDITION in the environment — an explicit override, and how the
//      supervisor tells the chat server what it started.
//   2. The .refugio-edition marker beside the code — what this INSTALL is.
//      Written once by the installer. This is the reliable one: a server
//      started by hand, by npm, or by a login item that lost its environment
//      still gets the right answer.
//   3. standard — every install that predates the split, and every checkout
//      nobody has told anything.
//
// The consequence of getting this wrong is not cosmetic, which is why there
// are three sources and not one: the edition decides which discussion modes
// are offered, and a coaching mode offered by a standard install is the
// product separation failing in the direction that matters.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { EDITIONS, DEFAULT_EDITION, MARKER_FILE, editionFor, isEdition } = require("../editions.cjs");

export { EDITIONS, DEFAULT_EDITION, MARKER_FILE, editionFor, isEdition };

/** Every edition id, in table order. */
export const EDITION_IDS = Object.keys(EDITIONS);

const HERE = dirname(fileURLToPath(import.meta.url));

/** The marker file's contents, or null. Never throws: a missing marker is the
 *  overwhelmingly common case (every checkout, every pre-split install) and
 *  must cost nothing. */
export function readMarker(root = join(HERE, "..")) {
  try {
    const id = readFileSync(join(root, MARKER_FILE), "utf-8").trim();
    return id || null;
  } catch { return null; }
}

/**
 * Resolve the running edition's id, applying the order documented above.
 *
 * Exported with its inputs as parameters so the tests can ask what a given
 * environment resolves to without setting one.
 */
export function resolveEdition({ env = process.env, marker = readMarker() } = {}) {
  const asked = (env.REFUGIO_EDITION || "").trim();
  if (asked) return isEdition(asked) ? asked : DEFAULT_EDITION;
  if (marker && isEdition(marker)) return marker;
  return DEFAULT_EDITION;
}

/** This process's edition id, resolved once at import. */
export const EDITION = resolveEdition();

/** This process's edition row. */
export const PRODUCT = editionFor(EDITION);

/**
 * Does this edition offer modes of that category?
 *
 * The whole of the product split, in one predicate. Callers ask it about a
 * mode's category rather than about a mode id, because the registry already
 * decides what kind of thing a mode is and an edition should not carry a
 * second list that has to be edited every time a mode is added.
 */
export function editionOffersCategory(category, edition = EDITION) {
  return editionFor(edition).modeCategories.includes(category);
}
