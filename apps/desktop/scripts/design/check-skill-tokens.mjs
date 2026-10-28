#!/usr/bin/env node
// Keeps the aplos-design skill and the tokens in step (DESIGN 12.3: "A token
// change that doesn't touch the skill fails a CI check that compares the token
// names listed in the skill against tokens.json").
//   node apps/desktop/scripts/design/check-skill-tokens.mjs
// --skill <path> and --tokens <path> point at other copies (used by the tests).
//
// 1. Every custom property written in backticks in SKILL.md exists: it is one
//    of the properties tokens.json generates into tokens.css. A wildcard such
//    as `--tag-*` or `--type-<role>` must match at least one of them. Only
//    code spans that are CSS are read (they start with `--` or contain
//    `var(--`), so command flags like `build-tokens.mjs --check` are ignored;
//    `var(--token)` is the skill's placeholder and is ignored too.
// 2. Every token in the colour, radius, elevation and layer families is named
//    in the skill, exactly or through a documented wildcard of its family
//    (`--tag-*`, `--z-*`). Every type role and every motion name must be the
//    first cell of a row in the skill's Type or Motion table, backticked
//    (`| \`caption\` |`, `| \`lift\`, \`follow\`, \`snap\` |`) or by its exact
//    property. A mention elsewhere (`once \`hold\` releases`) or a wildcard
//    such as `--type-<role>` or `--dur-*` does not count, so adding a role or a
//    motion means adding a row to the table, and deleting a row fails.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./build-tokens.mjs";
import { TOKENS_PATH, flattenTokens, readJson } from "./tokens-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const SKILL_PATH = resolve(here, "../../../../.claude/skills/aplos-design/SKILL.md");

const PLACEHOLDERS = new Set(["--token"]);
const PROPERTY = /--(?:\*|[a-z0-9]+(?:-[a-z0-9]+)*(?:-\*|-<[a-z-]+>)?)/gi;
// A wildcard must keep its family prefix (`--tag-*`), never a bare `--*`.
const WILDCARD_PREFIX = /^--[a-z0-9]+(?:-[a-z0-9]+)*-$/;

// Inline code spans, outside fenced blocks.
export function codeSpans(markdown) {
  const prose = markdown.replace(/^```[\s\S]*?^```/gm, "");
  return [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

// The tables whose rows name type roles and motions: the `### Type` and
// `### Motion` sections of the cheat-sheet.
const ROW_SECTIONS = { "type role": /^###\s+Type\b/i, motion: /^###\s+Motion\b/i };

// Backticked names in the first cell of each table row, per row section.
export function tableRowNames(markdown) {
  const out = Object.fromEntries(Object.keys(ROW_SECTIONS).map((family) => [family, new Set()]));
  let family = null;
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      family = Object.keys(ROW_SECTIONS).find((name) => ROW_SECTIONS[name].test(line)) ?? null;
      continue;
    }
    const row = family && line.match(/^\|([^|]*)\|/);
    if (!row || /^[\s:-]*$/.test(row[1])) {
      continue;
    }
    const cell = row[1].trim();
    // The whole cell must be backticked names separated by commas.
    if (!/^`[^`]+`(?:\s*,\s*`[^`]+`)*$/.test(cell)) {
      continue;
    }
    for (const [, name] of cell.matchAll(/`([^`]+)`/g)) {
      out[family].add(name.trim());
    }
  }
  return out;
}

// Exact names and wildcard prefixes the skill writes in CSS code spans.
export function skillReferences(markdown) {
  const exact = new Set();
  const wildcards = new Set();
  for (const span of codeSpans(markdown)) {
    const text = span.trim();
    if (!text.startsWith("--") && !text.includes("var(--")) {
      continue;
    }
    for (const [match] of text.matchAll(PROPERTY)) {
      if (match.endsWith("-*") || match.endsWith(">")) {
        wildcards.add(match.replace(/(-\*|-<[a-z-]+>)$/i, "-"));
      } else if (!PLACEHOLDERS.has(match)) {
        exact.add(match);
      }
    }
  }
  return { exact, wildcards, rows: tableRowNames(markdown) };
}

// Every custom property the generator writes for these tokens.
export function generatedProperties(tokensPath = TOKENS_PATH) {
  const css = generate(tokensPath)["tokens.css"];
  return new Set([...css.matchAll(/^\s*(--[a-z0-9-]+):/gim)].map((m) => m[1]));
}

function covered(name, refs) {
  return refs.exact.has(name) || [...refs.wildcards].some((prefix) => name.startsWith(prefix));
}

// Token families the skill must list, as { family, name, wildcardsCount }.
export function requiredMentions(flat) {
  const out = [];
  for (const token of flat.tokens) {
    if (!token.css) {
      continue;
    }
    if (token.type === "color" || token.group === "tag") {
      out.push({ family: "colour", name: token.css, wildcards: true });
    } else if (token.group === "radius") {
      out.push({ family: "radius", name: token.css, wildcards: true });
    } else if (token.group === "elev") {
      out.push({ family: "elevation", name: token.css, wildcards: true });
    } else if (token.group === "layer") {
      out.push({ family: "layer", name: token.css, wildcards: true });
    } else if (token.group === "type") {
      out.push({ family: "type role", name: token.key, property: token.css, wildcards: false });
    } else if (token.group === "motion") {
      out.push({ family: "motion", name: token.key, property: token.css, wildcards: false });
    }
  }
  return out;
}

export function checkSkillTokens(markdown, tokensPath = TOKENS_PATH) {
  const refs = skillReferences(markdown);
  const defined = generatedProperties(tokensPath);
  const flat = flattenTokens(readJson(tokensPath));
  const problems = [];

  for (const name of [...refs.exact].sort()) {
    if (!defined.has(name)) {
      problems.push(`SKILL.md names ${name}, which tokens.json does not define; fix the skill or the token`);
    }
  }
  for (const prefix of [...refs.wildcards].sort()) {
    if (!WILDCARD_PREFIX.test(prefix)) {
      problems.push(`SKILL.md wildcard ${prefix}* has no family prefix; name the family, e.g. --tag-*`);
    } else if (![...defined].some((name) => name.startsWith(prefix))) {
      problems.push(`SKILL.md wildcard ${prefix}* matches no token in tokens.json`);
    }
  }

  for (const need of requiredMentions(flat)) {
    if (need.wildcards) {
      if (!covered(need.name, refs)) {
        problems.push(`${need.family} token ${need.name} is not in SKILL.md; add it to the skill's token tables`);
      }
    } else if (!refs.rows[need.family].has(need.name) && !refs.rows[need.family].has(need.property)) {
      problems.push(`${need.family} \`${need.name}\` has no row in SKILL.md's table; add one`);
    }
  }
  return { problems, refs, defined };
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export function run(args) {
  const skillPath = resolve(argValue(args, "--skill") ?? SKILL_PATH);
  const tokensPath = resolve(argValue(args, "--tokens") ?? TOKENS_PATH);
  const { problems, refs } = checkSkillTokens(readFileSync(skillPath, "utf8"), tokensPath);
  for (const problem of problems) {
    console.log(`FAIL ${problem}`);
  }
  console.log(
    `Skill tokens: ${refs.exact.size} names and ${refs.wildcards.size} wildcards in SKILL.md; ${problems.length === 0 ? "in step with tokens.json" : `${problems.length} problem(s)`}.`,
  );
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
