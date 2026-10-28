import { useState } from 'react';
import { Kbd } from '../Kbd';

export function Row({ showAllHints, commandHeld }: { showAllHints: boolean; commandHeld: boolean }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <Kbd>E</Kbd>
      {showAllHints && <Kbd>L</Kbd>}
      {commandHeld ? <Kbd>D</Kbd> : null}
      <span style={{ color: hovered ? 'var(--ink)' : 'var(--dim)' }}>Maple Library</span>
    </div>
  );
}

export const sheet = `.row:hover { background: var(--hover); }`;

export function Plain() {
  return <div><kbd>E</kbd><span className="keycap">L</span></div>;
}
