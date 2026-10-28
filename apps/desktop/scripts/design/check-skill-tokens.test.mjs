import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_PATH, checkSkillTokens, skillReferences, tableRowNames } from "./check-skill-tokens.mjs";
import { TOKENS_PATH, readJson } from "./tokens-lib.mjs";

const SCRIPT = fileURLToPath(new URL("./check-skill-tokens.mjs", import.meta.url));
const SKILL = readFileSync(SKILL_PATH, "utf8");

function withTokens(edit, fn) {
  const tokens = readJson(TOKENS_PATH);
  edit(tokens);
  const dir = mkdtempSync(join(tmpdir(), "aplos-skill-"));
  try {
    const path = join(dir, "tokens.json");
    writeFileSync(path, JSON.stringify(tokens));
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the committed skill and tokens are in step", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /in step with tokens\.json/);
});

test("only CSS code spans are read: command flags and the var(--token) placeholder are ignored", () => {
  const refs = skillReferences("Run `node build-tokens.mjs --check`. Use `var(--token)`, `--accent`, `font: var(--type-<role>)` and `--tag-*`.");
  assert.deepEqual([...refs.exact], ["--accent"]);
  assert.deepEqual([...refs.wildcards].sort(), ["--tag-", "--type-"]);
});

test("a token named in the skill that tokens.json does not define fails", () => {
  const { problems } = checkSkillTokens(`${SKILL}\n| \`--glow\` | nothing |\n`);
  assert.deepEqual(problems, ["SKILL.md names --glow, which tokens.json does not define; fix the skill or the token"]);
});

test("a wildcard must keep its family and match something", () => {
  const { problems } = checkSkillTokens(`${SKILL}\nAlso \`--*\` and \`--glow-*\`.\n`);
  assert.ok(problems.some((p) => /wildcard --\* has no family prefix/.test(p)));
  assert.ok(problems.some((p) => /wildcard --glow-\* matches no token/.test(p)));
});

test("a new colour, radius, elevation or layer token that the skill does not list fails", () => {
  withTokens(
    (tokens) => {
      tokens.color.ochre = { $value: "#aa7700", $extensions: { aplos: { usage: ["nontext"] } } };
      tokens.radius.xxl = { $value: "20px" };
      tokens.elev.halo = { $value: tokens.elev.card.$value };
      tokens.layer.overlay = { $value: 80 };
    },
    (path) => {
      const { problems } = checkSkillTokens(SKILL, path);
      assert.deepEqual(problems, [
        "colour token --ochre is not in SKILL.md; add it to the skill's token tables",
        "radius token --radius-xxl is not in SKILL.md; add it to the skill's token tables",
        "elevation token --elev-halo is not in SKILL.md; add it to the skill's token tables",
        "layer token --z-overlay is not in SKILL.md; add it to the skill's token tables",
      ]);
    },
  );
});

test("a family wildcard covers its tokens, but not type roles or motion names", () => {
  withTokens(
    (tokens) => {
      tokens.tag.moss = { $value: "#4a6a2a", $extensions: { aplos: { usage: ["nontext"] } } };
      tokens.type.huge = { $value: { ...tokens.type.display.$value, fontSize: "40px", lineHeight: "48px" } };
      tokens.motion.drift = { $value: tokens.motion.swap.$value };
    },
    (path) => {
      const skill = `${SKILL}\nTags are \`--tag-*\`; durations are \`--dur-*\`.\n`;
      const { problems } = checkSkillTokens(skill, path);
      assert.deepEqual(problems, [
        "type role `huge` has no row in SKILL.md's table; add one",
        "motion `drift` has no row in SKILL.md's table; add one",
      ]);
    },
  );
});

test("removing a row from the skill's tables fails", () => {
  const skill = SKILL.replace(/^\| `--radius-xl` .*\n/m, "").replace(/^\| `breathe` .*\n/m, "");
  assert.notEqual(skill, SKILL);
  const { problems } = checkSkillTokens(skill);
  assert.deepEqual(problems, [
    "radius token --radius-xl is not in SKILL.md; add it to the skill's token tables",
    "motion `breathe` has no row in SKILL.md's table; add one",
  ]);
});

test("a motion or role mentioned elsewhere still needs its own row", () => {
  // `hold` is also backticked in the `close` row, `small` and `ui` in prose.
  const skill = SKILL.replace(/^\| `hold` .*\n/m, "").replace(/^\| `small` .*\n/m, "");
  assert.notEqual(skill, SKILL);
  assert.match(skill, /`hold`/);
  assert.match(skill, /`small`/);
  const { problems } = checkSkillTokens(skill);
  assert.deepEqual(problems, [
    "type role `small` has no row in SKILL.md's table; add one",
    "motion `hold` has no row in SKILL.md's table; add one",
  ]);
});

test("rows count only in their own table, and a shared row names each motion", () => {
  const rows = tableRowNames(SKILL);
  assert.ok(rows.motion.has("lift") && rows.motion.has("follow") && rows.motion.has("snap"));
  assert.ok(rows["type role"].has("caption"));
  assert.ok(!rows.motion.has("caption"), "type rows are not motion rows");
  assert.ok(!rows.motion.has("--radius-xl"), "radius rows are not motion rows");
  // A row moved out of its table no longer counts.
  const moved = SKILL.replace(/^(\| `breathe` .*)\n/m, "").replace(/^(### Radius.*)$/m, "$1\n\n| `breathe` | moved |");
  assert.ok(!tableRowNames(moved).motion.has("breathe"));
});
