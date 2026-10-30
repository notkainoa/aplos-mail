// A plain-text body as escaped host DOM: React text nodes only, links from textSegments, find marks. It follows the
// theme because it sits in the reader's `read` body (ThreadMessage styles the type).

import type { MouseEvent } from 'react';
import { handleLinkClick } from './links';
import { textSegments } from './text';

/** Props of PlainText. */
export interface PlainTextProps {
  text: string;
  findQuery?: string;
}

function onLink(event: MouseEvent<HTMLAnchorElement>) {
  handleLinkClick(event.nativeEvent);
}

/** Render a plain-text body with links and find marks. */
export function PlainText({ text, findQuery }: PlainTextProps) {
  return (
    <div className="aplos-mailframe__text" style={{ whiteSpace: 'pre-wrap' }}>
      {textSegments(text, findQuery).map((segment, i) => {
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
      })}
    </div>
  );
}
