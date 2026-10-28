/**
 * Puck: one shared selection indicator per group (DESIGN 4.8 `slide`, 6). The thumb is a single element whose
 * size is fixed on first measure; selection moves it with translate + scale, never width. 'segmented' is a
 * --sunken track with a --paper thumb (--elev-puck); 'selection' is rows with a --puck fill (sidebar, Settings nav).
 * Before the first measure (server render) the selected item paints its own fill, so nothing is ever unselected.
 */
import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { ComponentPropsMap, PuckItem } from '../props';
import { PartIcon, PartTip, formatCount, keysFor } from './parts';

interface Thumb {
  x: number;
  y: number;
  sx: number;
  sy: number;
  w: number;
  h: number;
}

function PuckCell({ item, selected, role, focusable, onSelect, onKeyDown }: { item: PuckItem; selected: boolean; role: 'tabs' | 'navigation' | 'radio'; focusable: boolean; onSelect: () => void; onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void }) {
  const tipId = useId();
  const chords = keysFor(item.commandId);
  const hasTip = chords.length > 0 || item.tooltip !== undefined || item.shortLabel !== undefined;
  const roleAttr = role === 'tabs' ? 'tab' : role === 'radio' ? 'radio' : undefined;
  return (
    <span className="ui-puck__cell ui-part-tipwrap" data-puck-id={item.id}>
      <button
        type="button"
        role={roleAttr}
        className="ui-puck__item"
        data-selected={selected ? 'true' : undefined}
        aria-selected={role === 'tabs' ? selected : undefined}
        aria-checked={role === 'radio' ? selected : undefined}
        aria-current={role === 'navigation' && selected ? 'page' : undefined}
        aria-label={item.shortLabel ? item.label : undefined}
        aria-describedby={hasTip ? tipId : undefined}
        tabIndex={role === 'navigation' ? undefined : focusable ? 0 : -1}
        disabled={item.disabled}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        {item.icon ? <PartIcon name={item.icon} /> : null}
        {item.swatch ? <i className="ui-puck__swatch" data-color={item.swatch} aria-hidden="true" /> : null}
        <span className="ui-puck__label">{item.shortLabel ?? item.label}</span>
        {item.count !== undefined ? <span className="ui-puck__count">{formatCount(item.count)}</span> : null}
      </button>
      {hasTip ? <PartTip id={tipId} label={item.label} detail={item.tooltip} chords={chords} placement={role === 'navigation' ? 'end' : 'below'} /> : null}
    </span>
  );
}

export function Puck({ kind, role, orientation, label, items, selectedId, onSelect }: ComponentPropsMap['Puck']) {
  const vertical = (orientation ?? (kind === 'segmented' ? 'horizontal' : 'vertical')) === 'vertical';
  const trackRef = useRef<HTMLDivElement | null>(null);
  const base = useRef<{ w: number; h: number } | null>(null);
  const [thumb, setThumb] = useState<Thumb | null>(null);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const cell = selectedId === null ? null : Array.from(track.querySelectorAll<HTMLElement>('[data-puck-id]')).find((el) => el.dataset.puckId === selectedId);
      if (!cell || cell.offsetWidth === 0) {
        setThumb(null);
        return;
      }
      const w = cell.offsetWidth;
      const h = cell.offsetHeight;
      base.current ??= { w, h };
      setThumb({ x: cell.offsetLeft, y: cell.offsetTop, sx: w / base.current.w, sy: h / base.current.h, w: base.current.w, h: base.current.h });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(track);
    return () => observer?.disconnect();
  }, [selectedId, items]);

  const enabled = items.filter((item) => !item.disabled);
  const roving = role !== 'navigation';
  const focusId = selectedId !== null && enabled.some((item) => item.id === selectedId) ? selectedId : enabled[0]?.id;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!roving || event.nativeEvent.isComposing) return;
    const nextKeys = vertical ? ['ArrowDown'] : ['ArrowRight'];
    const prevKeys = vertical ? ['ArrowUp'] : ['ArrowLeft'];
    const at = enabled.findIndex((item) => item.id === focusId);
    let next = -1;
    if (nextKeys.includes(event.key)) next = (at + 1) % enabled.length;
    else if (prevKeys.includes(event.key)) next = (at - 1 + enabled.length) % enabled.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = enabled.length - 1;
    if (next < 0 || enabled.length === 0) return;
    event.preventDefault();
    const id = enabled[next].id;
    onSelect(id);
    trackRef.current?.querySelector<HTMLElement>(`[data-puck-id="${CSS.escape(id)}"] button`)?.focus();
  };

  const thumbStyle = thumb
    ? ({
        '--puck-x': `${thumb.x}px`,
        '--puck-y': `${thumb.y}px`,
        '--puck-sx': String(thumb.sx),
        '--puck-sy': String(thumb.sy),
        '--puck-w': `${thumb.w}px`,
        '--puck-h': `${thumb.h}px`,
      } as CSSProperties)
    : undefined;

  const track = (
    <div
      ref={trackRef}
      className="ui-puck"
      data-kind={kind}
      data-orientation={vertical ? 'vertical' : 'horizontal'}
      data-ready={thumb ? 'true' : undefined}
      role={role === 'tabs' ? 'tablist' : role === 'radio' ? 'radiogroup' : undefined}
      aria-label={role === 'navigation' ? undefined : label}
      aria-orientation={role === 'tabs' ? (vertical ? 'vertical' : 'horizontal') : undefined}
    >
      <span className="ui-puck__thumb" aria-hidden="true" style={thumbStyle} />
      {items.map((item) => (
        <PuckCell
          key={item.id}
          item={item}
          role={role}
          selected={item.id === selectedId}
          focusable={item.id === focusId}
          onSelect={() => onSelect(item.id)}
          onKeyDown={roving ? onKeyDown : undefined}
        />
      ))}
    </div>
  );

  if (role === 'navigation') {
    return (
      <nav className="ui-puck__nav" aria-label={label}>
        {track}
      </nav>
    );
  }
  return track;
}
