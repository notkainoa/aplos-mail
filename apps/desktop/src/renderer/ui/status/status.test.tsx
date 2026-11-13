// Status family: static render checks of copy (DESIGN 7.1, 7.12, 7.15), structure, ARIA and states, with demo and
// worst-case data. Times are formatted in local time; the run pins TZ so "2:14 PM" is stable.
// Run: TZ=America/Los_Angeles npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/status/status.test.tsx
process.env.TZ = 'America/Los_Angeles';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyProblem } from '../../commands/internal';
import type { SyncAccount, SyncCheckpoint, SyncStatus } from '../props';
import {
  FatalScreen,
  ProgressSegments,
  ReconnectSheet,
  Spinner,
  StatusSlot,
  statusCopy,
  syncedLine,
} from './index';
import { failureCopy } from './ProgressSegments';

const EMAIL_80 = `${'a'.repeat(62)}@${'b'.repeat(13)}.com`;
const SUBJECT_300 =
  'Google did not answer after three tries and the newest mail will follow once it does so nothing is lost and your mail is safe on this Mac '
    .repeat(3)
    .slice(0, 300);
const RTL = 'لم يكتمل تسجيل الدخول';
const GM: SyncAccount = { address: 'alex.moreno@gmail.com', color: 'sky' };
const FW: SyncAccount = { address: 'alex@fernworks.studio', color: 'hill' };
const ONE: SyncAccount = { address: 'a@b.co', color: 'ember' };
const NOW = new Date('2026-10-29T10:00:00-07:00');
const RESUME = '2026-10-29T14:14:00-07:00';

