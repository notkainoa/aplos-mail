/**
 * Menu: opaque --paper, --elev-float, radius 12, 32 px items, at least 220 px wide (DESIGN 6 Menu).
 * Controlled: the screen owns `activeId`; arrows move it, Return chooses, digits 1–9 pick in short menus,
 * → fires the active row's inline action, Esc closes. Focus returns to the anchor on every close, before the
 * screen hears the choice, so it is never lost. The chosen item never blinks; the menu just closes (`reveal` out).
 */
import { useEffect, useId, type KeyboardEvent } from 'react';
import { motions } from '../generated/motion';
import type { ComponentPropsMap, MenuEntry, TagColor } from '../props';
import {
  PartIcon,
  PartKeys,
  SrOnly,
  useKeysFor,
  lowerFirst,
  useDismiss,
  useFloating,
  usePresence,
} from './parts';

/**
 * A whitespace text node. The item and its text column are flex containers, which draw no whitespace, but a checker
 * that joins the visible text (axe label-content-name-mismatch) then reads "ReplyR" and cannot find it in the
 * accessible name "Reply R". Layout is unchanged.
 */
const SPACE = ' ';

type ItemEntry = Extract<MenuEntry, { kind: 'item' }>;

function Swatches({ swatch }: { swatch: TagColor | readonly TagColor[] }) {
  const colors = typeof swatch === 'string' ? [swatch] : swatch;
  return (
    <span className="ui-menu__swatches" aria-hidden="true">
      {colors.map((color, index) => (
        <i key={index} className="ui-menu__swatch" data-color={color} />
      ))}
    </span>
  );
}

