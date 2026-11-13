// Surfaces family: popovers, dialogs, confirms, the puck and toasts.
// Run from the repo root: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/surfaces/surfaces-overlays.test.tsx

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { ToastData } from '../props';
import { Confirm, Dialog, Popover, Puck, Toast, ToastStack } from './index';
import { planToasts, visibleToasts } from './ToastStack';
import { toastLife } from './Toast';
import { timing } from '../generated/motion';
import {
  SUBJECT_300,
  EMAIL_80,
  CJK,
  RTL,
  EMOJI,
  noop,
  render,
  textOf,
  assertClean,
  count,
  assertIdRefs,
} from './fixtures.test';

describe('Popover', () => {
  it('dialog and tooltip roles, closed renders nothing', () => {
    assert.equal(
      render(
        <Popover open={false} anchor={null} label="Why it’s here" role="dialog" onClose={noop}>
          x
        </Popover>,
      ),
      '',
    );
    const dialog = render(
      <Popover
        open
        anchor={null}
        label="Why it’s here"
        role="dialog"
        placement="below-end"
        onClose={noop}
      >
        <p>Jordan asked for your pick by tomorrow.</p>
      </Popover>,
    );
    assert.match(
      dialog,
      /role="dialog" aria-label="Why it’s here" tabindex="-1" class="ui-popover" data-role="dialog" data-state="open" data-placement="below-end"/,
    );
    const tip = render(
      <Popover open anchor={null} label="Quote" role="tooltip" onClose={noop}>
        {RTL}
      </Popover>,
    );
    assert.match(
      tip,
      /role="tooltip" aria-label="Quote" class="ui-popover" data-role="tooltip" data-state="open" data-placement="below-start"/,
    );
    assert.ok(!tip.includes('tabindex'));
  });
});

