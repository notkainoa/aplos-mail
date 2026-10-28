// From the stored `Settings.ui` object (renderer/data contract-shapes UiSettings)
// to the registry's KeyPrefs. Typed structurally so this folder never imports data.
import type { KeyPrefs, Keymap } from './types';

/** The `Settings.ui` fields the key system reads; data's `UiSettings` satisfies this. */
export interface UiKeyFields {
  /** WCAG 2.1.4 single-key shortcuts switch. */
  readonly singleKeys: boolean;
  /** Tap versus hold threshold, default 250 ms. */
  readonly holdMs: number;
  /** 'doneRight': → Done, ← Later (DESIGN §8 default); 'doneLeft' swaps them (F1 names). */
  readonly swipeDirection: 'doneRight' | 'doneLeft';
  /** Remapped keys by command id. */
  readonly keymap: Keymap;
}

/** The registry prefs for the stored settings; pass the result to `registry.configure`. */
export function keyPrefsFromUi(ui: UiKeyFields): KeyPrefs {
  return {
    singleKeyShortcuts: ui.singleKeys,
    holdThresholdMs: ui.holdMs,
    swapTriageArrows: ui.swipeDirection === 'doneLeft',
    keymap: ui.keymap,
  };
}
