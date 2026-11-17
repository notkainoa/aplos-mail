import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnswerParagraph } from '../props';
import { AskTurn } from './index';
import { answerBlocks } from './answerBlocks';

// An answer's list lines are real lists: numbered and bulleted items, never one run-on paragraph (hands-on test 2026-11-16).

const noop = () => undefined;
const html = (answer: readonly AnswerParagraph[]) =>
  renderToStaticMarkup(
    <AskTurn
      id="q1"
      question="What is open?"
      state="answered"
      citations={[]}
      answer={answer}
      onOpenCitation={noop}
    />,
  );

test('AskTurn: list items render as one numbered list and one bulleted list, not a run-on paragraph', () => {
  const item = (ordered: boolean, number?: number) => ({
    kind: 'item' as const,
    ordered,
    ...(number ? { number } : {}),
  });
  const markup = html([
    [{ kind: 'text', text: 'Do these:' }],
    [item(true, 1), { kind: 'text', text: 'Review the draft' }],
    [item(true, 2), { kind: 'text', text: 'Send it' }, { kind: 'cite', index: 1 }],
    [{ kind: 'text', text: 'Also:' }],
    [item(false), { kind: 'text', text: 'Pack' }],
  ]);
  assert.match(
    markup,
    /<p><span>Do these:<\/span><\/p><ol><li><span>Review the draft<\/span><\/li><li>/,
  );
  assert.match(markup, /<ul><li><span>Pack<\/span><\/li><\/ul>/);
  assert.equal((markup.match(/<ol/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /<script|<img/);
});

test('answerBlocks: consecutive items of a kind are one list, which keeps its own start number', () => {
  const item = (ordered: boolean, number?: number) => [
    { kind: 'item' as const, ordered, ...(number ? { number } : {}) },
  ];
  assert.deepEqual(
    answerBlocks([item(true, 3), item(true, 4), [{ kind: 'text', text: 'x' }], item(false)]),
    [
      { kind: 'list', ordered: true, start: 3, items: [0, 1] },
      { kind: 'paragraph', at: 2 },
      { kind: 'list', ordered: false, items: [3] },
    ],
  );
});
