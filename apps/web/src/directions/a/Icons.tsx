import type { ReactNode } from 'react';

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="glyph"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function ReplyIcon() {
  return (
    <Glyph>
      <path d="M6.5 4 3 7.5 6.5 11" />
      <path d="M3.5 7.5h6a3.5 3.5 0 0 1 3.5 3.5v1" />
    </Glyph>
  );
}

export function ClockIcon() {
  return (
    <Glyph>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 5v3.2l2 1.3" />
    </Glyph>
  );
}

export function CheckIcon() {
  return (
    <Glyph>
      <path d="m3.5 8.5 3 3 6-7" />
    </Glyph>
  );
}

export function MoreIcon() {
  return (
    <Glyph>
      <circle cx="3.5" cy="8" r=".6" fill="currentColor" />
      <circle cx="8" cy="8" r=".6" fill="currentColor" />
      <circle cx="12.5" cy="8" r=".6" fill="currentColor" />
    </Glyph>
  );
}

export function BubbleIcon() {
  return (
    <Glyph>
      <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h0a1 1 0 0 1-1-1z" />
    </Glyph>
  );
}

export function MailIcon() {
  return (
    <Glyph>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
      <path d="m3 4.5 5 4 5-4" />
    </Glyph>
  );
}

export function CalendarIcon() {
  return (
    <Glyph>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </Glyph>
  );
}
