import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generate } from "./build-tokens.mjs";
import { springLinear } from "./spring.mjs";
import { GENERATED_DIR } from "./tokens-lib.mjs";

const SCRIPT = fileURLToPath(new URL("./build-tokens.mjs", import.meta.url));
const HEADER = "Generated from tokens.json by scripts/design/build-tokens.mjs. Do not edit.";

function runBuild(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function rootBlock(css) {
  return css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
}

test("generation is deterministic and the committed files are current", () => {
  const first = generate();
  const second = generate();
  assert.deepEqual(first, second);
  const result = runBuild(["--check"]);
  assert.equal(result.status, 0, result.stderr);
});

test("--check names a hand-edited generated file", () => {
  const dir = mkdtempSync(join(tmpdir(), "aplos-tokens-"));
  try {
    cpSync(GENERATED_DIR, dir, { recursive: true });
    assert.equal(runBuild(["--check", "--out", dir]).status, 0);
    const cssPath = join(dir, "tokens.css");
    writeFileSync(cssPath, readFileSync(cssPath, "utf8").replace("--accent: #0b5394;", "--accent: #0050ff;"));
    const result = runBuild(["--check", "--out", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tokens\.css/);
    assert.doesNotMatch(result.stderr, /motion\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--check fails on a hand-made file in generated/", () => {
  const dir = mkdtempSync(join(tmpdir(), "aplos-tokens-"));
  try {
    cpSync(GENERATED_DIR, dir, { recursive: true });
    writeFileSync(join(dir, "extra.css"), ":root { --x: red; }\n");
    const result = runBuild(["--check", "--out", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /extra\.css \(not generated; remove it\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every generated file starts with the do-not-edit header", () => {
  const outputs = generate();
  assert.ok(outputs["tokens.css"].startsWith(`/* ${HEADER}`));
  assert.ok(outputs["motion.ts"].startsWith(`// ${HEADER}`));
  assert.equal(JSON.parse(outputs["contrast-pairs.json"]).$comment, HEADER);
});

test("--font-mono is defined (baseline defect 9) and mockup leftovers are not carried over", () => {
  const css = generate()["tokens.css"];
  assert.match(rootBlock(css), /--font-mono: ui-monospace, "SF Mono", "Menlo", monospace;/);
  for (const leftover of ["--app-icon", "--icon-sky", "--dur-send", "--os-", "--avatar", "--page-top", "--float-bg", "--float-filter", "--elev-paper", "--radius-window"]) {
    assert.ok(!css.includes(`${leftover}`), `${leftover} should not be generated`);
  }
});

test("Increase Contrast and reduced motion work through both hooks", () => {
  const css = generate()["tokens.css"];
  const more = ["--line: var(--control-edge);", "--line-strong: var(--control-edge);", "--faint: var(--dim);", "--focus-width: 3px;"];
  const media = css.slice(css.indexOf("@media (prefers-contrast: more)"), css.indexOf(':root[data-contrast="more"],\n'));
  const attr = css.slice(css.indexOf(':root[data-contrast="more"],\n'), css.indexOf("/* Reduced motion"));
  for (const decl of more) {
    assert.ok(media.includes(decl), `media block lacks ${decl}`);
    assert.ok(attr.includes(decl), `attribute block lacks ${decl}`);
  }
  assert.match(media, /:root\[data-theme="dark"\]/, "contrast overrides must also beat the night block");
  const reduced = css.slice(css.indexOf(':root[data-motion="reduced"] {'));
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  for (const decl of ["--move-carry: 0px;", "--move-flight-rotate: 0deg;", "--scale-lift: 1;", "--press-scale: 1;", "--dur-slide: 0ms;", "--dur-flight: 120ms;", "--play-status: paused;", "--breathe-hi: 0.85;", "--dur-toast-fade: 120ms;"]) {
    assert.ok(reduced.includes(decl), `reduced block lacks ${decl}`);
  }
  assert.match(css, /:root\[data-theme-switching\] \*[\s\S]*transition: none !important;/);
});

test("generated motion.ts loads and matches the solver", async () => {
  const motion = await import(pathToFileURL(join(GENERATED_DIR, "motion.ts")).href);
  assert.equal(motion.springs.slide.linear, springLinear({ stiffness: 600, damping: 42, mass: 1 }));
  assert.equal(motion.motionMs("carry", "base"), 120);
  assert.equal(motion.motionMs("carry", "base", { rapid: true }), 60);
  assert.equal(motion.motionMs("carry", "base", { rapid: true, reduced: true }), 80);
  assert.equal(motion.motionMs("press", "up"), 140);
  assert.equal(motion.motions["undo-send"].durations.base, 8000);
  assert.equal(motion.easings.out.css, "cubic-bezier(0.16, 1, 0.3, 1)");
  assert.equal(motion.timingReduced.toastFade, 120);
});

test("arrive is deferred during rapid triage; nothing else is", async () => {
  const motion = await import(pathToFileURL(join(GENERATED_DIR, "motion.ts")).href);
  assert.equal(motion.motionDeferred("arrive", { rapid: true }), true);
  assert.equal(motion.motionDeferred("arrive", { rapid: true, reduced: true }), true);
  assert.equal(motion.motionDeferred("arrive"), false);
  const deferred = Object.keys(motion.motions).filter((name) => motion.motionDeferred(name, { rapid: true }));
  assert.deepEqual(deferred, ["arrive"]);
});
