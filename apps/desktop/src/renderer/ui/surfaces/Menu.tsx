/**
 * Menu: opaque --paper, --elev-float, radius 12, 32 px items, at least 220 px wide (DESIGN 6 Menu).
 * Controlled: the screen owns `activeId`; arrows move it, Return chooses, digits 1–9 pick in short menus,
 * Esc closes and focus returns to the anchor. The chosen item never blinks; the menu just closes.
 */
import { useEffect, useId, type KeyboardEvent } from 'react';
import type { ComponentPropsMap, MenuEntry, TagColor } from '../props';
import { PartIcon, PartKeys, keysFor, useDismiss, useFloating } from './parts';

type ItemEntry = Extract<MenuEntry, { kind: 'item' }>;

function Swatches({ swatch }: { swatch: TagColor | readonly TagColor[] }) {
  const colors = typeof swatch === 'string' ? [swatch] : swatch;
  return (
    <span className="ui-menu__swatches" aria-hidden="true">
      {colors.map((color) => (
        <i key={color} className="ui-menu__swatch" data-color={color} />
      ))}
    </span>
  );
}

export function Menu(props: ComponentPropsMap['Menu']) {
  const { open, anchor, label, entries, activeId, checkedId, numbered, onActiveChange, onSelect, onClose } = props;
  const baseId = useId();
  const { ref, style, placed } = useFloating(open, anchor, 'below-start');
  useDismiss(open, ref, anchor, onClose);

  useEffect(() => {
    if (open) ref.current?.focus({ preventScroll: true });
  }, [open, ref]);

  if (!open) return null;

  const items = entries.filter((entry): entry is ItemEntry => entry.kind === 'item');
  const enabled = items.filter((item) => !item.disabled);
  const digitOf = new Map<string, number>();
  if (numbered) items.slice(0, 9).forEach((item, i) => digitOf.set(item.id, i + 1));
  const domId = (id: string) => `${baseId}-${id}`;
  const picker = checkedId !== undefined;

  const choose = (id: string) => {
    const item = items.find((entry) => entry.id === id);
    if (!item || item.disabled) return;
    onSelect(id);
    onClose();
  };
  const move = (delta: number | 'first' | 'last') => {
    if (enabled.length === 0) return;
    const at = enabled.findIndex((item) => item.id === activeId);
    let next: number;
    if (delta === 'first') next = 0;
    else if (delta === 'last') next = enabled.length - 1;
    else if (at < 0) next = delta > 0 ? 0 : enabled.length - 1;
    else next = (at + delta + enabled.length) % enabled.length;
    onActiveChange?.(enabled[next].id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault();
      move(key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : key === 'Home' ? 'first' : 'last');
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (activeId) choose(activeId);
    } else if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchor?.focus();
    } else if (key === 'Tab') {
      onClose();
    } else if (numbered && /^[1-9]$/.test(key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const item = items[Number(key) - 1];
      if (item) {
        event.preventDefault();
        choose(item.id);
      }
    }
  };

  const activeItem = items.find((item) => item.id === activeId && !item.disabled);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      aria-activedescendant={activeItem ? domId(activeItem.id) : undefined}
      tabIndex={-1}
      className="ui-menu"
      data-placed={placed ? 'true' : undefined}
      data-numbered={numbered ? 'true' : undefined}
      style={style}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, index) => {
        if (entry.kind === 'separator') return <div key={`sep-${index}`} role="separator" className="ui-menu__sep" />;
        if (entry.kind === 'label') {
          return (
            <div key={`label-${index}`} role="presentation" className="ui-menu__label">
              {entry.label}
            </div>
          );
        }
        const digit = digitOf.get(entry.id);
        const checked = picker ? entry.id === checkedId : undefined;
        return (
          <div
            key={entry.id}
            id={domId(entry.id)}
            role={picker ? 'menuitemradio' : 'menuitem'}
            aria-checked={checked}
            aria-disabled={entry.disabled ? true : undefined}
            className="ui-menu__item"
            data-active={entry.id === activeItem?.id ? 'true' : undefined}
            data-tone={entry.danger ? 'danger' : undefined}
            data-detail={entry.detail ? 'true' : undefined}
            onPointerMove={() => {
              if (!entry.disabled && entry.id !== activeId) onActiveChange?.(entry.id);
            }}
            onClick={() => choose(entry.id)}
          >
            {numbered ? <span className="ui-menu__num">{digit ?? ''}</span> : null}
            {picker ? <span className="ui-menu__check">{checked ? <PartIcon name="check" /> : null}</span> : null}
            {entry.icon ? <PartIcon name={entry.icon} /> : null}
            {entry.swatch ? <Swatches swatch={entry.swatch} /> : null}
            <span className="ui-menu__text">
              <span className="ui-menu__item-label">{entry.label}</span>
              {entry.detail ? <span className="ui-menu__detail">{entry.detail}</span> : null}
              {entry.inlineAction ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className="ui-menu__inline"
                  data-tone={entry.inlineAction.tone}
                  onClick={(event) => {
                    event.stopPropagation();
                    entry.inlineAction?.onSelect();
                    onClose();
                  }}
                >
                  {entry.inlineAction.label}
                </button>
              ) : null}
            </span>
            {entry.aside ? <span className="ui-menu__aside">{entry.aside}</span> : null}
            <PartKeys chords={keysFor(entry.commandId)} />
          </div>
        );
      })}
    </div>
  );
}
