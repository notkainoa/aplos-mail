import { useRef } from 'react';
import { CheckIcon, ClockIcon, MoreIcon } from './Icons';
import { ActionButtonFace } from './Mocks';
import type { Mail } from './triageData';

export type Move = 'act' | 'later' | 'done';

type DragState = {
  id: number;
  x0: number;
  x: number;
  lastX: number;
  lastT: number;
  v: number;
  moving: boolean;
};

const THRESHOLD = 110;
const MAX_TILT = 2; // degrees, the app's own flight tilt

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const tilt = (x: number) => (still() ? 0 : Math.max(-MAX_TILT, Math.min(MAX_TILT, x / 60)));

function flung(drag: DragState) {
  if (Math.abs(drag.x) > THRESHOLD) return true;
  const fast = Math.abs(drag.v) > 0.5 && Math.abs(drag.x) > 30;
  return fast && Math.sign(drag.v) === Math.sign(drag.x);
}

// The card in focus can be dragged sideways, as in the app: past the threshold, or flicked, it goes to Later (left)
// or Done (right). Only transform is touched while dragging.
function useDrag(onMove?: (move: Move, x: number) => void, onDrag?: (x: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);

  const place = (x: number, animate: boolean) => {
    const el = ref.current!;
    el.style.transition = animate && !still() ? 'transform 320ms var(--ease-out)' : 'none';
    el.style.transform = x ? `translateX(${x}px) rotate(${tilt(x)}deg)` : '';
    onDrag?.(x);
  };

  const down = (event: React.PointerEvent) => {
    if (!onMove || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;
    const at = { x: event.clientX, t: event.timeStamp };
    drag.current = {
      id: event.pointerId,
      x0: at.x,
      x: 0,
      lastX: at.x,
      lastT: at.t,
      v: 0,
      moving: false,
    };
  };

  const move = (event: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const x = event.clientX - d.x0;
    if (!d.moving && Math.abs(x) < 6) return;
    if (!d.moving) {
      d.moving = true;
      ref.current!.setPointerCapture(event.pointerId);
    }
    const dt = event.timeStamp - d.lastT;
    if (dt > 0) d.v = (event.clientX - d.lastX) / dt;
    d.lastX = event.clientX;
    d.lastT = event.timeStamp;
    d.x = x;
    place(x, false);
  };

  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moving) return;
    if (!flung(d)) {
      place(0, true);
      return;
    }
    onDrag?.(0);
    onMove?.(d.x < 0 ? 'later' : 'done', d.x);
  };

  return { ref, down, move, up };
}

type CardProps = {
  mail: Mail;
  onMove?: (move: Move, x?: number) => void;
  ghost?: Move;
  from?: number;
  onDrag?: (x: number) => void;
};

function ghostStyle(from: number) {
  return { '--x': `${from}px`, '--r': `${tilt(from)}deg` } as React.CSSProperties;
}

/** The focus card: sender and due date, the summary in the serif, and the action row. */
export function TriageCard({ mail, onMove, ghost, from = 0, onDrag }: CardProps) {
  const { ref, down, move, up } = useDrag(onMove, onDrag);
  const pressed = (which: Move) => (ghost === which ? ' is-pressed' : '');
  return (
    <div
      ref={ref}
      className={`focus-card triage-card${ghost ? ` leaving leaving-${ghost}` : ' entering'}`}
      aria-hidden={ghost ? true : undefined}
      style={ghost ? ghostStyle(from) : undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div className="focus-meta">
        <span className="focus-sender">{mail.sender}</span>
        {mail.due ? (
          <span className={`chip${mail.overdue ? ' chip-overdue' : ''}`}>
            <ClockIcon />
            {mail.due}
          </span>
        ) : null}
        <span className="focus-time">{mail.when}</span>
      </div>
      <p className="focus-summary">{mail.summary}</p>
      <div className="focus-actions">
        <button
          type="button"
          tabIndex={-1}
          className={`app-filled${pressed('act')}`}
          onClick={() => onMove?.('act')}
        >
          <ActionButtonFace verb={mail.action.verb} icon={mail.action.icon} />
        </button>
        <span className="grow" />
        <button
          type="button"
          tabIndex={-1}
          className={`app-text${pressed('later')}`}
          onClick={() => onMove?.('later')}
        >
          <ClockIcon />
          Later <kbd className="kbd">←</kbd>
        </button>
        <button
          type="button"
          tabIndex={-1}
          className={`app-text${pressed('done')}`}
          onClick={() => onMove?.('done')}
        >
          <CheckIcon />
          Done <kbd className="kbd">→</kbd>
        </button>
        <span className="app-icon" aria-hidden="true">
          <MoreIcon />
        </span>
      </div>
    </div>
  );
}
