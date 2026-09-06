// The two products this repository builds, and everything that differs
// between them.
//
// REFUGIO and REFUGIO Listener are one codebase and two installs. They are not
// two configurations of one install: they take different directories, a
// different port, a different login item, a different application name and a
// different credentials file, so that a person who has one of them has one
// product with nothing of the other showing anywhere.
//
// Why a table rather than a flag read at each site: an edition is a dozen
// small facts, and a dozen `if (listener)` branches scattered through an
// installer, a supervisor and a server is how the tray ends up named for one
// product and the login item for the other. Everything that differs is here,
// and every consumer reads it from here.
//
// CommonJS on purpose. The installer and the supervisor are .cjs and the chat
// server is ESM; a .cjs module is the one format both can read without a build
// step, which is what keeps this a single source of truth instead of two
// copies that drift.
//
// The one unavoidable second copy is inside install-node.cjs: it is downloaded
// and run BEFORE the repository exists, so it cannot require this file until
// after the clone. It carries only the handful of fields it needs before then,
// and test/edition.test.js fails if those disagree with this table.

/**
 * What an edition is:
 *
 *   id             The value of REFUGIO_EDITION, and the name in every log
 *                  line, error message and marker file.
 *   product        What it is called in front of a person.
 *   modeCategories Which discussion modes this edition OFFERS. A mode outside
 *                  the list is still in the build — the registry, the prompts
 *                  and the guardrails all ship in both — it is simply never
 *                  offered, never switchable, and refused if asked for. That
 *                  is deliberate: one codebase means the safety layers are
 *                  tested once and cannot rot in the edition nobody is
 *                  currently working on.
 *   installDir     Under the user's home directory.
 *   dataDir        Conversations, settings, the SQLite database. Under home.
 *                  Never shared: two products asking a person to trust them
 *                  with a private conversation do not get to read each
 *                  other's.
 *   envFile        Credentials. Under home.
 *   logDir         Supervisor and service logs. Under home.
 *   chatPort       The chat window's port. Different so a leftover process
 *                  from the other edition is a refusal to start rather than a
 *                  window that looks like this one and is not.
 *   agentLabel     launchd label / systemd unit / Windows startup entry.
 *   macApp         The bundle installed into /Applications.
 *   cli            The `refugio` / `refugio-listener` shim on PATH.
 *   bootstrap      The installer entry point that selects this edition.
 */
const EDITIONS = {
  standard: {
    id: "standard",
    product: "REFUGIO",
    summary: "A self-hosted refuge for your AI — chat, connectors, your machine.",
    // Only "data" modes: a mode that exists to point a conversation at a
    // connector belongs with the connectors. Coaching is the other product.
    modeCategories: ["data"],
    installDir: "refugio",
    dataDir: ".refugio-data",
    envFile: ".refugio.env",
    logDir: ".refugio-logs",
    chatPort: 8090,
    agentLabel: "com.phantazein.refugio",
    macApp: "REFUGIO.app",
    cli: "refugio",
    bootstrap: "install-refugio",
  },
  listener: {
    id: "listener",
    product: "REFUGIO Listener",
    summary: "Private coaching conversations that never leave your machine.",
    modeCategories: ["coaching"],
    installDir: "refugio-listener",
    dataDir: ".refugio-listener-data",
    envFile: ".refugio-listener.env",
    logDir: ".refugio-listener-logs",
    chatPort: 8091,
    agentLabel: "com.phantazein.refugio-listener",
    macApp: "REFUGIO Listener.app",
    cli: "refugio-listener",
    bootstrap: "install-listener",
  },
}

/** The default when nothing says otherwise. Every existing install is this. */
const DEFAULT_EDITION = "standard"

/** The file an install drops beside its own code to say which one it is.
 *
 *  The environment variable is the override; this is the fact. A supervisor
 *  started by launchd, a server started by hand from the install directory and
 *  a `npm start` from a checkout all need the same answer, and only one of
 *  those three reliably carries an environment. */
const MARKER_FILE = ".refugio-edition"

/**
 * Resolve an edition id to its row, falling back to standard.
 *
 * Never throws and never returns undefined. An unknown id is somebody's typo
 * in an environment variable, and the safe answer is the edition that has
 * existed since the beginning rather than a crash on startup — with the
 * caller free to say so in the log.
 */
function editionFor(id) {
  return EDITIONS[String(id || "").trim()] || EDITIONS[DEFAULT_EDITION]
}

/** Is this a name we know? Used to tell a typo from a deliberate choice. */
const isEdition = (id) => Object.prototype.hasOwnProperty.call(EDITIONS, String(id || "").trim())

/** The other edition's row — what a conflict check needs. */
const otherEditions = (id) => Object.values(EDITIONS).filter((e) => e.id !== editionFor(id).id)

module.exports = { EDITIONS, DEFAULT_EDITION, MARKER_FILE, editionFor, isEdition, otherEditions }
