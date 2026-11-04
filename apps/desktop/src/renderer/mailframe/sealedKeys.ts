// The sealed frame's keys (PROTOCOL.md "mail-key wiring"). A keydown inside the out-of-process `aplos-mail://` frame
// never reaches the host page; main relays a listed one as the bridge event `{ type: 'mail-key', payload: { key } }`
// (`host/protocol/frame-keys.ts`, `shared/mail-keys.ts`), and this turns it into the same `MailFrameKey` the srcdoc
// relay hands `onKey`, or drops it. Every guard is read when the key arrives:
// (a) the slot's iframe element is `document.activeElement`, the slot is the double buffer's shown letter and nothing
//     inert (the reader's off-paper letter) is around it: the key belongs to the visible letter, and exactly one slot
//     of all the mounted ones takes it, so main's key and anything else are never handled twice (no timestamps);
// (b) the sealed slot installs no keydown listener: this subscription is its only key path;
// (c) nothing sits above the reader (`layers.ts`): a relayed Esc never closes a composer, dialog, menu, sheet or the
//     find bar, and no other key reaches them either.
// Letters, never shift: main cannot tell Caps Lock J from Shift+J (both arrive as `J`), so `J`/`K` become `j`/`k` with
// no shift, whatever any payload says about shift.

import { isMailKey, MAIL_KEY_EVENT, type MailKey } from '../../shared/mail-keys';
import type { MailFrameKey } from './types';

/** An event as preload hands it to `window.aplos.subscribe` listeners. */
export interface BridgeEvent {
  readonly type: string;
  readonly payload?: unknown;
}

/** `window.aplos.subscribe`: returns the unsubscribe. */
export type MailKeySubscribe = (listener: (event: BridgeEvent) => void) => () => void;

/** What a key is checked against, read when it arrives. */
export interface SealedKeyGate {
  /** The slot's iframe element; null before it mounts. */
  frame(): unknown;
  /** The slot is the shown letter, not the pending one being laid out unseen. */
  shown(): boolean;
  /** `document.activeElement`. */
  focused(): unknown;
  /** A modal, overlay, composer or the find bar sits above the reader. */
  layerAbove(): boolean;
}

function dataProperty(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** The listed key a bridge event carries, or null for any other event or payload. */
export function mailKeyOfEvent(event: unknown): MailKey | null {
  if (dataProperty(event, 'type') !== MAIL_KEY_EVENT) return null;
  const key = dataProperty(dataProperty(event, 'payload'), 'key');
  return isMailKey(key) ? key : null;
}

/** The key's letter: `J` and `K` (Caps Lock or Shift, main cannot tell) are `j` and `k`. Named keys stay as they are. */
export function letterOf(key: MailKey): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

function isInert(frame: unknown): boolean {
  const closest = (frame as { closest?: unknown }).closest;
  return typeof closest === 'function' && (frame as Element).closest('[inert]') !== null;
}

/** True when this slot's letter is the one the owner is reading with focus inside it (guard a). */
function ownsFocus(gate: SealedKeyGate): boolean {
  const frame = gate.frame();
  if (frame === null || frame === undefined || !gate.shown()) return false;
  return gate.focused() === frame && !isInert(frame);
}

/** The key to hand `onKey`, or null when the event is not a listed mail key or any guard refuses it. */
export function sealedMailKey(event: unknown, gate: SealedKeyGate): MailFrameKey | null {
  const key = mailKeyOfEvent(event);
  if (key === null || !ownsFocus(gate) || gate.layerAbove()) return null;
  return { key: letterOf(key), shift: false, alt: false };
}

/** The preload bridge's subscribe, or null where there is none (the browser preview, the stand-in, a test page). */
export function bridgeSubscribe(): MailKeySubscribe | null {
  const bridge = typeof window === 'undefined' ? undefined : window.aplos;
  if (!bridge || typeof bridge.subscribe !== 'function') return null;
  return listener => bridge.subscribe(listener);
}

/** Subscribes one slot: each accepted key goes to `onKey` once. Returns the unsubscribe. */
export function listenSealedKeys(
  subscribe: MailKeySubscribe,
  gate: SealedKeyGate,
  onKey: (key: MailFrameKey) => unknown,
): () => void {
  return subscribe(event => {
    const key = sealedMailKey(event, gate);
    if (key) onKey(key);
  });
}
