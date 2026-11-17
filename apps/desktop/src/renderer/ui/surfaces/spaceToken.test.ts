// Floating placement reads its gap and window margin from space tokens, which are emitted in rem.
// Run from the repo root: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/surfaces/spaceToken.test.ts

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { menuPlacementFor, spaceToken } from './parts';
import type { Anchor } from '../props';

const globals = globalThis as Record<string, unknown>;

function stubRoot(values: Record<string, string>, fontSize: string): void {
  globals.document = { documentElement: {} };
  globals.getComputedStyle = () => ({
    fontSize,
    getPropertyValue: (name: string) => values[name] ?? '',
  });
}

afterEach(() => {
  delete globals.document;
  delete globals.getComputedStyle;
});

describe('spaceToken', () => {
  it('turns a rem token into px with the root font size', () => {
    stubRoot({ '--shell-pad': ' 0.5rem', '--space-1': '0.25rem' }, '16px');
    assert.equal(spaceToken('--shell-pad'), 8);
    assert.equal(spaceToken('--space-1'), 4);
  });

  it('follows a larger root font size', () => {
    stubRoot({ '--shell-pad': '0.5rem' }, '20px');
    assert.equal(spaceToken('--shell-pad'), 10);
  });

  it('keeps a px token and answers 0 for a missing one', () => {
    stubRoot({ '--hairline': '1px' }, '16px');
    assert.equal(spaceToken('--hairline'), 1);
    assert.equal(spaceToken('--nope'), 0);
  });
});

describe('menuPlacementFor', () => {
  const anchorOf = (width: number) =>
    ({ getBoundingClientRect: () => ({ width }) }) as unknown as NonNullable<Anchor>;

  it('hangs a menu from the end edge of an icon trigger and the start edge of a text one', () => {
    assert.equal(menuPlacementFor(anchorOf(28)), 'below-end');
    assert.equal(menuPlacementFor(anchorOf(120)), 'below-start');
    assert.equal(menuPlacementFor(null), 'below-start');
  });
});
