// The inline reply while dictating (ui-reader states): there is no microphone in the harness, so the reply card is
// drawn from the composer's own pieces with the dictation props a live recording gives it. Split out of
// scenes.reader.tsx, which keeps the scenes on the real app.

import type { ReactElement } from 'react';
import { InlineReply, RecipientField } from '../../../apps/desktop/src/renderer/ui/compose';
import { ThreadMessage } from '../../../apps/desktop/src/renderer/ui/reader';
import { BodyEditor } from '../../../apps/desktop/src/renderer/screens/compose/views/BodyEditor';
import { Column, noop } from './scenes.shared';

const JORDAN = { name: 'Jordan Park', address: 'jordan@studio.example' };

/** The reply the inline-reply states type. */
export const REPLY_TEXT =
  'Thanks Jordan. Direction two reads better to me, with the quieter header.';

const COMMANDS = {
  send: 'compose.send',
  attach: 'compose.attach',
  more: 'compose.format',
  cc: 'compose.ccBcc',
} as const;

/** There is no microphone in the harness: the reply card is drawn with the dictation props a live recording gives it. */
export function DictatingScene(): ReactElement {
  return (
    <Column width="reader">
      <ThreadMessage
        id="m-jordan"
        from="Jordan Park"
        toLabel="to you and Mina Cho"
        date="2026-10-29T08:12:00-07:00"
        cursor={false}
        body={<p>Can you send me your preference by tomorrow?</p>}
      />
      <InlineReply
        recipients={
          <RecipientField
            label="To"
            recipients={[{ id: 'jordan', ...JORDAN }]}
            query=""
            onQueryChange={noop}
            onCommit={noop}
            onRemove={noop}
            listboxId="dictating-to"
            ccButton={{ onSelect: noop, commandId: 'compose.ccBcc' }}
          />
        }
        onPopOut={noop}
        editor={<BodyEditor value={REPLY_TEXT} onChange={noop} label="Reply" />}
        draftState="saving"
        onRetrySave={noop}
        dictation={{ holdKey: 'R', level: 0.55 }}
        commands={COMMANDS}
        onSend={noop}
        onAttach={noop}
        onFormat={noop}
        onMore={noop}
      />
    </Column>
  );
}
