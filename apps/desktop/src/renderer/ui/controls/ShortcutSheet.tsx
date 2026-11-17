// ShortcutSheet (DESIGN §6, §8): the "?" sheet, generated from the registry (see sheetModel.ts). A dialog with
// three columns at a fixed height that scrolls, alternatives joined with "or", and columns that keep their
// places while the filter narrows them. Esc clears the filter first, then closes; "?" again, the close button
// and the scrim close too. Handles only its own widget's keys, and never while an IME is composing.
import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '../buttons-keys/Button';
import { KeyCaps } from '../buttons-keys/Kbd';
import type { ShortcutEntry, ShortcutGroup, ShortcutSheetProps } from '../props';
import { TextField } from './TextField';

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

function plainKeys(entry: ShortcutEntry): string {
  return entry.alternatives.map(alt => (alt.hold ? `hold ${alt.chord}` : alt.chord)).join(' or ');
}

function matches(entry: ShortcutEntry, needle: string): boolean {
  return (
    entry.label.toLowerCase().includes(needle) || plainKeys(entry).toLowerCase().includes(needle)
  );
}

/** The label with the first match marked; unchanged when lower-casing would shift the indexes (rare scripts). */
function highlight(text: string, needle: string): ReactNode {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const at = lower.length === text.length ? lower.indexOf(needle) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

/** True while the element's content runs on below the visible part (re-read on scroll and on resize). */
function useMoreBelow(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  });
  return [ref, more];
}

export function ShortcutSheet({
  open,
  groups,
  columns,
  query,
  onQueryChange,
  onClose,
}: ShortcutSheetProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const filterId = `${uid}-filter`;
  const dialogRef = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [bodyRef, more] = useMoreBelow();

  // Focus goes back to whatever opened the sheet. It is read during render, before the filter field takes focus.
  if (
    open &&
    opener.current === null &&
    typeof document !== 'undefined' &&
    document.activeElement instanceof HTMLElement
  ) {
    opener.current = document.activeElement;
  }
  useEffect(() => {
    if (open || !opener.current) return;
    opener.current.focus();
    opener.current = null;
  }, [open]);
  useEffect(() => () => opener.current?.focus(), []);

  if (!open) return null;

  const needle = query.trim().toLowerCase();
  const byId = new Map<string, ShortcutGroup>(groups.map(group => [group.id, group]));
  const visible = new Map<string, readonly ShortcutEntry[]>();
  let shown = 0;
  let total = 0;
  for (const group of groups) {
    total += group.entries.length;
    const entries = needle ? group.entries.filter(entry => matches(entry, needle)) : group.entries;
    if (entries.length > 0) visible.set(group.id, entries);
    shown += entries.length;
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    const inField = event.target instanceof HTMLInputElement;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (query) onQueryChange('');
      else onClose();
    } else if (event.key === '?' && !inField) {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Tab' && dialogRef.current) {
      const stops = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const sheet = (
    <div
      className="ui-shortcut-sheet"
      data-state="open"
      onPointerDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="ui-shortcut-sheet-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <header className="ui-shortcut-sheet-head">
          <div className="ui-shortcut-sheet-heading">
            <h2 id={titleId} className="ui-shortcut-sheet-title">
              Keyboard shortcuts
            </h2>
            <p className="ui-shortcut-sheet-sub" role="status">
              {needle ? `${shown} of ${total} shortcuts` : 'Hold ⌘ on any screen to show its keys.'}
            </p>
          </div>
          <div className="ui-shortcut-sheet-filter">
            <TextField
              id={filterId}
              value={query}
              onChange={onQueryChange}
              label="Filter shortcuts"
              placeholder="Filter shortcuts"
              type="search"
              icon="search"
              autoFocus
            />
          </div>
          <Button variant="icon" icon="close" label="Close" keys="Esc" onPress={onClose} />
        </header>
        <div
          ref={bodyRef}
          className="ui-shortcut-sheet-body"
          data-more={more ? 'below' : undefined}
          tabIndex={0}
          role="region"
          aria-label="All shortcuts"
        >
          {shown === 0 ? (
            <p className="ui-shortcut-sheet-empty">No shortcut matches ‘{query.trim()}’.</p>
          ) : (
            <div className="ui-shortcut-sheet-cols">
              {columns.map((ids, columnIndex) => (
                <div key={columnIndex} className="ui-shortcut-sheet-col">
                  {ids.map(groupId => {
                    const group = byId.get(groupId);
                    const entries = visible.get(groupId);
                    if (!group || !entries) return null;
                    const headingId = `${uid}-g-${groupId}`;
                    return (
                      <section
                        key={groupId}
                        className="ui-shortcut-group"
                        aria-labelledby={headingId}
                      >
                        <h3 id={headingId} className="ui-shortcut-group-label">
                          {group.label}
                        </h3>
                        <ul className="ui-shortcut-list">
                          {entries.map((entry, index) => (
                            <li key={`${entry.commandId}:${index}`} className="ui-shortcut-row">
                              <span className="ui-shortcut-label">
                                {highlight(entry.label, needle)}
                                {entry.note ? (
                                  <span className="ui-shortcut-note"> · {entry.note}</span>
                                ) : null}
                              </span>
                              <span className="ui-shortcut-keys">
                                <KeyCaps caps={entry.alternatives} reveal="always" />
                              </span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
  // Portalled to <body> like the tooltip, so no positioned sibling or transformed ancestor (the dock) can cover or trap it.
  return typeof document !== 'undefined' ? createPortal(sheet, document.body) : sheet;
}
