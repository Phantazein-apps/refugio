// The maturity label — the one claim that is made in five places at once.
//
// "alpha" and "beta" are asserted in package.json, in two HTML files, in the
// macOS window title, in the README badge and on the banner at the top of the
// README — and nothing renders any of the others from the first one. The label
// went beta → alpha → beta over the project's life, and each move has to happen
// in all six or the product tells a different story depending on where someone
// is looking when they ask. The banner is the sixth because it is the first
// thing anyone sees, and an image is the surface least likely to be checked by
// hand.
//
// This does not say WHICH label is right. That is a judgement about the
// software, made by a person. It says the six agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf-8");
const pkg = JSON.parse(read("../package.json"));

/** alpha / beta / rc, read off the version rather than hard-coded here. */
const stage = () => (pkg.version.match(/-(alpha|beta|rc)/) || [])[1] || "stable";

test("the version carries a prerelease label while REFUGIO has one", () => {
  // A version with no label would make every check below vacuous, and it is
  // also the thing that must not happen by accident — 2.0.0 plain is a claim
  // nobody has made.
  assert.match(pkg.version, /^\d+\.\d+\.\d+-(alpha|beta|rc)\.\d+$/,
    `package.json version "${pkg.version}" is not a labelled prerelease`);
});

test("every surface that names the stage names the same one", () => {
  const want = stage();
  const surfaces = {
    "chat/static/index.html": read("../chat/static/index.html"),
    "chat/static/wizard.html": read("../chat/static/wizard.html"),
    "menubar/Sources/RefugioBar/ChatWindow.swift": read("../menubar/Sources/RefugioBar/ChatWindow.swift"),
    "README.md": read("../README.md"),
    "assets/banner.svg": read("../assets/banner.svg"),
  };
  for (const [file, text] of Object.entries(surfaces)) {
    assert.ok(new RegExp(want, "i").test(text), `${file} never says "${want}"`);
    // And does not still carry the label it used to have.
    for (const other of ["alpha", "beta", "rc"].filter((s) => s !== want)) {
      // The README quotes the older Open WebUI line and the CSS comment records
      // the history on purpose, so only the label-shaped uses are checked.
      const stale = new RegExp(`(class="stage"[^>]*>\\s*${other}|REFUGIO \\(${other}\\)|v2-${other.toUpperCase()}-|v2 is ${other}\\b|the \\*\\*v2 ${other}\\*\\*|V2 ${other}\\b)`, "i");
      assert.doesNotMatch(text, stale, `${file} still labels REFUGIO "${other}"`);
    }
  }
});

test("the release channel is a branch name, not the version", () => {
  // install-refugio pins a BRANCH, and it is deliberately never renamed —
  // every existing install tracks it by name and a rename breaks their pull.
  // So the version may move past it and the two are allowed to differ; what
  // must not happen is the version claiming to be BEHIND the channel, which
  // reads as an install that failed.
  const installer = read("../install-refugio");
  const pinned = (installer.match(/REFUGIO_VERSION:-v([\d.]+-[a-z]+\.\d+)/) || [])[1];
  assert.ok(pinned, "the installer no longer pins a recognisable version branch");
  assert.ok(!isOlder(pkg.version, pinned),
    `package.json is ${pkg.version} while the installer pins v${pinned} — that reads as a stale copy`);
});

/** Crude semver-prerelease comparison: enough for alpha.1 < beta.2 < beta.10. */
function isOlder(a, b) {
  const parse = (v) => {
    const [core, pre = ""] = v.split("-");
    const [label = "", n = "0"] = pre.split(".");
    return [...core.split(".").map(Number), ["alpha", "beta", "rc"].indexOf(label), Number(n)];
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}
