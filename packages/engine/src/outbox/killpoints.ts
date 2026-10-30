import type { SendPort } from '../ports/engine';

/**
 * Kill points (time-6): named places in the send path where a test kills the process, to prove a restart never
 * delivers one Message-ID twice and never loses a message silently. They exist only in test builds.
 *
 * HOW THEY LEAVE THE RELEASE BUNDLE. `apps/desktop/scripts/build-main.mjs` sets the `__APLOS_TEST_MODE__` define to
 * `false` for a release build (`APLOS_RELEASE_BUILD=1`) and does not minify. esbuild folds a call site written exactly as
 *
 *     if (typeof __APLOS_TEST_MODE__ === 'undefined' || __APLOS_TEST_MODE__) killpoint(KP.AFTER_MARKER);
 *
 * to `if (false) killpoint(KP.AFTER_MARKER)`, leaves the dead statement's text in a non-minified bundle, and drops every
 * declaration only that dead text refers to: `killpoint`, `killableSend`, the hook and `KP` itself. The name strings
 * (`'after-marker'`...) live only in `KP` below, so they are not in the bundle. The call sites must therefore (1) test
 * the define inline (a `const KILLPOINTS` imported from here would survive an unminified build) and (2) name a point
 * through `KP.SOME_CONSTANT`, never a string literal (a literal at a dead call site would stay in the output). Without
 * the define (tests under tsx, a dev build) the `typeof` guard makes them live, and without an installed hook they do
 * nothing. The hook is installed only by test code (`tests/outbox/killpoint-child.ts`), which also reads the
 * environment variable that picks the point; no source file under `src/` knows that variable's name.
 * `tests/outbox/release-grep.test.ts` builds the engine the way the release does and greps for every name.
 */
declare global {
  const __APLOS_TEST_MODE__: boolean | undefined;
}

/** The point names. Values are the strings a test passes in and a bundle must not contain. */
export const KP = {
  /** The send is due and its payload is built; the `sending` marker is not committed. */
  BEFORE_MARKER: 'before-marker',
  /** The marker is committed; `SendPort.send` has not been called. */
  AFTER_MARKER: 'after-marker',
  /** `SendPort.send` has finished (the bytes left or the call failed); the engine has not been told. */
  AFTER_BYTES: 'after-bytes',
  /** The engine holds the provider's acceptance; the `sent` commit has not started. */
  AFTER_ACCEPT: 'after-accept',
  /** A `findSent` request is in flight. */
  DURING_FIND_SENT: 'during-find-sent',
  /** Inside the `sent` commit's transaction: the row is updated, the transaction is not committed. */
  DURING_COMMIT: 'during-commit',
} as const;

export type KillPoint = (typeof KP)[keyof typeof KP];

/** Every kill point, in send order. */
export const KILL_POINTS: readonly KillPoint[] = /* @__PURE__ */ Object.values(KP);

type KillHook = (name: KillPoint) => void;
let hook: KillHook | undefined;

/** Test code only: what happens at a kill point (a child process kills itself). `undefined` removes it. */
export function installKillHook(next: KillHook | undefined): void {
  hook = next;
}

/** Does nothing unless a test installed a hook. */
export function killpoint(name: KillPoint): void {
  hook?.(name);
}

/**
 * The two points inside the provider call, as a wrapper of any `SendPort` (the counting fake today, the Gmail emulator's
 * adapter later): `after-bytes` once `send` has finished and before its answer reaches the engine, `during-find-sent`
 * with a `findSent` request in flight. The point sees the outcome in the port's own record, so the call still runs.
 */
export function killableSend(port: SendPort): SendPort {
  return {
    admission: account => port.admission(account),
    async send(account, payload) {
      const outcome = await port.send(account, payload).then(
        receipt => ({ receipt }),
        (error: unknown) => ({ error }),
      );
      killpoint(KP.AFTER_BYTES);
      if ('error' in outcome) throw outcome.error;
      return outcome.receipt;
    },
    findSent(account, internetId, since) {
      const answer = port.findSent(account, internetId, since);
      killpoint(KP.DURING_FIND_SENT);
      return answer;
    },
  };
}
