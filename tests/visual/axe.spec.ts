import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { axeKnownDefects } from './known-defects';
import { STATES, THEMES } from './states';
import { openState } from './support/gallery';

// axe-core on every state, both themes, both sizes (the projects). WCAG 2.0 and 2.1 A and AA only.
// A serious or critical violation fails the state unless `axeKnownDefects` names the state and the
// rule. Moderate and minor ones are printed, not failed. Every finding prints one `AXE` line so a
// full run can be tallied: `grep '^AXE' log`.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const BLOCKING = new Set(['serious', 'critical']);

/** The first failing-check message of a node, which for color-contrast names both colours and the ratio. */
function detail(node: { any: { message: string }[]; failureSummary?: string }): string {
  return (node.any[0]?.message ?? node.failureSummary ?? '').replace(/\s+/g, ' ');
}

test.describe('axe', () => {
  for (const state of STATES) {
    for (const theme of THEMES) {
      test(`${state.id} ${theme}`, async ({ page }, info) => {
        await openState(page, state, { theme });
        const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        const known = axeKnownDefects[state.id] ?? {};
        const blocking = violations.filter(v => BLOCKING.has(v.impact ?? ''));

        for (const violation of violations) {
          const first = violation.nodes[0];
          const where = `${first?.target.join(' ')} | ${first ? detail(first) : ''}`;
          const tag = known[violation.id] ? 'known' : (violation.impact ?? 'none');
          console.log(
            `AXE\t${info.project.name}\t${state.id}\t${theme}\t${tag}\t${violation.id}\t${violation.nodes.length}\t${where}`,
          );
        }

        const found = new Set(violations.map(v => v.id));
        for (const rule of Object.keys(known))
          if (!found.has(rule))
            console.log(`AXE-STALE\t${info.project.name}\t${state.id}\t${theme}\t${rule}`);

        const unexpected = blocking.filter(v => !known[v.id]);
        expect(
          unexpected.map(v => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.help}`),
          `axe serious or critical violations in ${state.id} ${theme}`,
        ).toEqual([]);
      });
    }
  }
});
