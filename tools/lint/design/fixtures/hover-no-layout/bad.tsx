import { useState } from 'react';
import { Kbd } from '../Kbd';

export function Row({ isHovering }: { isHovering: boolean }) {
  const [hovered, setHovered] = useState(false);
  const [over, setOver] = useState(false);
  return (
    <div
      onMouseEnter={() => setOver(true)}
      onMouseLeave={() => setOver(false)}
      onPointerOver={() => setHovered(true)}
    >
      {hovered && <Kbd>E</Kbd>} {/* @expect */}
      {over ? <Kbd keys="L" /> : null} {/* @expect */}
      {isHovering && (
        <span>
          <Kbd>D</Kbd> {/* @expect */}
        </span>
      )}
    </div>
  );
}

export const sheet = `.row:hover { display: block; }`; // @expect

export function Lower() {
  const [hovered, setHovered] = useState(false);
  return (
    <div onMouseEnter={() => setHovered(true)}>
      {hovered && <kbd>E</kbd>} {/* @expect */}
      {hovered ? <span className="keycap">L</span> : null} {/* @expect */}
    </div>
  );
}
