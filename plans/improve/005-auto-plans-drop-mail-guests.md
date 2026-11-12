# Plan 005: Automatically added plans never invite guests a sender chose

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/improve/README.md` — unless a reviewer dispatched you and told you
> they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8a254600..HEAD -- packages/engine/src/legacy/service.ts apps/desktop/tests/service.test.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security (AI acting on untrusted mail)
- **Planned at**: commit `8a254600`, 2026-11-11
- **Suggested executor**: Devin SWE-2 or Claude Sonnet 5.5 (non-UI, small)

## Why this matters

The released app (legacy engine) has an opt-in setting, "Automatically add
plans" (`autoCalendar`, default off). When it is on, every new non-spam email
goes through the Plans model, and every event the model extracts is saved to
the owner's calendar **with no click**, including the `guests` list the model
returned. The guests come from the email, so the sender decides who is on the
owner's event. On Google the event is saved with attendees (no invitation
email is sent); on Outlook (Graph) and some CalDAV servers, saving an event
with attendees **sends invitations from the owner's account** (recorded in
`DECISIONS.md:191`: "Graph cannot save meetings without notifying guests").
That is an AI-driven outbound action triggered by untrusted content, which the
Ask path deliberately forbids (Ask filters guests to people the owner already
knows), and it contradicts a decision already on record, `DECISIONS.md:280`:
"A plan with guests lists them on the card ("Invites …") so a one-click Add
never sends invitations the user did not see." The automatic path has no card
at all, so the code has drifted from that decision. After this plan, the two automatic save
paths strip guests; events the owner adds by hand are unchanged. The new
engine's own version of the setting (`calendar.autoAddPlans`) is not wired yet;
this plan records the rule for it in `DECISIONS.md`.

## Current state

- `packages/engine/src/legacy/writer.ts:203` — extraction validates guests with
  a predicate that accepts everyone:
  `.map(e => calendarEvent(e, () => true))`. (Do not change this: the manual
  "Add to calendar" flow shows the guests to the owner before saving.)
- `packages/engine/src/legacy/service.ts:1176-1195` — **automatic path 1**, during sync:

```ts
                  const extracted = await writer('plan').extractEvents(before, signal);
                  for (const event of extracted) {
                    if (signal.aborted || !state.settings.autoCalendar) break;
                    if (
                      !event.title ||
                      !event.start ||
                      !event.end ||
                      !Number.isFinite(Date.parse(event.start)) ||
                      Date.parse(event.end) <= Date.parse(event.start)
                    )
                      continue;
                    await invoke('calendar.save', {
                      event: {
                        ...event,
                        id: randomUUID(),
                        accountId: a.id,
                        threadId: before.id,
                        calendarId: event.calendarId || 'primary',
                      },
                    });
                  }
```

- `packages/engine/src/legacy/service.ts:2140-2142` — **automatic path 2**, the
  `calendar.extract` method when `autoCalendar` is on:

```ts
        if (state.settings.autoCalendar)
          for (const e of candidates)
            await invoke('calendar.save', { event: { ...e, id: e.id || randomUUID() } });
        return candidates;
