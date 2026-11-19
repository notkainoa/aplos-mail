#!/usr/bin/env node
// Reads plans/STATUS.md and prints the owner's review queue for the daily digest.
// Usage: node plans/tools/queue.mjs [path-to-STATUS.md]
// Read a fresh copy with: git show origin/revamp:plans/STATUS.md > /tmp/status.md
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TYPES = new Set([
  "NOTICE", "FROZEN", "HANDOFF-READY", "LANE-DONE", "REQUEST", "BLOCKED-ON",
  "CONTRACT-CHANGE-PROPOSED", "CONTRACT-CHANGE-DONE", "SLIP", "READY-FOR-OWNER",
  "APPROVED", "MERGED", "DECIDED",
]);
const THREADS = new Set(["engine", "providers", "ui-core", "ui-screens", "platform", "integrator"]);

export function parse(text) {
  const log = text.split("\n## Log")[1] ?? "";
  const entries = [];
  const problems = [];
  log.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const parts = line.split(" | ");
    const [when, thread, type, lane, ...rest] = parts;
    const entry = { when, thread, type, lane, text: rest.join(" | "), line };
    if (parts.length < 5 || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(when)) problems.push(`malformed: ${line}`);
    else if (!TYPES.has(type)) problems.push(`unknown type ${type}: ${line}`);
    else if (!THREADS.has(thread)) problems.push(`unknown thread ${thread}: ${line}`);
    else entries.push(entry);
  });
  return { entries, problems };
}

const feature = (e) => /^F(\d+)\b/.exec(e.text)?.[1];

export function queue(entries) {
  const byFeature = new Map();
  const problems = [];
  for (const e of entries) {
    if (!["READY-FOR-OWNER", "APPROVED", "MERGED"].includes(e.type)) continue;
    const f = feature(e);
    if (!f) {
      // Integrator MERGED entries for dependency PRs carry no feature number.
      if (e.type !== "MERGED" || e.thread !== "integrator") problems.push(`no F<n> in: ${e.line}`);
      continue;
    }
    const s = byFeature.get(f) ?? { feature: f, ready: [], approved: [], merged: [] };
    byFeature.set(f, s);
    if (e.type === "READY-FOR-OWNER") s.ready.push(e);
    if (e.type === "APPROVED") {
      if (!s.ready.length) problems.push(`F${f} APPROVED with no earlier READY-FOR-OWNER: ${e.line}`);
      s.approved.push(e);
    }
    if (e.type === "MERGED") {
      if (!s.ready.length || !s.approved.length) problems.push(`F${f} MERGED without earlier READY-FOR-OWNER and APPROVED (revert): ${e.line}`);
      s.merged.push(e);
    }
  }
  const last = (a) => a[a.length - 1];
  const waitingOnOwner = [];
  const inReview = [];
  for (const s of byFeature.values()) {
    const r = last(s.ready), a = last(s.approved);
    // A newer ready post after an approval means the feature came back to the owner.
    if (r && (!a || r.when > a.when)) waitingOnOwner.push({ feature: s.feature, since: r.when, text: r.text, thread: r.thread });
    else if (a && !(last(s.merged)?.when >= a.when)) inReview.push({ feature: s.feature, since: a.when, thread: a.thread });
  }
  waitingOnOwner.sort((x, y) => x.since.localeCompare(y.since));
  return { waitingOnOwner, inReview, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? new URL("../STATUS.md", import.meta.url);
  const { entries, problems } = parse(readFileSync(path, "utf8"));
  const q = queue(entries);
  const open = (t) => entries.filter((e) => e.type === t);
  console.log(`Waiting on the owner (oldest first): ${q.waitingOnOwner.length}`);
  for (const w of q.waitingOnOwner) console.log(`  F${w.feature} since ${w.since} (${w.thread}): ${w.text}`);
  console.log(`Approved, in deep review or PR: ${q.inReview.length}`);
  for (const w of q.inReview) console.log(`  F${w.feature} approved ${w.since} (${w.thread})`);
  console.log(`REQUEST entries: ${open("REQUEST").length}, BLOCKED-ON: ${open("BLOCKED-ON").length}, SLIP: ${open("SLIP").length}`);
  const issues = [...problems, ...q.problems];
  if (issues.length) {
    console.log(`Problems: ${issues.length}`);
    for (const p of issues) console.log(`  ${p}`);
    process.exitCode = 1;
  }
}
