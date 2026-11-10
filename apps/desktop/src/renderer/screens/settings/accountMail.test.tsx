// Run: npx tsx --test 'src/renderer/screens/settings/**/*.test.{ts,tsx}'   (from apps/desktop)
// The "Turn on for existing accounts" row on Settings → AI and its palette entry: shown only for real accounts
// that keep their mail out of AI, and offered from ⌘K exactly when it is drawn.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { clearAvailability, publishAvailability, rowAvailable } from './availability';
import { createController } from './controller';
import type { SettingsApiPort, SettingsData, SettingsHost, WriteFailure } from './ports';
import { anchorMissing, anchorScroll, screenDataVersion } from './SettingsScreen';
import { accountMailFocusTarget } from './sections/ai';
import type { AccountWrite } from './settings.model';
import { INITIAL_VIEW, type SettingsView } from './view';
import { ALEX, DEMO, JORDAN } from './preview/fixtures';
import { dataOf, STATES, staticScreen } from './preview/states';

const aiPage = (accounts: Parameters<typeof dataOf>[0]): string =>
  renderToStaticMarkup(staticScreen({ title: 'ai', section: 'ai', data: dataOf(accounts) }));

const demoOff = { ...DEMO, aiAllowed: false };
const alexOff = { ...ALEX, aiAllowed: false };

test('one real account off: the row names it and offers the button', () => {
  const markup = aiPage({ accounts: [ALEX, JORDAN] });
  assert.match(markup, /data-setting-anchor="accountMail"/);
  assert.match(markup, /jordan\.lee@example\.com keeps its mail out of AI\./);
  assert.match(markup, /Turn on for existing accounts/);
});

test('two real accounts off: the row counts them', () => {
  const markup = aiPage({ accounts: [alexOff, JORDAN] });
  assert.match(markup, /2 accounts keep their mail out of AI\./);
});

test('every real account on: no row', () => {
  assert.doesNotMatch(aiPage({ accounts: [ALEX] }), /accountMail/);
});

test('a demo-only account list draws no row, even though the demo account has AI off', () => {
  const markup = aiPage({ accounts: [demoOff] });
  assert.doesNotMatch(markup, /accountMail/);
  assert.doesNotMatch(markup, /Turn on for existing accounts/);
});

test('the demo account is not counted next to a real one', () => {
  const markup = aiPage({ accounts: [ALEX, demoOff] });
  assert.doesNotMatch(markup, /accountMail/);
});

test('⌘K offers the row only when it is drawn; while accounts load it stays offered', () => {
  try {
    const base = { providers: undefined, session: undefined };
    publishAvailability({ ...base, accounts: [JORDAN] });
    assert.equal(rowAvailable('ai', 'accountMail'), true);
    publishAvailability({ ...base, accounts: [ALEX] });
    assert.equal(rowAvailable('ai', 'accountMail'), false);
    publishAvailability({ ...base, accounts: [demoOff] });
    assert.equal(rowAvailable('ai', 'accountMail'), false);
    publishAvailability({ ...base, accounts: [], accountsLoaded: false });
    assert.equal(rowAvailable('ai', 'accountMail'), true);
  } finally {
    clearAvailability();
  }
});

function harness(
  over: {
    ports?: Partial<SettingsApiPort>;
    data?: Partial<SettingsData>;
    host?: SettingsHost;
  } = {},
) {
  let view: SettingsView = { ...INITIAL_VIEW };
  let data: SettingsData = dataOf(over.data);
  const accountOverlays: (Readonly<Record<string, AccountWrite>> | null)[] = [];
  const failures: (WriteFailure | null)[] = [];
  const undos: { label: string; undo(): void | Promise<void> }[] = [];
  let current: WriteFailure | null = null;
  const setFailure = (f: WriteFailure | null) => {
    current = f;
    failures.push(f);
  };
  const actions = createController({
    ports: (over.ports ?? {}) as SettingsApiPort,
    host: { pushUndo: entry => void undos.push(entry), ...(over.host ?? {}) },
    data: () => data,
    view: () => view,
    setView: patch => {
      view = { ...view, ...patch };
    },
    setData: patch => {
      data = { ...data, ...patch };
    },
    overlay: () => {},
    accountOverlay: patch => void accountOverlays.push(patch),
    fail: setFailure,
    failure: () => current,
  });
  return {
    actions,
    accountOverlays,
    failures,
    undos,
    setFailure,
    failure: () => current,
  };
}

