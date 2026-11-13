/**
 * One failure, one line, always a way forward (bug #322 and its review round): the Search page stacked the
 * generic "Couldn’t load this list." over the failure's own sentence — two `role="alert"` banners for one
 * failure — and the dedupe left dead ends: a failed window whose named reason carried no Try again could never
 * be reopened until remount, an unnamed window failure beside a remote refusal or pause drew nothing the owner
 * could act on, a remote line's Try again was routed by the wrong failure, and remote-flavoured copy described a
 * local window failure it never saw. The rule these tests pin: while the window is down its own banner is the
 * page's only failure line and its Try again always reopens the view; while the window stands the remote's
 * failed/paused lines behave as they always did.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/search/*.test.ts'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchPage } from './SearchPage';
import { toSearchQuery } from './parse';
import * as searchModel from './search.model';
import {
  initialSearch,
  remoteRejected,
  resultRow,
  searchPage,
  submit,
  type LocalResults,
  type RemoteContext,
  type RemoteState,
  type ResultRow,
  type SearchPageModel,
  type SearchState,
} from './search.model';
import type { ErrorBody } from '../../data';

/**
 * The fix's pure retry routing. On the pre-fix model it falls back to the page's old `localFailed` routing, so
 * a revert shows every regression test failing on its assertions, not on a missing export.
 */
const retryTarget = (model: SearchPageModel): 'results' | 'submit' =>
  'retryTarget' in searchModel
    ? searchModel.retryTarget(model)
    : model.localFailed
      ? 'results'
      : 'submit';

const NOW = 1_000;
const KEY = 'all|invoice';

const CTX = (over: Partial<RemoteContext> = {}): RemoteContext => ({
  now: NOW,
  supported: true,
  localIds: [],
  scope: 'all',
  ...over,
});

const LOCAL = (ids: string[], over: Partial<LocalResults> = {}): LocalResults => ({
  status: 'live',
  ids,
  total: ids.length,
  ...over,
});

const FAILED_LOCAL = (over: Partial<LocalResults> = {}): LocalResults => ({
  status: 'failed',
  ids: [],
  total: 0,
  ...over,
});

/** The remote state after a refused Return: the key `remoteKey` gives a scoped query. */
const refused = (reason: 'offline' | 'needsReauth' | 'unavailable' | 'error'): SearchState => ({
  ...initialSearch,
  field: 'invoice',
  remote: { phase: 'failed', key: KEY, reason },
});

const noop = () => undefined;
const HANDLERS = {
  onChange: noop,
  onRemoveToken: noop,
  onSubmit: noop,
  onRetryResults: noop,
  onLeaveToList: noop,
  onSelectRow: noop,
  onOpenRow: noop,
  onRowAction: noop,
};

function render(
  model: SearchPageModel,
  over: { localRows?: ResultRow[]; remoteRows?: ResultRow[] } = {},
): string {
  return renderToStaticMarkup(
    createElement(SearchPage, {
      model,
      localRows: over.localRows ?? [],
      remoteRows: over.remoteRows ?? [],
      density: 'comfortable',
      scopeLabel: 'All accounts',
      handlers: HANDLERS,
    }),
  );
}

/** Rows for whichever ids the model kept, as the screen does: `localIds` local, `remoteIds` remote. */
function renderPage(model: SearchPageModel): string {
  return render(model, {
    localRows: model.localIds.map(() => ROW),
    remoteRows: model.remoteIds.map(() => ROW),
  });
}

const alerts = (markup: string): number => markup.match(/role="alert"/g)?.length ?? 0;
const errorLines = (markup: string): number => markup.match(/class="ui-error-line"/g)?.length ?? 0;

const ROW = resultRow(
  {
    id: 't-1',
    fromName: 'Jordan Park',
    subject: 'Invoice 0412 · October illustrations',
    snippet: 'The October illustrations are finished.',
    unread: false,
    lastDate: 0,
    hasAttachments: false,
    workflow: { status: 'new', bookmarked: false, hiddenFromHome: false },
    accountId: 'a1',
  },
  toSearchQuery([], 'invoice'),
  false,
);

