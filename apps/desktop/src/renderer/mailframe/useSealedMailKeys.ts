// The sealed slot's one key path (sealedKeys.ts, PROTOCOL.md "mail-key wiring"): subscribe to main's relayed keys for
// as long as the slot is mounted and feed the accepted ones to the same `onKey` the srcdoc relay uses.

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { layerAboveReader } from './layers';
import { bridgeSubscribe, listenSealedKeys, type MailKeySubscribe } from './sealedKeys';
import type { MailFrameKey } from './types';

/** What the sealed slot passes; the two ports are for tests and default to the live ones. */
export interface SealedMailKeysOptions {
  /** The slot is the shown letter (false while it is the pending one). */
  readonly shown: boolean;
  readonly onKey: (key: MailFrameKey) => boolean | void;
  /** Default: `window.aplos.subscribe`; no bridge (browser preview, stand-in) means no subscription. */
  readonly subscribe?: MailKeySubscribe | null;
  /** Default: `layerAboveReader`. */
  readonly layerAbove?: () => boolean;
}

/** Subscribes the sealed slot whose iframe is `frame` to main's relayed keys while it is mounted. */
export function useSealedMailKeys(
  frame: RefObject<Element | null>,
  options: SealedMailKeysOptions,
): void {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const port = options.subscribe;
  useEffect(() => {
    const subscribe = port === undefined ? bridgeSubscribe() : port;
    if (!subscribe) return undefined;
    const gate = {
      frame: () => frame.current,
      shown: () => latest.current.shown,
      focused: () => document.activeElement,
      layerAbove: () => (latest.current.layerAbove ?? layerAboveReader)(),
    };
    return listenSealedKeys(subscribe, gate, key => latest.current.onKey(key));
  }, [frame, port]);
}