export function Menu(props: ComponentPropsMap['Menu']) {
  const {
    id,
    open,
    anchor,
    label,
    entries,
    activeId,
    checkedId,
    numbered,
    onActiveChange,
    onSelect,
    onClose,
  } = props;
  const baseId = useId();
  const keysOf = useKeysFor();
  const { mounted, leaving } = usePresence(open, motions.reveal.durations.out);
  const { ref, style, placed } = useFloating(mounted, anchor, 'below-start');
  useDismiss(open, ref, anchor, onClose);

  useEffect(() => {
    if (open) ref.current?.focus({ preventScroll: true });
  }, [open, ref]);

  if (!mounted) return null;

  const items = entries.filter((entry): entry is ItemEntry => entry.kind === 'item');
  const enabled = items.filter(item => !item.disabled);
  const digitOf = new Map<string, number>();
  if (numbered) items.slice(0, 9).forEach((item, i) => digitOf.set(item.id, i + 1));
  const domId = (id: string) => `${baseId}-${id}`;
  const picker = checkedId !== undefined;

  // Focus goes back to the anchor first, so a screen that moves focus on select (a dialog, a field) still wins.
  const close = () => {
    anchor?.focus({ preventScroll: true });
    onClose();
  };
  const choose = (id: string) => {
    const item = items.find(entry => entry.id === id);
    if (!item || item.disabled) return;
    anchor?.focus({ preventScroll: true });
    onSelect(id);
    onClose();
  };
  const fireInline = (item: ItemEntry) => {
    if (!item.inlineAction || item.disabled) return;
    anchor?.focus({ preventScroll: true });
    item.inlineAction.onSelect();
    onClose();
  };
  const move = (delta: number | 'first' | 'last') => {
    if (enabled.length === 0) return;
    const at = enabled.findIndex(item => item.id === activeId);
    let next: number;
    if (delta === 'first') next = 0;
    else if (delta === 'last') next = enabled.length - 1;
    else if (at < 0) next = delta > 0 ? 0 : enabled.length - 1;
    else next = (at + delta + enabled.length) % enabled.length;
    onActiveChange?.(enabled[next].id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || leaving) return;
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault();
      move(key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : key === 'Home' ? 'first' : 'last');
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (activeId) choose(activeId);
    } else if (key === 'ArrowRight') {
      const item = items.find(entry => entry.id === activeId);
      if (item?.inlineAction) {
        event.preventDefault();
        fireInline(item);
      }
    } else if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (key === 'Tab') {
      onClose();
    } else if (
      numbered &&
      /^[1-9]$/.test(key) &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const item = items[Number(key) - 1];
      if (item) {
        event.preventDefault();
        choose(item.id);
      }
    }
  };

  const activeItem = items.find(item => item.id === activeId && !item.disabled);

  return (
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-label={label}
      aria-activedescendant={activeItem ? domId(activeItem.id) : undefined}
      tabIndex={-1}
      className="ui-menu"
      data-state={leaving ? 'leaving' : 'open'}
      aria-hidden={leaving ? true : undefined}
      inert={leaving}
      data-placed={placed ? 'true' : undefined}
      data-numbered={numbered ? 'true' : undefined}
      style={style}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, index) => {
        if (entry.kind === 'separator')
          return <div key={`sep-${index}`} role="separator" className="ui-menu__sep" />;
        if (entry.kind === 'label') {
          return (
            <div key={`label-${index}`} role="presentation" className="ui-menu__label">
              {entry.label}
            </div>
          );
        }
        const digit = digitOf.get(entry.id);
        const checked = picker ? entry.id === checkedId : undefined;
        const labelId = `${domId(entry.id)}-label`;
        const detailId = entry.detail ? `${domId(entry.id)}-detail` : undefined;
        const hintId = entry.inlineAction ? `${domId(entry.id)}-hint` : undefined;
        const asideId = entry.aside ? `${domId(entry.id)}-aside` : undefined;
        const chords = keysOf(entry.commandId);
        const keysId = chords.length > 0 ? `${domId(entry.id)}-keys` : undefined;
        // The name holds every visible word (label, detail, aside, keys), so it contains the visible text (WCAG 2.5.3).
        const nameIds = [labelId, detailId, asideId, keysId].filter(Boolean).join(' ');
        return (
          <div
            key={entry.id}
            id={domId(entry.id)}
            role={picker ? 'menuitemradio' : 'menuitem'}
            aria-labelledby={nameIds}
            aria-describedby={hintId}
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
            {numbered ? (
              <span className="ui-menu__num" aria-hidden="true">
                {digit ?? ''}
              </span>
            ) : null}
            {picker ? (
              <span className="ui-menu__check" aria-hidden="true">
                {checked ? <PartIcon name="check" /> : null}
              </span>
            ) : null}
            {entry.icon ? <PartIcon name={entry.icon} /> : null}
            {entry.swatch ? <Swatches swatch={entry.swatch} /> : null}
            <span className="ui-menu__text">
              <span className="ui-menu__item-label" id={labelId}>
                {entry.label}
              </span>
              {entry.detail ? (
                <>
                  {SPACE}
                  <span className="ui-menu__detail" id={detailId}>
                    {entry.detail}
                  </span>
                </>
              ) : null}
              {entry.inlineAction ? (
                <>
                  {/* Pointer duplicate of → on the active row; the key path is spoken through the hint. */}
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden="true"
                    className="ui-menu__inline"
                    data-tone={entry.inlineAction.tone}
                    onClick={event => {
                      event.stopPropagation();
                      fireInline(entry);
                    }}
                  >
                    {entry.inlineAction.label}
                  </button>
                  <SrOnly
                    id={hintId}
                  >{`Press Right Arrow to ${lowerFirst(entry.inlineAction.label)}.`}</SrOnly>
                </>
              ) : null}
            </span>
            {entry.aside ? (
              <>
                {SPACE}
                <span className="ui-menu__aside" id={asideId}>
                  {entry.aside}
                </span>
              </>
            ) : null}
            {chords.length > 0 ? SPACE : null}
            <PartKeys chords={chords} id={keysId} />
          </div>
        );
      })}
    </div>
  );
}
