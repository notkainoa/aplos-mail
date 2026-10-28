import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apcaLc, deltaE2000 } from "./color.mjs";
import { evaluatePairs } from "./check-contrast.mjs";
import { GENERATED_DIR, REFERENCES_PATH, TOKENS_PATH, readJson } from "./tokens-lib.mjs";

const SCRIPT = fileURLToPath(new URL("./check-contrast.mjs", import.meta.url));

function runCheck(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function withTemp(name, data, fn) {
  const dir = mkdtempSync(join(tmpdir(), "aplos-contrast-"));
  try {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(data));
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const results = evaluatePairs(readJson(join(GENERATED_DIR, "contrast-pairs.json")));

function ratio(id, mode) {
  const row = results.find((r) => r.id === id && r.mode === mode);
  assert.ok(row, `no pair ${id} in ${mode}`);
  return row.ratio;
}

// DESIGN 4.1's computed-contrast table: [pair id, light, dark].
const DESIGN_TABLE = [
  ["ink-on-canvas", 16.67, 14.75],
  ["ink-on-shell", 15.3, 15.76],
  ["ink-on-paper", 16.67, 13.8],
  ["ink-on-raised", 15.43, 13.47],
  ["ink-on-sunken", 14.51, 16.25],
  ["ink-2-on-canvas", 9.15, 10.1],
  ["ink-2-on-shell", 8.4, 10.79],
  ["ink-2-on-raised", 8.47, 9.22],
  ["dim-on-canvas", 5.76, 6.41],
  ["dim-on-shell", 5.28, 6.85],
  ["dim-on-paper", 5.76, 6.0],
  ["dim-on-raised", 5.33, 5.86],
  ["dim-on-sunken", 5.01, 7.07],
  ["dim-on-accent-wash-over-canvas", 5.07, 5.19],
  ["dim-on-puck-over-canvas", 5.12, 5.23],
  ["dim-on-puck-over-shell", 4.71, 5.7],
  ["dim-on-hover-over-canvas", 5.33, 5.68],
  ["dim-on-today-tint-over-canvas", 5.41, 5.82],
  ["faint-on-canvas", 3.12, 3.61],
  ["accent-on-canvas", 7.84, 7.61],
  ["accent-on-shell", 7.19, 8.13],
  ["accent-ink-on-accent", 7.84, 8.3],
  ["fill-ink-on-hill", 6.13, 8.21],
  ["fill-ink-on-dusk", 7.31, 7.88],
  ["fill-ink-on-stamp", 5.52, 7.47],
  ["fill-ink-on-hill-70-over-paper", null, 4.85],
  ["fill-ink-on-dusk-70-over-paper", null, 4.7],
  ["fill-ink-on-accent-70-over-paper", null, 4.91],
  ["stamp-ink-on-stamp-tint-over-canvas", 6.63, 6.48],
  ["control-edge-on-canvas", 3.07, 3.41],
  // Dark control-edge on paper: DESIGN prints 3.19, which is the edge composited
  // over the pane but measured against paper. Composited over paper it is 3.37.
  ["control-edge-on-paper", 3.07, 3.37],
  ["line-strong-on-canvas", 1.33, 1.38],
  // Weakest event fill: stamp in light, sand in dark.
  ["ink-on-tag-stamp-event-fill-over-canvas", 13.86, null],
  ["ink-2-on-tag-stamp-event-fill-over-canvas", 7.61, null],
  ["dim-on-tag-stamp-event-fill-over-canvas", 4.79, null],
  ["ink-on-tag-sand-event-fill-over-canvas", null, 10.03],
  ["ink-2-on-tag-sand-event-fill-over-canvas", null, 6.87],
];

test("DESIGN 4.1's printed ratios are reproduced within 0.02", () => {
  for (const [id, light, dark] of DESIGN_TABLE) {
    if (light !== null) {
      assert.ok(Math.abs(ratio(id, "light") - light) <= 0.02, `${id} light ${ratio(id, "light").toFixed(3)} vs ${light}`);
    }
    if (dark !== null) {
      assert.ok(Math.abs(ratio(id, "dark") - dark) <= 0.02, `${id} dark ${ratio(id, "dark").toFixed(3)} vs ${dark}`);
    }
  }
});

test("dim on the weakest dark event fill stays undeclared because it is under 4.5", () => {
  assert.ok(!results.some((r) => r.id.startsWith("dim-on-tag-") && r.mode.startsWith("dark")));
});

test("the field ring is an accepted exception at rest and passes 3:1 under Increase Contrast", () => {
  for (const mode of ["light", "dark"]) {
    const row = results.find((r) => r.id === "line-strong-on-canvas" && r.mode === mode);
    assert.equal(row.status, "exception");
  }
  for (const mode of ["light-more", "dark-more"]) {
    const row = results.find((r) => r.id === "line-strong-on-canvas" && r.mode === mode);
    assert.equal(row.status, "pass");
    assert.ok(row.ratio >= 3);
  }
});

test("ΔE00 matches de2000.py within 0.05", () => {
  // Values printed by python3 de2000.py's de2000() for the same inputs.
  assert.ok(Math.abs(deltaE2000("#0b5394", "#0050ff") - 13.840971) < 0.05);
  assert.ok(Math.abs(deltaE2000("#86b86a", "#03ce4c") - 11.560366) < 0.05);
  assert.ok(Math.abs(deltaE2000("#0b5394", "#1c42b1") - 8.914) < 0.05);
});

test("APCA matches its published reference values", () => {
  assert.ok(Math.abs(apcaLc("#888888", "#ffffff") - 63.056) < 0.01);
  assert.ok(Math.abs(apcaLc("#ffffff", "#000000") - -107.885) < 0.01);
});

test("the real tokens pass every check", () => {
  const result = runCheck([]);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /Accepted exception: line-strong-on-canvas in light/);
});

test("a colour token without a declared pair fails coverage", () => {
  const tokens = readJson(TOKENS_PATH);
  tokens.color["link-visited"] = { $value: "#5a3d8a", $description: "test", $extensions: { aplos: { usage: ["text"] } } };
  withTemp("tokens.json", tokens, (path) => {
    const result = runCheck(["--contrast", "--tokens", path]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /color\.link-visited: used as text but is the foreground of no text pair/);
  });
});

test("a colour token with no usage fails coverage", () => {
  const tokens = readJson(TOKENS_PATH);
  tokens.color.mystery = { $value: "#336699" };
  withTemp("tokens.json", tokens, (path) => {
    const result = runCheck(["--contrast", "--tokens", path]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /color\.mystery: no \$extensions\.aplos\.usage/);
  });
});

test("an accent too close to Avec fails the identity check", () => {
  const tokens = readJson(TOKENS_PATH);
  tokens.color.accent.$value = "#0a4fe0";
  withTemp("tokens.json", tokens, (path) => {
    const result = runCheck(["--identity", "--tokens", path]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL identity: --accent light/);
  });
});

test("the provisional dark-hill exception is the only identity distance under 8.5", () => {
  const refs = readJson(REFERENCES_PATH);
  refs.exceptions = [];
  withTemp("refs.json", refs, (path) => {
    const result = runCheck(["--identity", "--refs", path]);
    assert.equal(result.status, 1);
    const fails = result.stdout.split("\n").filter((line) => line.startsWith("FAIL identity"));
    assert.deepEqual(fails, ["FAIL identity: --hill dark #86b86a is 7.72 from Mimestream system green #64ca56"]);
  });
});
