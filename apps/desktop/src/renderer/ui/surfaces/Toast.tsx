/**
 * Toast: one opaque notice, --paper, --elev-float, radius 12, `ui` text, up to 440 px (DESIGN 6, 7.13).
 * Wears its kind's icon (meaning never rides on colour alone; a failure wears the alert in --stamp-ink, never a check).
 * Plain toasts live 4 s, Undo and error toasts 8 s, then fade
 * over 400 ms (120 ms reduced); hover, focus or a hidden window pauses the clock. Durations come from motion.ts.
 * Announced politely by the stack's persistent live region (a region inserted with its text already inside is
 * often not read); it never takes focus.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { themeHooks, timing, timingReduced } from '../generated/motion';
import type { ComponentPropsMap, IconName, ToastData, ToastKind } from '../props';
import { ToastMessage } from './ToastMessage';
import { PartButton, PartIcon, PartKeys, prefersReducedMotion, useKeysFor } from './parts';

const KIND: Record<ToastKind, { icon: IconName; tone?: 'hill' | 'dusk' | 'stamp' }> = {
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
  locked: { icon: 'lock' },
  error: { icon: 'alert', tone: 'stamp' },
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

  // stop reads refs only; start also reads `life`, so it changes identity (and the effect restarts) only with it.
  const stop = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    left.current = Math.max(0, left.current - (Date.now() - startedAt.current));
  }, []);
  const start = useCallback(() => {
    if (life === null || timer.current !== null || reasons.current.size > 0) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(() => {
      timer.current = null;
      expire.current();
    }, left.current);
  }, [life]);

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
  }, [life, start, stop]);

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

/** How long a toast stays before it fades: plain 4 s, Undo and error 8 s, a persistent one (a held send) until it is replaced. */
export function toastLife(
  toast: Pick<ToastData, 'kind' | 'undoable' | 'persistent'>,
): number | null {
  if (toast.persistent) return null;
  return toast.undoable || toast.kind === 'error' ? timing.toastUndo : timing.toast;
}

export function Toast({
  kind,
  message,
  actions = [],
  undoable,
  persistent,
  onAction,
  onDismiss,
}: ComponentPropsMap['Toast']) {
  const [leaving, setLeaving] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const closable = kind === 'error';
  const life = toastLife({ kind, undoable, persistent });
  const clock = useLifetime(leaving ? null : life, () => setLeaving(true));

  useEffect(() => {
    if (!leaving) return;
    const fade = prefersReducedMotion(themeHooks.reducedMotionQuery)
      ? timingReduced.toastFade
      : timing.toastFade;
    const t = setTimeout(() => dismiss.current(), fade);
    return () => clearTimeout(t);
  }, [leaving]);

  const keysOf = useKeysFor();
  const look = KIND[kind];
  return (
    <div
      className="ui-toast"
      data-kind={kind}
      data-state={leaving ? 'leaving' : 'shown'}
      data-actions={actions.length > 0 ? '' : undefined}
      onPointerEnter={() => clock.pause('hover')}
      onPointerLeave={() => clock.resume('hover')}
      onFocus={() => clock.pause('focus')}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          clock.resume('focus');
      }}
    >
      <span className="ui-toast__icon" data-tone={look.tone}>
        <PartIcon name={look.icon} />
      </span>
      <ToastMessage message={message} />
      {actions.slice(0, 3).map(action => (
        <button
          key={action.id}
          type="button"
          className="ui-toast__action"
          onClick={() => onAction(action.id)}
        >
          <span>{action.label}</span>
          <PartKeys chords={keysOf(action.commandId ?? action.keysFrom)} />
        </button>
      ))}
      {closable ? (
        <span className="ui-toast__dismiss">
          <PartButton
            variant="icon"
            size="sm"
            icon="close"
            label="Dismiss"
            onPress={() => setLeaving(true)}
          />
        </span>
      ) : null}
    </div>
  );
}
