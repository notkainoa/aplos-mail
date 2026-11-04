/**
 * The reader's small writes to the engine that are not triage: remembering a sender's images and starting an
 * attachment's download. Each says plainly when it fails (DESIGN 7.15) and never shows a raw engine error.
 */
import { api, type Message } from '../../data';
import { pushToast } from '../../shell';
import type { DownloadState } from './readerRows';

const NOT_SAVED = 'Couldn’t save that. Nothing changed.';

/** "Load images from this sender": remember the sender. The images load now whether or not this is saved. */
export function allowImagesFrom(message: Message): void {
  const sender = message.from?.address;
  if (!sender) return;
  api.mail.allowImages({ sender, allow: true }).catch(() =>
    pushToast({
      id: `images-${message.id}`,
      kind: 'info',
      message: NOT_SAVED,
      undoable: false,
    }),
  );
}

/**
 * Makes an attachment's bytes available (`Attachment/get`) and reports its state. Handing the bytes to the owner (Save
 * or Open) needs a preload route that does not exist yet, so a finished fetch only marks the chip ready.
 */
export function fetchAttachment(
  message: Message,
  attachmentId: string,
  report: (state: DownloadState) => void,
): void {
  report('downloading');
  api.attachment.get({ messageId: message.id, attachmentId }).then(
    () => report('ready'),
    () => report('failed'),
  );
}
