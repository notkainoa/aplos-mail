// One keycap (DESIGN §6 Kbd): 18 px, radius 4, caption, --sunken. One size only.
// Never revealed by hover: it renders for its `reveal` mode and the app-wide key-hint mode, nothing else.
// A 'badge' overlays its positioned parent and never shifts layout.
import { Fragment } from 'react';
import type { KbdProps, ShortcutChord } from '../props';
import { displayChord, revealVisible, useKeyHints } from './keyHints';

export function Kbd({ chord, reveal = 'always' }: KbdProps) {
  const { showKeys } = useKeyHints();
  if (!revealVisible(reveal, showKeys)) return null;
  return (
    <kbd className="ui-kbd" data-reveal={reveal}>
      {displayChord(chord)}
    </kbd>
  );
}

export interface KeyCapsProps {
  /** Alternatives, joined with the plain word "or"; a `hold` chord has the plain word "hold" before it. */
  caps: readonly ShortcutChord[];
  /** Same meaning as `Kbd.reveal`. Default 'always'. */
  reveal?: KbdProps['reveal'];
}

/** A row of keycaps for one control or one sheet entry: "J or ↓", "hold R". */
export function KeyCaps({ caps, reveal = 'always' }: KeyCapsProps) {
  const { showKeys } = useKeyHints();
  if (caps.length === 0 || !revealVisible(reveal, showKeys)) return null;
  return (
    <span className="ui-key-caps" data-reveal={reveal}>
      {caps.map((cap, index) => (
        <Fragment key={`${index}:${cap.chord}`}>
          {index > 0 ? <span className="ui-key-word">or</span> : null}
          {cap.hold ? <span className="ui-key-word">hold</span> : null}
          <Kbd chord={cap.chord} reveal={reveal} />
        </Fragment>
      ))}
    </span>
  );
}
