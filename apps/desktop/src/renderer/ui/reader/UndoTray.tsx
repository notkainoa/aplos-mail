// UndoTray (DESIGN §6, §7.6 Send, §4.8 `undo-send`; plan 30 §4.5 #4). Mockups: reply.html (sent), compose.html.
// A --raised line under a sent message: "Sending to Jordan in 8 s · Undo Z · Send now", with a neutral 2 px
// bar that drains (scaleX 1 → 0) over the undo window. Reduced motion: no bar, the text countdown only.
// One notice per send; the same tray sits in ToastStack when no thread is visible.

import { useEffect, useRef, type CSSProperties } from 'react';
import { motions } from '../generated/motion';
import type { UndoTrayAction, UndoTrayProps, UndoTrayState } from '../props';
import { Action } from '../list/internal/Action';
import { splitCountdown } from '../surfaces/ToastMessage';
import { formatReaderTime } from '../list/internal/format';
import { useKeycapFor, useTooltipText } from '../list/internal/keys';

interface TrayCopy {
  text: string;
  actions: readonly { action: UndoTrayAction; label: string }[];
}

function copyFor(state: UndoTrayState): TrayCopy {
  switch (state.kind) {
    case 'sending':
      return {
        text: `Sending to ${state.recipients} in ${Math.max(0, Math.ceil(state.secondsLeft))} s`,
        actions: [
          { action: 'undo', label: 'Undo' },
          { action: 'sendNow', label: 'Send now' },
        ],
      };
    case 'uncertain':
      return {
        text: 'Couldn’t confirm this was sent.',
        actions: [
          { action: 'checkSent', label: 'Check Sent' },
          { action: 'sendAnyway', label: 'Send anyway' },
        ],
      };
    case 'suspended':
      return {
        text: 'Missed its time while your Mac was off.',
        actions: [
          { action: 'sendNow', label: 'Send now' },
          { action: 'reschedule', label: 'Reschedule' },
        ],
      };
    case 'deferred':
      return {
        text: `Couldn’t send until ${formatReaderTime(state.until)}. Your draft is saved.`,
        actions: [],
      };
  }
}

/** What the live region says when the tray appears or changes. */
function announcement(state: UndoTrayState, undoKey: string): string {
  if (state.kind === 'sending') {
    const press = undoKey ? ` Press ${undoKey} to undo.` : '';
    return `Sending to ${state.recipients} in ${Math.max(0, Math.ceil(state.secondsLeft))} seconds.${press}`;
  }
  return copyFor(state).text;
}

/** The tray's words; a countdown keeps " in 8 s" together and shortens the recipients with an ellipsis. */
function TrayText({ text }: { text: string }) {
  const split = splitCountdown(text);
  if (!split) return <span className="ui-undo-tray__text">{text}</span>;
  return (
    <span className="ui-undo-tray__text" data-countdown="">
      <span className="ui-undo-tray__lead" title={split.lead}>
        {split.lead}
      </span>
      <span className="ui-undo-tray__tail">{split.tail}</span>
    </span>
  );
}

/** The undo-send line and its follow-up notices. */
export function UndoTray({
  state,
  reducedMotion,
  placement,
  undoCommandId,
  onAction,
  announce,
}: UndoTrayProps) {
  const undoKey = useKeycapFor(undoCommandId);
  const tip = useTooltipText();
  const { text, actions } = copyFor(state);

  // The drain is laid out once per send from the undo window and the time already gone; React never
  // re-renders it per frame, and later secondsLeft updates only change the text.
  const start = useRef<{ total: number; left: number } | null>(null);
  if (state.kind === 'sending' && start.current === null)
    start.current = { total: state.totalSeconds, left: state.secondsLeft };
  if (state.kind !== 'sending') start.current = null;

  useEffect(() => {
    announce?.(announcement(state, undoKey));
    // Announce once per state kind (start, then the outcome), not every second.
  }, [state.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  let drainStyle: CSSProperties | undefined;
  if (state.kind === 'sending' && !reducedMotion && start.current && start.current.total > 0) {
    const base = motions['undo-send'].durations.base / 1000;
    const { total, left } = start.current;
    drainStyle = {
      '--undo-scale': String(total / base),
      '--undo-elapsed': String(Math.min(1, Math.max(0, (total - left) / total))),
    } as CSSProperties;
  }

  return (
    <div
      className="ui-undo-tray"
      data-state={state.kind}
      data-placement={placement}
      data-motion={reducedMotion ? 'reduced' : undefined}
      role={state.kind === 'sending' ? 'group' : 'status'}
      aria-label={state.kind === 'sending' ? 'Undo send' : undefined}
    >
      <div className="ui-undo-tray__inner">
        <TrayText text={text} />
        {actions.length > 0 ? (
          <span className="ui-undo-tray__actions">
            {actions.map(({ action, label }) => (
              <Action
                key={action}
                variant="text"
                size="sm"
                label={label}
                keycap={action === 'undo' ? undoKey : undefined}
                tooltip={action === 'undo' ? tip('Undo send', undoCommandId) : label}
                onPress={() => onAction(action)}
              />
            ))}
          </span>
        ) : null}
      </div>
      {drainStyle ? (
        <span className="ui-undo-tray__drain" style={drainStyle} aria-hidden="true" />
      ) : null}
    </div>
  );
}
