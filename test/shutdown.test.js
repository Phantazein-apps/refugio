// Stopping the chat server stops its connectors.
//
// It did not. On SIGTERM the server called the pool's close() and exited in the
// same breath, so the SDK never got as far as signalling a connector that does
// not quit when its input closes. Hermeneia is one: it was left running with no
// parent, holding the WhatsApp session lock, and every later start's WhatsApp
// failed with "Another Hermeneia is already running". Found by stopping REFUGIO
// on a real install.
//
// The real server, a real MCP connector that ignores its input closing, and a
// SIGTERM.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let sdk = true;
try { await import("@modelcontextprotocol/sdk/server/index.js"); } catch { sdk = false; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test("SIGTERM to the chat server takes its connectors with it", { skip: !sdk && "@modelcontextprotocol/sdk is not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "refugio-shutdown-"));
  const pidFile = join(dir, "connector.pid");
  const config = join(dir, "mcpo-config.json");
  writeFileSync(config, JSON.stringify({
    mcpServers: { stubborn: { command: process.execPath, args: [join(ROOT, "test", "fixtures", "stubborn-connector.mjs")] } },
  }));
  const port = await freePort();
  let output = "";
  const child = spawn(process.execPath, [join(ROOT, "chat", "server.js"), "--port", String(port)], {
    env: {
      ...process.env,
      OLLAMA_BASE_URL: "http://127.0.0.1:9",
      REFUGIO_DATA_DIR: dir,
      REFUGIO_ENV_FILE: join(dir, "refugio.env"),
      REFUGIO_MCPO_CONFIG: config,
      STUBBORN_PID_FILE: pidFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => { output += b; });
  child.stderr.on("data", (b) => { output += b; });

  try {
    // Wait for the connector to have started.
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(100);
    assert.ok(existsSync(pidFile), `the connector never started:\n${output}`);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(alive(pid), true);

    const exited = new Promise((r) => child.on("exit", r));
    child.kill("SIGTERM");
    await exited;
    // The SDK's close is end-input, wait 2 s, SIGTERM; give it a moment past that.
    for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
    assert.equal(alive(pid), false, `the connector outlived its chat server:\n${output}`);
  } finally {
    child.kill("SIGKILL");
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
