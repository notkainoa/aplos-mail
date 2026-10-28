import { useEffect, useState } from 'react';
import { X } from '../icons';
import type { Draft } from '@aplos/contract/legacy/types';
import { isoDay } from '../bridge';
import {
  Button,
  Dialog,
  DialogHeader,
  Keys,
  Notice,
  Skeleton,
  Tabs,
  cx,
  useLatest,
  usePresence,
} from '../ui';

export function ShortcutsDialog({
  open,
  close,
  doneLeft,
  minimized,
}: {
  open: boolean;
  close: () => void;
  doneLeft: boolean;
  minimized: boolean;
}) {
  const done = doneLeft ? '←' : '→';
  const todo = doneLeft ? '→' : '←';
  const tabs: { id: string; rows: [string, string[]][] }[] = [
    {
      id: 'General',
      rows: [
        ['Ask me anything', ['A', '⌘ J']],
        ['Today in the dock', ['⇧ A']],
        ['Talk to Ask', ['Hold A']],
        ['Search mail', ['/']],
        ['Compose', ['C']],
        ['Settings', ['⌘ ,']],
        [minimized ? 'Open the mailbox menu' : 'Show or hide the sidebar', ['[']],
        ['This guide', ['?']],
      ],
    },
    {
      id: 'Moving around',
      rows: [
        ['Home', ['⌃ 1']],
        ['Later', ['⌃ 2']],
        ['All mail', ['⌃ 3']],
        ['Drafts', ['⌃ 4']],
        ['Calendar', ['⌃ 6']],
        ['Next email', ['J', '↓']],
        ['Previous email', ['K', '↑']],
        ['Open the focused email', ['↵', 'O']],
        ['Suggested action', ['Space']],
        ['Swipe through them', ['S']],
        ['Select', ['X']],
        ['Select all', ['⌘ A']],
        ['Close or clear the selection', ['Esc']],
      ],
    },
    {
      id: 'Email',
      rows: [
        ['Done', [done, 'E']],
        ['Later', [todo, 'L']],
        ['Reply', ['R']],
        ['Reply in the reader', ['Space']],
        ['Reply and dictate', ['Hold Space']],
        ['Reply all', ['⇧ R']],
        ['Forward', ['F']],
        ['Bookmark', ['B']],
        ['Read or unread', ['U']],
        ['More actions', ['.']],
        ['Move to Trash', ['#']],
        ['Undo', ['Z']],
      ],
    },
    {
      id: 'Calendar',
      rows: [
        ['Today', ['T']],
        ['Day, week or month', ['D', 'W', 'M']],
        ['Next', ['J', '→']],
        ['Previous', ['K', '←']],
        ['New event', ['N']],
        ['Open the event', ['↵']],
        ['Edit the open event', ['E']],
        ['Delete the open event', ['⌫']],
        ['Close, or cancel a drag', ['Esc']],
        ['Add the plan shown in Today', ['↵']],
        ['Not now, for that plan', ['Esc']],
        ['Show only one calendar', ['⌥ Click']],
        ['Next or previous, by trackpad', ['Swipe']],
        ['Zoom the hours', ['Pinch', '⌘ Scroll']],
        ['Step days in Today', ['←', '→']],
      ],
    },
    {
      id: 'Ask',
      rows: [
        ['Move through suggestions', ['↑', '↓']],
        ['Ask, or open the selected item', ['↵']],
        ['Search all mail instead', ['⌘ ↵']],
        ['New chat', ['⌘ N']],
        ['Stop, clear, then close', ['Esc']],
        ['Release to ask, while holding A', ['Hold A']],
      ],
    },
    {
      id: 'Writing',
      rows: [
        ['Send', ['⌘ ↵']],
        ['Dictate into an empty body', ['Hold Space']],
        ['Bold', ['⌘ B']],
        ['Italic', ['⌘ I']],
        ['Close', ['Esc']],
      ],
    },
  ];
  const [tab, setTab] = useState('General');
  return (
    <Dialog
      open={open}
      onClose={close}
      label="Keyboard shortcuts"
      className="shortcuts-dialog"
      instant
    >
      <DialogHeader title="Keyboard shortcuts" onClose={close} closeLabel="Close shortcuts" />
      <Tabs
        variant="pill"
        label="Shortcut groups"
        value={tab}
        onChange={setTab}
        items={tabs.map(t => ({ id: t.id, label: t.id }))}
        className="shortcut-tabs"
      />
      <div className="shortcut-list" role="tabpanel" key={tab}>
        {tabs
          .find(t => t.id === tab)!
          .rows.map(([label, keys]) => (
            <div key={label}>
              <span>{label}</span>
              <span className="shortcut-keys">
                {keys.map((key, i) => (
                  <Keys key={i} combo={key} />
                ))}
              </span>
            </div>
          ))}
      </div>
      <footer className="shortcuts-footer">Shortcuts pause while you type.</footer>
    </Dialog>
  );
}

