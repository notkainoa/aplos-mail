import { useEffect, useRef, useState } from 'react';
import { Check } from '../icons';
import type { Icon } from './Button';
import type { Anchor, Placement } from './floating';
import { cx, reducedMotion } from './motion';
import { Popover } from './Popover';

export type MenuItem = {
  label: string;
  icon?: Icon;
  /** Shortcut hint shown at the trailing edge. */
  keys?: string;
  hint?: string;
  /** Leading avatar or swatch instead of an icon. */
  leading?: React.ReactNode;
  /** A count shown at the trailing edge, like the sidebar's. */
  count?: number;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => unknown;
};
export type MenuGroups = (MenuItem | false | null | undefined)[][];

type MenuProps = {
  open: boolean;
  anchor: Anchor;
  onClose: () => void;
  groups: MenuGroups;
  placement?: Placement;
  label?: string;
  className?: string;
  matchWidth?: boolean;
  onError?: (error: Error) => void;
};

/**
 * A keyboard-navigable menu. The highlight follows the pointer and arrow keys; choosing an
 * item blinks it briefly before the menu closes, like native menus do.
 */
export function Menu({
  open,
  anchor,
  onClose,
  groups,
  placement = 'bottom-end',
  label,
  className,
  matchWidth,
  onError,
}: MenuProps) {
  return (
    <Popover
      open={open}
      anchor={anchor}
      onClose={onClose}
      placement={placement}
      role="presentation"
      className={cx('ui-menu-surface', className)}
      matchWidth={matchWidth}
    >
      <MenuList groups={groups} label={label} onClose={onClose} onError={onError} />
    </Popover>
  );
}

function MenuList({
  groups,
  label,
  onClose,
  onError,
}: {
  groups: MenuGroups;
  label?: string;
  onClose: () => void;
  onError?: (error: Error) => void;
}) {
  const clean = groups
    .map(group => group.filter(Boolean) as MenuItem[])
    .filter(group => group.length);
  const flat = clean.flat();
  const [active, setActive] = useState(-1);
  const [chosen, setChosen] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.focus({ preventScroll: true });
  }, []);
  function choose(index: number) {
    const item = flat[index];
    if (!item || item.disabled || chosen >= 0) return;
    setChosen(index);
    const run = () => {
      onClose();
      void Promise.resolve()
        .then(item.onSelect)
        .catch(error => onError?.(error as Error));
    };
    if (reducedMotion()) run();
    else setTimeout(run, 90);
  }
  function step(delta: number) {
    if (!flat.length) return;
    let next = active;
    for (let i = 0; i < flat.length; i++) {
      next = (next + delta + flat.length) % flat.length;
      if (!flat[next].disabled) break;
    }
    setActive(next);
  }
  let index = -1;
  return (
    <div
      ref={list}
      className="ui-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      aria-activedescendant={active >= 0 ? 'menu-item-' + active : undefined}
      onKeyDown={event => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          step(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          step(-1);
        } else if (event.key === 'Home') {
          event.preventDefault();
          setActive(-1);
          step(1);
        } else if (event.key === 'End') {
          event.preventDefault();
          setActive(0);
          step(-1);
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (active >= 0) choose(active);
        } else if (event.key === 'Tab') {
          event.preventDefault();
          onClose();
        } else if (event.key.length === 1) {
          const at =
            flat.findIndex(
              (item, i) =>
                i > active && item.label.toLowerCase().startsWith(event.key.toLowerCase()),
            ) ?? -1;
          const wrap =
            at >= 0
              ? at
              : flat.findIndex(item =>
                  item.label.toLowerCase().startsWith(event.key.toLowerCase()),
                );
          if (wrap >= 0) setActive(wrap);
        }
        event.stopPropagation();
      }}
      onPointerLeave={() => {
        if (chosen < 0) setActive(-1);
      }}
    >
      {clean.map((group, g) => (
        <div className="ui-menu-group" role="group" key={g}>
          {group.map(item => {
            const i = ++index;
            const ItemIcon = item.icon;
            return (
              <div
                key={i + item.label}
                id={'menu-item-' + i}
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.checked}
                aria-disabled={item.disabled || undefined}
                className={cx(
                  'ui-menu-item',
                  item.danger && 'is-danger',
                  item.disabled && 'is-disabled',
                  active === i && 'is-active',
                  chosen === i && 'is-chosen',
                )}
                onPointerMove={() => {
                  if (chosen < 0 && !item.disabled && active !== i) setActive(i);
                }}
                onClick={() => choose(i)}
              >
                {item.leading ?? (ItemIcon && <ItemIcon size={15} />)}
                <span className="ui-menu-text">
                  <span>{item.label}</span>
                  {item.hint && <small>{item.hint}</small>}
                </span>
                {!!item.count && <span className="ui-menu-count">{item.count}</span>}
                {item.keys && <span className="ui-menu-keys">{item.keys}</span>}
                {item.checked && <Check size={14} className="ui-menu-check" />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Holds a menu's open state and the element it opened from. */
export function useMenu() {
  const [anchor, setAnchor] = useState<HTMLElement | DOMRect | null>(null);
  return {
    open: !!anchor,
    anchor,
    toggle: (event: React.MouseEvent<HTMLElement>) => {
      const target = event.currentTarget;
      setAnchor(current => (current ? null : target));
    },
    openAt: (rect: DOMRect | HTMLElement) => setAnchor(rect),
    close: () => setAnchor(null),
  };
}
