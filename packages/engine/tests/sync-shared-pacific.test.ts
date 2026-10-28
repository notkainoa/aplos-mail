// Temporary home: these move next to the shared provider code when the engine restructure lands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPacificMidnight } from '../../../apps/desktop/src/host/providers/shared/pacific';

const iso = (ms: number) => new Date(ms).toISOString();
const at = (s: string) => Date.parse(s);

test('an ordinary winter and summer day', () => {
  assert.equal(iso(nextPacificMidnight(at('2026-01-15T20:00:00Z'))), '2026-01-16T08:00:00.000Z'); // PST, UTC-8
  assert.equal(iso(nextPacificMidnight(at('2026-07-15T20:00:00Z'))), '2026-07-16T07:00:00.000Z'); // PDT, UTC-7
});

test('spring forward on 2026-03-08: the day is 23 hours long', () => {
  // Mar 7 noon PST -> Mar 8 00:00 PST
  assert.equal(iso(nextPacificMidnight(at('2026-03-07T20:00:00Z'))), '2026-03-08T08:00:00.000Z');
  // Mar 8 03:30 PDT (just after the jump) -> Mar 9 00:00 PDT
  assert.equal(iso(nextPacificMidnight(at('2026-03-08T10:30:00Z'))), '2026-03-09T07:00:00.000Z');
  // Mar 8 01:59:59 PST (just before the jump)
  assert.equal(iso(nextPacificMidnight(at('2026-03-08T09:59:59Z'))), '2026-03-09T07:00:00.000Z');
  assert.equal(
    nextPacificMidnight(at('2026-03-08T08:00:00Z')) - at('2026-03-08T08:00:00Z'),
    23 * 3600_000,
  );
});

test('fall back on 2026-11-01: the day is 25 hours long and 01:30 happens twice', () => {
  // Oct 31 evening PDT -> Nov 1 00:00 PDT
  assert.equal(iso(nextPacificMidnight(at('2026-11-01T03:00:00Z'))), '2026-11-01T07:00:00.000Z');
  // first 01:30 (PDT), second 01:30 (PST), and noon PST all land on Nov 2 00:00 PST
  for (const t of ['2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z', '2026-11-01T20:00:00Z']) {
    assert.equal(iso(nextPacificMidnight(at(t))), '2026-11-02T08:00:00.000Z', t);
  }
  assert.equal(
    nextPacificMidnight(at('2026-11-01T07:00:00Z')) - at('2026-11-01T07:00:00Z'),
    25 * 3600_000,
  );
});

test('around midnight itself: strictly the next one', () => {
  assert.equal(
    iso(nextPacificMidnight(at('2026-10-27T06:59:59.999Z'))),
    '2026-10-27T07:00:00.000Z',
  );
  assert.equal(iso(nextPacificMidnight(at('2026-10-27T07:00:00Z'))), '2026-10-28T07:00:00.000Z');
  assert.equal(
    iso(nextPacificMidnight(at('2026-10-27T07:00:00.001Z'))),
    '2026-10-28T07:00:00.000Z',
  );
  // The same edge on the PST side of the year and across the new year.
  assert.equal(
    iso(nextPacificMidnight(at('2026-12-31T07:59:59.999Z'))),
    '2026-12-31T08:00:00.000Z',
  );
  assert.equal(iso(nextPacificMidnight(at('2026-12-31T08:00:00Z'))), '2027-01-01T08:00:00.000Z');
});

test('every day of 2026 resolves to a Pacific 00:00 within 25 hours', () => {
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hourCycle: 'h23',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  for (
    let t = at('2026-01-01T00:00:00Z');
    t < at('2027-01-01T00:00:00Z');
    t += 5 * 3600_000 + 17 * 60_000
  ) {
    const next = nextPacificMidnight(t);
    assert.ok(next > t && next - t <= 25 * 3600_000, iso(t));
    assert.equal(clock.format(next), '00:00:00', iso(t));
  }
});