```

  Note: `candidates` is also **returned** to the UI. Strip guests only in the
  object passed to `calendar.save`, so the returned candidates keep theirs.

- The new engine: `packages/engine/src/runtime/settings.ts:52` defines
  `calendar: { autoAddPlans: false, ... }` and the Settings screen shows the
  toggle, but nothing in `packages/engine/src` reads `autoAddPlans` yet
  (`grep -rn autoAddPlans packages/engine/src` → only the default).

- Existing test to extend: `apps/desktop/tests/service.test.ts:328-424`,
  "sync classifies fresh mail, auto-adds definite events, and preserves edits
  despite visible AI failures". Its fake `groq.extractEvents` returns two events
  for thread `live-one` (lines ~383-394) and its fake `google.saveEvent` echoes
  the event (`saveEvent: async (_account, event) => ({ ...event, remoteId: 'google-event' })`).

## Commands you will need

| Purpose | Command (from the repo root) | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 |
| This test file | `node scripts/audit/electron-node.mjs --import tsx --test apps/desktop/tests/service.test.ts` | all pass |
| Engine suite | `npm run test:engine` | all pass |
| Typecheck | `npm run typecheck` | exit 0 |
| Full gate | `npm run check` | exit 0 |

## Scope

**In scope**:
- `packages/engine/src/legacy/service.ts` (the two automatic save sites only)
- `apps/desktop/tests/service.test.ts`
- `DECISIONS.md` (append one entry at the end)

**Out of scope**:
- `packages/engine/src/legacy/writer.ts`, `proposals.ts`, `ask.ts` — the
  manual flows show guests to the owner first; keep them.
- `apps/desktop/src/main/microsoft.ts`, `caldav.ts`, `google.ts` — don't change
  how providers save attendees.
- Wiring `autoAddPlans` in the new engine (a feature, not this fix).

## Git workflow

- Branch from `origin/revamp`: `rv/improve/005-auto-plans-guests`.
- Commit style: `Legacy engine: auto-added plans carry no guests from mail (improve 005)`.
- `npm run check` before each commit; author Kainoa Newton <k@kainoa.me>. Never touch `main`.

## Steps

### Step 1: Write the failing test first

In `service.test.ts`, in the test named above:
1. Give the first fake extracted event a guest list:
   `guests: ['stranger@evil.example', 'test@example.com']`.
2. Record what reaches the provider: change the fake `saveEvent` to push each
   `event` into a `saved: any[]` array declared beside `let calls = 0;`, then
   return as before.
3. After `account.connect`, assert:
   `assert.deepEqual(saved.find(e => e.title === 'Review meeting')?.guests ?? [], [])`.

**Verify**: run the test file → this test FAILS (guests are passed through today).
If it passes already, STOP (see STOP conditions).

### Step 2: Strip guests on automatic path 1

At `service.ts` ~1187, add `guests: []` to the event object passed to
`calendar.save` (after `...event`, so it wins).

**Verify**: run the test file → the test now passes.

### Step 3: Strip guests on automatic path 2

At `service.ts` ~2142, pass `{ ...e, guests: [], id: e.id || randomUUID() }` to
`calendar.save`. Leave `return candidates;` unchanged.

Add a second small test if `service.test.ts` already has a `calendar.extract`
test (search for `'calendar.extract'`): with `autoCalendar: true`, the saved
event has `guests: []` and the returned candidate still has its guests. If no
such test exists, add one modelled on the sync test's setup (same fakes, call
`service.invoke('calendar.extract', { threadId: 'live-one' })` after connect).

**Verify**: run the test file → all pass.

### Step 4: Record the rule

Append to the end of `DECISIONS.md`, matching the format of the last entries
(`## <date> — <lane>: <title>` then `- **Chosen:**` / `- **Why:**` bullets).
Use today's date:

```markdown
## <YYYY-MM-DD> — improve 005: plans added automatically carry no guests from mail

- **Chosen:** events the Plans model extracts from mail and saves without a click (legacy `autoCalendar`; the new
  engine's `calendar.autoAddPlans` once it is wired) are saved with no guests. Events the owner adds or confirms by
  hand keep the guests they saw on the card.
- **Why:** the guest list comes from the email, so its sender would choose who is on the owner's event, and Graph and
  some CalDAV servers send invitations on save. This restores the rule at line ~280 ("a one-click Add never sends
  invitations the user did not see") for the path that has no card.
```

**Verify**: `tail -8 DECISIONS.md` shows the entry.

### Step 5: Full gate

**Verify**: `npm run test:engine && npm run check` → exit 0.

## Test plan

- Extend the existing auto-add sync test (Step 1).
- One `calendar.extract` auto-save test (Step 3).

## Done criteria

- [ ] The new assertions fail on `8a254600` and pass after the change
- [ ] `grep -n "guests: \[\]" packages/engine/src/legacy/service.ts` shows 2 sites
- [ ] `DECISIONS.md` ends with the new entry
- [ ] `npm run check` exits 0; only in-scope files changed
- [ ] `plans/improve/README.md` status row updated

## STOP conditions

- The Step 1 test passes before any change (something upstream already strips
  guests): report where.
- `calendar.save` rejects an event with `guests: []` (validation requires a
  non-empty array or `undefined`): report; don't change `calendar.save`.
- `DECISIONS.md` has a merge-union or ownership rule that forbids appending
  from this lane (`plans/OWNERS.md`): report and leave the entry text in the PR
  description instead.

## Maintenance notes

- Whoever wires `calendar.autoAddPlans` in the new engine must apply the same
  rule; the DECISIONS entry is the pointer.
- Reviewer: confirm the manual "Add to calendar" proposal path still shows and
  saves guests the owner accepted.
