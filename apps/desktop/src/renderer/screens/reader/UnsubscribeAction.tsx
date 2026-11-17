/**
 * "Unsubscribe" in the card header (round 6): a quiet text button, drawn only for a thread that offers List-Unsubscribe.
 * It asks first in the app's Confirm dialog, then runs `Unsubscribe/run` and says the outcome in one toast.
 */
import { useState } from 'react';
import { api, type ThreadRow } from '../../data';
import { openCompose, pushToast } from '../../shell';
import { Button } from '../../ui/buttons-keys';
import { Confirm } from '../../ui/surfaces';
import { senderOf } from '../home/homeRows';
import { unsubscribeFailed, unsubscribeNotice, type UnsubscribeNotice } from './unsubscribe';

function say(notice: UnsubscribeNotice, id: string, row: ThreadRow): void {
  pushToast({ id, kind: 'info', message: notice.message, undoable: false });
  if (notice.open) void api.shell.open({ url: notice.open }).catch(() => undefined);
  // A mailto never sends from here: the prepared email opens in a new message, from the account that got the mail.
  if (notice.compose) openCompose({ prefill: { accountId: row.accountId, ...notice.compose } });
}

async function run(row: ThreadRow): Promise<void> {
  const sender = senderOf(row);
  const id = `unsubscribe-${row.id}`;
  try {
    say(unsubscribeNotice(await api.unsubscribe.run({ threadId: row.id }), sender), id, row);
  } catch {
    say(unsubscribeFailed(sender), id, row);
  }
}

export function UnsubscribeAction({ row }: { readonly row: ThreadRow }) {
  const [asking, setAsking] = useState(false);
  if (!row.unsubscribe) return null;
  const sender = senderOf(row);
  return (
    <>
      <span className="aplos-unsubscribe">
        <Button variant="text" size="sm" label="Unsubscribe" onPress={() => setAsking(true)} />
      </span>
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
