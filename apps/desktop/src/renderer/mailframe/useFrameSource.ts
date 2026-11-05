// The stand-in fetch: `useMessageBody` (renderer/data/bodies.ts, `MessageBody/get`) for the kind and plain text, then
// `api.mail.frame` (`Mail/frame`) for HTML. The stand-in answers with `srcdoc`; the real engine with an
// `aplos-mail://` URL only. Returns null until the letter for the current request is known. The `srcdoc` frame is
// same-origin with the renderer, so it is mounted in a Vite dev build only; elsewhere a `srcdoc` answer shows the
// body-failed state (PROTOCOL.md "Why the srcdoc frame is same-origin").

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, useMessageBody } from '../data';
import { tokenOf } from './protocol';
import { quotedRangesFor } from './quoted';
import type { FrameSource, ImagePolicy } from './types';

/** The hook's answer. */
export interface FrameSourceState {
  /** The letter for the current request; null while fetching. */
  source: FrameSource | null;
  /** Set when the body or frame could not load. */
  failed: { retry: () => void } | null;
  /** Ask `Mail/frame` again (a new token): Try again after the frame timed out. */
  reload: () => void;
}

interface FrameAnswer {
  request: string;
  source: FrameSource | null;
  failed: boolean;
}

/** True only in a Vite dev build (`npm run dev`). Packaged builds and Node (no `import.meta.env`) are not. */
export function isDevBuild(): boolean {
  return import.meta.env?.DEV === true;
}

/**
 * Build the source for one `Mail/frame` answer; null for a `srcdoc` answer outside a dev build and for a URL that is
 * not an `aplos-mail://m/<token>/` document.
 */
export function sourceOfFrame(
  request: string,
  frame: { url: string; srcdoc?: string; trackersRemoved: number },
  imagePolicy: ImagePolicy,
  findQuery: string | undefined,
  dev = isDevBuild(),
): FrameSource | null {
  if (frame.srcdoc !== undefined) {
    if (!dev) return null;
    const key = `${request}|${frame.url}`;
    return { kind: 'srcdoc', key, html: frame.srcdoc, imagePolicy, findQuery, url: frame.url };
  }
  // A URL outside the engine's grammar has no token the reporter could echo: fail now, not after the deadline.
  const token = tokenOf(frame.url);
  if (!token) return null;
  return {
    kind: 'url',
    key: `${request}|${frame.url}`,
    url: frame.url,
    token,
    blocked: frame.trackersRemoved,
  };
}

/** Load the letter for (messageId, imagePolicy, findQuery). */
export function useFrameSource(
  messageId: string,
  imagePolicy: ImagePolicy,
  findQuery: string | undefined,
): FrameSourceState {
  const body = useMessageBody(messageId);
  const find = findQuery?.trim() || undefined;
  const request = `${messageId}|${imagePolicy}|${find ?? ''}`;
  const [answer, setAnswer] = useState<FrameAnswer | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ready = body.status === 'ready' ? body.body : undefined;
  const html = ready?.messageId === messageId && ready.bodyKind === 'html';
  const reload = useCallback(() => {
    setAnswer(null);
    setAttempt(n => n + 1);
  }, []);

  useEffect(() => {
    if (!html) return;
    let live = true;
    api.mail.frame({ messageId, imagePolicy, findQuery: find }).then(
      frame => {
        const source = sourceOfFrame(request, frame, imagePolicy, find);
        if (live) setAnswer({ request, source, failed: source === null });
        if (!live || source === null) void api.mail.release({ url: frame.url }).catch(() => {});
      },
      () => live && setAnswer({ request, source: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [html, messageId, imagePolicy, find, request, attempt]);

  const plain = ready && ready.messageId === messageId && !html ? ready.text : null;
  const engineQuoted = ready?.quoted;
  const text = useMemo<FrameSource | null>(() => {
    if (plain === null) return null;
    const quoted = quotedRangesFor(plain, engineQuoted ?? []);
    return { kind: 'text', key: `${messageId}|text`, text: plain, quoted };
  }, [messageId, plain, engineQuoted]);

  if (body.status === 'failed') return { source: null, failed: { retry: body.retry }, reload };
  if (text) return { source: text, failed: null, reload };
  if (!html || answer?.request !== request) return { source: null, failed: null, reload };
  if (answer.failed) return { source: null, failed: { retry: reload }, reload };
  return { source: answer.source, failed: null, reload };
}

/** Free a frame token when its letter leaves (`Mail/release`). Plain text has none. */
export function releaseSource(source: FrameSource): void {
  if (source.kind === 'text' || !source.url) return;
  void api.mail.release({ url: source.url }).catch(() => {});
}
