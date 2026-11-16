// The Done key as a tap or a hold, with no React in it so it can be driven by a fake clock in tests.
// Keydown (never a repeat) starts the clock. Keyup before `holdMs` is one done; the clock running out is all done and
// the keyup that follows is ignored. `stop` drops a hold in progress (Esc, blur, unmount) without marking anything.

/** What the controller calls out to, and the clock it uses. */
export interface DoneHoldOptions {
  /** How long the key is held to mean all, in ms. */
  readonly holdMs: number;
  /** A tap: one done. */
  readonly onOne: () => void;
  /** A hold that ran its full length: all done. */
  readonly onAll: () => void;
  /** The hold started (true) or ended for any reason (false), for the button's progress. */
  readonly onHolding: (holding: boolean) => void;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

/** One Done key's state. */
export interface DoneHold {
  /** Keydown; ignored while the key is already down (a key repeat). */
  press(): void;
  /** Keyup; ignored without a keydown, and after a hold already fired. */
  release(): void;
  /** Drops a hold in progress without marking anything. */
  stop(): void;
}

/** A controller over one key. */
export function createDoneHold(options: DoneHoldOptions): DoneHold {
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as number));
  let timer: unknown = null;
  let down = false;
  let fired = false;

  const clear = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const stop = () => {
    clear();
    down = false;
    fired = false;
    options.onHolding(false);
  };

  const press = () => {
    if (down) return;
    down = true;
    options.onHolding(true);
    timer = setTimer(() => {
      timer = null;
      fired = true;
      options.onHolding(false);
      options.onAll();
    }, options.holdMs);
  };

  const release = () => {
    if (!down) return;
    if (fired) {
      fired = false;
      down = false;
      return;
    }
    const tapped = timer !== null;
    stop();
    if (tapped) options.onOne();
  };

  return { press, release, stop };
}
