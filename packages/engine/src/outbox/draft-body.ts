import type { RemoteDraftWrite } from '../store';
import { REMOTE_BODY_MAX } from './draft-state';

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
  /** Over the limit: not escaped or kept, only remembered so that it still counts as the body on offer. */
  over?: boolean;
}

/** Escaping only grows a text, so a source already over the limit is dropped before any work is done on it. */
function candidate(body: string, build: (body: string) => string = b => b): Candidate {
  if (body.length > REMOTE_BODY_MAX) return { html: '', blank: false, over: true };
  return { html: build(body), blank: body === '' };
}

/** The bodies the fact offers, best first: top-level `html`, then `text`, then an `html` on the message. */
function candidates(w: RemoteDraftWrite): Candidate[] {
  const found: Candidate[] = [];
  if (w.html !== undefined) found.push(candidate(w.html));
  if (w.text !== undefined) found.push(candidate(w.text, paragraphs));
  const inMessage = (w.message as MessageWithBody | undefined)?.html;
  if (inMessage !== undefined) found.push(candidate(inMessage));
  return found;
}

const bodies = new WeakMap<RemoteDraftWrite, string | undefined>();

/**
 * The draft's body when the provider delivered a usable one, as it would be stored. An empty body next to a snippet that
 * says there is text is a provider that sent nothing, not an empty draft; a body over the local limit (counted after
 * escaping and wrapping) is left out, so the draft stays snippet-only and a remote draft cannot hold more than a local
 * save may. Worked out once per fact: it is asked for several times.
 */
export function bodyOf(w: RemoteDraftWrite): string | undefined {
  if (bodies.has(w)) return bodies.get(w);
  const found = candidates(w);
  // A source over the limit means the provider's real body is too big to keep: never settle for another source then.
  if (found.some(c => c.over)) return void bodies.set(w, undefined);
  const snippet = w.message?.snippet;
  const body = found.find(c => !c.blank) ?? (snippet ? undefined : found[0]);
  const html = body && !body.over && body.html.length <= REMOTE_BODY_MAX ? body.html : undefined;
  bodies.set(w, html);
  return html;
}

/** Does this fact make the draft complete: a usable body and no attachments (those are not delivered)? */
export function completes(w: RemoteDraftWrite) {
  return bodyOf(w) !== undefined && w.message?.hasAttachments !== true;
}

/** The write's metadata in the shape `theirsFields` reads, with the usable body when there is one. */
export function messageOf(w: RemoteDraftWrite) {
  const { html: _offered, ...message } = (w.message ?? {}) as MessageWithBody;
  const html = bodyOf(w);
  return html === undefined ? message : { ...message, html };
}
