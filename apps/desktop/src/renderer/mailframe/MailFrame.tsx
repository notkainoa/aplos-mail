// MailFrame (plan 30 section 4.4, lane card ui-reader): the one host for a message body. HTML goes through a sandboxed
// iframe (the scriptless `srcdoc` frame on the stand-in engine today, the sealed `aplos-mail://` frame once `eng-html`
// lands, behind these same props); plain text renders as escaped host DOM. Security notes: PROTOCOL.md.

import { MailFrameView } from './MailFrameView';
import type { MailFrameProps } from './types';
import { releaseSource, useFrameSource } from './useFrameSource';

/** Show one message body, double-buffered against the previous letter. */
export function MailFrame({
  messageId,
  imagePolicy,
  findQuery,
  showQuoted,
  label,
  onReady,
  onKey,
}: MailFrameProps) {
  const { source, failed, reload } = useFrameSource(messageId, imagePolicy, findQuery);
  return (
    <MailFrameView
      source={source}
      findQuery={findQuery}
      showQuoted={showQuoted}
      label={label}
      failed={failed}
      onReady={onReady}
      onKey={onKey}
      onRetire={releaseSource}
      reload={reload}
    />
  );
}
