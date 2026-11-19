import type { AttackClass, CorpusEntry, CorpusExpect, GeneratedPromise } from './index';

// Shared helpers for the synthetic entries. Bodies are built from templates that use the same placeholders as the
// message files, then substituted once by `finishEntry`, so a vector is attributable to an entry and a name.

export interface GeneratedContext {
  canaryOrigin: string;
  dnsSuffix: string;
}

export interface Draft {
  id: string;
  title: string;
  classes: AttackClass[];
  html?: string;
  text?: string;
  cids?: string[];
  expect?: CorpusExpect;
  promise?: GeneratedPromise;
}

/** A visible sentence placed before the stress, so a sanitizer that survives can be checked for keeping it. */
export function lead(phrase: string): string {
  return `<p>Synthetic stress message: ${phrase}.</p>`;
}

/** An image placed after the stress, so a sanitizer that gives up halfway and passes the rest through is caught. */
export function tail(name = 'end'): string {
  return `<img src="{{CANARY}}/{{ID}}/${name}" width="40" height="40" alt="end marker">`;
}

/** Deterministic pseudo-random numbers (mulberry32), so the corpus is identical on every run. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `unit` repeated until the result is at least `chars` long. */
export function fill(unit: string, chars: number): string {
  return unit.repeat(Math.ceil(chars / unit.length));
}

/** Fills the placeholders and applies the draft's defaults. */
export function finishEntry(
  draft: Draft,
  ctx: GeneratedContext,
  substitute: Substituter,
): CorpusEntry {
  const tag = /^(g\d+)/.exec(draft.id)?.[1] ?? draft.id;
  const host = `${tag}.${ctx.dnsSuffix}`;
  const vars = {
    origin: ctx.canaryOrigin,
    host,
    port: new URL(ctx.canaryOrigin).port,
    id: draft.id,
  };
  const fill = (value: string | undefined) =>
    value === undefined ? undefined : substitute(value, vars);
  return {
    id: draft.id,
    title: draft.title,
    classes: draft.classes,
    html: fill(draft.html),
    text: fill(draft.text),
    cids: (draft.cids ?? []).map(cid => substitute(cid, vars)),
    expect: draft.expect ?? {},
    canaryHost: host,
    generated: true,
    promise: draft.promise,
  };
}

export type Substituter = (
  text: string,
  vars: { origin: string; host: string; port: string; id: string },
) => string;
