// Tap versus hold without waiting (plan 30 §4.2). The tap has already run on
// keydown; this only tells the caller when a hold upgrades it. Time is passed in,
// so the logic is pure and testable; the caller owns the timer.
import type { CommandId } from './types';

export const DEFAULT_HOLD_THRESHOLD_MS = 250;

export interface HoldUpgrade {
  readonly chordId: string;
  readonly commandId: CommandId;
  readonly heldMs: number;
}

export interface HoldRelease {
  readonly chordId: string;
  readonly commandId: CommandId;
  /** 'hold' when the key stayed down at least the threshold. */
  readonly phase: 'tap' | 'hold';
  /** True when tick() already reported the upgrade, so the hold command is running and should stop. */
  readonly upgraded: boolean;
  readonly heldMs: number;
}

export interface HoldTracker {
  /**
   * A keydown that resolved with a hold command. A repeat of the armed key is
   * ignored; a different key ends the armed hold and returns how it ended.
   */
  down(chordId: string, holdCommandId: CommandId, at: number): HoldRelease | null;
  /** Any other keydown while armed (J after R): ends the hold without upgrading later. */
  interrupt(at: number): HoldRelease | null;
  /** Call from a timer at `deadline`. Returns the upgrade once, when the threshold is crossed. */
  tick(at: number): HoldUpgrade | null;
  /** The keyup. Returns null if this key was not armed. */
  up(chordId: string, at: number): HoldRelease | null;
  /** Esc while dictating, blur, or the window hiding. */
  cancel(at: number): HoldRelease | null;
  /** When to call tick(), or null when nothing is armed or the upgrade already fired. */
  readonly deadline: number | null;
  readonly armed: boolean;
}

interface Armed {
  readonly chordId: string;
  readonly commandId: CommandId;
  readonly start: number;
  upgraded: boolean;
}

export function createHoldTracker(thresholdMs: number = DEFAULT_HOLD_THRESHOLD_MS): HoldTracker {
  let current: Armed | null = null;

  function finish(at: number): HoldRelease | null {
    if (!current) return null;
    const heldMs = Math.max(0, at - current.start);
    const release: HoldRelease = {
      chordId: current.chordId,
      commandId: current.commandId,
      phase: heldMs >= thresholdMs ? 'hold' : 'tap',
      upgraded: current.upgraded,
      heldMs,
    };
    current = null;
    return release;
  }

  return {
    down(chordId, holdCommandId, at) {
      if (current?.chordId === chordId) return null;
      const ended = finish(at);
      current = { chordId, commandId: holdCommandId, start: at, upgraded: false };
      return ended;
    },
    interrupt(at) {
      return finish(at);
    },
    tick(at) {
      if (!current || current.upgraded) return null;
      const heldMs = at - current.start;
      if (heldMs < thresholdMs) return null;
      current.upgraded = true;
      return { chordId: current.chordId, commandId: current.commandId, heldMs };
    },
    up(chordId, at) {
      if (current?.chordId !== chordId) return null;
      return finish(at);
    },
    cancel(at) {
      return finish(at);
    },
    get deadline() {
      return current && !current.upgraded ? current.start + thresholdMs : null;
    },
    get armed() {
      return current !== null;
    },
  };
}
