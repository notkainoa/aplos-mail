import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

// The one axe setup, shared by axe.spec.ts (the gate) and scorers/axe.score.ts (the hill-climb
// score). WCAG 2.0 and 2.1 A and AA only.

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
export const BLOCKING = new Set(['serious', 'critical']);

export type AxeViolation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number];

/** Runs axe on the open page with the project's tags and returns its violations. */
export async function runAxe(page: Page): Promise<AxeViolation[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return violations;
}

/** The first failing-check message of a node, which for color-contrast names both colours and the ratio. */
export function nodeDetail(node: { any: { message: string }[]; failureSummary?: string }): string {
  return (node.any[0]?.message ?? node.failureSummary ?? '').replace(/\s+/g, ' ');
}