test('needsReauth: a refused Return and a failed window share one line, not two banners', () => {
  // The packaged sweep's case: Return's remote search and the search window both report needsReauth.
  let state = submit({ ...initialSearch, field: 'invoice' }, CTX()).state;
  state = remoteRejected(state, KEY, { type: 'needsReauth', message: 'x' });
  const model = searchPage(state, FAILED_LOCAL({ error: { type: 'needsReauth' } }), NOW);
  assert.equal(model.localFailed, true);
  assert.equal(model.localLine?.kind, 'reason');
  // The remote's own line hides while the window is down; it returns once the window stands.
  assert.equal(model.remoteLine, null);
  const markup = renderPage(model);
  assert.equal(errorLines(markup), 1);
  assert.equal(alerts(markup), 1);
  assert.ok(markup.includes('Google needs you to sign in again before it can search.'));
  // The dead window still offers a way forward: Try again reopens the view.
  assert.ok(markup.includes('Try again'));
  assert.ok(!markup.includes('Couldn’t load this list.'));
});

test('a window that failed naming a reason shows only that reason, never the generic line', () => {
  // The window's own error names the failure: no generic line, and no offer to ask Google what it just refused.
  const model = searchPage(
    { ...initialSearch, field: 'invoice' },
    FAILED_LOCAL({ error: { type: 'needsReauth' } }),
    NOW,
  );
  assert.equal(model.localLine?.kind, 'reason');
  assert.equal(model.remoteLine, null);
  assert.equal(retryTarget(model), 'results');
  const markup = renderPage(model);
  assert.equal(errorLines(markup), 1);
  assert.equal(alerts(markup), 1);
  assert.ok(markup.includes('Google needs you to sign in again before it can search.'));
  assert.ok(markup.includes('Try again'));
  assert.ok(!markup.includes('Couldn’t load this list.'));
  assert.ok(!markup.includes('Search all mail on Google'));
});

test('a window failure with no reason to name keeps the generic line and its Try again', () => {
  for (const error of [{ type: 'internal' as const, message: 'x' }, undefined, null]) {
    const model = searchPage({ ...initialSearch, field: 'invoice' }, FAILED_LOCAL({ error }), NOW);
    assert.equal(model.localFailed, true);
    assert.equal(model.localLine?.kind, 'list');
    const markup = renderPage(model);
    assert.equal(errorLines(markup), 1);
    assert.equal(alerts(markup), 1);
    assert.ok(markup.includes('Couldn’t load this list.'));
    assert.ok(markup.includes('Try again'));
  }
});

test('a remote refusal beside an unnamed window failure draws the window’s line, not the remote’s', () => {
  let state = submit({ ...initialSearch, field: 'invoice' }, CTX()).state;
  state = remoteRejected(state, KEY, { type: 'internal', message: 'x' });
  const model = searchPage(state, FAILED_LOCAL({ error: { type: 'internal' } }), NOW);
  assert.equal(model.localLine?.kind, 'list');
  assert.equal(model.remoteLine, null);
  const markup = renderPage(model);
  assert.equal(errorLines(markup), 1);
  assert.equal(alerts(markup), 1);
  assert.ok(markup.includes('Couldn’t load this list.'));
  assert.ok(!markup.includes('Google didn’t answer.'));
});

test('every remote refusal reason draws its one sentence while the window stands', () => {
  const cases = [
    ['offline', 'You’re offline. Your mail on this Mac is still searched.', true],
    ['needsReauth', 'Google needs you to sign in again before it can search.', false],
    ['unavailable', 'This account can’t search on Google.', false],
    ['error', 'Google didn’t answer.', true],
  ] as const;
  for (const [reason, text, tries] of cases) {
    const model = searchPage(refused(reason), LOCAL([]), NOW);
    assert.equal(model.remoteLine?.kind, 'failed');
    assert.equal(model.localLine, null);
    assert.equal(retryTarget(model), 'submit', reason);
    const markup = renderPage(model);
    assert.equal(errorLines(markup), 1, reason);
    assert.equal(alerts(markup), 1, reason);
    assert.ok(markup.includes(text), `${reason}: ${text}`);
    assert.equal(markup.includes('Try again'), tries, reason);
  }
});

