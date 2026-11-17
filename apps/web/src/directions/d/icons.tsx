import type { ReactNode } from 'react';

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="ico"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function ClockIcon() {
  return (
    <Glyph>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.4" />
    </Glyph>
  );
}

export function CheckIcon() {
  return (
    <Glyph>
      <path d="M3.4 8.4l3 3 6.2-6.6" />
    </Glyph>
  );
}

export function ChevronIcon() {
  return (
    <Glyph>
      <path d="M6 4l4 4-4 4" />
    </Glyph>
  );
}

export function UndoIcon() {
  return (
    <Glyph>
      <path d="M5.5 4L3 6.5 5.5 9" />
      <path d="M3 6.5h6.5a3.5 3.5 0 010 7H7" />
    </Glyph>
  );
}

export function ArrowLeft() {
  return <span aria-hidden="true">←</span>;
}

export function ArrowRight() {
  return <span aria-hidden="true">→</span>;
}