const noop = () => {};
const render = (el: ReactElement) => renderToStaticMarkup(el);
const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
function textOf(html: string): string {
  const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map(m => m[1]);
  return decode(
    `${html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ')} ${labels.join(' ')}`,
  ).replace(/\s+/g, ' ');
}
function assertClean(html: string, data: readonly string[] = []) {
  let text = textOf(html);
  for (const d of data) text = text.split(d).join(' ');
  assert.equal(copyProblem(text), null, `banned copy in: ${text}`);
  assert.doesNotMatch(html, /lucide-(sparkle|star|wand|brain|bot)|✨|⭐|🪄|🤖|🧠/i);
  assert.doesNotMatch(html, /style="(?![^"]*--)[^"]*"/, 'only custom properties may be inline');
  assert.doesNotMatch(textOf(html), /\d+(\.\d+)?\s?%/, 'never a percentage');
}
const count = (html: string, needle: string) => html.split(needle).length - 1;
function assertIdRefs(html: string) {
  for (const attr of ['aria-describedby', 'aria-labelledby']) {
    for (const m of html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g')))
      assert.ok(html.includes(`id="${m[1]}"`), `${attr} → missing #${m[1]}`);
  }
}

/* ───────────── StatusSlot ───────────── */
describe('statusCopy (DESIGN 7.1 table)', () => {
  const cases: [SyncStatus, string, string | undefined][] = [
    [{ kind: 'starting' }, 'Starting…', undefined],
    [{ kind: 'syncing' }, 'Syncing…', undefined],
    [
      { kind: 'syncing', firstWindow: { read: 24, of: 50 } },
      'Reading your newest mail · 24 of 50',
      undefined,
    ],
    [
      { kind: 'ok', reconnectBy: '2026-10-30T09:00:00-07:00' },
      'Gmail will ask you to reconnect tomorrow at 9:00 AM.',
      'Reconnect now',
    ],
    [{ kind: 'backfilling', done: 214, of: 500 }, 'Importing 214 of 500', undefined],
    [
      { kind: 'paused', reason: 'throttle', resumeAt: RESUME },
      'Google asked us to slow down. Resuming at 2:14 PM.',
      'Retry now',
    ],
    [
      { kind: 'paused', reason: 'dailyLimit' },
      'Google’s daily limit is reached. Resuming tomorrow.',
      undefined,
    ],
    [{ kind: 'needsReauth' }, 'Google needs you to sign in again.', 'Reconnect'],
    [{ kind: 'needsPermission' }, 'Aplos needs permission to read your Gmail.', 'Reconnect'],
    [
      { kind: 'needsAdmin' },
      'Your organization has blocked Aplos. Ask your administrator.',
      undefined,
    ],
    [{ kind: 'misconfigured' }, 'Google sign-in isn’t set up in this build.', 'Copy diagnostics'],
    [{ kind: 'offline', changesWaiting: 2 }, 'Offline · 2 changes waiting', undefined],
    [{ kind: 'error' }, 'Sync hit a problem.', 'View details'],
    [{ kind: 'demo' }, 'Demo mail. Remove it in Settings.', undefined],
  ];
  for (const [status, text, action] of cases) {
    it(`${status.kind}${'reason' in status ? ` (${status.reason})` : ''}: "${text}"`, () => {
      const copy = statusCopy(status, NOW);
      assert.ok(copy);
      assert.equal(copy.text, text);
      assert.equal(copy.action?.label, action);
      assert.equal(copyProblem(text), null);
    });
  }
  it('ok shows nothing; a reconnect more than a day away shows nothing; today reads "today"', () => {
    assert.equal(statusCopy({ kind: 'ok', lastSyncedAt: '2026-10-29T09:58:00-07:00' }, NOW), null);
    assert.equal(statusCopy({ kind: 'ok', reconnectBy: '2026-10-31T09:00:00-07:00' }, NOW), null);
    assert.equal(
      statusCopy({ kind: 'ok', reconnectBy: '2026-10-29T17:30:00-07:00' }, NOW)?.text,
      'Gmail will ask you to reconnect today at 5:30 PM.',
    );
  });
  it('a reconnect deadline already past reads as an expired sign-in, never a past weekday', () => {
    const past = statusCopy({ kind: 'ok', reconnectBy: '2026-10-26T09:00:00-07:00' }, NOW);
    assert.equal(past?.text, 'Google needs you to sign in again.');
    assert.deepEqual(past?.action, { kind: 'reconnect', label: 'Reconnect', tone: 'danger' });
    assert.equal(past?.attention, true);
  });
  it('offline counts: 0, 1 and 9999', () => {
    assert.equal(statusCopy({ kind: 'offline', changesWaiting: 0 })?.text, 'Offline');
    assert.equal(
      statusCopy({ kind: 'offline', changesWaiting: 1 })?.text,
      'Offline · 1 change waiting',
    );
    assert.equal(
      statusCopy({ kind: 'offline', changesWaiting: 9999 })?.text,
      'Offline · 9,999 changes waiting',
    );
  });
  it('the throttle with no resume time still says what happened', () => {
    assert.equal(
      statusCopy({ kind: 'paused', reason: 'throttle' })?.text,
      'Google asked us to slow down.',
    );
  });
  it('the hover line for a healthy account', () => {
    assert.equal(syncedLine('2026-10-29T09:58:00-07:00', NOW), 'Synced 2 min ago');
    assert.equal(syncedLine('2026-10-29T09:59:40-07:00', NOW), 'Synced just now');
    assert.equal(syncedLine('2026-10-29T07:05:00-07:00', NOW), 'Synced at 7:05 AM');
  });
});

describe('StatusSlot', () => {
  it('sign-in expired: a polite region in --stamp-ink with an inline Reconnect', () => {
    const html = render(
      <StatusSlot status={{ kind: 'needsReauth' }} account={GM} onAction={noop} />,
    );
    assert.match(
      html,
      /^<div class="ui-status-slot" role="status" data-status="needsReauth" data-tone="attention" data-state="shown">/,
    );
    assert.match(html, /data-icon="alert"/);
    assert.match(textOf(html), /Google needs you to sign in again\. Reconnect/);
    assert.match(html, /data-variant="text" data-size="sm" data-tone="danger"/);
    assert.ok(!html.includes(GM.address), 'one account: the copy does not name it');
    assertClean(html);
  });
  it('names the account when two or more are connected, even an 80-character one', () => {
    const html = render(
      <StatusSlot
        status={{ kind: 'paused', reason: 'throttle', resumeAt: RESUME }}
        account={{ address: EMAIL_80, color: 'sky' }}
        multipleAccounts
        onAction={noop}
      />,
    );
    // Folded into the sentence, not a line of its own: the colour dot leads, the address is spoken and in the tooltip.
    assert.ok(!html.includes('ui-status-slot__account'));
    assert.match(
      html,
      /<p class="ui-status-slot__text"><i class="ui-status-slot__dot" data-color="sky" aria-hidden="true"><\/i><span class="ui-sr-only">[^<]+: <\/span>Google asked us/,
    );
    assert.match(html, new RegExp(`ui-part-tip__detail">${EMAIL_80}<`));
    assert.match(textOf(html), /Google asked us to slow down\. Resuming at 2:14 PM\. Retry now/);
    assert.match(html, /data-icon="pause"/);
    assert.ok(!html.includes('data-tone="attention"'));
  });
  it('now replaces the real clock for reconnectBy; a healthy account carries the synced line as its title only', () => {
    const now = '2026-10-29T10:00:00-07:00';
    const soon = render(
      <StatusSlot
        status={{ kind: 'ok', reconnectBy: '2026-10-29T12:00:00-07:00' }}
        now={now}
        onAction={noop}
      />,
    );
    assert.match(textOf(soon), /Gmail will ask you to reconnect today at 12:00 PM\. Reconnect now/);
    const far = render(
      <StatusSlot
        status={{ kind: 'ok', reconnectBy: '2026-11-02T12:00:00-07:00' }}
        now={now}
        onAction={noop}
      />,
    );
    assert.equal(textOf(far).trim(), '');
    const late = render(
      <StatusSlot
        status={{ kind: 'ok', reconnectBy: '2026-10-29T09:00:00-07:00' }}
        now={now}
        onAction={noop}
      />,
    );
    assert.match(textOf(late), /Google needs you to sign in again\. Reconnect/);
    const ok = render(
      <StatusSlot
        status={{ kind: 'ok', lastSyncedAt: '2026-10-29T09:58:00-07:00' }}
        now={now}
        onAction={noop}
      />,
    );
    assert.match(ok, /role="status" title="Synced 2 min ago" data-status="ok"/);
    assert.equal(textOf(ok).trim(), '', 'nothing visible when ok');
    const never = render(<StatusSlot status={{ kind: 'ok' }} now={now} onAction={noop} />);
    assert.ok(!never.includes('title='));
  });
  it('Starting… waits 150 ms before it shows; ok leaves an empty live region', () => {
    const starting = render(<StatusSlot status={{ kind: 'starting' }} onAction={noop} />);
    assert.match(starting, /data-state="waiting"/);
    assert.match(textOf(starting), /Starting…/);
    const ok = render(
      <StatusSlot
        status={{ kind: 'ok', lastSyncedAt: '2026-10-29T09:58:00-07:00' }}
        now="2026-10-29T10:00:00-07:00"
        onAction={noop}
      />,
    );
    // Nothing visible; the hover line is only the element's title (DESIGN 7.1).
    assert.equal(
      ok,
      '<div class="ui-status-slot" role="status" title="Synced 2 min ago" data-status="ok" data-state="empty"></div>',
    );
  });
  it('backfilling: "Importing 214 of 500" on a neutral track labelled "<address> sync", counts kept out of the live region', () => {
    const html = render(
      <StatusSlot
        status={{ kind: 'backfilling', done: 214, of: 500 }}
        account={GM}
        onAction={noop}
      />,
    );
    assert.match(textOf(html), /Importing 214 of 500/);
    assert.match(html, /<div aria-live="off">/);
    assert.match(
      html,
      /role="progressbar" aria-label="alex\.moreno@gmail\.com sync" aria-valuemin="0" aria-valuemax="500" aria-valuenow="214"/,
    );
    assert.match(html, /style="--fill:0\.428"/);
    assertClean(html, [GM.address]);
  });
  it('first window: "Reading your newest mail · 24 of 50" with a quiet indeterminate track', () => {
    const html = render(
      <StatusSlot
        status={{ kind: 'syncing', firstWindow: { read: 24, of: 50 } }}
        account={GM}
        onAction={noop}
      />,
    );
    assert.match(html, /data-state="shown"/);
    assert.match(html, /aria-live="off">Reading your newest mail · 24 of 50</);
    assert.match(
      html,
      /role="progressbar" aria-label="alex\.moreno@gmail\.com sync"><i class="ui-progress-segments__runner">/,
    );
  });
  it('worst-case counts and the reconnect heads-up', () => {
    const huge = render(
      <StatusSlot
        status={{ kind: 'backfilling', done: 9999, of: 9999 }}
        account={ONE}
        onAction={noop}
      />,
    );
    assert.match(textOf(huge), /Importing 9,999 of 9,999/);
    const zero = render(
      <StatusSlot status={{ kind: 'backfilling', done: 0, of: 0 }} account={ONE} onAction={noop} />,
    );
    assert.match(zero, /style="--fill:0"/);
    const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const due = render(<StatusSlot status={{ kind: 'ok', reconnectBy: soon }} onAction={noop} />);
    assert.match(
      textOf(due),
      /Gmail will ask you to reconnect (today|tomorrow) at \d{1,2}:\d{2} [AP]M\. Reconnect now/,
    );
    for (const status of [
      { kind: 'needsAdmin' },
      { kind: 'misconfigured' },
      { kind: 'error' },
      { kind: 'demo' },
      { kind: 'offline', changesWaiting: 9999 },
    ] as SyncStatus[]) {
      assertClean(render(<StatusSlot status={status} onAction={noop} />));
    }
  });
});

/* ───────────── ProgressSegments ───────────── */
const progress: SyncCheckpoint[] = [
  { step: 'connect', state: 'done' },
  { step: 'find', state: 'done', estimate: 214 },
  { step: 'read', state: 'current', read: 24, of: 50 },
  { step: 'sort', state: 'pending', sorted: 0, of: 40 },
];

describe('ProgressSegments', () => {
  it('progress: checkpoints, a labelled bar, real n of m, the motion on the marker, one phase status', () => {
    const html = render(
      <ProgressSegments variant="checkpoints" account={GM} checkpoints={progress} />,
    );
    assert.match(html, /data-variant="checkpoints" data-state="working"/);
    assert.match(
      html,
      /role="progressbar" aria-label="alex\.moreno@gmail\.com sync" aria-valuetext="Reading your newest mail · 24 of 50"/,
    );
    assert.equal(count(html, 'class="ui-progress-segments__seg"'), 4);
    assert.match(
      html,
      /data-state="current" data-step="read"><i class="ui-progress-segments__fill" style="--fill:0\.48"/,
    );
    for (const line of [
      'Connected',
      'Found about 214 recent emails',
      'Reading your newest mail · 24 of 50',
      'Sorting what matters',
    ])
      assert.ok(textOf(html).includes(line), line);
    assert.match(
      html,
      /data-state="current"><span class="ui-progress-segments__marker"><svg class="ui-spinner__glyph"/,
    );
    assert.match(html, /ui-progress-segments__status">Reading 24 of 50</);
    assert.equal(count(html, 'role="status"'), 1);
    assert.match(
      html,
      /class="ui-sr-only" role="status">alex\.moreno@gmail\.com: found recent mail\.</,
    );
    assert.ok(!html.includes('aria-live'), 'no live list');
    assertClean(html, [GM.address]);
  });

  it('no estimate: "Found recent mail"; Find still running is an indeterminate bar; no AI omits Sort', () => {
    const html = render(
      <ProgressSegments
        variant="checkpoints"
        account={FW}
        checkpoints={[
          { step: 'connect', state: 'done' },
          { step: 'find', state: 'current' },
          { step: 'read', state: 'pending', read: 0, of: 50 },
        ]}
      />,
    );
    assert.equal(count(html, 'class="ui-progress-segments__seg"'), 3);
    assert.match(html, /data-step="find"><i class="ui-progress-segments__runner">/);
    assert.ok(!textOf(html).includes('Sort'));
    assert.match(html, /alex@fernworks\.studio connected\./);
  });

  it('paused: --dusk segment, "Paused until 2:14 PM", the count where it stopped', () => {
    const html = render(
      <ProgressSegments
        variant="checkpoints"
        account={GM}
        pausedUntil={RESUME}
        checkpoints={[
          { step: 'connect', state: 'done' },
          { step: 'find', state: 'done', estimate: 214 },
          { step: 'read', state: 'paused', read: 24, of: 50 },
          { step: 'sort', state: 'pending', sorted: 0, of: 40 },
        ]}
      />,
    );
    assert.match(html, /ui-progress-segments__status">Paused until 2:14 PM</);
    assert.match(html, /data-state="paused" data-step="read"/);
    assert.match(textOf(html), /Reading your newest mail · paused at 24 of 50/);
  });

  it('partial: "Sorted 12 of 40. The rest continue in the background." and never "Done"', () => {
    const html = render(
      <ProgressSegments
        variant="checkpoints"
        account={GM}
        checkpoints={[
          { step: 'connect', state: 'done' },
          { step: 'find', state: 'done', estimate: 214 },
          { step: 'read', state: 'done', read: 50, of: 50 },
          { step: 'sort', state: 'partial', sorted: 12, of: 40 },
        ]}
      />,
    );
    assert.match(textOf(html), /Sorted 12 of 40\. The rest continue in the background\./);
    assert.match(html, /ui-progress-segments__status">Sorting continues</);
    assert.doesNotMatch(textOf(html), /\bDone\b/);
    assert.match(html, /is ready\./);
  });

  it('failed: the engine’s plain reason with its icon in --stamp-ink, Try again, a long RTL reason wraps', () => {
    const html = render(
      <ProgressSegments
        variant="checkpoints"
        account={GM}
        failure={{ kind: 'reason', text: SUBJECT_300, retryable: true }}
        onRetry={noop}
        checkpoints={[
          { step: 'connect', state: 'done' },
          { step: 'find', state: 'done', estimate: 214 },
          { step: 'read', state: 'failed', read: 24, of: 50 },
        ]}
      />,
    );
    assert.match(html, /data-state="failed"/);
    assert.match(html, /<span class="ui-part-button__label">Try again<\/span>/);
    assert.ok(html.includes(SUBJECT_300));
    assert.match(
      html,
      /data-state="failed"><span class="ui-progress-segments__marker"><svg[^>]*data-icon="alert"/,
    );
    assert.match(html, /sync stopped\./);
    assert.ok(
      render(
        <ProgressSegments
          variant="checkpoints"
          account={GM}
          failure={{ kind: 'reason', text: RTL, retryable: false }}
          checkpoints={[{ step: 'connect', state: 'failed' }]}
        />,
      ).includes(RTL),
    );
  });

  it('AI failure: "Couldn’t sort with Groq: the key was refused. Mail is ready; sorting will retry." + Open Settings', () => {
    const html = render(
      <ProgressSegments
        variant="checkpoints"
        account={GM}
        failure={{ kind: 'sortFailed', provider: 'Groq', cause: 'keyRefused' }}
        onOpenSettings={noop}
        checkpoints={[
          { step: 'connect', state: 'done' },
          { step: 'find', state: 'done' },
          { step: 'read', state: 'done', read: 50, of: 50 },
          { step: 'sort', state: 'failed', sorted: 3, of: 40 },
        ]}
      />,
    );
    assert.match(
      textOf(html),
      /Couldn’t sort with Groq: the key was refused\. Mail is ready; sorting will retry\. Open Settings/,
    );
    assert.equal(
      failureCopy({ kind: 'sortFailed', provider: 'Groq', cause: 'unreachable' }),
      'Couldn’t sort with Groq: Groq didn’t answer. Mail is ready; sorting will retry.',
    );
    assert.equal(
      failureCopy({ kind: 'sortFailed', provider: 'Groq', cause: 'cap' }),
      'Couldn’t sort with Groq: today’s AI limit is reached. Mail is ready; sorting will retry.',
    );
  });

  it('not connected: "Not connected · Try again", never an endless Waiting; compact keeps only the bar', () => {
    const html = render(
      <ProgressSegments
        variant="checkpoints"
        account={FW}
        notConnected
        onRetry={noop}
        checkpoints={progress}
      />,
    );
    assert.match(textOf(html), /Not connected Try again/);
    assert.ok(!html.includes('ui-progress-segments__checklist'));
    assert.doesNotMatch(textOf(html), /Waiting/);
    const compact = render(
      <ProgressSegments variant="checkpoints" account={GM} compact checkpoints={progress} />,
    );
    assert.ok(!compact.includes('ui-progress-segments__checklist'));
    assert.match(compact, /role="progressbar"/);
  });

  it('waiting for sign-in, and the ready check with per-account results', () => {
    const waiting = render(<ProgressSegments variant="waiting" label="Waiting for sign-in" />);
    assert.match(
      waiting,
      /role="progressbar" aria-label="Waiting for sign-in"><i class="ui-progress-segments__runner">/,
    );
    assert.ok(!waiting.includes('aria-valuenow'));
    const ready = render(
      <ProgressSegments
        variant="ready"
        label="ready"
        accounts={[
          { ...GM, read: 50, sorted: { done: 40, of: 40 } },
          { ...FW, read: 50 },
        ]}
      />,
    );
    assert.match(ready, /<svg class="ui-progress-segments__check"[^>]*aria-hidden="true"/);
    assert.match(ready, /role="status">Your mail is ready</);
    assert.match(textOf(ready), /alex\.moreno@gmail\.com Newest 50 read · sorted 40 of 40/);
    assert.match(textOf(ready), /alex@fernworks\.studio Newest 50 read /);
    assert.match(
      render(<ProgressSegments variant="ready" label="connected" />),
      />Account connected</,
    );
  });
});

/* ───────────── ReconnectSheet ───────────── */
describe('ReconnectSheet', () => {
  it('waiting: a small modal sheet, "Waiting for Google in your browser…", Cancel with Esc, no filled button', () => {
    assert.equal(
      render(
        <ReconnectSheet
          open={false}
          address={GM.address}
          state="waiting"
          onCancel={noop}
          onRetry={noop}
        />,
      ),
      '',
    );
    const html = render(
      <ReconnectSheet open address={GM.address} state="waiting" onCancel={noop} onRetry={noop} />,
    );
    assert.match(html, /role="dialog" aria-modal="true"[^>]*data-size="sm"/);
    assert.match(html, /ui-dialog__title[^>]*>Reconnect alex\.moreno@gmail\.com</);
    assert.match(textOf(html), /Nothing resyncs, and your changes on this Mac are kept\./);
    assert.match(html, /role="status">.*Waiting for Google in your browser…/);
    assert.match(
      html,
      /<span class="ui-part-button__label">Cancel<\/span><span class="ui-part-keys" data-reveal="always">.*?Esc/,
    );
    assert.ok(!html.includes('data-variant="filled"'));
    assertIdRefs(html);
    assertClean(html, [GM.address]);
  });
  it('failed: the reason, Try again as the one filled button with Return; Microsoft is named', () => {
    const html = render(
      <ReconnectSheet
        open
        address={EMAIL_80}
        state="failed"
        reason="Google says the sign-in window was closed."
        onCancel={noop}
        onRetry={noop}
      />,
    );
    assert.match(html, /role="alert">.*Google says the sign-in window was closed\./);
    assert.equal(count(html, 'data-variant="filled"'), 1);
    assert.match(
      html,
      /data-variant="filled"[^>]*><span class="ui-part-button__label">Try again<\/span>.*?Return/,
    );
    assert.ok(html.includes(EMAIL_80));
    const ms = render(
      <ReconnectSheet
        open
        address={ONE.address}
        provider="microsoft"
        state="waiting"
        onCancel={noop}
        onRetry={noop}
      />,
    );
    assert.match(textOf(ms), /Waiting for Microsoft in your browser…/);
    assert.match(
      textOf(
        render(
          <ReconnectSheet
            open
            address={ONE.address}
            state="failed"
            onCancel={noop}
            onRetry={noop}
          />,
        ),
      ),
      /Google didn’t finish the sign-in\. Your mail is safe on this Mac\./,
    );
  });
});

/* ───────────── FatalScreen, Spinner ───────────── */
describe('FatalScreen', () => {
  it('sans display line, "Your mail is safe on this Mac.", Restart engine (Return) · Copy diagnostics', () => {
    const html = render(
      <FatalScreen kind="unreachable" restarting={false} onRestart={noop} onDiagnostics={noop} />,
    );
    assert.match(
      html,
      /^<div class="ui-fatal-screen" role="alert" data-kind="unreachable" data-state="idle">/,
    );
    assert.match(
      html,
      /<h1 class="ui-fatal-screen__title">Aplos can’t reach its mail engine\.<\/h1>/,
    );
    assert.match(html, /<p class="ui-fatal-screen__safe">Your mail is safe on this Mac\.<\/p>/);
    assert.match(
      html,
      /data-variant="filled"[^>]*><span class="ui-part-button__label">Restart engine<\/span>.*?<kbd class="ui-part-kbd">Return<\/kbd>/,
    );
    assert.match(html, />Copy diagnostics</);
    assert.doesNotMatch(textOf(html), /Aplos needs a moment|Making room/);
    assertClean(html);
  });
  it('restarting soft-disables the button (focus kept) and says "Restarting…"; the parked engine offers Try again · Export diagnostics', () => {
    const restarting = render(
      <FatalScreen kind="unreachable" restarting onRestart={noop} onDiagnostics={noop} />,
    );
    assert.match(restarting, /data-state="restarting"/);
    assert.match(
      restarting,
      /aria-disabled="true"><span class="ui-part-button__label">Restarting…</,
    );
    assert.ok(
      !restarting.includes('disabled=""'),
      'never natively disabled, which would drop focus to the page',
    );
    const parked = render(
      <FatalScreen kind="parked" restarting={false} onRestart={noop} onDiagnostics={noop} />,
    );
    assert.match(textOf(parked), /Try again Return Export diagnostics/);
  });
});

describe('Spinner', () => {
  it('labelled, hidden for its first 150 ms, two sizes', () => {
    const html = render(<Spinner label="Searching Google" />);
    assert.match(
      html,
      /^<span class="ui-spinner" data-size="md" data-state="waiting" role="img" aria-label="Searching Google" aria-hidden="true"><svg class="ui-spinner__glyph"/,
    );
    assert.match(render(<Spinner label="Loading Maple Library…" size="sm" />), /data-size="sm"/);
  });
});

describe('ReconnectSheet grant mode', () => {
  it('has its own title, line and button; reconnect keeps Reconnect and Try again', () => {
    const grant = render(
      <ReconnectSheet
        open
        mode="grant"
        address={GM.address}
        state="failed"
        onCancel={noop}
        onRetry={noop}
      />,
    );
    assert.match(grant, /ui-dialog__title[^>]*>Grant access for alex\.moreno@gmail\.com</);
    assert.match(textOf(grant), /Aplos needs permission to read your Gmail\./);
    assert.match(grant, /data-variant="filled"[^>]*>.*Grant access/);
    assert.doesNotMatch(textOf(grant), /Reconnect|Try again/);
    assertClean(grant, [GM.address]);
    const reconnect = render(
      <ReconnectSheet open address={GM.address} state="failed" onCancel={noop} onRetry={noop} />,
    );
    assert.match(reconnect, /ui-dialog__title[^>]*>Reconnect alex/);
    assert.match(reconnect, /Try again/);
    assert.doesNotMatch(textOf(reconnect), /Grant access/);
  });
});

describe('ProgressSegments live regions and account dot', () => {
  const account = { address: GM.address, color: 'sky' } as const;
  const cps = (read: number) =>
    [
      { step: 'connect', state: 'done' },
      { step: 'find', state: 'done' },
      { step: 'read', state: 'current', read, of: 50 },
    ] as const;
  const status = (html: string): string[] =>
    [...html.matchAll(/role="status">([^<]*)</g)].map(m => m[1]);

  it('one visually hidden status that says the phase and does not move while counts tick', () => {
    const a = render(
      <ProgressSegments variant="checkpoints" account={account} checkpoints={cps(10)} />,
    );
    const b = render(
      <ProgressSegments variant="checkpoints" account={account} checkpoints={cps(11)} />,
    );
    assert.deepEqual(status(a), [`${GM.address}: found recent mail.`]);
    assert.deepEqual(status(a), status(b));
    assert.equal(count(a, 'role="status"'), 1);
    assert.equal(count(a, 'aria-live'), 0);
    const paused = render(
      <ProgressSegments
        variant="checkpoints"
        account={account}
        checkpoints={[
          { step: 'connect', state: 'done' },
          { step: 'find', state: 'done' },
          { step: 'read', state: 'paused', read: 10, of: 50 },
        ]}
      />,
    );
    assert.deepEqual(status(paused), [`${GM.address} sync paused.`]);
  });

  it('the plain segments variant announces stopped, paused and finished only', () => {
    const seg = (state: 'current' | 'done' | 'failed' | 'paused', value?: number) =>
      render(
        <ProgressSegments
          variant="segments"
          label="jordan@gmail.com sync"
          segments={[
            { label: 'Connect', state: 'done' },
            { label: 'Read', state, value },
          ]}
        />,
      );
    assert.deepEqual(status(seg('current', 0.2)), ['']);
    assert.deepEqual(status(seg('current', 0.6)), ['']);
    assert.deepEqual(status(seg('failed')), ['jordan@gmail.com sync stopped.']);
    assert.deepEqual(status(seg('paused')), ['jordan@gmail.com sync paused.']);
    assert.deepEqual(status(seg('done')), ['jordan@gmail.com sync finished.']);
  });

  it('live="off" drops the per-account status, so a parent wrapper is the one live region (F11)', () => {
    const accounts = [account, { address: ONE.address, color: 'hill' } as const];
    const parts = (live?: 'polite' | 'off') =>
      accounts.map(a => (
        <ProgressSegments
          key={a.address}
          variant="checkpoints"
          account={a}
          checkpoints={cps(10)}
          accountCount={2}
          live={live}
        />
      ));
    // Default unchanged: one role="status" per account.
    assert.equal(count(render(<div>{parts()}</div>), 'role="status"'), 2);
    assert.equal(count(render(<div>{parts('polite')}</div>), 'role="status"'), 2);
    // The parent wrapper is polite and non-atomic: a bare role="status" implies aria-atomic="true" and would re-read
    // every account on each change.
    const wrapped = render(
      <div aria-live="polite" aria-atomic="false">
        {parts('off')}
      </div>,
    );
    assert.equal(count(wrapped, 'role="status"'), 0);
    assert.equal(count(wrapped, 'aria-live="polite"'), 1);
    assert.match(wrapped, /^<div aria-live="polite" aria-atomic="false">/);
    // The phase text and the visible lines stay.
    assert.match(wrapped, new RegExp(`${GM.address}: found recent mail\\.`));
    assert.match(wrapped, /Reading your newest mail · 10 of 50/);
    assert.match(wrapped, /aria-label="alex\.moreno@gmail\.com sync"/);
    const seg = render(
      <ProgressSegments
        variant="segments"
        label="jordan@gmail.com sync"
        live="off"
        segments={[{ label: 'Read', state: 'paused' }]}
      />,
    );
    assert.equal(count(seg, 'role="status"'), 0);
    assert.match(seg, /jordan@gmail\.com sync paused\./);
    const ready = (live?: 'polite' | 'off') =>
      render(<ProgressSegments variant="ready" label="ready" live={live} />);
    assert.equal(count(ready(), 'role="status"'), 1);
    assert.equal(count(ready('polite'), 'role="status"'), 1);
    assert.equal(count(ready('off'), 'role="status"'), 0);
    assert.match(ready('off'), /Your mail is ready/);
  });

  it('the account dot shows only with two or more accounts', () => {
    const one = render(
      <ProgressSegments variant="checkpoints" account={account} checkpoints={cps(5)} />,
    );
    assert.equal(count(one, 'ui-progress-segments__dot'), 0);
    const two = render(
      <ProgressSegments
        variant="checkpoints"
        account={account}
        checkpoints={cps(5)}
        accountCount={2}
      />,
    );
    assert.equal(count(two, 'ui-progress-segments__dot'), 1);
    const readyOne = render(
      <ProgressSegments variant="ready" label="ready" accounts={[{ ...account, read: 50 }]} />,
    );
    assert.equal(count(readyOne, 'ui-progress-segments__dot'), 0);
    const readyTwo = render(
      <ProgressSegments
        variant="ready"
        label="ready"
        accounts={[
          { ...account, read: 50 },
          { address: ONE.address, color: 'hill', read: 50 },
        ]}
      />,
    );
    assert.equal(count(readyTwo, 'ui-progress-segments__dot'), 2);
  });
});