test('a window stopped by a rate limit shows the pause notice with a way forward', () => {
  const model = searchPage(
    { ...initialSearch, field: 'invoice' },
    FAILED_LOCAL({ error: { type: 'paused', resumeAt: 61_000 } }),
    NOW,
  );
  assert.equal(model.localLine?.kind, 'reason');
  assert.equal(model.remoteLine, null);
  const markup = renderPage(model);
  assert.equal(errorLines(markup), 1);
  assert.equal(alerts(markup), 1);
  assert.ok(markup.includes('Google asked us to slow down. Search again at'));
  assert.ok(markup.includes('Try again'));
  assert.ok(!markup.includes('Couldn’t load this list.'));
});

test('local results still render under a remote failure, with one notice', () => {
  const model = searchPage(refused('needsReauth'), LOCAL(['t-1']), NOW);
  const markup = renderPage(model);
  assert.ok(markup.includes('role="listbox"'));
  assert.ok(markup.includes('search-row-t-1'));
  assert.equal(errorLines(markup), 1);
  assert.equal(alerts(markup), 1);
  assert.ok(markup.includes('Google needs you to sign in again before it can search.'));
});

test('a failed window that kept its rows shows them under one notice', () => {
  const model = searchPage(
    refused('needsReauth'),
    FAILED_LOCAL({ ids: ['t-1'], total: 1, error: { type: 'needsReauth' } }),
    NOW,
  );
  const markup = renderPage(model);
  assert.ok(markup.includes('role="listbox"'));
  assert.equal(errorLines(markup), 1);
  assert.equal(alerts(markup), 1);
  assert.ok(!markup.includes('Couldn’t load this list.'));
});

test('no mail matched is not a failure: the empty line carries the offer, no alert', () => {
  const model = searchPage({ ...initialSearch, field: 'dentist' }, LOCAL([]), NOW);
  assert.equal(model.noMatch, 'No mail matches ‘dentist’');
  const markup = renderPage(model);
  assert.equal(errorLines(markup), 0);
  assert.equal(alerts(markup), 0);
  assert.ok(markup.includes('No mail matches'));
});

/* ───────────────────────── review regressions ───────────────────────── */

test('R-A: a window that failed on sign-in still offers Try again, wired to reopen the view', () => {
  // The named reason used to draw without an action: after signing in the window stayed dead until remount.
  const model = searchPage(
    { ...initialSearch, field: 'invoice' },
    FAILED_LOCAL({ error: { type: 'needsReauth' } }),
    NOW,
  );
  assert.equal(model.localLine?.kind, 'reason');
  assert.equal(retryTarget(model), 'results');
  const markup = renderPage(model);
  assert.equal(alerts(markup), 1);
  assert.ok(markup.includes('Google needs you to sign in again before it can search.'));
  assert.ok(markup.includes('Try again'));
});

test('R-B: an unnamed window failure under a remote pause still draws the generic line with Try again', () => {
  // The remote pause line suppressed the generic line, so a dead window rendered nothing it could act on.
  const model = searchPage(
    {
      field: 'invoice',
      tokens: [],
      remote: { phase: 'paused', key: KEY, resumeAt: NOW + 3_600_000, at: NOW },
    },
    FAILED_LOCAL({ error: { type: 'internal' } }),
    NOW,
  );
  assert.equal(model.localLine?.kind, 'list');
  assert.equal(model.remoteLine, null);
  const markup = renderPage(model);
  assert.equal(alerts(markup), 1);
  assert.ok(markup.includes('Couldn’t load this list.'));
  assert.ok(markup.includes('Try again'));
  assert.ok(!markup.includes('Google asked us to slow down.'));
});

