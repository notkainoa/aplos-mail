import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

// The one axe setup, shared by axe.spec.ts (the gate) and scorers/axe.score.ts (the hill-climb
// score). WCAG 2.0 and 2.1 A and AA only.

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
export const BLOCKING = new Set(['serious', 'critical']);
// A mail body is the sender's own document in a scriptless sandboxed frame: axe cannot reach into it (the run would wait
// out its 60 s frame timeout), and its markup is not ours. The host chrome around the frame is still checked.
export const MAIL_FRAME = 'iframe.aplos-mailframe__frame';

export type AxeViolation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number];

/** Runs axe on the open page with the project's tags and returns its violations. */
export async function runAxe(page: Page): Promise<AxeViolation[]> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(AXE_TAGS)
    .exclude(MAIL_FRAME)
    .analyze();
  return violations;
}

/** The first failing-check message of a node, which for color-contrast names both colours and the ratio. */
export function nodeDetail(node: { any: { message: string }[]; failureSummary?: string }): string {
  return (node.any[0]?.message ?? node.failureSummary ?? '').replace(/\s+/g, ' ');
}
