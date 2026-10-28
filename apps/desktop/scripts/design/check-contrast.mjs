#!/usr/bin/env node
// Contrast, coverage and identity checks for the Paper tokens (DESIGN 12.4).
//   --contrast  every declared pair meets its WCAG 2.x minimum in every mode
//               (APCA Lc printed as advice), and every text or non-text colour
//               token is the foreground of at least one declared pair
//   --identity  ΔE00 of accent, hill, dusk and stamp against the reference
//               list, the not-Avec distances, and the shell's Lab b*
// Both run by default. Exits 1 on any failure.
// --tokens, --pairs and --refs point at other copies (used by the tests).
//
// Coverage exemptions: a colour token is exempt from needing a pair only when
// its $extensions.aplos.usage lists nothing but surface, decorative, shadow or
// overlay. A colour token with no usage at all fails.

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apcaLc, contrastRatio, deltaE2000, toHex, toLab } from "./color.mjs";
import {
  COLOR_USAGES,
  GENERATED_DIR,
  MODES,
  REFERENCES_PATH,
  TOKENS_PATH,
  aliasPath,
  colorTokens,
  declaredPairs,
  flattenTokens,
  lookup,
  readJson,
  solidColor,
} from "./tokens-lib.mjs";

const PAIRS_PATH = join(GENERATED_DIR, "contrast-pairs.json");
const PAIRED_USAGES = ["text", "nontext"];

function pad(text, width) {
  return String(text).padEnd(width);
}

// ---------- contrast ----------

export function evaluatePairs(pairsDoc) {
  return pairsDoc.pairs.map((pair) => {
    const ratio = contrastRatio(pair.fgRgb, pair.bgRgb);
    const lc = apcaLc(pair.fgRgb, pair.bgRgb);
    const meets = ratio >= pair.min;
    const status = meets ? "pass" : pair.exception ? "exception" : "FAIL";
    return { ...pair, ratio, lc, status };
  });
}

function printPairs(results) {
  const ids = [...new Set(results.map((r) => r.id))];
  const header = `${pad("pair", 52)} ${pad("min", 4)} ${MODES.map((m) => pad(m, 22)).join(" ")}`;
  console.log(header);
  for (const id of ids) {
    const rows = results.filter((r) => r.id === id);
    const cells = MODES.map((mode) => {
      const r = rows.find((row) => row.mode === mode);
      if (!r) {
        return pad("-", 22);
      }
      const mark = r.status === "pass" ? "" : r.status === "exception" ? " EXC" : " FAIL";
      return pad(`${r.ratio.toFixed(2)} Lc${r.lc.toFixed(0)}${mark}`, 22);
    });
    console.log(`${pad(id, 52)} ${pad(rows[0].min, 4)} ${cells.join(" ")}`);
  }
}

export function checkCoverage(flat) {
  const pairs = declaredPairs(flat);
  const problems = [];
  for (const token of colorTokens(flat)) {
    const usage = token.usage;
    if (!Array.isArray(usage) || usage.length === 0) {
      problems.push(`${token.path}: no $extensions.aplos.usage; declare how it is used (${COLOR_USAGES.join(", ")})`);
      continue;
    }
    const unknown = usage.filter((u) => !COLOR_USAGES.includes(u));
    if (unknown.length > 0) {
      problems.push(`${token.path}: unknown usage ${unknown.join(", ")}`);
    }
    if (!usage.some((u) => PAIRED_USAGES.includes(u))) {
      continue;
    }
    const asFg = pairs.filter((p) => aliasPath(p.fg) === token.path);
    if (usage.includes("text") && !asFg.some((p) => p.kind === "text")) {
      problems.push(`${token.path}: used as text but is the foreground of no text pair`);
    }
    if (usage.includes("nontext") && asFg.length === 0) {
      problems.push(`${token.path}: used as a non-text foreground but appears in no pair`);
    }
  }
  return problems;
}

function runContrast(flat, pairsDoc) {
  console.log("Contrast (WCAG 2.x; APCA Lc advisory)");
  const results = evaluatePairs(pairsDoc);
  printPairs(results);
  const failures = results.filter((r) => r.status === "FAIL");
  const exceptions = results.filter((r) => r.status === "exception");
  for (const r of exceptions) {
    console.log(`Accepted exception: ${r.id} in ${r.mode} at ${r.ratio.toFixed(2)} (${r.exception.decision}): ${r.exception.reason}`);
  }
  for (const r of failures) {
    console.log(`FAIL ${r.id} in ${r.mode}: ${r.ratio.toFixed(2)} < ${r.min} (${r.fgHex} on ${r.bgHex}) — ${r.usage}`);
  }
  const coverage = checkCoverage(flat);
  for (const problem of coverage) {
    console.log(`FAIL coverage: ${problem}`);
  }
  const passed = results.length - failures.length - exceptions.length;
  console.log(
    `Contrast: ${results.length} checks, ${passed} pass, ${exceptions.length} accepted exception, ${failures.length} fail; coverage ${coverage.length === 0 ? "ok" : `${coverage.length} problem(s)`}.`,
  );
  return failures.length + coverage.length;
}

