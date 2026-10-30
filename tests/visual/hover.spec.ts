import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// Hover never changes layout (DESIGN 5 rule 17, 12.5). In every state, hover up to 90 interactive
// elements one at a time. Fail if any other element's box moves or resizes by more than 0.5 px.
// Light theme only: colour never changes a box, so the dark run would repeat the same layout.
test.use({ reducedMotion: 'no-preference' });

const MAX_TARGETS = 90;
const TOLERANCE_PX = 0.5;
/** A hover transition is 100 ms; wait past it, then for any finite animation the hover started. */
const SETTLE_MS = 140;

const INTERACTIVE = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="gridcell"]',
  '[data-event-id]',
].join(',');

/** Keycaps: the `kbd` tag and every `*-kbd` class (ui-kbd, ui-list-kbd, ui-compose-kbd, ui-cal-kbd). */
const KEYCAP = "kbd, [class*='-kbd']";

interface Moved {
  element: string;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Marks the targets (up to MAX_TARGETS visible, in document order) and returns how many. */
async function markTargets(page: Page): Promise<number> {
  return page.evaluate(
    ({ selector, max }) => {
      const stage = document.querySelector('.stage')!;
      const inView = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          r.bottom > 0 &&
          r.right > 0 &&
          r.top < innerHeight &&
          r.left < innerWidth &&
          s.visibility !== 'hidden' &&
          s.pointerEvents !== 'none' &&
          !el.closest('[inert]')
        );
      };
      const targets = [...stage.querySelectorAll(selector)].filter(inView).slice(0, max);
      targets.forEach((el, index) => el.setAttribute('data-hover-target', String(index)));
      return targets.length;
    },
    { selector: INTERACTIVE, max: MAX_TARGETS },
  );
}

async function hoverOne(
  page: Page,
  index: number,
): Promise<{ target: string; moved: Moved[]; revealed: string[] }> {
  // Rest state first: every box that exists now, so only those can be said to have moved.
  const target = await page.evaluate(
    ({ i, keycap }) => {
      const el = document.querySelector(`[data-hover-target="${i}"]`) as HTMLElement;
      el.scrollIntoView({ block: 'nearest' });
      const stage = document.querySelector('.stage')!;
      const name = (e: Element) =>
        `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${typeof e.className === 'string' && e.className ? `.${e.className.trim().split(/\s+/)[0]}` : ''}`;
      // A running transform animation (the spinner, the undo tray's drain) changes a bounding box with no hover involved.
      const spinning = new Set<Element>();
      for (const animation of document.getAnimations()) {
        const effect = animation.effect as KeyframeEffect | null;
        if (!effect?.target || animation.playState !== 'running') continue;
        if (
          effect
            .getKeyframes()
            .some(k => ['transform', 'rotate', 'scale', 'translate'].some(p => p in k))
        )
          spinning.add(effect.target);
      }
      const watched = [...stage.querySelectorAll('*')].filter(
        e =>
          !e.closest('[role="tooltip"]') &&
          ![...spinning].some(s => s.contains(e)) &&
          e.getBoundingClientRect().width + e.getBoundingClientRect().height > 0,
      );
      const w = window as unknown as {
        __watched: Element[];
        __before: DOMRect[];
        __name: (e: Element) => string;
        __showing: () => Set<Element>;
        __keysBefore: Set<Element>;
      };
      // A keycap is on show when it has a box, is not hidden and is not transparent (itself or any
      // ancestor). Tooltips and the badge reveal are the allowed ways to show one on hover.
      const showing = () =>
        new Set(
          [...stage.querySelectorAll(keycap)].filter(k => {
            if (k.closest('[role="tooltip"], [data-reveal="badge"]')) return false;
            const r = k.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0 || getComputedStyle(k).visibility === 'hidden')
              return false;
            for (let e: Element | null = k; e && e !== stage.parentElement; e = e.parentElement)
              if (parseFloat(getComputedStyle(e).opacity) <= 0) return false;
            return true;
          }),
        );
      w.__watched = watched;
      w.__before = watched.map(e => e.getBoundingClientRect());
      w.__name = name;
      w.__showing = showing;
      w.__keysBefore = showing();
      const r = el.getBoundingClientRect();
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24);
      return {
        label: `${name(el)} "${label}"`,
        x: Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1),
        y: Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1),
      };
    },
    { i: index, keycap: KEYCAP },
  );

  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(SETTLE_MS);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(a => a.effect?.getComputedTiming().iterations !== Infinity)
        .map(a => a.finished.catch(() => undefined)),
    ),
  );

  const { moved, revealed } = await page.evaluate(tolerance => {
    const w = window as unknown as {
      __watched: Element[];
      __before: DOMRect[];
      __name: (e: Element) => string;
      __showing: () => Set<Element>;
      __keysBefore: Set<Element>;
    };
    const out: Moved[] = [];
    const revealed = [...w.__showing()].filter(k => !w.__keysBefore.has(k)).map(w.__name);
    w.__watched.forEach((el, i) => {
      if (el.closest('[role="tooltip"]')) return;
      const a = w.__before[i];
      const b = el.getBoundingClientRect();
      const d = { dx: b.x - a.x, dy: b.y - a.y, dw: b.width - a.width, dh: b.height - a.height };
      if (Object.values(d).some(v => Math.abs(v) > tolerance))
        out.push({ element: w.__name(el), ...d });
    });
    return { moved: out, revealed };
  }, TOLERANCE_PX);

  await page.mouse.move(0, 0);
  return { target: target.label, moved, revealed };
}

