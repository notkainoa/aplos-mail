// Real-input tracking for key-hint tooltips (the launch-time stray "C" over the compose button).
// A freshly drawn element under a resting cursor gets pointerenter with no pointermove, and script
// focus onto a control while nothing else was focused can match :focus-visible. Neither is intent:
// a hover tip waits for a genuine move, a focus tip for a real keydown.
// The module also flags the documentElement (data-real-pointer / data-real-key) so the surfaces
// family's CSS-only tips (PartTip) stay closed for the same non-input.

/** The movement a resting cursor cannot produce: a nonzero pointer delta (a press also counts via pointerdown). */
export function realPointerOf(event: {
  readonly movementX?: number;
  readonly movementY?: number;
}): boolean {
  return (event.movementX ?? 0) !== 0 || (event.movementY ?? 0) !== 0;
}

let keySeen = false;
let pointerSeen = false;
let watching: unknown = null;

/** Whether a real keydown landed since the watch began (the Tab that moved focus counts). */
export function realKeySeen(): boolean {
  return keySeen;
}

/** Whether a real pointer move or press landed since the watch began. */
export function realPointerSeen(): boolean {
  return pointerSeen;
}

function flag(name: 'realKey' | 'realPointer'): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset[name] = 'true';
}

function markKey(): void {
  keySeen = true;
  flag('realKey');
}

function markPointer(): void {
  pointerSeen = true;
  flag('realPointer');
}

/** The smallest event source this listens on; `window` and `EventTarget` both satisfy it. */
export interface IntentSource {
  addEventListener(type: string, listener: (event: never) => void, options?: unknown): void;
}

/** Binds the one-time listeners on `source` (window by default); idempotent per source. */
export function watchInputIntent(source?: IntentSource): void {
  const target = source ?? (typeof window === 'undefined' ? undefined : window);
  if (!target || watching === target) return;
  watching = target;
  target.addEventListener('keydown', () => markKey(), true);
  target.addEventListener('pointerdown', () => markPointer(), true);
  target.addEventListener(
    'pointermove',
    event => {
      if (realPointerOf(event as unknown as PointerEvent)) markPointer();
    },
    true,
  );
}

/** Tests only: flags go back to launch state; already-bound listeners keep working. */
export function resetInputIntent(): void {
  keySeen = false;
  pointerSeen = false;
  if (typeof document !== 'undefined') {
    delete document.documentElement.dataset.realKey;
    delete document.documentElement.dataset.realPointer;
  }
}

watchInputIntent();