describe('Turn on for existing accounts (the bulk write)', () => {
  test('a refused account leaves one line naming it; the settled writes drop their own overlays', async () => {
    const calls: string[] = [];
    const refusedOnce = new Set<string>();
    const h = harness({
      data: { accounts: [alexOff, JORDAN] },
      ports: {
        accountSet: async id => {
          calls.push(id);
          // JORDAN's first write is refused; a retry goes through.
          if (id === JORDAN.id && !refusedOnce.has(id)) {
            refusedOnce.add(id);
            throw new Error('rejected');
          }
        },
      },
    });
    assert.equal(await h.actions.allowMailForAccounts([ALEX.id, JORDAN.id]), false);
    assert.deepEqual([...calls].sort(), [ALEX.id, JORDAN.id].sort());
    assert.equal(h.accountOverlays.at(-1), null, 'every overlay dropped once its write settled');
    const failure = h.failure();
    assert.equal(failure?.op, 'turn on mail for AI on jordan.lee@example.com');
    // Retry writes only the refused account, and its success clears this path's own line.
    calls.length = 0;
    failure!.retry?.();
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(calls, [JORDAN.id]);
    assert.equal(h.failure(), null);
  });

  test('two refusals read "on 2 accounts" and Retry covers both', async () => {
    const calls: string[] = [];
    const h = harness({
      data: { accounts: [alexOff, JORDAN] },
      ports: {
        accountSet: async id => {
          calls.push(id);
          throw new Error('rejected');
        },
      },
    });
    await h.actions.allowMailForAccounts([ALEX.id, JORDAN.id]);
    assert.equal(h.failure()?.op, 'turn on mail for AI on 2 accounts');
    assert.equal(h.undos.length, 0, 'nothing went on: no undo');
  });

  test('a full success clears this path’s own line only while it still holds it', async () => {
    let refuseJordan = true;
    const h = harness({
      data: { accounts: [alexOff, JORDAN] },
      ports: {
        accountSet: async id => {
          if (id === JORDAN.id && refuseJordan) throw new Error('rejected');
        },
      },
    });
    await h.actions.allowMailForAccounts([ALEX.id, JORDAN.id]);
    const sibling: WriteFailure = {
      op: 'save that account setting',
      retry: () => {},
      dismiss: () => {},
    };
    // A sibling write's failure took the slot meanwhile; this path's next success leaves it alone.
    h.setFailure(sibling);
    refuseJordan = false;
    assert.equal(await h.actions.allowMailForAccounts([JORDAN.id]), true);
    assert.equal(h.failure(), sibling);
  });

  test('one undo covers exactly the accounts the press turned on', async () => {
    const calls: [string, AccountWrite][] = [];
    const h = harness({
      data: { accounts: [alexOff, JORDAN] },
      ports: { accountSet: async (id, patch) => void calls.push([id, patch]) },
    });
    assert.equal(await h.actions.allowMailForAccounts([ALEX.id, JORDAN.id]), true);
    assert.equal(h.undos.length, 1);
    assert.equal(h.undos[0]!.label, 'Mail for AI turned on for 2 accounts');
    calls.length = 0;
    await h.undos[0]!.undo();
    assert.deepEqual(calls, [
      [ALEX.id, { aiAllowed: false }],
      [JORDAN.id, { aiAllowed: false }],
    ]);
  });

  test('a partial success names the one turned-on account in its undo and restores only it', async () => {
    const calls: [string, AccountWrite][] = [];
    const h = harness({
      data: { accounts: [alexOff, JORDAN] },
      ports: {
        accountSet: async (id, patch) => {
          calls.push([id, patch]);
          if (id === JORDAN.id) throw new Error('rejected');
        },
      },
    });
    await h.actions.allowMailForAccounts([ALEX.id, JORDAN.id]);
    assert.equal(h.undos[0]?.label, 'Mail for AI turned on for alex.moreno@example.com');
    calls.length = 0;
    await h.undos[0]!.undo();
    assert.deepEqual(calls, [[ALEX.id, { aiAllowed: false }]]);
  });
});

describe('the one failure slot: a write clears only the line it wrote', () => {
  test('a refused bulk line survives a successful Settings/set and Account/set', async () => {
    const h = harness({
      data: { accounts: [alexOff, JORDAN] },
      ports: {
        accountSet: async id => {
          if (id === JORDAN.id) throw new Error('rejected');
        },
        settingsSet: async () => {},
      },
    });
    await h.actions.allowMailForAccounts([ALEX.id, JORDAN.id]);
    const bulk = h.failure();
    assert.equal(bulk?.op, 'turn on mail for AI on jordan.lee@example.com');
    await h.actions.set({ ui: { singleKeys: false } });
    assert.equal(h.failure(), bulk, 'a settings write leaves the bulk line up');
    await h.actions.setAccount(ALEX.id, { colorTag: 'sky' });
    assert.equal(h.failure(), bulk, 'an account write leaves the bulk line up');
  });

  test('a refused bulk line also survives a guarded write', async () => {
    const h = harness({
      data: { accounts: [alexOff, JORDAN] },
      ports: {
        accountSet: async id => {
          if (id === JORDAN.id) throw new Error('rejected');
        },
        listenerSet: async () => {},
      },
    });
    await h.actions.allowMailForAccounts([ALEX.id, JORDAN.id]);
    const bulk = h.failure();
    assert.ok(bulk);
    await h.actions.setListener(true);
    assert.equal(h.failure(), bulk, 'a guarded write leaves the bulk line up');
  });

  test('a path still takes down the line it wrote itself', async () => {
    let refuse = true;
    const h = harness({
      ports: {
        settingsSet: async () => {
          if (refuse) throw new Error('rejected');
        },
      },
    });
    assert.equal(await h.actions.set({ mail: { undoSendSeconds: 20 } }, 'change undo send'), false);
    assert.equal(h.failure()?.op, 'change undo send');
    refuse = false;
    assert.equal(await h.actions.set({ mail: { undoSendSeconds: 30 } }), true);
    assert.equal(h.failure(), null, "the path's own success clears its own line");
  });

  test('Retry on a refused settings write re-runs it and clears its own line', async () => {
    let attempts = 0;
    const h = harness({
      ports: {
        settingsSet: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('rejected');
        },
      },
    });
    assert.equal(await h.actions.set({ mail: { undoSendSeconds: 20 } }, 'change undo send'), false);
    h.failure()!.retry?.();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(attempts, 2);
    assert.equal(h.failure(), null);
  });
});