test('R-B: an unnamed window failure under a remote sign-in refusal still draws a way forward', () => {
  // Same dead end with a non-retryable remote line: no generic line, no Try again, one mute banner.
  const model = searchPage(
    refused('needsReauth'),
    FAILED_LOCAL({ error: { type: 'internal' } }),
    NOW,
  );
  const markup = renderPage(model);
  assert.equal(alerts(markup), 1);
  assert.ok(markup.includes('Couldn’t load this list.'));
  assert.ok(markup.includes('Try again'));
  assert.ok(!markup.includes('Google needs you to sign in again'));
});

test('R-C: a retryable remote line waits for a standing window; a downed window’s Try again is its own', () => {
  // Window down + remote retryable: the only banner is the window's, and Try again reopens the view —
  // never re-asks Google for a failure the line does not describe.
  const down = searchPage(refused('error'), FAILED_LOCAL({ error: { type: 'internal' } }), NOW);
  assert.equal(retryTarget(down), 'results');
  const downMarkup = renderPage(down);
  assert.ok(!downMarkup.includes('Google didn’t answer.'));
  assert.ok(downMarkup.includes('Couldn’t load this list.'));
  // Window standing + remote retryable: Try again re-asks Google.
  const up = searchPage(refused('error'), LOCAL([]), NOW);
  assert.equal(retryTarget(up), 'submit');
  assert.ok(renderPage(up).includes('Google didn’t answer.'));
});

test('R-D: a window failure never wears the remote’s copy', () => {
  // "Your mail on this Mac is still searched" is false when the local window is what failed; "This account
  // can't search on Google" describes a remote refusal, not a dead local view. Both get the generic line.
  const cases: [string, Pick<ErrorBody, 'type' | 'reasonCode' | 'resumeAt'>, string][] = [
    [
      'net.offline',
      { type: 'providerError', reasonCode: 'net.offline' },
      'Your mail on this Mac is still searched.',
    ],
    ['unavailable', { type: 'unavailable' }, 'This account can’t search on Google.'],
    ['notImplemented', { type: 'notImplemented' }, 'This account can’t search on Google.'],
  ];
  for (const [name, error, banned] of cases) {
    const model = searchPage({ ...initialSearch, field: 'invoice' }, FAILED_LOCAL({ error }), NOW);
    assert.equal(model.localLine?.kind, 'list', name);
    const markup = renderPage(model);
    assert.equal(alerts(markup), 1, name);
    assert.ok(markup.includes('Couldn’t load this list.'), name);
    assert.ok(markup.includes('Try again'), name);
    assert.ok(!markup.includes(banned), name);
  }
});

/* ───────────────────────── the enumeration ───────────────────────── */

type WindowError = Pick<ErrorBody, 'type' | 'reasonCode' | 'resumeAt'> | null;

/** Every window error the model distinguishes, in the contract's own type/reasonCode names. */
const WINDOW_ERRORS: [string, WindowError][] = [
  ['needsReauth', { type: 'needsReauth' }],
  ['paused', { type: 'paused', resumeAt: NOW + 3_600_000 }],
  [
    'rate.limited',
    { type: 'providerError', reasonCode: 'rate.limited', resumeAt: NOW + 3_600_000 },
  ],
  ['quota.exceeded', { type: 'providerError', reasonCode: 'quota.exceeded' }],
  ['unavailable', { type: 'unavailable' }],
  ['notImplemented', { type: 'notImplemented' }],
  ['internal', { type: 'internal' }],
  ['net.offline', { type: 'providerError', reasonCode: 'net.offline' }],
  ['validation', { type: 'validation' }],
  ['none', null],
];

/** Every remote line the page can draw: none-yet, offer, busy, done, each refusal reason, paused. */
const REMOTE_CASES: [string, RemoteState][] = [
  ['none', { phase: 'starting', key: KEY, at: NOW, localIds: [] }],
  ['offer', { phase: 'idle' }],
  ['loading', { phase: 'running', key: KEY, at: NOW - 1_000, runId: 'r1', localIds: [] }],
  ['ok', { phase: 'done', key: KEY, runId: 'r1', localIds: [] }],
  ['failed-offline', { phase: 'failed', key: KEY, reason: 'offline' }],
  ['failed-needsReauth', { phase: 'failed', key: KEY, reason: 'needsReauth' }],
  ['failed-unavailable', { phase: 'failed', key: KEY, reason: 'unavailable' }],
  ['failed-error', { phase: 'failed', key: KEY, reason: 'error' }],
  ['paused', { phase: 'paused', key: KEY, resumeAt: NOW + 3_600_000, at: NOW }],
];

