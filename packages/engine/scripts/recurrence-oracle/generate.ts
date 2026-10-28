/**
 * Builds the recurrence golden corpus from two independent oracles; the engine's own module is
 * never consulted. Writes, under packages/engine/tests/fixtures/calendar/:
 *   golden.json        cases every supporting oracle agrees on (the acceptance gate)
 *   disputed.json      cases where the oracles disagree, both answers, and the side the corpus takes
 *   property-b.json    300 seeded random rules inside oracle B's subset, as B (and A) expand them
 *   disagreements.md   the disputes with a reading of RFC 5545, and the single-oracle cases
 *
 * Oracle A runs in a throwaway venv outside the repo (python-dateutil is never a repo dependency):
 *   python3 -m venv /tmp/aplos-rrule-oracle && /tmp/aplos-rrule-oracle/bin/pip install python-dateutil
 * Oracle B is read from the prov-emu-gcal worktree (override with APLOS_ORACLE_B_DIR). Then, from the repo root:
 *   npx tsx packages/engine/scripts/recurrence-oracle/generate.ts
 *   npx prettier --write packages/engine/tests/fixtures/calendar   (npm run format:check covers the fixtures)
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases, type Case, type CaseEvent } from './cases';
import { ORACLE_B_DIR, loadOracleB, type Job, type OracleResult } from './oracle-b';
import { propertyRules } from './property-rules';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'tests', 'fixtures', 'calendar');
const PYTHON = process.env.APLOS_ORACLE_PYTHON ?? '/tmp/aplos-rrule-oracle/bin/python';
const DAY = 86_400_000;
const DEFAULT_LIMIT = 5_000;

// ---------- keys (plain string arithmetic, independent of the engine) ----------

function keyMs(key: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(key);
  if (!m) throw new Error(`bad key ${key}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

function msKey(ms: number, like: string): string {
  const iso = new Date(ms).toISOString();
  const date = iso.slice(0, 10).replace(/-/g, '');
  if (like.length === 8) return date;
  return `${date}T${iso.slice(11, 19).replace(/:/g, '')}${like.endsWith('Z') ? 'Z' : ''}`;
}

/** An end `ms` after a start key, in the start key's own form. */
function after(key: string, ms: number, mode: string): string {
  if (key.length === 8 && mode !== 'date') return msKey(keyMs(key) + DAY, key);
  return msKey(keyMs(key) + ms, key);
}

// ---------- applying overrides, range and limit to an oracle's recurrence set ----------

export interface Expected {
  recurrenceId: string;
  start: string;
  end: string;
  overridden: boolean;
}

function materialise(res: Extract<OracleResult, { status: 'ok' }>, c: Case): Expected[] {
  const from = Date.parse(c.range.from);
  const to = Date.parse(c.range.to);
  const overrides = new Map(res.overrides.map(o => [o.recurrenceId, o]));
  const list: (Expected & { at: number })[] = [];
  for (const id of res.instances) {
    const o = overrides.get(id);
    if (o?.cancelled) continue;
    const start = o?.start ?? id;
    const end =
      o?.end ??
      (o?.start ? after(o.start, res.durationMs, res.mode) : after(id, res.durationMs, res.mode));
    const [s, e] = [keyMs(start), keyMs(end)];
    const inside = e > s ? s < to && e > from : s >= from && s < to;
    if (inside) list.push({ recurrenceId: id, start, end, overridden: o !== undefined, at: s });
  }
  list.sort((a, b) => a.at - b.at || (a.recurrenceId < b.recurrenceId ? -1 : 1));
  return list.slice(0, c.limit ?? DEFAULT_LIMIT).map(({ at: _at, ...rest }) => rest);
}

// ---------- running the oracles ----------

function cutoffOf(c: Pick<Case, 'range' | 'event'>): number {
  let cutoff = Date.parse(c.range.to);
  for (const o of c.event.overrides ?? []) {
    const id = o.recurrenceId;
    const text =
      typeof id === 'string'
        ? id
        : 'utc' in id
          ? new Date(id.utc).toISOString()
          : 'date' in id
            ? id.date
            : id.local;
    cutoff = Math.max(cutoff, keyMs(text.replace(/[-:]/g, '').slice(0, 15).replace(/\..*$/, '')));
  }
  return cutoff + 3 * DAY;
}