/** Hovers every target of the open state and reports each element that moved, with the delta. */
async function hoverAll(page: Page): Promise<{ count: number; failures: string[] }> {
  const count = await markTargets(page);
  const failures: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const { target, moved, revealed } = await hoverOne(page, index);
    // Rule 17: hover never reveals an inline keycap, even when its space is kept.
    for (const keycap of revealed) failures.push(`hover ${target} revealed keycap ${keycap}`);
    if (moved.length === 0) continue;
    const shown = moved
      .slice(0, 4)
      .map(
        m =>
          `${m.element} moved by (${m.dx.toFixed(2)}, ${m.dy.toFixed(2)}) and resized by (${m.dw.toFixed(2)}, ${m.dh.toFixed(2)})`,
      );
    failures.push(
      `hover ${target}: ${shown.join('; ')}${moved.length > 4 ? `; and ${moved.length - 4} more` : ''}`,
    );
  }
  return { count, failures };
}

test.describe('hover', () => {
  for (const state of STATES) {
    test(`${state.id} never shifts`, async ({ page }) => {
      test.setTimeout(120_000);
      await openState(page, state, { theme: 'light' });
      const { count, failures } = await hoverAll(page);
      test.info().annotations.push({ type: 'targets', description: String(count) });
      expect(count, 'a state with nothing to hover is not checked').toBeGreaterThan(0);
      expect(failures, `hover moved a box by more than ${TOLERANCE_PX}px`).toEqual([]);
    });
  }

  // Positive control: a hover rule that nudges a row must be caught, or a pass means nothing.
  test('the check catches a hover that moves a neighbour', async ({ page }) => {
    const state = STATES.find(candidate => candidate.id === 'list-rows')!;
    await openState(page, state, { theme: 'light' });
    await page.addStyleTag({ content: '[role="option"]:hover { margin-bottom: 6px; }' });
    const { failures } = await hoverAll(page);
    expect(failures.length, 'the planted shift was not reported').toBeGreaterThan(0);
    expect(failures[0]).toMatch(/moved by \(0\.00, [\d.-]+\)/);
  });

  // Positive control: a keycap that keeps its space and only turns visible on hover moves no box,
  // so the box comparison alone passes it. Visibility and opacity versions must both be reported.
  for (const hidden of ['visibility: hidden', 'opacity: 0']) {
    test(`the check catches a keycap revealed by ${hidden.split(':')[0]}`, async ({ page }) => {
      const state = STATES.find(candidate => candidate.id === 'compose-page')!;
      await openState(page, state, { theme: 'light' });
      const revealed = hidden.replace(/hidden|0/, m => (m === '0' ? '1' : 'visible'));
      await page.addStyleTag({
        content: `[data-variant='filled'] :is(kbd, [class*='-kbd']) { ${hidden} !important; }
          [data-variant='filled']:hover :is(kbd, [class*='-kbd']) { ${revealed} !important; }`,
      });
      const { failures } = await hoverAll(page);
      expect(failures.join('\n')).toMatch(/revealed keycap/);
    });
  }
});
