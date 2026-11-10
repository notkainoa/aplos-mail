// ReconnectSheet 'enableEditing' mode: the calendar-write ask's own title, line and retry verb, in the
// same sheet the reconnect and grant modes use (DESIGN 7.1, 7.15).
// Run: cd apps/desktop && npx tsx --test src/renderer/ui/status/ReconnectSheet.test.tsx
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyProblem } from '../../commands/internal';
import { ReconnectSheet } from './ReconnectSheet';

const ADDRESS = 'alex.moreno@example.com';
const noop = () => {};
const render = (el: ReactElement) => renderToStaticMarkup(el);
const textOf = (html: string): string =>
  html
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

describe("ReconnectSheet 'enableEditing'", () => {
  it('waiting: "Turn on editing" with the ask in one line, and the same browser wait', () => {
    const html = render(
      <ReconnectSheet
        open
        mode="enableEditing"
        address={ADDRESS}
        state="waiting"
        onCancel={noop}
        onRetry={noop}
      />,
    );
    assert.match(html, /ui-dialog__title[^>]*>Turn on editing for alex\.moreno@example\.com</);
    assert.match(
      textOf(html),
      /Aplos will ask Google for permission to change events\. Nothing changes unless you ask\./,
    );
    assert.match(textOf(html), /Waiting for Google in your browser…/);
    assert.doesNotMatch(textOf(html), /Reconnect|Grant access|read your Gmail/);
    assert.equal(copyProblem(textOf(html)), null);
  });

  it('failed: the same ask stays, with "Turn on editing" in place of Try again', () => {
    const html = render(
      <ReconnectSheet
        open
        mode="enableEditing"
        address={ADDRESS}
        state="failed"
        onCancel={noop}
        onRetry={noop}
      />,
    );
    assert.match(html, /data-variant="filled"[^>]*>.*Turn on editing/);
    assert.match(textOf(html), /granting access\. Your calendar stays as it is\./);
    assert.doesNotMatch(textOf(html), />Grant access|>Try again/);
    assert.equal(copyProblem(textOf(html)), null);
  });
});
