#!/usr/bin/env node
// Budget register check (plan 40 Q3 deliverable 6). Usage: node scripts/audit/check-budgets.mjs [file] [--now YYYY-MM-DD]
// Fails when a row has no owner, environment or gate, an id appears twice, a number is not a
// non-negative number, or a measurement is older than the row's maxAgeDays. A row never measured
// is reported as "awaiting first measurement" until its dueBy date and fails after it, so a
// harness that never lands cannot stay green.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const gates = ['hard-3x', 'trend-10pct', 'record', 'tighten-only', 'required', 'release'];
export const calibrations = ['calibrate', 'set'];
const dayMs = 24 * 60 * 60 * 1000;

const isText = value => typeof value === 'string' && value.trim() !== '';
const isNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isDate = value =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
const idPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

const startOfDay = date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** Returns { errors, awaiting } for a parsed budgets.json. `now` is injectable for tests. */
export function checkBudgets(register, now = new Date()) {
  const errors = [];
  const awaiting = [];
  if (!register || !Array.isArray(register.rows)) {
    return { errors: ['budgets.json needs a "rows" array'], awaiting };
  }
  const seen = new Set();
  register.rows.forEach((row, index) => {
    const label = isText(row?.id) ? row.id : `row #${index + 1}`;
    const fail = message => errors.push(`${label}: ${message}`);
    checkId(row, seen, fail);
    checkDescriptors(row, fail);
    checkValue(row, fail);
    checkMeasurement(row, label, now, fail, awaiting);
  });
  return { errors, awaiting };
}

function checkId(row, seen, fail) {
  if (!isText(row?.id)) fail('missing id');
  else if (!idPattern.test(row.id))
    fail('id must be lower-case words joined by "." or "-", no spaces');
  else if (seen.has(row.id.toLowerCase())) fail('duplicate id');
  else seen.add(row.id.toLowerCase());
}

function checkDescriptors(row, fail) {
  if (!isText(row?.owner)) fail('missing owner');
  if (!isText(row?.environment)) fail('missing environment');
  if (!isText(row?.gate)) fail('missing gate');
  else if (!gates.includes(row.gate)) fail(`unknown gate "${row.gate}"`);
  if (row?.secondaryGate != null && !gates.includes(row.secondaryGate)) {
    fail(`unknown secondaryGate "${row.secondaryGate}"`);
  }
  if (!calibrations.includes(row?.calibration)) fail('calibration must be "calibrate" or "set"');
}

function checkValue(row, fail) {
  if (row?.value == null) {
    if (!isText(row?.source)) fail('a null value needs a source naming the plan section');
  } else if (!isNumber(row.value))
    fail(`value ${JSON.stringify(row.value)} must be a number of 0 or more`);
  else if (!isText(row?.unit)) fail('a value needs a unit');
  if (row?.alertPct != null && !(isNumber(row.alertPct) && row.alertPct > 0)) {
    fail('alertPct must be a positive number');
  }
  if (!isDate(row?.dueBy)) fail('dueBy must be an ISO date for the first measurement');
}

function checkMeasurement(row, label, now, fail, awaiting) {
  if (row?.lastMeasured == null) {
    if (isDate(row?.dueBy) && new Date(row.dueBy) < startOfDay(now)) {
      fail(`overdue: no first measurement, due by ${row.dueBy}`);
    } else {
      awaiting.push(
        `${label}: awaiting first measurement (${row?.calibration ?? 'unknown'}, due by ${row?.dueBy})`,
      );
    }
    return;
  }
  const measured = new Date(row.lastMeasured);
  if (Number.isNaN(measured.getTime()))
    return fail(`lastMeasured "${row.lastMeasured}" is not a date`);
  if (measured > now) return fail(`lastMeasured ${row.lastMeasured} is in the future`);
  if (!(typeof row.maxAgeDays === 'number' && row.maxAgeDays > 0)) {
    return fail('a measured row needs a positive maxAgeDays');
  }
  const ageDays = Math.floor((now - measured) / dayMs);
  if (ageDays > row.maxAgeDays) {
    fail(`stale: measured ${row.lastMeasured}, ${ageDays} days ago, allowed ${row.maxAgeDays}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const args = process.argv.slice(2);
  const nowFlag = args.indexOf('--now');
  const now = nowFlag === -1 ? new Date() : new Date(args.splice(nowFlag, 2)[1]);
  if (Number.isNaN(now.getTime())) {
    console.error('usage: node scripts/audit/check-budgets.mjs [file] [--now YYYY-MM-DD]');
    process.exit(2);
  }
  const file = resolve(args[0] ?? `${root}/budgets.json`);
  const register = JSON.parse(readFileSync(file, 'utf8'));
  const { errors, awaiting } = checkBudgets(register, now);
  for (const line of awaiting) console.log(`awaiting: ${line}`);
  for (const line of errors) console.error(`FAIL: ${line}`);
  console.log(
    `${register.rows?.length ?? 0} budgets: ${errors.length} failing, ${awaiting.length} awaiting first measurement`,
  );
  process.exit(errors.length ? 1 : 0);
}
