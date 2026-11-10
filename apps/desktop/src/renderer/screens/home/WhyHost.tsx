/**
 * "Why it's here" (DESIGN 7.2, 6): the small popover opened from ⋯ or I, anchored to the thread's letter or row. It asks
 * the engine for the reason, shows nothing until the answer comes (never a skeleton), and offers the ⌥↑ / ⌥↓ lane
 * corrections. A Popover is the primitive for rich content that takes focus and gives it back on Esc.
 */
import { useEffect, useState } from 'react';
import { api, type ThreadId, type WhyItsHere } from '../../data';
import { Popover } from '../../ui/surfaces';
import type { Lane } from '../../ui/props';
import { Why } from '../../ui/reader/Why';

/** The thread the popover explains, and the element it hangs from. */
export interface WhyTarget {
  readonly id: ThreadId;
  readonly anchor: HTMLElement;
}

type WhyState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly answer: WhyItsHere }
  | { readonly kind: 'failed' };

const LOADING: WhyState = { kind: 'loading' };
const LANES: readonly Lane[] = ['do', 'update', 'low'];
const LANE_COMMANDS = { up: 'mail.laneUp', down: 'mail.laneDown' } as const;

/** The lane the answer names; a lane a newer engine added reads as the middle one, so both corrections stay on offer. */
function laneOfAnswer(answer: WhyItsHere): Lane {
  return LANES.find(lane => lane === answer.lane) ?? 'update';
}

/** The engine's answer for one thread. */
function useWhyAnswer(threadId: ThreadId): WhyState {
  const [state, setState] = useState<WhyState>(LOADING);
  useEffect(() => {
    let current = true;
    api.thread.why({ threadId }).then(
      answer => current && setState({ kind: 'ready', answer }),
      () => current && setState({ kind: 'failed' }),
    );
    return () => {
      current = false;
    };
  }, [threadId]);
  return state;
}

/** ⌥↑ / ⌥↓ while the popover has focus: the popover is a modal context, so the list's own keys do not reach it. */
function useLaneKeys(lane: Lane | null, onMove: (direction: 'up' | 'down') => void): void {
  useEffect(() => {
    if (lane === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.isComposing) return;
      const direction = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : null;
      if (direction === null || (direction === 'up' && lane === 'do')) return;
      if (direction === 'down' && lane === 'low') return;
      event.preventDefault();
      event.stopPropagation();
      onMove(direction);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [lane, onMove]);
}

/**
 * Esc and the other ways out leave focus in the list. The Popover hands focus back to its anchor, but a row or letter is
 * an option, which cannot take focus; the listbox around it can.
 */
export function restoreListFocus(
  find: (selector: string) => { focus(options?: FocusOptions): void } | null,
): void {
  (find('[role="listbox"]') ?? find('.aplos-one-by-one__card'))?.focus({ preventScroll: true });
}

/** The answer is for a thread the cursor has left: the popover must not open for the old row. */
export function isStaleWhy(target: WhyTarget, current: ThreadId | null): boolean {
  return current !== target.id;
}

/** Props for `WhyHost`. */
export interface WhyHostProps {
  readonly target: WhyTarget;
  /** The thread under the cursor now. A different one drops the popover, even while its answer is still loading. */
  readonly current: ThreadId | null;
  /** A lane correction was chosen; the host has already closed. */
  readonly onMove: (direction: 'up' | 'down') => void;
  readonly onClose: () => void;
}

export function WhyHost({ target, current, onMove, onClose }: WhyHostProps) {
  const state = useWhyAnswer(target.id);
  const stale = isStaleWhy(target, current);
  useEffect(() => {
    if (stale) onClose();
  }, [stale, onClose]);
  const close = () => {
    restoreListFocus(selector => target.anchor.closest<HTMLElement>(selector));
    onClose();
  };
  const move = (direction: 'up' | 'down') => {
    close();
    onMove(direction);
  };
  useLaneKeys(state.kind === 'ready' ? laneOfAnswer(state.answer) : null, move);
  if (stale || state.kind === 'loading') return null;
  return (
    <Popover
      open
      anchor={target.anchor}
      label="Why it’s here"
      role="dialog"
      placement="below-start"
      onClose={close}
    >
      {state.kind === 'ready' ? (
        <Why
          reason={state.answer.sentence}
          quote={state.answer.quote}
          lane={laneOfAnswer(state.answer)}
          commands={LANE_COMMANDS}
          onMove={move}
        />
      ) : (
        <p className="aplos-why-failed">Couldn’t load the reason.</p>
      )}
    </Popover>
  );
}
