// A plain-text body as escaped host DOM: React text nodes only, links from textSegments, find marks. It follows the
// theme because it sits in the reader's `read` body (ThreadMessage styles the type and spaces its paragraphs: a blank
// line in the text is a paragraph break, so the gap is the body's 16 px, not a 26 px empty line). Quoted history (`quoted`) is
// left out until `showQuoted`, then drawn as a quiet block without its `>` marks (reader.css styles it).

import { useMemo, type MouseEvent } from 'react';
import { handleLinkClick } from './links';
import { hasOwnText, quotedParts, type QuotedRange } from './quoted';
import { textSegments } from './text';

/** Props of PlainText. */
export interface PlainTextProps {
  text: string;
  findQuery?: string;
  /** Quoted history in `text`. Absent or empty: the text is drawn whole, as written. */
  quoted?: readonly QuotedRange[];
  /** Draw the quoted history (O, "Show quoted text"); otherwise it is left out. */
  showQuoted?: boolean;
}

const PRE_WRAP = { whiteSpace: 'pre-wrap' } as const;

function onLink(event: MouseEvent<HTMLAnchorElement>) {
  handleLinkClick(event.nativeEvent);
}

function Segments({ text, findQuery }: { text: string; findQuery?: string }) {
  const segments = useMemo(() => textSegments(text, findQuery), [text, findQuery]);
  return segments.map((segment, i) => {
    if (segment.kind === 'mark') return <mark key={i}>{segment.text}</mark>;
    if (segment.kind === 'text') return segment.text;
    return (
      <a
        key={i}
        href={segment.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onLink}
        onAuxClick={onLink}
      >
        {segment.text}
      </a>
    );
  });
}

const BLANK_LINES = /\n(?:[ \t]*\n)+/;

/** A run of text as paragraphs: blank lines become paragraph breaks (the body spaces `p + p`), single breaks stay. */
function Paragraphs({ text, findQuery }: { text: string; findQuery?: string }) {
  const paragraphs = text.split(BLANK_LINES).filter(p => p.trim() !== '');
  return paragraphs.map((paragraph, i) => (
    <p key={i} dir="auto">
      <Segments text={paragraph} findQuery={findQuery} />
    </p>
  ));
}

function Parts({
  text,
  findQuery,
  quoted,
  showQuoted,
}: Required<Omit<PlainTextProps, 'findQuery'>> & { findQuery?: string }) {
  const parts = useMemo(() => quotedParts(text, quoted), [text, quoted]);
  // A body that is nothing but quote (a forward) is the content: it has no words of the sender's to fold it under.
  const open = showQuoted || !hasOwnText(parts);
  return parts.map((part, i) => {
    if (part.kind === 'own')
      return (
        <div key={i} className="aplos-mailframe__part">
          <Paragraphs text={part.text} findQuery={findQuery} />
        </div>
      );
    if (!open) return null;
    return (
      <blockquote key={i} className="aplos-mailframe__quote">
        <Paragraphs text={part.text} findQuery={findQuery} />
      </blockquote>
    );
  });
}

/** Render a plain-text body with links and find marks, its quoted history hidden or quiet. */
export function PlainText({ text, findQuery, quoted, showQuoted = false }: PlainTextProps) {
  const split = quoted !== undefined && quoted.length > 0;
  return (
    <div
      className="aplos-mailframe__text"
      data-quoted={split ? 'true' : undefined}
      style={PRE_WRAP}
    >
      {split ? (
        <Parts text={text} findQuery={findQuery} quoted={quoted} showQuoted={showQuoted} />
      ) : (
        <Paragraphs text={text} findQuery={findQuery} />
      )}
    </div>
  );
}
