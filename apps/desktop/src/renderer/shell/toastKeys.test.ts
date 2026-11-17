import test from 'node:test';
import assert from 'node:assert/strict';
import { withLiveKeys } from './ToastHost';
import type { ToastData } from '../ui/props';

const toast: ToastData = {
  id: 't',
  kind: 'done',
  message: 'Done · Jordan Park',
  undoable: true,
  actions: [
    { id: 'remind', label: 'Remind me if no reply', keysFrom: 'mail.remindIfNoReply' },
    { id: 'undo', label: 'Undo', keysFrom: 'app.undo' },
  ],
};

test('a toast action keeps its keycap only while the screen binds that key', () => {
  const [home] = withLiveKeys([toast], () => true);
  assert.equal(home?.actions?.[0]?.keysFrom, 'mail.remindIfNoReply');
  const [reader] = withLiveKeys([toast], id => id === 'app.undo');
  assert.equal(reader?.actions?.[0]?.keysFrom, undefined, 'R is Reply in the reader');
  assert.equal(reader?.actions?.[0]?.label, 'Remind me if no reply', 'the button stays');
  assert.equal(reader?.actions?.[1]?.keysFrom, 'app.undo', 'Z still undoes');
});
