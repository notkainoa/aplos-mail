import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { Feature } from './features';
import { ChevronIcon } from './icons';

const NEXT_KEYS = ['ArrowDown', 'j'];
const PREV_KEYS = ['ArrowUp', 'k'];

function rowButtons(list: HTMLElement | null) {
  return Array.from(list?.querySelectorAll<HTMLButtonElement>('[data-row]') ?? []);
}

function step(event: KeyboardEvent<HTMLElement>) {
  if (NEXT_KEYS.includes(event.key)) {
    return 1;
  }
  if (PREV_KEYS.includes(event.key)) {
    return -1;
  }
  return 0;
}

/** Moves the keyboard cursor between rows while focus is already in the list; elsewhere ↑/↓ scroll. */
function useRoving() {
  const ref = useRef<HTMLUListElement>(null);
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const delta = step(event);
    const buttons = rowButtons(ref.current);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (delta === 0 || index < 0) {
      return;
    }
    const next = buttons[index + delta];
    event.preventDefault();
    if (next) {
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    }
  }
  return { ref, onKeyDown };
}

function RowHead({
  feature,
  open,
  onToggle,
}: {
  feature: Feature;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="row-head"
      data-row=""
      aria-expanded={open}
      aria-controls={`reader-${feature.id}`}
      onClick={onToggle}
    >
      <span className="row-sender">{feature.sender}</span>
      <span className="row-subject">{feature.subject}</span>
      <span className="row-label">{feature.label}</span>
      <span className="row-chevron">
        <ChevronIcon />
      </span>
    </button>
  );
}

function Reader({ feature }: { feature: Feature }) {
  return (
    <div className="reader" id={`reader-${feature.id}`}>
      <p className="reader-summary" data-claim={feature.summaryClaim}>
        {feature.summary}
      </p>
      <div className="reader-body">{feature.body}</div>
      {feature.visual}
    </div>
  );
}

type RowsProps = { items: Feature[]; open: Set<string>; onToggle: (id: string) => void };

export function Rows({ items, open, onToggle }: RowsProps) {
  const roving = useRoving();
  return (
    <ul className="rows" ref={roving.ref} onKeyDown={roving.onKeyDown}>
      {items.map(feature => (
        <li key={feature.id} className={open.has(feature.id) ? 'row is-open' : 'row'}>
          <RowHead
            feature={feature}
            open={open.has(feature.id)}
            onToggle={() => onToggle(feature.id)}
          />
          {open.has(feature.id) ? <Reader feature={feature} /> : null}
        </li>
      ))}
    </ul>
  );
}

type Line = { sender: string; text: ReactNode; claim?: string; meta?: string };

/** Plain, non-expanding rows for the secondary sections. */
export function StaticRows({ lines }: { lines: Line[] }) {
  return (
    <ul className="rows rows-static">
      {lines.map(line => (
        <li key={line.sender} className="row">
          <div className="row-head">
            <span className="row-sender">{line.sender}</span>
            <span className="row-subject" data-claim={line.claim}>
              {line.text}
            </span>
            <span className="row-label">{line.meta}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
