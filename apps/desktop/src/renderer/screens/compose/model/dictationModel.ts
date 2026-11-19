/**
 * Dictation as a small pure machine (DESIGN 7.6 Dictation, 8 "tap to act; hold the same key to say it"): hold R from
 * the reader or Space in an empty body, and the composer shows the `--stamp` level meter and one line, "Listening.
 * Release R to keep, Esc to cancel." Releasing the key keeps what was heard (it is transcribed into the body); Esc, a
 * blur or another key throws it away. The text stays editable.
 */
import type { HoldRelease } from '../../../commands';
import type { DictationState } from '../../../ui/props';

export type HoldKey = DictationState['holdKey'];

export type DictationPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'listening'; readonly holdKey: HoldKey; readonly level: number }
  | { readonly kind: 'transcribing' };

export type DictationEvent =
  | { readonly type: 'start'; readonly holdKey: HoldKey }
  | { readonly type: 'level'; readonly level: number }
  | { readonly type: 'release'; readonly keep: boolean }
  | { readonly type: 'cancel' }
  | { readonly type: 'done' };

export const IDLE: DictationPhase = { kind: 'idle' };

function clampLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}

export function dictationReducer(phase: DictationPhase, event: DictationEvent): DictationPhase {
  switch (event.type) {
    case 'start':
      return phase.kind === 'idle'
        ? { kind: 'listening', holdKey: event.holdKey, level: 0 }
        : phase;
    case 'level':
      return phase.kind === 'listening' ? { ...phase, level: clampLevel(event.level) } : phase;
    case 'release':
      if (phase.kind !== 'listening') return phase;
      return event.keep ? { kind: 'transcribing' } : IDLE;
    case 'cancel':
      return phase.kind === 'listening' ? IDLE : phase;
    case 'done':
      return IDLE;
  }
}

/** What the composer's footer shows: the meter and the Listening line while listening, nothing otherwise. */
export function dictationShown(phase: DictationPhase): DictationState | undefined {
  return phase.kind === 'listening' ? { holdKey: phase.holdKey, level: phase.level } : undefined;
}

/** Keep what was heard only when the held key came up after the hold began ("Release R to keep"). */
export function keepsOnRelease(release: Pick<HoldRelease, 'upgraded' | 'ended'>): boolean {
  return release.upgraded && release.ended === 'up';
}

/** The sentence the footer shows while listening (written by `DictationLine`; kept here for the tests). */
export function listeningLine(holdKey: HoldKey): string {
  return `Listening. Release ${holdKey} to keep, Esc to cancel.`;
}
