import type { ReactNode } from 'react';

// The app's line icons, redrawn small on a 16 px grid. Decorative: the words beside them carry the meaning.
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

export function PaperclipIcon() {
  return (
    <Glyph>
      <path d="m12.5 7.5-4.8 4.8a2.9 2.9 0 0 1-4.1-4.1l5.2-5.2a1.9 1.9 0 0 1 2.7 2.7L6.3 10.9a.95.95 0 0 1-1.3-1.3L9.6 5" />
    </Glyph>
  );
}

export function LinkIcon() {
  return (
    <Glyph>
      <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8" />
      <path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />
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

export function CloseIcon() {
  return (
    <Glyph>
      <path d="m4.5 4.5 7 7m0-7-7 7" />
    </Glyph>
  );
}

export function ArrowDownIcon() {
  return (
    <Glyph>
      <path d="M8 3v10m0 0-4-4m4 4 4-4" />
    </Glyph>
  );
}

export function DownloadIcon() {
  return (
    <Glyph>
      <path d="M8 2.5v8m0 0L4.75 7.25M8 10.5l3.25-3.25M3 13.25h10" />
    </Glyph>
  );
}

export type ActionIcon = 'reply' | 'paperclip' | 'link' | 'calendar' | 'check';

const actionIcons: Record<ActionIcon, () => ReactNode> = {
  reply: ReplyIcon,
  paperclip: PaperclipIcon,
  link: LinkIcon,
  calendar: CalendarIcon,
  check: CheckIcon,
};

/** The icon a suggested action wears, as in the app: the action's own icon, never an "AI" glyph. */
export function ActionGlyph({ icon }: { icon: ActionIcon }) {
  const Icon = actionIcons[icon];
  return <Icon />;
}
