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

/** Bytes from numbers and ASCII strings. */
export const bytes = (...values: (number | string)[]) =>
  new Uint8Array(
    values.flatMap(v => (typeof v === 'string' ? [...v].map(c => c.charCodeAt(0)) : [v])),
  );

/** The smallest leading bytes of each raster type the frame may show. */
export const SAMPLES = {
  png: bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'IHDR'),
  jpeg: bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, 'JFIF'),
  gif87: bytes('GIF87a', 1, 0, 1, 0),
  gif89: bytes('GIF89a', 1, 0, 1, 0),
  webp: bytes('RIFF', 36, 0, 0, 0, 'WEBPVP8 '),
};
