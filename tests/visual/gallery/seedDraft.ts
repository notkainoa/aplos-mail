import type { FixtureEngine } from '@aplos/contract-fixture';
import { textToHtml } from '../../../apps/desktop/src/renderer/screens/compose/model/fields';
import { NEW_MESSAGE } from './readerDemo';

type Fixture = FixtureEngine['fixture'];

/** The new-message page as a saved draft: To, subject and a 120-word body, the draft line "Draft saved". */
export const NEW_MESSAGE_DRAFT = 'demo-work:draft-plan';

export function seedNewMessageDraft(fx: Fixture): void {
  const base = fx.store.all('Draft')[0];
  if (!base) return;
  const { threadId: _thread, replyToMessageId: _reply, ...rest } = base;
  const [name, address] = NEW_MESSAGE.to.replace('>', '').split(' <');
  fx.write({ kind: 'Fixture/control' }, tx => {
    tx.put('Draft', {
      ...rest,
      id: NEW_MESSAGE_DRAFT,
      mode: 'new',
      to: [{ address: address ?? '', name: name ?? '' }],
      subject: NEW_MESSAGE.subject,
      html: textToHtml(NEW_MESSAGE.body),
    });
  });
}