/** Asks when a Todo should come back. It sits above the Undo toast and drops away when answered. */
export function DuePopover({
  prompt,
  setDue,
  dismiss,
}: {
  prompt?: { id: string; key: number };
  setDue: (id: string, day: string, label: string) => void;
  dismiss: () => void;
}) {
  const { mounted, closing } = usePresence(!!prompt);
  const shown = useLatest(prompt);
  if (!mounted || !shown) return null;
  const nextWeek = (8 - new Date().getDay()) % 7 || 7;
  return (
    <div
      key={shown.key}
      className={cx('due-popover ui-surface', closing && 'is-closing')}
      role="dialog"
      aria-label="When should this come back?"
    >
      <span>Due</span>
      {(
        [
          ['Today', 0],
          ['Tomorrow', 1],
          ['Next week', nextWeek],
        ] as const
      ).map(([label, offset]) => (
        <button
          key={label}
          onClick={() => setDue(shown.id, isoDay(offset), 'Due ' + label.toLowerCase())}
        >
          {label}
        </button>
      ))}
      <button className="due-skip" aria-label="No due date" onClick={dismiss}>
        <X size={12} />
      </button>
    </div>
  );
}

/** Messages waiting out the undo-send delay, each with a draining progress bar. */
export function PendingSends({
  drafts,
  seconds,
  undo,
}: {
  drafts: Draft[];
  seconds: number;
  undo: (draft: Draft) => void;
}) {
  // The countdown ticks here, and only while something is waiting, so the rest of the app does not re-render every second.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!drafts.length) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [drafts.length > 0]);
  if (!drafts.length) return null;
  return (
    <div className="pending-sends">
      {drafts.map(d => (
        <PendingSend key={d.id} draft={d} now={now} seconds={seconds} undo={undo} />
      ))}
    </div>
  );
}

function PendingSend({
  draft,
  now,
  seconds,
  undo,
}: {
  draft: Draft;
  now: number;
  seconds: number;
  undo: (draft: Draft) => void;
}) {
  const due = +new Date(draft.pendingSendAt!);
  // Fixed at mount so the once-a-second countdown re-render does not restart the bar.
  const [bar] = useState(() => {
    const ms = Math.max(0, due - Date.now());
    return {
      '--send-ms': ms + 'ms',
      '--send-start': String(Math.min(1, ms / 1000 / Math.max(1, seconds))),
    } as React.CSSProperties;
  });
  const left = Math.max(0, Math.ceil((due - now) / 1000));
  return (
    <div className="pending-send ui-surface" style={bar}>
      <span className="pending-spinner" />
      <span>
        Sending “{draft.subject || 'your message'}”{left > 0 ? ' in ' + left + 's' : '…'}
      </span>
      <Button variant="text" className="pending-undo" onClick={() => undo(draft)}>
        Undo send
      </Button>
      <i className="pending-progress" aria-hidden="true" />
    </div>
  );
}

export function ComposeSkeleton() {
  return (
    <div className="composer skeleton" aria-hidden="true">
      <div className="skeleton-row">
        <Skeleton width={90} />
        <span />
        <Skeleton width={64} height={22} radius={11} />
      </div>
      <div className="skeleton-row line">
        <Skeleton width={40} />
        <Skeleton width={180} />
      </div>
      <div className="skeleton-row line">
        <Skeleton width={28} />
        <Skeleton width={120} />
      </div>
      <div className="skeleton-row line">
        <Skeleton width={220} />
      </div>
      <div className="skeleton-body">
        <Skeleton width="62%" />
        <Skeleton width="44%" />
      </div>
      <div className="skeleton-row">
        <Skeleton width={70} />
      </div>
    </div>
  );
}
