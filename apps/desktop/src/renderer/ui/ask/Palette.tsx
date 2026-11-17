import { Fragment, useEffect, useId, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { ConfirmProps, PaletteItem, PaletteProps } from '../props';
import { Icon } from '../compose/icons';
import { keycapsFor } from '../compose/keycaps';
import { Kbd } from '../compose/parts';
import { nextActiveId } from './palette-nav';

/** The label with the matched characters in 600. `matches` are code-point indices of `label`. */
function MatchedLabel({ label, matches }: { label: string; matches?: readonly number[] }) {
  if (!matches || matches.length === 0) return <>{label}</>;
  const hit = new Set(matches);
  const runs: { text: string; bold: boolean }[] = [];
  Array.from(label).forEach((char, index) => {
    const bold = hit.has(index);
    const last = runs[runs.length - 1];
    if (last && last.bold === bold) last.text += char;
    else runs.push({ text: char, bold });
  });
  return (
    <>
      {runs.map((run, index) =>
        run.bold ? <b key={index}>{run.text}</b> : <Fragment key={index}>{run.text}</Fragment>,
      )}
    </>
  );
}

function ConfirmView({ confirm }: { confirm: ConfirmProps }) {
  const titleId = useId();
  const {
    question,
    consequence,
    confirmLabel,
    cancelLabel = 'Cancel',
    destructive,
    onConfirm,
    onCancel,
  } = confirm;
  const cancel = (
    <button
      type="button"
      className="ui-palette__key-row"
      data-primary={destructive ? 'true' : undefined}
      onClick={onCancel}
    >
      <span>{cancelLabel}</span>
      <Kbd>{destructive ? 'Return' : 'Esc'}</Kbd>
    </button>
  );
  const confirmRow = (
    <button
      type="button"
      className="ui-palette__key-row"
      data-primary={destructive ? undefined : 'true'}
      data-tone={destructive ? 'danger' : undefined}
      onClick={onConfirm}
    >
      {destructive ? <Icon name="trash" /> : null}
      <span>{confirmLabel}</span>
      <Kbd>{destructive ? '⇧Return' : 'Return'}</Kbd>
    </button>
  );
  return (
    <div
      className="ui-palette__confirm"
      role="group"
      aria-labelledby={titleId}
      data-destructive={destructive ? 'true' : undefined}
    >
      <p className="ui-palette__confirm-ask" id={titleId} dir="auto">
        {question}
      </p>
      <p className="ui-palette__confirm-what" dir="auto">
        {consequence}
      </p>
      <div className="ui-palette__keys">
        {destructive ? cancel : confirmRow}
        {destructive ? confirmRow : cancel}
      </div>
    </div>
  );
}

/**
 * ⌘K, the only overlay (DESIGN §6 Palette, §7.9): an opaque `--paper` panel on `--elev-float`, 600 px wide, centred,
 * over a light scrim. A context line says what the commands act on. Suggested and Go to show first; keycaps come from
 * the registry; 1 to 9 run the Nth result only while the field is empty; Esc goes up a level, then closes.
 * A destructive command opens an inline confirm whose default is Cancel: Return cancels, ⇧Return confirms.
 * A WAI-ARIA combobox: the field keeps focus and `aria-activedescendant` names the highlighted option.
 * The `settle` in and out is the motion runtime's.
 */
export function Palette(props: PaletteProps) {
  const {
    open,
    query,
    onQueryChange,
    context,
    trail,
    sections,
    activeId,
    onActiveChange,
    onRun,
    confirm,
    listboxId,
    onBack,
    onClose,
    announce,
  } = props;
  const resultsRef = useRef<HTMLDivElement>(null);
  // Only the keyboard (and digits) may scroll the list; a pointer-driven change never does, so hover moves nothing.
  const keyboardMoved = useRef(false);
  const flat: PaletteItem[] = sections.flatMap(section => [...section.items]);
  const empty = query === '';

  useEffect(() => {
    if (!confirm) return;
    (confirm.announce ?? announce)?.(
      confirm.destructive
        ? `${confirm.question} Cancel is selected. Return cancels, Shift Return confirms.`
        : `${confirm.question} Return confirms, Escape cancels.`,
    );
    // Announce on entry only; the callbacks may change identity each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(confirm)]);

  useEffect(() => {
    if (!keyboardMoved.current) return;
    keyboardMoved.current = false;
    resultsRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  if (!open) return null;

  function move(step: 1 | -1) {
    const next = nextActiveId(
      flat.map(item => item.id),
      activeId,
      step,
    );
    if (next === undefined) return;
    keyboardMoved.current = true;
    onActiveChange(next);
  }

  function onConfirmKey(event: KeyboardEvent<HTMLElement>, pending: ConfirmProps) {
    // On a focused key row Return is that button's own click; the Return mapping is for the field.
    if (event.key !== 'Enter' || (event.target as HTMLElement).tagName === 'BUTTON') return;
    event.preventDefault();
    if (event.shiftKey || !pending.destructive) pending.onConfirm();
    else pending.onCancel();
  }

  /** A bare digit 1 to 9 picks that result, in the empty palette only. */
  function digitPick(event: KeyboardEvent<HTMLElement>): PaletteItem | undefined {
    const { key } = event;
    const bare = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (!/^[1-9]$/.test(key) || !empty || !bare || Number(key) > Math.min(9, flat.length)) return;
    return flat[Number(key) - 1];
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing) return;
    const key = event.key;
    if (event.metaKey && key.toLowerCase() === 'k') {
      event.preventDefault();
      onClose();
      return;
    }
    if (key === 'Escape') {
      event.preventDefault();
      if (confirm) confirm.onCancel();
      else if (trail && trail.length > 0) onBack();
      else onClose();
      return;
    }
    if (confirm) {
      onConfirmKey(event, confirm);
      return;
    }
    if (key === 'ArrowDown' || (event.ctrlKey && key === 'n')) {
      event.preventDefault();
      move(1);
    } else if (key === 'ArrowUp' || (event.ctrlKey && key === 'p')) {
      event.preventDefault();
      move(-1);
    } else if (key === 'Enter') {
      if (activeId) {
        event.preventDefault();
        onRun(activeId);
      }
    } else {
      const picked = digitPick(event);
      if (!picked) return;
      event.preventDefault();
      onRun(picked.id);
    }
  }

  const listing = !confirm && flat.length > 0;
  let number = 0;
  return (
    <div
      className="ui-palette"
      data-open="true"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="ui-palette__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Commands"
        onKeyDown={onKeyDown}
      >
        <div className="ui-palette__field">
          <Icon name="search" />
          {trail && trail.length > 0 ? (
            <ol className="ui-palette__trail" aria-label="Path">
              {trail.map((crumb, index) => (
                <li key={`${index}:${crumb}`} dir="auto">
                  <span className="ui-palette__trail-text">{crumb}</span>
                  <Icon name="chevron-right" size="xs" />
                </li>
              ))}
            </ol>
          ) : null}
          <input
            className="ui-palette__input"
            type="text"
            role="combobox"
            aria-label="Command"
            aria-autocomplete="list"
            aria-expanded={listing}
            aria-controls={listing ? listboxId : undefined}
            aria-activedescendant={listing ? activeId : undefined}
            placeholder="Type a command"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            dir="auto"
            readOnly={Boolean(confirm)}
            value={query}
            onChange={event => onQueryChange(event.target.value)}
          />
        </div>
        {confirm ? (
          <ConfirmView confirm={confirm} />
        ) : (
          <>
            {context ? (
              <p className="ui-palette__context" title={context}>
                For: <b dir="auto">{context}</b>
              </p>
            ) : null}
            {flat.length === 0 ? (
              <p
                className="ui-palette__none"
                role="status"
                dir="auto"
              >{`No commands match “${query.trim()}”.`}</p>
            ) : (
              <div
                id={listboxId}
                ref={resultsRef}
                className="ui-palette__results"
                role="listbox"
                aria-label="Commands"
              >
                {sections.map(section => {
                  const labelId = `${listboxId}-${section.id}`;
                  return (
                    <div
                      key={section.id}
                      className="ui-palette__section"
                      role="group"
                      aria-labelledby={labelId}
                    >
                      <div
                        id={labelId}
                        className="ui-palette__section-label"
                        data-hidden={empty ? undefined : 'true'}
                      >
                        {section.label}
                      </div>
                      {section.items.map(item => {
                        number += 1;
                        const active = item.id === activeId;
                        return (
                          <div
                            key={item.id}
                            id={item.id}
                            className="ui-palette__option"
                            role="option"
                            aria-selected={active}
                            data-active={active ? 'true' : undefined}
                            data-destructive={item.destructive ? 'true' : undefined}
                            onMouseDown={event => event.preventDefault()}
                            onPointerMove={() => {
                              keyboardMoved.current = false;
                              if (!active) onActiveChange(item.id);
                            }}
                            onClick={() => onRun(item.id)}
                          >
                            {empty && number <= 9 ? (
                              <span className="ui-palette__num">{number}</span>
                            ) : null}
                            {item.icon ? (
                              <Icon name={item.icon} />
                            ) : (
                              <span className="ui-palette__icon-gap" aria-hidden="true" />
                            )}
                            <span className="ui-palette__label" dir="auto">
                              <MatchedLabel label={item.label} matches={item.matches} />
                            </span>
                            <span className="ui-palette__right">
                              {!empty && item.group ? (
                                <span className="ui-palette__group">{item.group}</span>
                              ) : null}
                              {keycapsFor(item.commandId).map((cap, index) => (
                                <Fragment key={cap}>
                                  {index > 0 ? <span className="ui-palette__or">or</span> : null}
                                  <Kbd>{cap}</Kbd>
                                </Fragment>
                              ))}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