// ---------- identity ----------

function isExcepted(refs, tokenPath, mode, hex) {
  return (refs.exceptions ?? []).find(
    (e) => aliasPath(e.token) === tokenPath && e.mode === mode && e.reference.toLowerCase() === hex.toLowerCase(),
  );
}

export function identityResults(flat, refs) {
  const rows = [];
  for (const ref of refs.targets) {
    const token = lookup(flat, ref);
    for (const mode of ["light", "dark"]) {
      const hex = toHex(solidColor(flat, ref, mode));
      for (const reference of refs.references) {
        const de = deltaE2000(hex, reference.hex);
        const exception = isExcepted(refs, token.path, mode, reference.hex);
        const status = de >= refs.threshold ? "pass" : exception ? "exception" : "FAIL";
        rows.push({ token: token.css, mode, hex, reference, de, status, exception });
      }
    }
  }
  return rows;
}

export function notAvecResults(flat, refs) {
  const rows = [];
  for (const check of refs.notAvec.checks) {
    const token = lookup(flat, check.token);
    for (const mode of ["light", "dark"]) {
      const hex = toHex(solidColor(flat, check.token, mode));
      for (const refHex of check.references) {
        const de = deltaE2000(hex, refHex);
        rows.push({ token: token.css, mode, hex, refHex, de, pass: de >= refs.notAvec.minimum });
      }
    }
  }
  return rows;
}

export function shellResults(flat, refs) {
  return ["light", "dark"].map((mode) => {
    const hex = toHex(solidColor(flat, refs.shell.token, mode));
    const [, , b] = toLab(hex);
    return { mode, hex, b, pass: b < refs.shell.maxB };
  });
}

function runIdentity(flat, refs) {
  console.log(`Identity (ΔE00, minimum ${refs.threshold})`);
  const rows = identityResults(flat, refs);
  const nearest = new Map();
  for (const row of rows) {
    const key = `${row.token} ${row.mode}`;
    if (!nearest.has(key) || nearest.get(key).de > row.de) {
      nearest.set(key, row);
    }
  }
  for (const [key, row] of nearest) {
    console.log(`  ${pad(key, 16)} ${row.hex}  nearest ${row.de.toFixed(2)} ${row.reference.name} ${row.reference.hex}`);
  }
  const failures = rows.filter((r) => r.status === "FAIL");
  for (const r of rows.filter((row) => row.status === "exception")) {
    console.log(`Accepted exception (${r.exception.status}): ${r.token} ${r.mode} ${r.de.toFixed(2)} from ${r.reference.name} ${r.reference.hex}`);
  }
  for (const r of failures) {
    console.log(`FAIL identity: ${r.token} ${r.mode} ${r.hex} is ${r.de.toFixed(2)} from ${r.reference.name} ${r.reference.hex}`);
  }

  console.log(`Not Avec (DESIGN 2.3, minimum ${refs.notAvec.minimum})`);
  const avec = notAvecResults(flat, refs);
  for (const r of avec) {
    console.log(`  ${pad(`${r.token} ${r.mode}`, 16)} ${r.hex} vs ${r.refHex}: ${r.de.toFixed(2)}${r.pass ? "" : " FAIL"}`);
  }

  console.log("Shell Lab b* (must be below 0)");
  const shell = shellResults(flat, refs);
  for (const r of shell) {
    console.log(`  ${pad(r.mode, 6)} ${r.hex}: b* ${r.b.toFixed(2)}${r.pass ? "" : " FAIL"}`);
  }
  const failed = failures.length + avec.filter((r) => !r.pass).length + shell.filter((r) => !r.pass).length;
  const excepted = rows.filter((r) => r.status === "exception").length;
  console.log(`Identity: ${rows.length + avec.length + shell.length} checks, ${excepted} accepted exception, ${failed} fail.`);
  return failed;
}

// ---------- driver ----------

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export function run(args) {
  const flat = flattenTokens(readJson(resolve(argValue(args, "--tokens") ?? TOKENS_PATH)));
  const doContrast = args.includes("--contrast") || !args.includes("--identity");
  const doIdentity = args.includes("--identity") || !args.includes("--contrast");
  let failures = 0;
  if (doContrast) {
    failures += runContrast(flat, readJson(resolve(argValue(args, "--pairs") ?? PAIRS_PATH)));
  }
  if (doIdentity) {
    failures += runIdentity(flat, readJson(resolve(argValue(args, "--refs") ?? REFERENCES_PATH)));
  }
  console.log(failures === 0 ? "All design checks passed." : `${failures} design check(s) failed.`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