const PAUSE_COPY = 'Google asked us to slow down.';
const SIGN_IN_COPY = 'Google needs you to sign in again before it can search.';
const GENERIC_COPY = 'Couldn’t load this list.';
/** Remote-only sentences a window failure must never borrow. */
const REMOTE_ONLY_COPY = [
  'You’re offline. Your mail on this Mac is still searched.',
  'This account can’t search on Google.',
  'Google didn’t answer.',
  'Searching Google…',
  'Nothing on Google either.',
  'Search all mail on Google',
];

test('enumeration: window status × window error × remote line × results — one banner, one way forward', () => {
  const windows: [string, (has: boolean) => LocalResults][] = [
    ['live', has => LOCAL(has ? ['t-1'] : [])],
    ['opening', has => ({ status: 'opening', ids: has ? ['t-1'] : [], total: has ? 1 : 0 })],
    ['reset', has => ({ status: 'reset', ids: has ? ['t-1'] : [], total: has ? 1 : 0 })],
    ...WINDOW_ERRORS.map(([name, error]): [string, (has: boolean) => LocalResults] => [
      `failed:${name}`,
      has => FAILED_LOCAL({ ids: has ? ['t-1'] : [], total: has ? 1 : 0, error }),
    ]),
  ];
  for (const [windowName, makeLocal] of windows) {
    for (const [remoteName, remote] of REMOTE_CASES) {
      for (const has of [true, false]) {
        const tag = `${windowName} × ${remoteName} × results:${has}`;
        const local = makeLocal(has);
        const model = searchPage({ ...initialSearch, field: 'invoice', remote }, local, NOW);
        const markup = renderPage(model);
        const windowFailed = local.status === 'failed';
        const remoteFailed = remote.phase === 'failed';
        // A failure draws exactly one alert; anything else draws none.
        assert.equal(alerts(markup), windowFailed || remoteFailed ? 1 : 0, `alerts: ${tag}`);
        assert.equal(errorLines(markup), windowFailed || remoteFailed ? 1 : 0, `lines: ${tag}`);
        if (windowFailed) {
          // The window's own banner: always Try again, always the window retry, never the remote's line.
          assert.equal(retryTarget(model), 'results', tag);
          assert.equal(model.remoteLine, null, `remote line must hide: ${tag}`);
          assert.ok(markup.includes('Try again'), `no way forward: ${tag}`);
          const errorName = windowName.slice('failed:'.length);
          if (errorName === 'needsReauth') {
            assert.ok(markup.includes(SIGN_IN_COPY), tag);
          } else if (['paused', 'rate.limited', 'quota.exceeded'].includes(errorName)) {
            assert.ok(markup.includes(PAUSE_COPY), tag);
          } else {
            assert.ok(markup.includes(GENERIC_COPY), tag);
            assert.ok(!markup.includes(PAUSE_COPY), tag);
            assert.ok(!markup.includes(SIGN_IN_COPY), tag);
          }
          for (const copy of REMOTE_ONLY_COPY) assert.ok(!markup.includes(copy), `${tag}: ${copy}`);
        } else if (remoteFailed) {
          // The remote's failed line behaves as it always did: its own copy, retry only where retryable,
          // and Try again re-asks Google.
          assert.equal(model.localLine, null, tag);
          assert.equal(retryTarget(model), 'submit', tag);
          const retryable = remote.reason === 'error' || remote.reason === 'offline';
          assert.equal(markup.includes('Try again'), retryable, tag);
        } else if (remote.phase === 'paused') {
          assert.ok(markup.includes(PAUSE_COPY), tag);
        }
      }
    }
  }
});
