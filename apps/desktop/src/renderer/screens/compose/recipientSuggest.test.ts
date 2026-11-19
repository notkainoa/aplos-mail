/** Recipient type-ahead (DESIGN 7.6): what is offered, the highlight and keys, and the asking loop (debounce, stale answers). */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createHarness } from '../../data/harness';
import { createSuggestLoop } from './runtime/suggestLoop';
import {
  freshEntries,
  initialActive,
  moveActive,
  SUGGEST_DEBOUNCE_MS,
  SUGGEST_LIMIT,
  suggestKey,
  toSuggestions,
  withOtherAccounts,
  type SuggestEntry,
} from './model/suggestions';

const person = (address: string, name?: string): SuggestEntry => ({
  address,
  ...(name ? { name } : {}),
  sentTo: 1,
  receivedFrom: 1,
});
const JORDAN = person('jordan.lee@example.com', 'Jordan Lee');
const JOANNA = person('Joanna.Pierce@example.com', 'Joanna Pierce');
const JONAS = person('jonas@example.org');

describe('toSuggestions', () => {
  test('keeps the engine order, makes ids from the lower-cased address, and skips people already on the row', () => {
    const list = toSuggestions(
      [JORDAN, JOANNA, JONAS],
      [{ id: 'jordan.lee@example.com', address: 'jordan.lee@example.com' }],
    );
    assert.deepEqual(
      list.map(r => r.id),
      ['joanna.pierce@example.com', 'jonas@example.org'],
    );
    assert.equal(list[0]?.address, 'Joanna.Pierce@example.com', 'the address keeps its case');
    assert.equal(list[1]?.name, undefined);
  });

  test('drops repeats and addresses the composer would refuse, and caps the list', () => {
    assert.deepEqual(toSuggestions([JORDAN, JORDAN, person('not an address')], []).length, 1);
    const many = Array.from({ length: 12 }, (_, i) => person(`p${i}@example.com`));
    assert.equal(toSuggestions(many, []).length, SUGGEST_LIMIT);
  });
});

describe('highlight and keys', () => {
  const list = toSuggestions([JORDAN, JOANNA, JONAS], []);
  const ids = list.map(r => r.id);

  test('a name being typed highlights the first match; a typed address highlights nothing', () => {
    assert.equal(initialActive('jo', list), ids[0]);
    assert.equal(initialActive('jordan@', list), undefined, 'Return must commit what was typed');
    assert.equal(initialActive('jordan＠x', list), undefined, 'the fullwidth ＠ of an IME counts');
    assert.equal(initialActive('jordan﹫x', list), undefined, 'so does the small ﹫');
    assert.equal(initialActive('jo', []), undefined);
  });

  test('the arrows move and wrap; from nothing, down is the first and up is the last', () => {
    assert.equal(moveActive(list, undefined, 1), ids[0]);
    assert.equal(moveActive(list, undefined, -1), ids[2]);
    assert.equal(moveActive(list, ids[2], 1), ids[0]);
    assert.equal(moveActive(list, ids[0], -1), ids[2]);
    assert.equal(moveActive([], undefined, 1), undefined);
  });

  test('ArrowDown, ArrowUp, Tab and Esc act while the list is open; Tab with nothing highlighted and any key with the list shut do not', () => {
    assert.deepEqual(suggestKey('ArrowDown', false, list, ids[0]), {
      type: 'highlight',
      id: ids[1],
    });
    assert.deepEqual(suggestKey('ArrowUp', false, list, ids[0]), { type: 'highlight', id: ids[2] });
    assert.deepEqual(suggestKey('Tab', false, list, ids[1]), { type: 'accept', id: ids[1] });
    assert.equal(suggestKey('Tab', true, list, ids[1]), null, 'Shift+Tab moves back as usual');
    assert.equal(
      suggestKey('Tab', false, list, undefined),
      null,
      'nothing highlighted: Tab moves on',
    );
    assert.deepEqual(suggestKey('Escape', false, list, undefined), { type: 'close' });
    assert.equal(suggestKey('a', false, list, ids[0]), null);
    for (const key of ['ArrowDown', 'Tab', 'Escape'])
      assert.equal(suggestKey(key, false, [], undefined), null, `${key} with the list shut`);
  });
});

describe('freshEntries', () => {
  const answer = { entries: [JORDAN], asked: { query: 'jo', accountId: 'a1' } };

  test('an answer shows only for the exact trimmed text and account it was asked for', () => {
    assert.deepEqual(freshEntries(answer, 'jo', 'a1'), [JORDAN]);
    assert.deepEqual(freshEntries(answer, ' jo ', 'a1'), [JORDAN], 'the text is compared trimmed');
    assert.deepEqual(freshEntries(answer, 'jon', 'a1'), [], 'newer text: nothing until it answers');
    assert.deepEqual(
      freshEntries(answer, 'jo', 'a2'),
      [],
      "another From account: not this one's people",
    );
    assert.deepEqual(freshEntries(null, 'jo', 'a1'), []);
  });
});

