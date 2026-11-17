/**
 * "Unsubscribe" in the card header (round 6): a quiet text button, drawn only for a thread that offers List-Unsubscribe.
 * It asks first in the app's Confirm dialog, then runs `Unsubscribe/run` and says the outcome in one toast.
 */
import { useState } from 'react';
import { api, type ThreadRow } from '../../data';
import { pushToast } from '../../shell';
import { Button } from '../../ui/buttons-keys';
import { Confirm } from '../../ui/surfaces';
import { senderOf } from '../home/homeRows';
import { unsubscribeFailed, unsubscribeNotice, type UnsubscribeNotice } from './unsubscribe';

function say(notice: UnsubscribeNotice, id: string): void {
  pushToast({ id, kind: 'info', message: notice.message, undoable: false });
  if (notice.open) void api.shell.open({ url: notice.open }).catch(() => undefined);
}

async function run(row: ThreadRow): Promise<void> {
  const sender = senderOf(row);
  const id = `unsubscribe-${row.id}`;
  try {
    say(unsubscribeNotice(await api.unsubscribe.run({ threadId: row.id }), sender), id);
  } catch {
    say(unsubscribeFailed(sender), id);
  }
}

export function UnsubscribeAction({ row }: { readonly row: ThreadRow }) {
  const [asking, setAsking] = useState(false);
  if (!row.unsubscribe) return null;
  const sender = senderOf(row);
  return (
    <>
      <Button variant="text" size="sm" label="Unsubscribe" onPress={() => setAsking(true)} />
      {asking ? (
        <Confirm
          presentation="dialog"
          destructive={false}
          question={`Unsubscribe from ${sender}?`}
          consequence="Aplos asks the sender to stop emailing you. Mail already here stays."
          confirmLabel="Unsubscribe"
          onConfirm={() => {
            setAsking(false);
            void run(row);
          }}
          onCancel={() => setAsking(false)}
        />
      ) : null}
    </>
  );
}
