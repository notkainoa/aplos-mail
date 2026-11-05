// Guard (c) of the sealed frame's keys (PROTOCOL.md "mail-key wiring"): a key relayed from the letter never reaches
// a layer above the reader. A physical Esc goes to the top-most layer (it closes the menu, the dialog, the composer or
// the find bar); a relayed one is dropped instead, so a key pressed inside an email can never close or cancel
// anything but the reader's own state. Read when the key arrives, from the same sources as the shell's key listener:
// the key layers (`useShellKeyLayer`: the composer's `compose`, a list's `dialog`), the open sheet, and the overlays
// in the DOM (role and class, or `data-keyctx`, as `overlayContexts` reads them), plus the reader's own host layers
// (`data-keylayer`: the find bar).

import { isModal, type ContextName } from '../commands';
import { overlayContexts } from '../shell/keys-dispatch';
import { getKeyLayers, shellStack, type KeyLayer } from '../shell/store-keys';
import { getSheet } from '../shell/store-sheet';

/** Marks a host layer that owns Esc while it is open but has no key context of its own (the reader's find bar). */
export const KEY_LAYER_ATTRIBUTE = 'data-keylayer';

/** Every element that may open a layer: overlays by role, anything declaring a key context, and host layers. */
const OPEN_LAYERS = `[role="dialog"],[role="alertdialog"],[role="menu"],[aria-modal="true"],.ui-date-presets,[data-keyctx],[${KEY_LAYER_ATTRIBUTE}]`;

/**
 * A context that sits above the reader: a modal transient (menu, dialog, palette, sheet, ...), the composer or Ask.
 * (`ask` is listed ahead of the dock: it registers its own key layer when it lands.)
 */
export function isAboveReader(context: ContextName): boolean {
  return isModal(context) || context === 'compose' || context === 'ask';
}

/** What the check reads. */
export interface LayerState {
  readonly layers: readonly KeyLayer[];
  readonly sheetOpen: boolean;
  /** The elements matching `OPEN_LAYERS` in the host document. */
  readonly overlays: readonly Element[];
}

/** Roles that are a modal surface whether or not the shell maps a key context for them. */
const DIALOG_ROLES: ReadonlySet<string> = new Set(['dialog', 'alertdialog']);

// Read from the DOM, so an overlay still leaving (its exit animation, about 200 ms) counts as open and drops keys for
// that long. Deliberately conservative: a key dropped is cheap, a key that closes the wrong thing is not.
function overlayAbove(el: Element): boolean {
  if (el.hasAttribute(KEY_LAYER_ATTRIBUTE)) return true;
  if (el.getAttribute('aria-modal') === 'true') return true;
  if (DIALOG_ROLES.has(el.getAttribute('role') ?? '')) return true;
  return overlayContexts(el).some(isAboveReader);
}

/** True when anything sits above the reader. */
export function layerAbove(state: LayerState): boolean {
  if (shellStack(null, state.sheetOpen, state.layers).some(isAboveReader)) return true;
  return state.overlays.some(overlayAbove);
}

/** The live check: the shell's layers and sheet now, and the host document's open overlays. */
export function layerAboveReader(): boolean {
  const overlays =
    typeof document === 'undefined' ? [] : [...document.querySelectorAll(OPEN_LAYERS)];
  return layerAbove({ layers: getKeyLayers(), sheetOpen: getSheet() !== null, overlays });
}
