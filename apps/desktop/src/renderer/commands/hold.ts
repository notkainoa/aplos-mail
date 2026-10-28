// Tap versus hold without waiting (plan 30 §4.2). The tap has already run on
// keydown; this only tells the caller when a hold upgrades it. Time is passed in,
// so the logic is pure and testable; the caller owns the timer.
// Holds are tracked by physical key (holdKeyOf), never by the modified chord, so
// pressing or releasing ⇧, ⌘ or ⌥ mid-hold still ends it on keyup.
import { holdKeyOf } from './keys';
import type { CommandId, KeyInput } from './types';

export const DEFAULT_HOLD_THRESHOLD_MS = 250;

export interface HoldUpgrade {
  /** The physical key, e.g. 'r' or 'Space'. */
  readonly key: string;
  readonly commandId: CommandId;
  readonly heldMs: number;
  /**
   * The keydown went through and typed one character (phase 'hold' in a field).
   * Delete it before running the hold command, so an empty body stays empty.
   */
  readonly removeTyped: boolean;
}

/** How a hold ended: the key came up, Esc/blur/hide cancelled it, another key interrupted it, or a different hold key went down. */
export type HoldEnd = 'up' | 'cancel' | 'interrupt' | 'down';

/**
 * What the tracker returns when an armed key ends. Keep what a hold command heard only when
 * `upgraded && ended === 'up'` ("Release R to keep"); every other ending discards it ("Esc to cancel").
 * `phase` is by duration alone and does not say how the hold ended.
 */
export interface HoldRelease {
  readonly key: string;
  readonly commandId: CommandId;
  /** 'hold' when the key stayed down at least the threshold. Duration only: Esc after a long hold is still 'hold'. */
  readonly phase: 'tap' | 'hold';
  /** True when tick() already reported the upgrade, so the hold command is running and should stop. */
  readonly upgraded: boolean;
  readonly heldMs: number;
  /** How the hold ended (see HoldEnd). */
  readonly ended: HoldEnd;
}

export interface HoldOptions {
  /** The keydown was let through and typed a character (see HoldUpgrade.removeTyped). */
  readonly typed?: boolean;
}

export interface HoldTracker {
  /**
   * A keydown that resolved with a hold command. Another keydown of the armed
   * key is ignored; a different key ends the armed hold and returns how it ended.
   */
  down(
    event: KeyInput,
    holdCommandId: CommandId,
    at: number,
    options?: HoldOptions,
  ): HoldRelease | null;
  /**
   * True for keydowns of the armed key (its auto-repeats). Call it first on every
   * keydown and prevent the event when true: the repeats must not type into the
   * field the tap just focused, nor reach the resolver.
   */
  swallows(event: KeyInput): boolean;
  /** Any other keydown while armed (J after R): ends the hold without upgrading later. */
  interrupt(at: number): HoldRelease | null;
  /** Call from a timer at `deadline`. Returns the upgrade once, when the threshold is crossed. */
  tick(at: number): HoldUpgrade | null;
  /** The keyup. Returns null if this physical key was not armed. */
  up(event: KeyInput, at: number): HoldRelease | null;
  /** Esc while dictating, blur, or the window hiding. */
  cancel(at: number): HoldRelease | null;
  /** When to call tick(), or null when nothing is armed or the upgrade already fired. */
  readonly deadline: number | null;
  readonly armed: boolean;
}

interface Armed {
  readonly key: string;
  readonly commandId: CommandId;
  readonly start: number;
  readonly typed: boolean;
  upgraded: boolean;
}

export function createHoldTracker(thresholdMs: number = DEFAULT_HOLD_THRESHOLD_MS): HoldTracker {
  let current: Armed | null = null;

  function finish(at: number, ended: HoldEnd): HoldRelease | null {
    if (!current) return null;
    const heldMs = Math.max(0, at - current.start);
    const release: HoldRelease = {
      key: current.key,
      commandId: current.commandId,
      phase: heldMs >= thresholdMs ? 'hold' : 'tap',
      upgraded: current.upgraded,
      heldMs,
      ended,
    };
    current = null;
    return release;
  }

  return {
    down(event, holdCommandId, at, options = {}) {
      const key = holdKeyOf(event);
      if (current?.key === key) return null;
      const previous = finish(at, 'down');
      current = {
        key,
        commandId: holdCommandId,
        start: at,
        typed: options.typed ?? false,
        upgraded: false,
      };
      return previous;
    },
    swallows(event) {
      return current !== null && holdKeyOf(event) === current.key;
    },
    interrupt(at) {
      return finish(at, 'interrupt');
    },
    tick(at) {
      if (!current || current.upgraded) return null;
      const heldMs = at - current.start;
      if (heldMs < thresholdMs) return null;
      current.upgraded = true;
      return { key: current.key, commandId: current.commandId, heldMs, removeTyped: current.typed };
    },
    up(event, at) {
      if (current?.key !== holdKeyOf(event)) return null;
      return finish(at, 'up');
    },
    cancel(at) {
      return finish(at, 'cancel');
    },
    get deadline() {
      return current && !current.upgraded ? current.start + thresholdMs : null;
    },
    get armed() {
      return current !== null;
    },
  };
}