function jobOf(id: string, event: CaseEvent, cutoff: number): Job {
  return { id, ...event, cutoff };
}

function runA(jobs: Job[]): { engine: string; results: Map<string, OracleResult> } {
  const raw = execFileSync(PYTHON, ['-I', join(here, 'oracle_a.py')], {
    input: JSON.stringify(jobs),
    maxBuffer: 1 << 28,
  });
  const parsed = JSON.parse(raw.toString()) as { engine: string; results: OracleResult[] };
  return { engine: parsed.engine, results: new Map(parsed.results.map(r => [r.id, r])) };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function agree(a: OracleResult, b: OracleResult): boolean {
  if (a.status !== 'ok' || b.status !== 'ok') return false;
  return (
    a.mode === b.mode &&
    a.durationMs === b.durationMs &&
    same(a.instances, b.instances) &&
    same(a.overrides, b.overrides)
  );
}

// ---------- the reading of RFC 5545 for every known dispute ----------

const READINGS: Record<string, { side: 'A' | 'B'; reading: string }> = {
  'ordinal-yearly-20th-monday': {
    side: 'A',
    reading:
      'RFC 5545 §3.3.10: with FREQ=YEARLY and no BYMONTH, a BYDAY ordinal counts within the year ("+20MO ... the 20th Monday within the YEARLY rule"). Oracle B counts within DTSTART\'s month instead (documented in its header), so it finds no 20th Monday at all. The corpus takes A (the RFC).',
  },
  'ordinal-yearly-last-sunday-june-start': {
    side: 'A',
    reading:
      "YEARLY;BYDAY=-1SU without BYMONTH is the last Sunday of the year (late December). B reads the ordinal within DTSTART's month and returns the last Sunday of June each year. A also drops the June DTSTART because the rule does not produce it (see the DTSTART note below). The corpus takes A.",
  },
  'setpos-weekly-last-of-week': {
    side: 'A',
    reading:
      'RFC 5545 §3.3.10 lets BYSETPOS apply to any frequency ("within the set of recurrence instances" of each interval); WEEKLY;BYDAY=MO,WE,FR;BYSETPOS=-1 is the Friday of each week. B applies BYSETPOS only for MONTHLY and YEARLY and so keeps all three days. The corpus takes A.',
  },
  'setpos-yearly-across-months': {
    side: 'A',
    reading:
      "For YEARLY, BYSETPOS selects within the whole year's set (here every Monday of January and February), so BYSETPOS=1 is the first Monday of January only. B applies BYSETPOS month by month and also keeps the first Monday of February. The corpus takes A.",
  },
  'mday-yearly-no-bymonth': {
    side: 'A',
    reading:
      'RFC 5545 §3.3.10\'s table marks BYMONTHDAY as "Expand" for YEARLY: without BYMONTH, YEARLY;BYMONTHDAY=15 is the 15th of every month of the year. B only uses DTSTART\'s month. The corpus takes A.',
  },
};

// ---------- main ----------

function bCommitOf(): string {
  try {
    return (
      execFileSync('git', ['-C', ORACLE_B_DIR, 'rev-parse', '--short', 'HEAD']).toString().trim() ||
      'unknown'
    );
  } catch {
    return 'unknown';
  }
}

interface Classified {
  golden: unknown[];
  disputed: unknown[];
  aOnly: string[];
  bOnly: string[];
  problems: string[];
}

function classify(
  a: { engine: string; results: Map<string, OracleResult> },
  firstA: { results: Map<string, OracleResult> },
  jobs: Job[],
  firstJobs: Job[],
  oracleB: (job: Job) => OracleResult,
): Classified {
  const result: Classified = { golden: [], disputed: [], aOnly: [], bOnly: [], problems: [] };
  const { golden, disputed, aOnly, bOnly, problems } = result;

  for (const [i, c] of cases.entries()) {
    const ra = a.results.get(c.id)!;
    const rb = oracleB(jobs[i]);
    const input = {
      ...c.event,
      range: c.range,
      ...(c.limit !== undefined ? { limit: c.limit } : {}),
    };
    const record = (oracles: string[], expected: unknown): void => {
      golden.push({
        id: c.id,
        tags: c.tags,
        ...(c.note ? { note: c.note } : {}),
        oracles,
        input,
        expected,
      });
    };

    if (c.refusal) {
      refusalCase(
        c,
        ra,
        rb,
        firstA.results.get(c.id)!,
        oracleB(firstJobs[i]),
        input,
        record,
        problems,
      );
      continue;
    }
    if (ra.status === 'refused' && rb.status === 'refused') {
      problems.push(`${c.id}: both oracles refuse (A: ${ra.error}; B: ${rb.error})`);
      continue;
    }
    if (ra.status === 'refused' && rb.status === 'ok') {
      bOnly.push(`${c.id} (A: ${ra.error})`);
      record(['B'], { ok: true, occurrences: materialise(rb, c) });
      continue;
    }
    if (ra.status === 'ok' && rb.status === 'refused') {
      aOnly.push(`${c.id} (B: ${rb.error})`);
      record(['A'], { ok: true, occurrences: materialise(ra, c) });
      continue;
    }
    if (ra.status === 'ok' && rb.status === 'ok') {
      const ea = materialise(ra, c);
      const eb = materialise(rb, c);
      if (agree(ra, rb) && same(ea, eb)) {
        record(['A', 'B'], { ok: true, occurrences: ea });
      } else {
        disputed.push(disputeFor(c.id, c.tags, input, ea, eb, problems));
      }
    }
  }
  return result;
}

/** A refused series still shows its own first instance: both oracles expand the event without its rule. */
function refusalCase(
  c: Case,
  ra: OracleResult,
  rb: OracleResult,
  fa: OracleResult,
  fb: OracleResult,
  input: unknown,
  record: (oracles: string[], expected: unknown) => void,
  problems: string[],
): void {
  if (rb.status === 'ok')
    problems.push(`${c.id}: oracle B accepts a rule the case expects to be refused`);
  else if (fa.status !== 'ok' || fb.status !== 'ok' || !agree(fa, fb))
    problems.push(`${c.id}: the oracles disagree on the first instance`);
  else {
    const first = materialise(fa, c);
    const refused = ra.status === 'ok' ? 'unsupported' : 'invalid';
    if (ra.status === 'ok' && ra.instances[0] !== fa.instances[0])
      problems.push(`${c.id}: DTSTART is not the rule's first instance`);
    record(['A', 'B'], {
      ok: false,
      refused,
      occurrences: first,
      why: { A: ra.status === 'ok' ? 'expands it' : ra.error, B: rb.error },
    });
  }
}

function disputeFor(
  id: string,
  tags: string[],
  input: unknown,
  ea: Expected[],
  eb: Expected[],
  problems: string[],
): unknown {
  const reading = READINGS[id];
  if (!reading) problems.push(`${id}: oracles disagree and no reading is recorded`);
  return {
    id,
    tags,
    input,
    side: reading?.side ?? 'A',
    reading: reading?.reading ?? 'UNREVIEWED',
    expected: { ok: true, occurrences: (reading?.side ?? 'A') === 'A' ? ea : eb },
    A: ea,
    B: eb,
  };
}

/** The unset readings: a reading is recorded but the oracles now agree. */
function unsetReadings(disputed: unknown[], problems: string[]): void {
  for (const [id, _r] of Object.entries(READINGS)) {
    if (!disputed.some(d => (d as { id: string }).id === id))
      problems.push(`${id}: a reading is recorded but the oracles now agree`);
  }
}

// ---------- property sweep: random rules inside B's subset, three years each ----------

function propertySweep(oracleB: (job: Job) => OracleResult): {
  property: unknown[];
  sweepDisagreements: string[];
  swept: number;
} {
  const rules = propertyRules(20261027, 600);
  const pJobs = rules.map(r => jobOf(r.id, r.event, r.to - 1));
  const pa = runA(pJobs);
  const property: unknown[] = [];
  const sweepDisagreements: string[] = [];
  for (const [i, r] of rules.entries()) {
    if (property.length >= 300) break;
    const rb = oracleB(pJobs[i]);
    const ra = pa.results.get(r.id)!;
    if (rb.status !== 'ok')
      throw new Error(`${r.id}: the property generator left B's subset (${rb.error})`);
    const keys = rb.instances.filter(k => keyMs(k) < r.to && keyMs(k) >= r.from);
    const aKeys =
      ra.status === 'ok'
        ? ra.instances.filter(k => keyMs(k) < r.to && keyMs(k) >= r.from)
        : undefined;
    if (!aKeys || !same(aKeys, keys)) {
      sweepDisagreements.push(
        `${r.id} ${r.event.rrule} (${ra.status === 'ok' ? `A ${aKeys!.length} vs B ${keys.length}` : ra.error})`,
      );
      continue;
    }
    property.push({
      id: r.id,
      event: r.event,
      range: { from: r.from, to: r.to },
      count: keys.length,
      hash: fnv(keys.join(' ')),
      head: keys.slice(0, 30),
    });
  }
  return { property, sweepDisagreements, swept: rules.length };
}

async function main(): Promise<void> {
  const oracleB = await loadOracleB();
  const bCommit = bCommitOf();

  const jobs = cases.map(c => jobOf(c.id, c.event, cutoffOf(c)));
  const a = runA(jobs);
  const firstJobs = cases.map(c => jobOf(c.id, { ...c.event, rrule: undefined }, cutoffOf(c)));
  const firstA = runA(firstJobs);

  const golden: unknown[] = [];
  const disputed: unknown[] = [];

  const classified = classify(a, firstA, jobs, firstJobs, oracleB);
  golden.push(...classified.golden);
  disputed.push(...classified.disputed);
  unsetReadings(disputed, classified.problems);

  const sweep = propertySweep(oracleB);
  const { property, sweepDisagreements } = sweep;

  writeFileSync(
    join(out, 'golden.json'),
    `${JSON.stringify(
      {
        about:
          'Recurrence golden corpus. Inputs from scripts/recurrence-oracle/cases.ts; expected outputs from the oracles listed per case, never from the engine. Regenerate with scripts/recurrence-oracle/generate.ts.',
        oracles: { A: a.engine, B: `Google Calendar emulator rrule.ts (prov-emu-gcal ${bCommit})` },
        cases: golden,
      },
      null,
      1,
    )}\n`,
  );
  writeFileSync(
    join(out, 'disputed.json'),
    `${JSON.stringify({ about: 'Cases where the oracles disagree; `expected` follows `side`. See disagreements.md.', cases: disputed }, null, 1)}\n`,
  );
  writeFileSync(
    join(out, 'property-b.json'),
    `${JSON.stringify({
      about:
        "Seeded random rules inside oracle B's subset, each over three years. count, FNV-1a hash and first keys of the occurrence keys B and A both produce. Regenerate with generate.ts.",
      seed: 20261027,
      rules: property,
    })}\n`,
  );
  writeFileSync(
    join(out, 'disagreements.md'),
    report({
      a: a.engine,
      bCommit,
      golden: golden.length,
      disputed,
      aOnly: classified.aOnly,
      bOnly: classified.bOnly,
      sweepDisagreements,
      property: property.length,
      swept: sweep.swept,
    }),
  );

  const twoOracle = golden.filter(g => (g as { oracles: string[] }).oracles.length === 2).length;
  console.log(
    `golden: ${golden.length} cases (${twoOracle} with both oracles, ${classified.aOnly.length} A only, ${classified.bOnly.length} B only); disputed: ${disputed.length}; property: ${property.length} kept, ${sweepDisagreements.length} dropped`,
  );
  if (classified.problems.length) {
    console.error(`problems:\n  ${classified.problems.join('\n  ')}`);
    process.exitCode = 1;
  }
}

function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Found by the fuzz review, not by this generator; kept here so a regeneration keeps them. */
const ORACLE_A_DEFECTS: string[] = [
  '## Oracle A defects the fuzz found (the module follows RFC 5545)',
  '',
  "The seeded fuzz (`calendar-recurrence-fuzz.test.ts`) compares the module with oracle A over ten years. In three places dateutil is wrong and the module is right; the fuzz steers around the first two and hand tests pin the module's answers. No golden or disputed case depends on them.",
  '',
  '- **WEEKLY with BYSETPOS.** RFC 5545 §3.3.10 applies BYSETPOS to "the set of recurrence instances" of each interval, which for WEEKLY is the whole week from WKST. dateutil counts only the days of DTSTART\'s week from DTSTART on. `WEEKLY;BYDAY=FR,WE,SA;WKST=WE;BYSETPOS=1` from Sat 15 Aug 2026: dateutil says 15 Aug, the RFC (and the module) say 19 Aug, because position 1 of that week is Wed 12 Aug, before DTSTART.',
  '- **BYWEEKNO near 1 January.** Week 1 is the first week with at least four days of the year (§3.3.10). dateutil sizes the previous year from the current one, so with `WKST=SU` it calls 1-2 Jan 2027 week 53, but 2026 has 52 weeks and they are week 52. The three BYWEEKNO golden cases avoid this and rest on oracle A alone.',
  "- **A start given as an exact instant on a fall-back night.** RFC 5545 §3.3.5 picks the first of two equal wall readings only for a local time with TZID. A start given as an instant (Google's `start.dateTime` with an offset) is that instant: 09:30Z on 1 Nov 2026 in Los Angeles is the second 01:30, and Google's id for that instance ends `_20261101T093000Z`. Oracle A reads the instant back as a wall time and lands on the first 01:30, as the module did before the fix; later instances take the first reading in both.",
  '',
];

function report(r: {
  a: string;
  bCommit: string;
  golden: number;
  disputed: unknown[];
  aOnly: string[];
  bOnly: string[];
  sweepDisagreements: string[];
  property: number;
  swept: number;
}): string {
  const lines = [
    '# Recurrence oracle disagreements',
    '',
    'Generated by `packages/engine/scripts/recurrence-oracle/generate.ts`; edit the readings in that script, not here.',
    '',
    `- Oracle A: ${r.a} (time zones from Python zoneinfo).`,
    `- Oracle B: the Google Calendar emulator expander, prov-emu-gcal ${r.bCommit}, read-only.`,
    `- Golden corpus: ${r.golden} cases where every oracle that supports the case agrees.`,
    '',
    '## Disputed cases (kept out of golden.json)',
    '',
    'Each is in `disputed.json` with both answers; the module is tested against the side named here.',
    '',
  ];
  for (const d of r.disputed as {
    id: string;
    input: { rrule?: string };
    side: string;
    reading: string;
    A: Expected[];
    B: Expected[];
  }[]) {
    const show = (list: Expected[]): string =>
      list.length
        ? list
            .slice(0, 6)
            .map(e => e.recurrenceId)
            .join(', ') + (list.length > 6 ? `, ... (${list.length})` : ` (${list.length})`)
        : 'none';
    lines.push(
      `### ${d.id}`,
      '',
      `Rule \`${d.input.rrule}\`.`,
      '',
      `- A: ${show(d.A)}`,
      `- B: ${show(d.B)}`,
      `- Corpus side: **${d.side}**. ${d.reading}`,
      '',
    );
  }
  lines.push(
    '## A note that is not a disagreement: DTSTART that does not match the rule',
    '',
    'RFC 5545 §3.3.10 says DTSTART "always counts as the first occurrence" but also that a recurrence set whose DTSTART is not synchronised with the rule is undefined. Both oracles (and Google) drop a DTSTART the rule does not produce, and so does the module; the cases `unsynced-dtstart-*` pin that. A CalDAV server that keeps such a DTSTART would show one more occurrence; it is a round-2 question for CalDAV.',
    '',
    ...ORACLE_A_DEFECTS,
    '## Cases only one oracle supports (kept in golden.json with that one oracle)',
    '',
    'Oracle A only (oracle B refuses the rule part):',
    '',
    ...r.aOnly.map(x => `- ${x}`),
    '',
    "Oracle B only (dateutil refuses an UNTIL whose form differs from DTSTART's; RFC 5545 says it MUST match, but Google writes such rules, so the module reads them leniently the same way B does):",
    '',
    ...r.bOnly.map(x => `- ${x}`),
    '',
    '## Property sweep',
    '',
    `${r.swept} seeded rules were generated inside oracle B's subset; the first ${r.property} on which A and B agree over three years are in \`property-b.json\`.`,
    r.sweepDisagreements.length
      ? 'Rules dropped because A and B disagree:'
      : 'No generated rule was dropped for a disagreement before the 300 were reached.',
    '',
    ...r.sweepDisagreements.map(x => `- ${x}`),
    '',
  );
  return lines.join('\n');
}

await main();
