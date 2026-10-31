import type { RemoteDraftWrite } from '../store';
import { hasInlineRef, REMOTE_BODY_MAX } from './draft-state';

/**
 * The body a remote draft fact delivers: which of its sources counts, the size limit, and whether it makes the draft
 * complete. Split out of `draft-writes.ts` (the line limit); nothing here writes.
 */

type RemoteMessage = NonNullable<RemoteDraftWrite['message']>;
type MessageWithBody = RemoteMessage & { html?: string };

function paragraphs(text: string) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .split(/\r?\n\r?\n/)
    .map(p => `<p>${p.replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
}

interface Candidate {
  html: string;
  blank: boolean;
}

/** The bodies the fact offers, best first: top-level `html`, then `text`, then an `html` on the message. */
function candidates(w: RemoteDraftWrite): Candidate[] {
  const sources: [string | undefined, (body: string) => string][] = [
    [w.html, b => b],
    [w.text, paragraphs],
    [(w.message as MessageWithBody | undefined)?.html, b => b],
  ];
  return sources.flatMap(([body, build]) =>
    body === undefined ? [] : [{ html: build(body), blank: body === '' }],
  );
}

const bodies = new WeakMap<RemoteDraftWrite, string | undefined>();

/**
 * The draft's body when the provider delivered a usable one, as it would be stored. An empty body next to a snippet that
 * says there is text is a provider that sent nothing, not an empty draft; a body over the local limit (counted after
 * escaping and wrapping) is left out, so the draft stays snippet-only and a remote draft cannot hold more than a local
 * save may. Worked out once per fact: it is asked for several times.
 */
export function bodyOf(w: RemoteDraftWrite): string | undefined {
  if (!bodies.has(w)) bodies.set(w, pick(w));
  return bodies.get(w);
}

function pick(w: RemoteDraftWrite): string | undefined {
  // A source over the limit means the provider's real body is too big to keep: never settle for another source then.
  // Escaping only grows a text, so it is checked before any work is done on it.
  const offered = [w.html, w.text, (w.message as MessageWithBody | undefined)?.html];
  if (offered.some(body => (body?.length ?? 0) > REMOTE_BODY_MAX)) return undefined;
  const found = candidates(w);
  const snippet = w.message?.snippet;
  const body = found.find(c => !c.blank) ?? (snippet ? undefined : found[0]);
  // Escaping and wrapping can grow a text past the limit, so the stored body is measured too.
  return body && body.html.length <= REMOTE_BODY_MAX ? body.html : undefined;
}

/** Does this fact make the draft complete: a usable body, no attachments and no inline parts (those are not delivered)? */
export function completes(w: RemoteDraftWrite) {
  const body = bodyOf(w);
  return body !== undefined && w.message?.hasAttachments !== true && !hasInlineRef(body);
}

/** The write's metadata in the shape `theirsFields` reads, with the usable body when there is one. */
export function messageOf(w: RemoteDraftWrite) {
  const { html: _offered, ...message } = (w.message ?? {}) as MessageWithBody;
  const html = bodyOf(w);
  return html === undefined ? message : { ...message, html };
}