// Replays the anchor effect's bookkeeping over a sequence of draws, so the spent-link rule can be
// checked without a DOM: what the miss line, scroll and focus would do at each step.
const anchorVisit = (steps: { linked: boolean; freshNav?: boolean }[]) => {
  let missing: string | null = null;
  let wasConsumed = false;
  return steps.map(step => {
    const consumed = step.freshNav ? false : wasConsumed;
    const line = anchorMissing({ looking: true, linked: step.linked, consumed })
      ? 'accountMail'
      : null;
    const move = anchorScroll({
      recording: false,
      recordingChanged: false,
      linked: step.linked,
      wasMissing: missing === 'accountMail',
      freshNav: step.freshNav ?? false,
      consumed,
    });
    missing = line;
    wasConsumed = consumed || step.linked;
    return { move, missing };
  });
};

describe('a drawn anchor is spent: the write that empties it is not a miss', () => {
  test('draw-then-vanish never shows the "not shown" line and never moves again', () => {
    const seen = anchorVisit([
      { linked: true, freshNav: true }, // the link lands on its row
      { linked: false }, // 'Turn on for existing accounts' empties it under the button
      { linked: true }, // a lagging data layer draws it once more
      { linked: false },
    ]);
    assert.deepEqual(
      seen.map(s => s.move),
      ['linked', 'none', 'none', 'none'],
    );
    assert.deepEqual(
      seen.map(s => s.missing),
      [null, null, null, null],
    );
  });

  test('a row never drawn still reads "not shown" and links the moment it appears', () => {
    const seen = anchorVisit([
      { linked: false, freshNav: true },
      { linked: false },
      { linked: true },
    ]);
    assert.deepEqual(
      seen.map(s => s.missing),
      ['accountMail', 'accountMail', null],
    );
    assert.deepEqual(
      seen.map(s => s.move),
      ['top', 'none', 'linked'],
    );
  });

  test('a re-open of the same anchor after leaving still scrolls to the row', () => {
    const seen = anchorVisit([
      { linked: true, freshNav: true },
      { linked: false }, // it left under the button
      { linked: true, freshNav: true }, // the link lands again
    ]);
    assert.equal(seen.at(-1)!.move, 'linked');
    assert.equal(seen.at(-1)!.missing, null);
  });
});

describe('the row leaves under the pressed button (DESIGN 11.2)', () => {
  const SWITCH = '[data-setting-anchor="background"] [role="switch"]';
  const root = (answers: Record<string, Element | null>, queried: string[]) => ({
    querySelector: (sel: string) => {
      queried.push(sel);
      return answers[sel] ?? null;
    },
  });

  test('the next row’s switch is asked first, then the section’s first control', () => {
    const sw = { focus() {} } as unknown as Element;
    const first = { focus() {} } as unknown as Element;
    const queried: string[] = [];
    assert.equal(accountMailFocusTarget(root({ [SWITCH]: sw }, queried)), sw);
    assert.deepEqual(queried, [SWITCH]);
    queried.length = 0;
    const fallback = root({}, queried);
    assert.equal(accountMailFocusTarget(fallback), null);
    assert.equal(queried.length, 2, 'the switch was tried before the generic control');
    assert.equal(queried[0], SWITCH);
    assert.equal(accountMailFocusTarget({ querySelector: () => first }), first);
    assert.equal(accountMailFocusTarget(null), null);
  });
});

describe('copy and redraws', () => {
  test('the per-account switch makes no consent promise', () => {
    const markup = renderToStaticMarkup(staticScreen(STATES['accounts-default']));
    assert.match(markup, /Off keeps this mailbox out of every AI feature\./);
    assert.doesNotMatch(markup, /asks your consent/);
  });

  test('an aiAllowed flip changes the data version, so a missed row resolves', () => {
    const before = dataOf({ accounts: [ALEX, JORDAN] });
    const after = dataOf({ accounts: [ALEX, { ...JORDAN, aiAllowed: true }] });
    assert.notEqual(screenDataVersion(before), screenDataVersion(after));
    // The demo account has no AI switch: its flag never moves the version.
    const demo = dataOf({ accounts: [{ ...DEMO, aiAllowed: false }] });
    assert.equal(screenDataVersion(demo), screenDataVersion(dataOf({ accounts: [DEMO] })));
  });
});
