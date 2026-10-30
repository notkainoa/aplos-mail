// The stand-in fetch: `useMessageBody` (renderer/data/bodies.ts, `MessageBody/get`) for the kind and plain text, then
// `api.mail.frame` (`Mail/frame`) for HTML. The stand-in answers with `srcdoc`; the real engine with an
// `aplos-mail://` URL only. Returns null until the letter for the current request is known.

import { useEffect, useMemo, useState } from 'react';
import { api, useMessageBody } from '../data';
import { tokenOf } from './protocol';
import type { FrameSource, ImagePolicy } from './types';

/** The hook's answer. */
export interface FrameSourceState {
  /** The letter for the current request; null while fetching. */
  source: FrameSource | null;
  /** Set when the body or frame could not load. */
  failed: { retry: () => void } | null;
}

interface FrameAnswer {
  request: string;
  source: FrameSource | null;
  failed: boolean;
}

/** Build the source for one `Mail/frame` answer. */
export function sourceOfFrame(
  request: string,
  frame: { url: string; srcdoc?: string; trackersRemoved: number },
  imagePolicy: ImagePolicy,
  findQuery: string | undefined,
): FrameSource {
  if (frame.srcdoc !== undefined) {
    const key = `${request}|${frame.url}`;
    return { kind: 'srcdoc', key, html: frame.srcdoc, imagePolicy, findQuery, url: frame.url };
  }
  const token = tokenOf(frame.url);
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

  useEffect(() => {
    if (!html) return;
    let live = true;
    api.mail.frame({ messageId, imagePolicy, findQuery: find }).then(
      frame => {
        const source = sourceOfFrame(request, frame, imagePolicy, find);
        if (live) setAnswer({ request, source, failed: false });
        else void api.mail.release({ url: frame.url }).catch(() => {});
      },
      () => live && setAnswer({ request, source: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [html, messageId, imagePolicy, find, request, attempt]);

  const plain = ready && ready.messageId === messageId && !html ? ready.text : null;
  const text = useMemo<FrameSource | null>(
    () => (plain === null ? null : { kind: 'text', key: `${messageId}|text`, text: plain }),
    [messageId, plain],
  );

  if (body.status === 'failed') return { source: null, failed: { retry: body.retry } };
  if (text) return { source: text, failed: null };
  if (!html || answer?.request !== request) return { source: null, failed: null };
  if (answer.failed) {
    const retry = () => {
      setAnswer(null);
      setAttempt(n => n + 1);
    };
    return { source: null, failed: { retry } };
  }
  return { source: answer.source, failed: null };
}

/** Free a frame token when its letter leaves (`Mail/release`). Plain text has none. */
export function releaseSource(source: FrameSource): void {
  if (source.kind === 'text' || !source.url) return;
  void api.mail.release({ url: source.url }).catch(() => {});
}