/* ───────────── Dialog, Confirm ───────────── */
describe('Dialog', () => {
  it('modal, labelled by its title, described by its line, with a footer', () => {
    assert.equal(
      render(
        <Dialog open={false} title="x" size="sm" onClose={noop}>
          x
        </Dialog>,
      ),
      '',
    );
    const html = render(
      <Dialog
        open
        title="Keyboard shortcuts"
        description="Every key Aplos knows."
        size="lg"
        footer={<button type="button">Done</button>}
        onClose={noop}
      >
        <p>Body</p>
      </Dialog>,
    );
    assert.match(
      html,
      /^<div class="ui-dialog__scrim" data-state="open"><section role="dialog" aria-modal="true" aria-labelledby="[^"]+" aria-describedby="[^"]+" tabindex="-1" class="ui-dialog" data-size="lg" data-state="open">/,
    );
    assert.ok(!html.includes('inert'), 'open: takes input');
    assert.match(html, /<h2 class="ui-dialog__title" id="[^"]+">Keyboard shortcuts<\/h2>/);
    assert.match(html, /ui-dialog__foot"><button/);
    assertIdRefs(html);
  });
  it('a 300-character title and no description', () => {
    const html = render(
      <Dialog open title={SUBJECT_300} size="md" onClose={noop}>
        x
      </Dialog>,
    );
    assert.ok(html.includes(SUBJECT_300));
    assert.ok(!html.includes('aria-describedby'));
    assert.ok(!html.includes('ui-dialog__foot'));
  });
});

describe('Confirm', () => {
  it('destructive: Cancel is the default row with Return; the confirm row needs ⇧Return and reads red', () => {
    const html = render(
      <Confirm
        question="Delete forever?"
        consequence="“Invoice #0412” will be removed from your account. This can’t be undone."
        confirmLabel="Delete forever"
        destructive
        presentation="dialog"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    assert.match(html, /role="dialog" aria-modal="true"/);
    assert.match(html, /ui-dialog__title[^>]*>Delete forever\?</);
    const cancelAt = html.indexOf('>Cancel<');
    const confirmAt = html.indexOf('>Delete forever</span>');
    assert.ok(cancelAt > 0 && confirmAt > cancelAt, 'Cancel comes first');
    assert.match(
      html,
      /data-primary="true"><span class="ui-confirm__row-label">Cancel<\/span>.*?<kbd class="ui-part-kbd">Return<\/kbd>/,
    );
    assert.match(
      html,
      /data-tone="danger"><span class="ui-confirm__row-label">Delete forever<\/span>.*?<kbd class="ui-part-kbd">⇧Return<\/kbd>/,
    );
    assert.match(html, /data-destructive="true"/);
    assertIdRefs(html);
  });
  it('not destructive: the confirm row is the default with Return; Cancel takes Esc; inline is a labelled group', () => {
    const html = render(
      <Confirm
        question="Send to 9,999 people?"
        consequence="Everyone in the list gets it."
        confirmLabel="Send"
        cancelLabel="Keep editing"
        destructive={false}
        presentation="inline"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    assert.match(
      html,
      /^<div class="ui-confirm" role="group" aria-labelledby="[^"]+" aria-describedby="[^"]+" data-presentation="inline">/,
    );
    assert.ok(html.indexOf('>Send</span>') < html.indexOf('>Keep editing</span>'));
    assert.match(
      html,
      /data-primary="true"><span class="ui-confirm__row-label">Send<\/span>.*?Return/,
    );
    assert.match(html, /Keep editing<\/span>.*?<kbd class="ui-part-kbd">Esc<\/kbd>/);
    assert.ok(!html.includes('data-tone="danger"'));
    assertIdRefs(html);
    assertClean(html);
  });
});

/* ───────────── Puck ───────────── */
describe('Puck', () => {
  it('segmented tabs: one thumb, aria-selected, roving tab stop, short labels named in full', () => {
    const html = render(
      <Puck
        kind="segmented"
        role="tabs"
        label="View"
        items={[
          { id: 'd', label: 'Day view', shortLabel: 'D', commandId: 'calendar.dayView' },
          { id: 'w', label: 'Week view', shortLabel: 'W', commandId: 'calendar.weekView' },
          { id: 'm', label: 'Month view', shortLabel: 'M', commandId: 'calendar.monthView' },
        ]}
        selectedId="w"
        onSelect={noop}
      />,
    );
    assert.match(
      html,
      /^<div class="ui-puck" data-kind="segmented" data-orientation="horizontal" role="tablist" aria-label="View" aria-orientation="horizontal">/,
    );
    assert.equal(count(html, 'class="ui-puck__thumb"'), 1, 'one shared indicator');
    assert.equal(count(html, 'role="tab"'), 3);
    assert.equal(count(html, 'aria-selected="true"'), 1);
    assert.match(html, /aria-selected="true" aria-label="Week view"[^>]*tabindex="0"/);
    assert.equal(count(html, 'tabindex="-1"'), 2);
    assert.match(html, /<span class="ui-puck__label">W<\/span>/);
    assert.match(textOf(html), /Week view W/);
    assert.ok(!html.includes('data-ready'), 'the selected item paints itself until measured');
    assert.ok(!html.includes('--puck-sy'), 'scaleX only: the thumb is never scaled vertically');
    assertIdRefs(html);
  });

  it('sidebar selection: a nav with aria-current, counts 0 and 9999, tooltip second line', () => {
    const html = render(
      <Puck
        kind="selection"
        role="navigation"
        label="Places"
        items={[
          { id: 'home', label: 'Home', icon: 'home', count: 9999, commandId: 'nav.home' },
          { id: 'later', label: 'Later', icon: 'clock', count: 0, commandId: 'nav.later' },
          {
            id: 'done',
            label: 'Done',
            icon: 'check-circle',
            tooltip: 'Mail you finished. Press H to move one back to Home.',
          },
          { id: 'cal', label: CJK, swatch: 'ember' },
        ]}
        selectedId="home"
        onSelect={noop}
      />,
    );
    assert.match(
      html,
      /^<nav class="ui-puck__nav" aria-label="Places"><div class="ui-puck" data-kind="selection" data-orientation="vertical">/,
    );
    assert.equal(count(html, 'aria-current="page"'), 1);
    assert.ok(html.includes('>9,999<') && html.includes('>0<'));
    assert.match(textOf(html), /Home ⌃1/);
    assert.match(textOf(html), /Mail you finished\. Press H to move one back to Home\./);
    assert.match(html, /data-color="ember"/);
    assert.match(
      html,
      /aria-current="page"[^>]*tabindex="0"/,
      'the selected row is the one tab stop',
    );
    assert.equal(count(html, 'tabindex="0"'), 1, 'roving: exactly one row is tabbable');
    assert.equal(count(html, 'tabindex="-1"'), 3, 'the rest are out of the tab order');
    assertIdRefs(html);
    assertClean(html, [CJK]);
  });

  it('radio with nothing chosen (an unanswered RSVP): no checked item, the first is the tab stop', () => {
    const html = render(
      <Puck
        kind="segmented"
        role="radio"
        label="Going?"
        items={[
          { id: 'yes', label: 'Yes' },
          { id: 'maybe', label: 'Maybe' },
          { id: 'no', label: 'No', disabled: true },
        ]}
        selectedId={null}
        onSelect={noop}
      />,
    );
    assert.match(html, /role="radiogroup" aria-label="Going\?"/);
    assert.equal(count(html, 'aria-checked="true"'), 0);
    assert.match(html, /aria-checked="false" tabindex="0"[^>]*>.*?Yes/);
    assert.match(html, /disabled=""/);
  });
});

/* ───────────── Toast, ToastStack ───────────── */
const t = (id: string, over: Partial<ToastData> = {}): ToastData => ({
  id,
  kind: 'info',
  message: `Toast ${id}`,
  undoable: false,
  ...over,
});

describe('Toast', () => {
  it('a failure wears the alert in --stamp-ink, never a check, and can be closed', () => {
    const html = render(
      <Toast
        id="f1"
        kind="error"
        message="Couldn’t send to Jordan. Your draft is saved."
        actions={[{ id: 'retry', label: 'Try again' }]}
        undoable={false}
        onAction={noop}
        onDismiss={noop}
      />,
    );
    assert.match(html, /data-tone="stamp"><svg[^>]*data-icon="alert"/);
    assert.ok(!html.includes('data-icon="check"'));
    assert.match(html, /<button[^>]*aria-label="Dismiss"/);
    assertClean(html);
  });
  it('a plain toast has no close button', () => {
    const html = render(
      <Toast
        id="p1"
        kind="info"
        message="Saved"
        undoable={false}
        onAction={noop}
        onDismiss={noop}
      />,
    );
    assert.ok(!html.includes('Dismiss'));
  });
  it('lifetimes: plain 4 s, Undo and error 8 s, persistent none', () => {
    assert.equal(toastLife({ kind: 'info', undoable: false }), timing.toast);
    assert.equal(toastLife({ kind: 'done', undoable: true }), timing.toastUndo);
    assert.equal(toastLife({ kind: 'error', undoable: false }), timing.toastUndo);
    assert.equal(toastLife({ kind: 'error', undoable: false, persistent: true }), null);
  });
  it('Moved to Later · Set a date D · Undo Z, with the clock in dusk, polite', () => {
    const html = render(
      <Toast
        id="t1"
        kind="later"
        message="Moved to Later"
        actions={[
          { id: 'date', label: 'Set a date', commandId: 'mail.setDate' },
          { id: 'undo', label: 'Undo', commandId: 'app.undo' },
        ]}
        undoable
        onAction={noop}
        onDismiss={noop}
      />,
    );
    // Not a live region of its own: the stack's persistent region announces it (a region born with text is often silent).
    assert.match(html, /^<div class="ui-toast" data-kind="later" data-state="shown">/);
    assert.ok(!html.includes('role="status"'));
    assert.match(html, /data-tone="dusk"><svg[^>]*data-icon="clock"/);
    assert.match(textOf(html), /Moved to Later Set a date D Undo Z/);
    assert.ok(!html.includes('tabindex'), 'never takes focus');
    assertClean(html);
  });
  it('keysFrom shows the keycap like commandId; commandId wins; no keys without either', () => {
    const html = render(
      <Toast
        id="k1"
        kind="later"
        message="Moved to Later"
        actions={[
          { id: 'undo', label: 'Undo', keysFrom: 'app.undo' },
          { id: 'date', label: 'Set a date', commandId: 'mail.setDate', keysFrom: 'app.undo' },
          { id: 'plain', label: 'Open' },
        ]}
        undoable
        onAction={noop}
        onDismiss={noop}
      />,
    );
    assert.match(textOf(html), /Moved to Later Undo Z Set a date D Open/);
    assert.equal(count(html, 'class="ui-toast__action"'), 3);
  });
  it('every kind wears an icon; at most three verbs; worst-case message', () => {
    const kinds = [
      'done',
      'later',
      'trash',
      'home',
      'bookmark',
      'undone',
      'pending',
      'offline',
      'tip',
      'info',
    ] as const;
    for (const kind of kinds)
      assert.match(
        render(
          <Toast
            id="k"
            kind={kind}
            message="Saved here · will sync"
            undoable={false}
            onAction={noop}
            onDismiss={noop}
          />,
        ),
        /class="ui-toast__icon"[^>]*><svg/,
      );
    const html = render(
      <Toast
        id="w"
        kind="done"
        message={`${SUBJECT_300} ${EMAIL_80} ${RTL} ${EMOJI}`}
        actions={[1, 2, 3, 4].map(n => ({ id: `a${n}`, label: `Verb ${n}` }))}
        undoable={false}
        persistent
        onAction={noop}
        onDismiss={noop}
      />,
    );
    assert.equal(count(html, 'class="ui-toast__action"'), 3);
    assert.ok(html.includes(EMAIL_80) && html.includes(RTL) && html.includes(EMOJI));
  });
});

describe('ToastStack', () => {
  it('keeps three, the oldest plain toasts giving way; an Undo toast is never dropped', () => {
    const list = [t('1', { undoable: true }), t('2'), t('3', { undoable: true }), t('4'), t('5')];
    assert.deepEqual(
      visibleToasts(list, 0).map(x => x.id),
      ['1', '3', '5'],
    );
    assert.deepEqual(
      visibleToasts(list, 1).map(x => x.id),
      ['1', '3', '5'],
      'the newest is never evicted, so the stack grows rather than lose it',
    );
    assert.deepEqual(
      visibleToasts([t('a'), t('b')], 0).map(x => x.id),
      ['a', 'b'],
    );
    assert.deepEqual(visibleToasts([], 0), []);
    // Four quick E presses: all four Undo toasts stay rather than one being silently hidden.
    const undos = [1, 2, 3, 4].map(n => t(String(n), { undoable: true }));
    assert.deepEqual(
      visibleToasts(undos, 0).map(x => x.id),
      ['1', '2', '3', '4'],
    );
    assert.deepEqual(
      visibleToasts([...undos, t('p')], 1).map(x => x.id),
      ['1', '2', '3', '4', 'p'],
    );
  });

  it('never drops a persistent (failure) toast: only plain ones give way, oldest first', () => {
    const list = [
      t('f1', { persistent: true }),
      t('p1'),
      t('p2'),
      t('u1', { undoable: true }),
      t('f2', { persistent: true }),
      t('p3'),
    ];
    assert.deepEqual(
      visibleToasts(list, 0).map(x => x.id),
      ['f1', 'u1', 'f2', 'p3'],
    );
    const failures = [1, 2, 3, 4].map(n => t(`f${n}`, { persistent: true }));
    assert.deepEqual(
      visibleToasts([...failures, t('p')], 1).map(x => x.id),
      ['f1', 'f2', 'f3', 'f4', 'p'],
    );
  });

  it('never evicts the newest toast: a plain notice after three Undo or failure toasts is shown', () => {
    const list = [
      t('u1', { undoable: true }),
      t('f1', { persistent: true }),
      t('u2', { undoable: true }),
      t('moved'),
    ];
    const plan = planToasts(list, 0);
    assert.deepEqual(
      plan.shown.map(x => x.id),
      ['u1', 'f1', 'u2', 'moved'],
    );
    assert.deepEqual(plan.dropped, []);
    // An older plain toast is the one that goes, oldest first; the newest plain stays.
    const mixed = planToasts([t('p1'), t('p2'), ...list], 0);
    assert.deepEqual(
      mixed.dropped.map(x => x.id),
      ['p1', 'p2'],
    );
    assert.deepEqual(
      mixed.shown.map(x => x.id),
      ['u1', 'f1', 'u2', 'moved'],
    );
  });

  it('caps the mounted toasts at six: the oldest Undo and failure toasts are hidden, not dismissed', () => {
    const many = [1, 2, 3, 4, 5, 6, 7, 8].map(n => t(`f${n}`, { persistent: true }));
    const plan = planToasts(many, 0);
    assert.deepEqual(
      plan.shown.map(x => x.id),
      ['f3', 'f4', 'f5', 'f6', 'f7', 'f8'],
    );
    assert.deepEqual(plan.dropped, [], 'hidden ones are not dismissed');
    assert.deepEqual(
      planToasts(many, 1).shown.map(x => x.id),
      ['f4', 'f5', 'f6', 'f7', 'f8'],
      'the undo-send notice counts toward the six',
    );
    // When newer ones close, the hidden ones come back.
    assert.deepEqual(
      planToasts(many.slice(0, 7), 0).shown.map(x => x.id),
      ['f2', 'f3', 'f4', 'f5', 'f6', 'f7'],
    );
    const html = render(<ToastStack toasts={many} onAction={noop} onDismiss={noop} />);
    assert.equal(count(html, 'class="ui-toast"'), 6);
  });

  it('renders a polite stack and the undo-send notice inside it, counted in the three', () => {
    const html = render(
      <ToastStack
        toasts={[t('1', { kind: 'done', message: 'Done', undoable: true }), t('2'), t('3'), t('4')]}
        undoSend={{
          state: { kind: 'sending', recipients: 'Jordan', secondsLeft: 6, totalSeconds: 8 },
          reducedMotion: false,
          undoCommandId: 'app.undo',
          onAction: noop,
        }}
        onAction={noop}
        onDismiss={noop}
      />,
    );
    assert.match(html, /^<div class="ui-toast-stack" aria-live="polite">/);
    assert.ok(!html.includes('aria-label="Notifications"'), 'not a landmark');
    assert.equal(count(html, 'class="ui-toast"'), 3);
    // The ticking countdown opts out of the stack's live region; its start is spoken once through announce.
    assert.match(html, /data-kind="undo-send" data-state="shown" aria-live="off"/);
    assert.match(textOf(html), /Sending to Jordan in 6 s Undo Z Send now/);
    assert.match(html, /class="ui-toast__drain" aria-hidden="true" style="--drain:0.75"/);
    assert.ok(html.includes('>Done<'), 'the Undo toast stays');
    assertClean(html);
  });

  it('undo-send states: reduced motion has no drain; uncertain, suspended and deferred copy', () => {
    const base = { reducedMotion: true, undoCommandId: 'app.undo', onAction: noop } as const;
    const sending = render(
      <ToastStack
        toasts={[]}
        undoSend={{
          ...base,
          state: {
            kind: 'sending',
            recipients: 'Jordan and Mina',
            secondsLeft: 8,
            totalSeconds: 8,
          },
        }}
        onAction={noop}
        onDismiss={noop}
      />,
    );
    assert.ok(!sending.includes('ui-toast__drain'));
    assert.match(textOf(sending), /Sending to Jordan and Mina in 8 s/);
    assert.match(
      textOf(
        render(
          <ToastStack
            toasts={[]}
            undoSend={{ ...base, state: { kind: 'uncertain' } }}
            onAction={noop}
            onDismiss={noop}
          />,
        ),
      ),
      /Couldn’t confirm this was sent\. Check Sent Send anyway/,
    );
    assert.match(
      textOf(
        render(
          <ToastStack
            toasts={[]}
            undoSend={{ ...base, state: { kind: 'suspended' } }}
            onAction={noop}
            onDismiss={noop}
          />,
        ),
      ),
      /Missed its time while your Mac was off\. Send now Reschedule/,
    );
    assert.match(
      textOf(
        render(
          <ToastStack
            toasts={[]}
            undoSend={{ ...base, state: { kind: 'deferred', until: '2026-10-29T14:14:00-07:00' } }}
            onAction={noop}
            onDismiss={noop}
          />,
        ),
      ),
      /Couldn’t send until \d{1,2}:\d{2} [AP]M\. Your draft is saved\./,
    );
  });

  it('an empty stack stays mounted so announcements land', () => {
    assert.equal(
      render(<ToastStack toasts={[]} onAction={noop} onDismiss={noop} />),
      '<div class="ui-toast-stack" aria-live="polite"></div>',
    );
  });
});

/* ───────────── Dialog entrance leaves no transform ───────────── */
describe('Dialog entrance animation', () => {
  const css = readFileSync(new URL('./surfaces.css', import.meta.url), 'utf8');
  const animationOf = (selector: string): string => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, `rule ${selector} exists`);
    const block = css.slice(start, css.indexOf('}', start));
    const line = block.match(/animation:([^;]*);/);
    assert.ok(line, `rule ${selector} animates`);
    return line[1];
  };

  it('fills backwards only, so no identity transform stays on the dialog', () => {
    // A transform left on the dialog makes it the containing block of every fixed Menu and Popover inside it.
    const entrance = animationOf('.ui-dialog');
    assert.match(entrance, /ui-settle/);
    assert.match(entrance, /\bbackwards\b/);
    assert.doesNotMatch(entrance, /\b(both|forwards)\b/);
  });

  it('the leaving animation keeps its end state, because it ends invisible', () => {
    assert.match(animationOf(".ui-dialog[data-state='leaving']"), /\bboth\b/);
  });
});
