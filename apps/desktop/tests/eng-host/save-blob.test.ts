import assert from 'node:assert/strict';
import test from 'node:test';
import { saveBlob } from '../../src/renderer/screens/settings/SettingsContainer';

/**
 * The window owns an export's caller-bound blob: a saved file frees it through `Blob/release`, a cancelled
 * dialog keeps it (eng-admin #441 — main may only READ blobs, so release is the window's job).
 */
const calls = (canceled: boolean, released: string[]) => ({
  save: () => Promise.resolve({ canceled }),
  release: (a: { blobId: string }) => {
    released.push(a.blobId);
    return Promise.resolve({});
  },
});

test('a saved export releases its blob; a cancelled dialog keeps it', async () => {
  const released: string[] = [];
  assert.deepEqual(
    await saveBlob({ blobId: 'b1', name: 'aplos-data.json' }, calls(false, released)),
    { canceled: false },
  );
  assert.deepEqual(released, ['b1']);
  released.length = 0;
  assert.deepEqual(
    await saveBlob({ blobId: 'b2', name: 'aplos-data.json' }, calls(true, released)),
    { canceled: true },
  );
  assert.deepEqual(released, [], 'cancel never releases');
});
