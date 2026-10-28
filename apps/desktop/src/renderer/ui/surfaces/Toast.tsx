/**
 * Toast: one opaque notice, --paper, --elev-float, radius 12, `ui` text, up to 440 px (DESIGN 6, 7.13).
 * Wears its kind's icon (meaning never rides on colour alone). Plain toasts live 4 s, Undo toasts 8 s, then fade
 * over 400 ms (120 ms reduced); hover, focus or a hidden window pauses the clock. Durations come from motion.ts.
 * Announced politely; it never takes focus.
 */
import { useEffect, useRef, useState } from 'react';
import { themeHooks, timing, timingReduced } from '../generated/motion';
import type { ComponentPropsMap, IconName, ToastKind } from '../props';
import { PartIcon, PartKeys, keysFor, prefersReducedMotion } from './parts';

const KIND: Record<ToastKind, { icon: IconName; tone?: 'hill' | 'dusk' }> = {
  done: { icon: 'check', tone: 'hill' },
  later: { icon: 'clock', tone: 'dusk' },
  trash: { icon: 'trash' },
  home: { icon: 'home' },
  bookmark: { icon: 'bookmark' },
  undone: { icon: 'undo' },
  pending: { icon: 'refresh' },
  offline: { icon: 'cloud-off' },
  tip: { icon: 'keyboard' },
  info: { icon: 'check' },
};

type PauseReason = 'hover' | 'focus' | 'hidden';

/** A countdown that pauses for any reason and resumes with the time that was left. Null life = never expires. */
function useLifetime(life: number | null, onExpire: () => void) {
  const expire = useRef(onExpire);
  expire.current = onExpire;
  const left = useRef(life ?? 0);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reasons = useRef(new Set<PauseReason>());

  const stop = () => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    left.current = Math.max(0, left.current - (Date.now() - startedAt.current));
  };
  const start = () => {
    if (life === null || timer.current !== null || reasons.current.size > 0) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(() => {
      timer.current = null;
      expire.current();
    }, left.current);
  };

  useEffect(() => {
    if (life === null) return;
    left.current = life;
    const onVisibility = () => {
      if (document.hidden) {
        reasons.current.add('hidden');
        stop();
      } else {
        reasons.current.delete('hidden');
        start();
      }
    };
    if (document.hidden) reasons.current.add('hidden');
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
    // start/stop read refs only; the lifetime restarts only when the life itself changes.
  }, [life]);

  return {
    pause(reason: PauseReason) {
      reasons.current.add(reason);
      stop();
    },
    resume(reason: PauseReason) {
      reasons.current.delete(reason);
      start();
    },
  };
}

export function Toast({ kind, message, actions = [], undoable, persistent, onAction, onDismiss }: ComponentPropsMap['Toast']) {
  const [leaving, setLeaving] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const life = persistent ? null : undoable ? timing.toastUndo : timing.toast;
  const clock = useLifetime(leaving ? null : life, () => setLeaving(true));

  useEffect(() => {
    if (!leaving) return;
    const fade = prefersReducedMotion(themeHooks.reducedMotionQuery) ? timingReduced.toastFade : timing.toastFade;
    const t = setTimeout(() => dismiss.current(), fade);
    return () => clearTimeout(t);
  }, [leaving]);

  const look = KIND[kind];
  return (
    <div
      role="status"
      aria-atomic="true"
      className="ui-toast"
      data-kind={kind}
      data-state={leaving ? 'leaving' : 'shown'}
      onPointerEnter={() => clock.pause('hover')}
      onPointerLeave={() => clock.resume('hover')}
      onFocus={() => clock.pause('focus')}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clock.resume('focus');
      }}
    >
      <span className="ui-toast__icon" data-tone={look.tone}>
        <PartIcon name={look.icon} />
      </span>
      <span className="ui-toast__message">{message}</span>
      {actions.slice(0, 3).map((action) => (
        <button key={action.id} type="button" className="ui-toast__action" onClick={() => onAction(action.id)}>
          <span>{action.label}</span>
          <PartKeys chords={keysFor(action.commandId)} />
        </button>
      ))}
    </div>
  );
}
