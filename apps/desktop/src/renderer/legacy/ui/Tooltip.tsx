import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFloating, type Placement } from './floating';
import { Keys } from './Kbd';

// After one tooltip closes, the next one opens without the hover delay (like native toolbars).
let warmUntil = 0;
const openDelay = 520;

export type TooltipProps = {
  /** Main line. */
  content: React.ReactNode;
  /** Optional dimmer second line(s). */
  detail?: React.ReactNode;
  /** Keyboard shortcut shown beside the content, e.g. "⌘ K". */
  shortcut?: string;
  placement?: Placement;
  disabled?: boolean;
  children: React.ReactNode;
};

export function Tooltip({
  content,
  detail,
  shortcut,
  placement = 'bottom',
  disabled,
  children,
}: TooltipProps) {
  const wrap = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  function target() {
    return wrap.current?.firstElementChild as HTMLElement | null;
  }
  function show() {
    if (disabled) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => {
        const el = target();
        if (el && el.isConnected) setAnchor(el.getBoundingClientRect());
      },
      Date.now() < warmUntil ? 0 : openDelay,
    );
  }
  function hide() {
    clearTimeout(timer.current);
    setAnchor(current => {
      if (current) warmUntil = Date.now() + 450;
      return null;
    });
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!anchor) return;
    const close = () => hide();
    addEventListener('scroll', close, true);
    addEventListener('blur', close);
    addEventListener('keydown', close, true);
    return () => {
      removeEventListener('scroll', close, true);
      removeEventListener('blur', close);
      removeEventListener('keydown', close, true);
    };
  }, [anchor]);
  useEffect(() => {
    if (disabled) hide();
  }, [disabled]);
  return (
    <span
      ref={wrap}
      className="ui-tip-anchor"
      onPointerEnter={e => {
        if (e.pointerType === 'mouse') show();
      }}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={e => {
        if ((e.target as HTMLElement).matches(':focus-visible')) show();
      }}
      onBlur={hide}
    >
      {children}
      {anchor &&
        createPortal(
          <Bubble
            anchor={anchor}
            placement={placement}
            content={content}
            detail={detail}
            shortcut={shortcut}
          />,
          document.body,
        )}
    </span>
  );
}

function Bubble({
  anchor,
  placement,
  content,
  detail,
  shortcut,
}: {
  anchor: DOMRect;
  placement: Placement;
  content: React.ReactNode;
  detail?: React.ReactNode;
  shortcut?: string;
}) {
  const { ref, style, side } = useFloating(anchor, placement, 8);
  return (
    <div
      ref={ref}
      role="tooltip"
      className={'ui-tooltip' + (detail ? ' rich' : '')}
      data-side={side}
      style={{ ...style, position: 'fixed' }}
    >
      <span className="ui-tooltip-main">
        <span>{content}</span>
        {shortcut && <Keys combo={shortcut} size="sm" />}
      </span>
      {detail && <span className="ui-tooltip-detail">{detail}</span>}
    </div>
  );
}
