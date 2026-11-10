/** The reader's "Add to calendar" offer: which plans are offered, when nothing shows, and the words. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Plan } from '../../data';
import { EventOfferCard } from './EventOffer';
import { MAX_OFFERS, offerOf, offersOf, offersShown } from './offerModel';

const plan = (over: Partial<Plan> = {}): Plan => ({
  id: 'acct:plan-1',
  rev: 1,
  threadId: 't1',
  title: 'Design review',
  start: { type: 'floating', local: '2026-11-12T15:00:00' },
  end: { type: 'floating', local: '2026-11-12T16:00:00' },
  allDay: false,
  state: 'open',
  ...over,
});

describe('offerOf', () => {
  test('says the title, the when line in the calendar words, the place and the day the calendar opens on', () => {
    const o = offerOf(plan({ location: ' Room 4 ' }), 'Subject');
    assert.equal(o.title, 'Design review');
    assert.equal(o.when, 'Thursday, November 12 · 3:00 – 4:00 PM');
    assert.equal(o.place, 'Room 4');
    assert.equal(o.date, '2026-11-12');
    assert.equal(o.planId, 'acct:plan-1');
  });

  test('an untitled plan takes the email subject; an all-day plan says so; no place means no place line', () => {
    const o = offerOf(
      plan({
        title: '  ',
        allDay: true,
        start: { type: 'date', date: '2026-11-14' },
        end: { type: 'date', date: '2026-11-15' },
      }),
      'Offsite plans',
    );
    assert.equal(o.title, 'Offsite plans');
    assert.match(o.when, /All day$/);
    assert.equal('place' in o, false);
    assert.equal(o.date, '2026-11-14');
  });
});

describe('offersOf and offersShown', () => {
  test('only open plans are offered, soonest first, at most two', () => {
    const list = offersOf(
      [
        plan({ id: 'c', start: { type: 'floating', local: '2026-11-20T09:00:00' } }),
        plan({ id: 'done', state: 'confirmed' }),
        plan({ id: 'gone', state: 'dismissed' }),
        plan({ id: 'a', start: { type: 'floating', local: '2026-11-12T09:00:00' } }),
        plan({ id: 'b', start: { type: 'floating', local: '2026-11-13T09:00:00' } }),
      ],
      's',
    );
    assert.deepEqual(
      list.map(o => o.planId),
      ['a', 'b'],
    );
    assert.equal(list.length, MAX_OFFERS);
  });

  test('nothing shows for an account left out of AI, an unknown account, or an email whose invitation card already shows the event', () => {
    assert.equal(offersShown({ aiAllowed: true }, false), true);
    assert.equal(offersShown({ aiAllowed: false }, false), false, 'excluded: quiet, no line');
    assert.equal(offersShown(undefined, false), false);
    assert.equal(offersShown({ aiAllowed: true }, true), false);
  });
});

describe('the card', () => {
  test('draws the words and one text button that is not filled, with no AI mark', () => {
    const markup = renderToStaticMarkup(
      createElement(EventOfferCard, {
        offer: offerOf(plan({ location: 'Room 4' }), 's'),
        onAdd: () => {},
      }),
    );
    assert.match(markup, /Design review/);
    assert.match(markup, /Thursday, November 12/);
    assert.match(markup, /Room 4/);
    assert.match(markup, />Add to calendar</);
    assert.doesNotMatch(markup, /data-variant="filled"/);
    assert.doesNotMatch(markup, /!|sparkle|AI/i);
  });
});
