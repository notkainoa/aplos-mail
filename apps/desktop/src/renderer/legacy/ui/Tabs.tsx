import { useLayoutEffect, useRef, useState } from 'react';
import type { Icon } from './Button';
import { cx } from './motion';
import { Tooltip } from './Tooltip';

export type TabItem<T extends string> = {
  id: T;
  label: string;
  icon?: Icon;
  count?: number;
  tooltip?: { title: string; detail?: string };
  iconOnly?: boolean;
};
type TabsProps<T extends string> = {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** pill: rounded chips · underline: text with a sliding rule · segmented: toolbar switcher · nav: vertical list */
  variant?: 'pill' | 'underline' | 'segmented' | 'nav';
  label: string;
  className?: string;
  /** Use tab semantics (with panels) or a plain navigation group. */
  semantics?: 'tabs' | 'nav';
};

/** Tabs whose selection indicator slides between items. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  variant = 'pill',
  label,
  className,
  semantics = 'tabs',
}: TabsProps<T>) {
  const list = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [animate, setAnimate] = useState(false);
  const vertical = variant === 'nav';
  useLayoutEffect(() => {
    const root = list.current;
    if (!root) return;
    function measure() {
      const el = root!.querySelector<HTMLElement>('[data-selected="true"]');
      if (!el) {
        setBox(null);
        return;
      }
      setBox({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [value, items.map(item => item.id + item.label + (item.count ?? '')).join()]);
  // Skip the slide on first paint so the indicator does not fly in from the corner.
  useLayoutEffect(() => {
    if (box && !animate) {
      const frame = requestAnimationFrame(() => setAnimate(true));
      return () => cancelAnimationFrame(frame);
    }
  }, [box]);
  function key(event: React.KeyboardEvent) {
    const keys = vertical ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    const at = items.findIndex(item => item.id === value);
    let next = -1;
    if (event.key === keys[0]) next = (at - 1 + items.length) % items.length;
    else if (event.key === keys[1]) next = (at + 1) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onChange(items[next].id);
    requestAnimationFrame(() =>
      list.current?.querySelector<HTMLElement>('[data-selected="true"]')?.focus(),
    );
  }
  const tabs = semantics === 'tabs';
  return (
    <div
      ref={list}
      role={tabs ? 'tablist' : 'group'}
      aria-label={label}
      aria-orientation={tabs && vertical ? 'vertical' : undefined}
      className={cx('ui-tabs', 'ui-tabs-' + variant, className)}
      onKeyDown={key}
    >
      {box && (
        <span
          className={cx('ui-tabs-indicator', animate && 'is-animated')}
          aria-hidden="true"
          style={{ transform: `translate(${box.x}px,${box.y}px)`, width: box.w, height: box.h }}
        />
      )}
      {items.map(item => {
        const selected = item.id === value;
        const ItemIcon = item.icon;
        const button = (
          <button
            key={item.id}
            type="button"
            role={tabs ? 'tab' : undefined}
            aria-selected={tabs ? selected : undefined}
            aria-current={!tabs && selected ? 'page' : undefined}
            aria-label={item.iconOnly ? item.label : undefined}
            data-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={cx('ui-tab', selected && 'is-selected')}
            onClick={() => onChange(item.id)}
          >
            {ItemIcon && <ItemIcon size={variant === 'segmented' ? 15 : 14} />}
            {!item.iconOnly && <span className="ui-tab-label">{item.label}</span>}
            {item.count !== undefined && <span className="ui-tab-count">{item.count}</span>}
          </button>
        );
        return item.tooltip ? (
          <Tooltip key={item.id} content={item.tooltip.title} detail={item.tooltip.detail}>
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}
