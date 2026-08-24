// The per-user half of the Windows install.
//
// Run once per user by Active Setup, at that user's first logon after the MSI
// lands. Everything here is the stuff an MSI running as SYSTEM cannot do,
// because at install time this user may not have existed: their data
// directory, their credentials file, and a Startup shortcut so REFUGIO comes
// up with their session.
//
// Node rather than PowerShell, deliberately. The runtime is bundled two
// directories away and is guaranteed present; PowerShell's execution policy is
// not ours to assume on a machine whose whole point is that IT locks it down.
//
// Must be idempotent and must never throw: Active Setup shows the user a
// progress dialog while this runs, and an unhandled exception there is a crash
// dialog at the exact moment someone first logs into a new laptop.

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const HOME = os.homedir();
const DATA = process.env.REFUGIO_DATA_DIR || path.join(HOME, ".refugio-data");
const LOGS = path.join(HOME, ".refugio-logs");

function log(msg) {
  try {
    fs.mkdirSync(LOGS, { recursive: true });
    fs.appendFileSync(path.join(LOGS, "user-setup.log"),
      `${new Date().toISOString()} ${msg}\n`);
  } catch { /* a machine where we cannot even log is not one to crash on */ }
}

function main() {
  log(`user-setup for ${os.userInfo().username}, payload at ${ROOT}`);

  fs.mkdirSync(DATA, { recursive: true });

  // A credentials file the user owns. No invented values — a managed
  // deployment has no business making them up, and a file of placeholders
  // looks configured when it is not.
  //
  // Not empty, though, and that matters: the supervisor reads a file with no
  // keys as "the installer was never run", says so and exits 1 — which under a
  // restart-on-failure launcher is a loop. One truthful line stops that.
  const envPath = path.join(HOME, ".refugio.env");
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath,
      "# Installed by the REFUGIO package. Connectors are configured in Settings.\r\n" +
      "REFUGIO_INSTALL=msi\r\n");
  }

  // Start with the session. A Startup-folder shortcut rather than an HKCU Run
  // key: it is visible in Task Manager's Startup tab, which means a user can
  // turn it off without editing the registry, and can see that it is there at
  // all.
  const startup = path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"),
    "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  try {
    fs.mkdirSync(startup, { recursive: true });
    // A .cmd, not a .lnk — writing a shell link needs COM, and shelling out to
    // PowerShell to make one is the execution-policy problem all over again.
    // refugio-node.exe, not node.exe — a build-time copy under our own name,
    // so uninstall can terminate REFUGIO's supervisor by process name without
    // killing every other Node process on the machine.
    fs.writeFileSync(path.join(startup, "REFUGIO.cmd"),
      "@echo off\r\n" +
      `start "" /b "${path.join(ROOT, "runtime", "refugio-node.exe")}" "${path.join(ROOT, "start-refugio.cjs")}"\r\n`);
    log("startup entry written");
  } catch (e) {
    log(`could not write the startup entry: ${e.message}`);
  }

  fs.writeFileSync(path.join(DATA, ".provisioned"), new Date().toISOString());
  log("done");
}

try {
  main();
} catch (e) {
  // Never rethrow. Active Setup is showing this user a dialog right now, on
  // what is very likely the first minute of their first logon.
  log(`failed: ${e.stack || e.message}`);
}
process.exit(0);
