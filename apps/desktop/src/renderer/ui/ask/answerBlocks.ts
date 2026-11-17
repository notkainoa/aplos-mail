import type { AnswerParagraph } from '../props';

/** A paragraph of the answer, or a run of list items, by index into the answer's paragraphs. */
export type AnswerBlock =
  | { readonly kind: 'paragraph'; readonly at: number }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      /** The first item's own number, when the list is numbered. */
      readonly start?: number;
      readonly items: readonly number[];
    };

/** The answer's paragraphs grouped into blocks: consecutive list items of one kind are one list. */
export function answerBlocks(answer: readonly AnswerParagraph[]): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  answer.forEach((paragraph, at) => {
    const lead = paragraph[0];
    if (lead?.kind !== 'item') return void blocks.push({ kind: 'paragraph', at });
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'list' && last.ordered === lead.ordered) {
      blocks[blocks.length - 1] = { ...last, items: [...last.items, at] };
      return;
    }
    blocks.push({
      kind: 'list',
      ordered: lead.ordered,
      ...(lead.number !== undefined ? { start: lead.number } : {}),
      items: [at],
    });
  });
  return blocks;
}