describe('the asking loop', () => {
  function rig(answer: (query: string, accountId: string) => Promise<readonly SuggestEntry[]>) {
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const asked: [string, string][] = [];
    const results: (readonly SuggestEntry[])[] = [];
    const answers: { query: string; accountId: string }[] = [];
    const loop = createSuggestLoop({
      suggest: (q, a) => {
        asked.push([q, a]);
        return answer(q, a);
      },
      onResult: (r, asked) => {
        results.push(r);
        answers.push(asked);
      },
      schedule: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return () => {
          t.live = false;
        };
      },
    });
    const fire = () => timers.filter(t => t.live).forEach(t => ((t.live = false), t.fn()));
    return { loop, asked, results, answers, fire, timers };
  }
  const tick = () => new Promise<void>(r => setImmediate(r));

  test('typing asks once after the pause, for the From account, with the trimmed text', async () => {
    const r = rig(async () => [JORDAN]);
    r.loop.update('j', 'acct-1');
    r.loop.update('jo', 'acct-1');
    r.loop.update(' jor ', 'acct-1');
    assert.deepEqual(r.asked, [], 'nothing is asked while typing');
    assert.equal(r.timers.at(-1)?.ms, SUGGEST_DEBOUNCE_MS);
    r.fire();
    await tick();
    assert.deepEqual(r.asked, [['jor', 'acct-1']], 'one ask, for the last text');
    assert.deepEqual(r.results.at(-1), [JORDAN]);
    assert.deepEqual(
      r.answers.at(-1),
      { query: 'jor', accountId: 'acct-1' },
      'the answer names its question',
    );
  });

  test('a changed From account asks again, and empty text clears at once without asking', async () => {
    const r = rig(async () => [JORDAN]);
    r.loop.update('jo', 'acct-1');
    r.fire();
    await tick();
    r.loop.update('jo', 'acct-2');
    r.fire();
    await tick();
    assert.deepEqual(r.asked, [
      ['jo', 'acct-1'],
      ['jo', 'acct-2'],
    ]);
    r.loop.update('  ', 'acct-2');
    assert.deepEqual(r.results.at(-1), []);
    r.fire();
    assert.equal(r.asked.length, 2);
  });

  test('a slow answer for an older question never replaces a newer one', async () => {
    const waiting: ((v: readonly SuggestEntry[]) => void)[] = [];
    const r = rig(() => new Promise(res => waiting.push(res)));
    r.loop.update('jo', 'a');
    r.fire();
    r.loop.update('jor', 'a');
    r.fire();
    waiting[1]!([JORDAN]);
    await tick();
    waiting[0]!([JORDAN, JOANNA, JONAS]);
    await tick();
    assert.deepEqual(r.results, [[JORDAN]], 'only the newest answer landed');
  });

  test('a failed ask shows nothing, a late answer after dispose is dropped, and a pending ask is cancelled', async () => {
    const bad = rig(async () => {
      throw new Error('no engine');
    });
    bad.loop.update('jo', 'a');
    bad.fire();
    await tick();
    assert.deepEqual(bad.results.at(-1), [], 'quiet, no error');

    let late: ((v: readonly SuggestEntry[]) => void) | undefined;
    const r = rig(() => new Promise(res => (late = res)));
    r.loop.update('jo', 'a');
    r.fire();
    r.loop.dispose();
    late?.([JORDAN]);
    await tick();
    assert.deepEqual(r.results, []);

    const pending = rig(async () => [JORDAN]);
    pending.loop.update('jo', 'a');
    pending.loop.dispose();
    pending.fire();
    assert.deepEqual(pending.asked, [], 'the cancelled timer never asks');
  });
});

describe('Contact/suggest through the data layer on the stand-in', () => {
  test('answers from local mail only, filtered by the From account, and the entries fit the dropdown', async () => {
    const h = createHarness();
    try {
      await h.settle();
      const accounts = await h.truth.api.account.get({});
      const account = accounts.list[0]!;
      const all = (
        await h.layer.api.contact.suggest({ query: '', accountId: account.id, limit: 20 })
      ).list;
      assert.ok(all.length > 0, 'the demo mail has correspondents');
      const none = await h.layer.api.contact.suggest({ query: '', accountId: 'no-such-account' });
      assert.deepEqual(none.list, [], 'another account has none of them');
      const shown = toSuggestions(all, []);
      assert.ok(shown.length > 0 && shown.length <= SUGGEST_LIMIT);
      const first = shown[0]!;
      const narrowed = (
        await h.layer.api.contact.suggest({
          query: first.address.slice(0, 3),
          accountId: account.id,
        })
      ).list;
      assert.ok(
        narrowed.some(e => e.address.toLowerCase() === first.id),
        'a typed prefix finds them',
      );
    } finally {
      h.close();
    }
  });
});

describe('withOtherAccounts', () => {
  test("a person only another account knows is still offered, after the From account's own, without repeats", () => {
    const maya = person('maya@garden.example', 'Maya Chen');
    const merged = withOtherAccounts([JORDAN], [JORDAN, maya, person('MAYA@garden.example')]);
    assert.deepEqual(
      merged.map(e => e.address),
      ['jordan.lee@example.com', 'maya@garden.example'],
    );
    assert.deepEqual(withOtherAccounts([], [maya]), [maya]);
  });
});
