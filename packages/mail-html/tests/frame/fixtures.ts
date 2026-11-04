import type { FrameRenderInput } from '../../src/frame/tokens';

/** One render's input for the token tests, window `w1` unless a test says otherwise. */
export function render(extra: Partial<FrameRenderInput> = {}): FrameRenderInput {
  return {
    windowId: 'w1',
    messageId: 'm1',
    accountScope: 'acct-1',
    imagePolicy: 'block',
    document: '<!doctype html><html><body>hi</body></html>',
    remoteImages: [],
    cids: [],
    ...extra,
  };
}
