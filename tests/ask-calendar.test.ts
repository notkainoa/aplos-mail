import test from 'node:test';
import assert from 'node:assert/strict';
import { localNow } from '../src/main/groq';

test('the clock Ask resolves relative dates with spells out weekdays and offsets',async()=>{
  const now=new Date('2026-10-20T16:00:00Z');
  const clock=localNow('America/Los_Angeles',now);
  assert.deepEqual({...clock,upcoming:undefined},{now:'2026-10-20T09:00:00-07:00',weekday:'Tuesday',timeZone:'America/Los_Angeles',upcoming:undefined});
  assert.equal(clock.upcoming[2],'Friday 2026-10-23 -07:00');
  const london=localNow('Europe/London',now);assert.equal(london.upcoming[3],'Saturday 2026-10-24 +01:00');assert.equal(london.upcoming[6],'Tuesday 2026-10-27 +00:00');assert.equal(clock.upcoming.length,14);
  assert.equal(localNow('Not/AZone',now).timeZone,Intl.DateTimeFormat().resolvedOptions().timeZone);
});
