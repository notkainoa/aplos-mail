import { expect, test, type Page } from '@playwright/test';
import { STATES, THEMES } from './states';
import { KNOWN_DEFECTS } from './known-defects';
import { openState } from './support/gallery';

// DOM assertions that run beside the pixels (DESIGN 12.5). Reduced motion is off here so computed
// transitions and animations are the real ones, not the zeroed ones.
test.use({ reducedMotion: 'no-preference' });

/** DESIGN 10 and 13. Case-insensitive, word-bounded; data in the gallery never contains them. */
const BANNED_PHRASES = [
  'Swipe through them',
  'Hold to talk',
  'Hold Space to talk',
  'Tap to write',
  'Hide all',
  'Todos?',
  'Be here now',
  'Sent with',
  'Ask me anything',
  'magic',
  'AI-powered',
  'AI powered',
  'Copilot',
  'Ready when you are',
  'Waiting on you',
  'No reply yet',
  'All clear for now',
  'Making room for your mail',
  'Aplos needs a moment',
  'Couldn.t summarize this email',
  'Your day beside your mail',
  'A comfortable place for your mail',
  'Make light work of your inbox',
  'A little less inbox',
  'Aplos is ready when your day begins',
  'Skypaper',
  'Airmail',
  'par avion',
  'Smart',
  'Beta',
];
/** Glyphs for sparkles, stars, wand, robot and brain (DESIGN 4.7, 9 rule 8). */
const BANNED_GLYPHS = '✨⭐🪄🤖🧠★☆✦✧⚝';
/** Icon names: a Lucide class, a data-icon, a use href or a symbol id. `\b` keeps Restart and Start out. */
const BANNED_ICON = /sparkl|wand|\bstars?\b|\bbrain|\bbot\b|robot|apple\.intelligence/i;

/** Properties whose animation moves layout (DESIGN 5 rule 7). `all` counts when its duration is not zero. */
const LAYOUT_PROPERTY =
  /^(all|width|height|min-width|min-height|max-width|max-height|padding(-.*)?|margin(-.*)?|inset(-.*)?|top|left|right|bottom|flex(-.*)?|grid-template(-.*)?|font-size|font-weight|letter-spacing|line-height|border-width|border-.*-width|gap|row-gap|column-gap)$/;

interface Findings {
  filled: { count: number; radiusOver8: string[]; labels: string[] };
  layoutTransitions: string[];
  decoration: string[];
  smallText: string[];
  banned: string[];
  summaries: {
    ready: { serif: boolean; family: string }[];
    pending: { serif: boolean }[];
    absent: number;
  };
  serifLoaded: boolean;
}

async function audit(page: Page): Promise<Findings> {
  return page.evaluate(
    ({ phrases, glyphs, iconSource, layoutSource }) => {
      const layoutProperty = new RegExp(layoutSource);
      const bannedIcon = new RegExp(iconSource, 'i');
      const bannedPhrase = new RegExp(`(^|[^\\p{L}])(${phrases.join('|')})($|[^\\p{L}])`, 'iu');
      const stage = document.querySelector('.stage') as HTMLElement;
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none'
        );
      };
      const name = (el: Element) =>
        `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
      const all = [stage, ...stage.querySelectorAll('*')];

      const filledButtons = all.filter(el => el.matches('[data-variant="filled"]') && visible(el));
      const radiusOver8 = filledButtons
        .filter(el => parseFloat(getComputedStyle(el).borderTopLeftRadius) > 8)
        .map(name);

      const layoutTransitions: string[] = [];
      const decoration: string[] = [];
      const smallText: string[] = [];
      const banned: string[] = [];

      const auditTransitions = (el: Element, style: CSSStyleDeclaration) => {
        const properties = style.transitionProperty.split(',').map(s => s.trim());
        const durations = style.transitionDuration.split(',').map(s => parseFloat(s));
        properties.forEach((property, index) => {
          const duration = durations[index % durations.length];
          if (duration > 0 && layoutProperty.test(property))
            layoutTransitions.push(`${name(el)} transitions ${property} for ${duration}s`);
        });
      };
      const gradientChecks: [keyof CSSStyleDeclaration, string][] = [
        ['backgroundImage', 'gradient background'],
        ['maskImage', 'gradient mask'],
        ['borderImageSource', 'gradient border-image'],
        ['listStyleImage', 'gradient list-style-image'],
      ];
      const auditPseudo = (label: string, s: CSSStyleDeclaration) => {
        for (const [key, what] of gradientChecks)
          if (/gradient/.test(String(s[key] || ''))) decoration.push(`${label} has a ${what}`);
        if (s.backdropFilter && s.backdropFilter !== 'none')
          decoration.push(`${label} has backdrop-filter`);
        const webkit = s.getPropertyValue('-webkit-backdrop-filter');
        if (webkit && webkit !== 'none') decoration.push(`${label} has -webkit-backdrop-filter`);
      };
      for (const el of all) {
        const style = getComputedStyle(el);
        auditTransitions(el, style);
        for (const pseudo of [null, '::before', '::after'] as const) {
          const s = pseudo ? getComputedStyle(el, pseudo) : style;
          if (pseudo && s.content === 'none') continue;
          auditPseudo(`${name(el)}${pseudo ?? ''}`, s);
        }
      }

      // SVG paint servers: a gradient or pattern drawn in markup is as banned as one in CSS. Any such
      // element under the stage counts, and so does a fill or stroke that points at one anywhere.
      const auditPaintServers = () => {
        const paintServer = /^(lineargradient|radialgradient|pattern)$/;
        for (const el of all)
          if (paintServer.test(el.localName.toLowerCase()))
            decoration.push(`svg ${el.localName}${el.id ? `#${el.id}` : ''} under the stage`);
        for (const el of all) {
          if (!(el instanceof SVGElement)) continue;
          const style = getComputedStyle(el);
          for (const property of ['fill', 'stroke'] as const) {
            const id = /url\(\s*["']?#([^"')\s]+)/.exec(style[property])?.[1];
            const target = id ? document.getElementById(id) : null;
            if (target && paintServer.test(target.localName.toLowerCase()))
              decoration.push(`${name(el)} ${property} uses ${target.localName}#${id}`);
          }
        }
      };
      auditPaintServers();

      const copy: string[] = [];
      const collectText = () => {
        const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent?.trim();
          const parent = node.parentElement;
          if (!text || !parent || !visible(parent)) continue;
          copy.push(text);
          const size = parseFloat(getComputedStyle(parent).fontSize);
          if (size < 11) smallText.push(`${name(parent)} is ${size}px: "${text.slice(0, 30)}"`);
        }
        for (const el of all) {
          for (const attribute of ['aria-label', 'title', 'placeholder', 'alt'] as const) {
            const value = el.getAttribute(attribute);
            if (value) copy.push(value);
          }
        }
      };
      collectText();

      for (const text of copy) {
        const hit = bannedPhrase.exec(text);
        if (hit) banned.push(`phrase "${hit[2]}" in "${text.slice(0, 50)}"`);
        if (text.includes('!')) banned.push(`exclamation mark in "${text.slice(0, 50)}"`);
        for (const glyph of glyphs)
          if (text.includes(glyph)) banned.push(`glyph ${glyph} in "${text.slice(0, 50)}"`);
      }
      const iconHandles = (el: Element) => [
        el.getAttribute('data-icon'),
        el.getAttribute('data-name'),
        el.getAttribute('href'),
        el.getAttribute('xlink:href'),
        el instanceof SVGElement ? el.getAttribute('class') : null,
        el.tagName === 'symbol' ? el.id : null,
      ];
      for (const el of all)
        for (const handle of iconHandles(el))
          if (handle && bannedIcon.test(handle)) banned.push(`icon "${handle}" on ${name(el)}`);

      const family = (el: Element) => getComputedStyle(el).fontFamily;
      const summaries = [...stage.querySelectorAll('.ui-summary')];
      return {
        filled: {
          count: filledButtons.length,
          radiusOver8,
          labels: filledButtons.map(el => (el.textContent ?? '').trim().slice(0, 24)),
        },
        layoutTransitions: [...new Set(layoutTransitions)],
        decoration: [...new Set(decoration)],
        smallText: [...new Set(smallText)],
        banned: [...new Set(banned)],
        summaries: {
          ready: summaries
            .filter(el => el.getAttribute('data-state') === 'ready')
            .map(el => ({ serif: /Newsreader/.test(family(el)), family: family(el) })),
          pending: summaries
            .filter(el => el.getAttribute('data-state') === 'pending')
            .map(el => ({ serif: /Newsreader/.test(family(el)) })),
          absent: summaries.filter(el => el.getAttribute('data-state') === 'absent').length,
        },
        serifLoaded: document.fonts.check('430 21px Newsreader'),
      };
    },
    {
      phrases: BANNED_PHRASES,
      glyphs: [...BANNED_GLYPHS],
      iconSource: BANNED_ICON.source,
      layoutSource: LAYOUT_PROPERTY.source,
    },
  );
}

test.describe('dom', () => {
  for (const state of STATES) {
    for (const theme of THEMES) {
      test(`${state.id} ${theme}`, async ({ page }) => {
        await openState(page, state, { theme });
        const found = await audit(page);

        // One filled button per state, and never a rounder one than 8 px (DESIGN 3 rule 6, 2.3).
        expect(
          found.filled.count,
          `filled buttons: ${found.filled.labels.join(' | ')}`,
        ).toBeLessThanOrEqual(1);
        expect(
          found.filled.count,
          `filled buttons in ${state.id}: ${found.filled.labels.join(' | ')}`,
        ).toBe(state.filled);
        expect(found.filled.radiusOver8, 'filled button radius over 8px').toEqual([]);

        expect(found.layoutTransitions, 'a transition on a layout property').toEqual([]);
        expect(found.decoration, 'gradient or backdrop-filter').toEqual([]);
        expect(found.smallText, 'text under 11px').toEqual([]);
        expect(found.banned, 'banned strings, glyphs or icons').toEqual([]);

        // The summary is the one serif line; a pending or absent one is sans (DESIGN 4.3, 9).
        if (state.summary === 'ready') {
          expect(found.summaries.ready.length, 'a ready summary renders').toBeGreaterThan(0);
          for (const summary of found.summaries.ready)
            expect(summary.serif, `ready summary font: ${summary.family}`).toBe(true);
          expect(found.serifLoaded, 'Newsreader is loaded').toBe(true);
        }
        if (state.summary === 'pending') {
          expect(found.summaries.pending.length, 'a pending summary renders').toBeGreaterThan(0);
          for (const summary of found.summaries.pending) expect(summary.serif).toBe(false);
        }
        if (state.summary === 'absent') expect(found.summaries.absent).toBeGreaterThan(0);
      });

      // Controls are drawn by the design system, never by the browser's default button chrome.
      test(`${state.id} ${theme} has no browser-default button chrome`, async ({ page }) => {
        const known = KNOWN_DEFECTS.uaButtonChrome[state.id];
        test.fail(Boolean(known), known);
        await openState(page, state, { theme });
        const chrome = await page.evaluate(() =>
          [...document.querySelectorAll('.stage button, .stage select')]
            .filter(el => {
              const style = getComputedStyle(el);
              return (
                /outset|inset|ridge|groove/.test(style.borderTopStyle) &&
                parseFloat(style.borderTopWidth) > 0 &&
                el.getBoundingClientRect().width > 0
              );
            })
            .map(el => `${el.tagName.toLowerCase()}.${el.className}`),
        );
        expect([...new Set(chrome)], 'elements with the default border').toEqual([]);
      });
    }
  }
});

// Behaviour that a static render cannot show.
test.describe('behaviour', () => {
  test('a Dialog leaves no transform behind after its entrance, so a Menu or Popover inside it is not offset', async ({
    page,
  }) => {
    const state = STATES.find(candidate => candidate.id === 'dialog-confirm-destructive')!;
    await openState(page, state);
    const dialog = page.locator('.ui-dialog');
    await dialog.waitFor();
    await expect
      .poll(() => dialog.evaluate(el => el.getAnimations().length), { timeout: 3000 })
      .toBe(0);
    expect(await dialog.evaluate(el => getComputedStyle(el).transform)).toBe('none');
  });

  test('ChoiceGroup reports a click, Space, Return and an arrow once each, with the row id', async ({
    page,
  }) => {
    const state = STATES.find(candidate => candidate.id === 'onboarding-choice-group')!;
    await openState(page, state);
    const group = page.getByRole('radiogroup', { name: 'AI provider' });
    const choices = (): Promise<string[]> => page.evaluate(() => window.__choices ?? []);

    // One tab stop: the chosen row.
    const stops = await group
      .locator('[role="radio"]')
      .evaluateAll(rows => rows.map(row => (row as HTMLElement).tabIndex));
    expect(stops).toEqual([0, -1, -1]);

    await group.getByRole('radio', { name: /Claude/ }).click();
    expect(await choices()).toEqual(['ai-claude']);

    // The chosen row now holds the tab stop; Space and Return choose the focused row.
    const claude = group.getByRole('radio', { name: /Claude/ });
    await claude.focus();
    await page.keyboard.press('Space');
    expect(await choices()).toEqual(['ai-claude', 'ai-claude']);
    await page.keyboard.press('Enter');
    expect(await choices()).toEqual(['ai-claude', 'ai-claude', 'ai-claude']);

    // Arrow keys move focus and choose the next row once.
    await page.keyboard.press('ArrowDown');
    expect((await choices()).slice(3)).toEqual(['ai-local']);
    await expect(group.getByRole('radio', { name: /Ollama/ })).toBeFocused();
    await expect(group.getByRole('radio', { name: /Ollama/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.keyboard.press('ArrowUp');
    expect((await choices()).slice(4)).toEqual(['ai-claude']);
  });
});

// Positive control: plant one violation of each kind and require the audit to name it.
test('the audit catches planted violations', async ({ page }) => {
  const state = STATES.find(candidate => candidate.id === 'empty-inbox-zero')!;
  await openState(page, state);
  await page.evaluate(() => {
    const host = document.querySelector('.stage__column')!;
    host.insertAdjacentHTML(
      'beforeend',
      `<style>
        .planted-fade { transition: width 200ms; background-image: linear-gradient(red, blue); }
        .planted-blur { backdrop-filter: blur(4px); }
      </style>
      <div class="planted-fade">Todo</div>
      <div class="planted-blur" style="font-size: 10px">Ready!</div>
      <svg class="lucide lucide-sparkles" width="8" height="8"></svg>
      <svg width="20" height="20"><defs><linearGradient id="planted-sky"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="20" height="20" fill="url(#planted-sky)"/></svg>
      <div class="planted-border" style="border: 4px solid; border-image: linear-gradient(red, blue) 1">Edge</div>
      <button data-variant="filled" style="border-radius: 20px">First</button>
      <button data-variant="filled">Second</button>`,
    );
  });
  const found = await audit(page);
  expect(found.filled.count).toBe(2);
  expect(found.filled.radiusOver8.length).toBe(1);
  expect(found.layoutTransitions.join()).toContain('width');
  expect(found.decoration.join()).toContain('gradient');
  expect(found.decoration.join()).toContain('backdrop-filter');
  expect(found.decoration.join()).toContain('svg linearGradient#planted-sky under the stage');
  expect(found.decoration.join()).toContain('gradient border-image');
  expect(found.smallText.join()).toContain('10px');
  expect(found.banned.join()).toMatch(/Todo/);
  expect(found.banned.join()).toMatch(/exclamation/);
  expect(found.banned.join()).toMatch(/sparkles/);
});

// A paint server defined outside the stage (a shared sprite sheet) and used only through fill or
// stroke is found by the reference, not by the element scan.
test('the audit catches a pattern reached only through fill and stroke', async ({ page }) => {
  const state = STATES.find(candidate => candidate.id === 'empty-inbox-zero')!;
  await openState(page, state);
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<svg width="0" height="0" style="position:absolute"><defs>
        <pattern id="planted-stripe" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="2" height="4" fill="red"/></pattern>
        <radialGradient id="planted-glow"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient>
      </defs></svg>`,
    );
    document
      .querySelector('.stage__column')!
      .insertAdjacentHTML(
        'beforeend',
        `<svg width="20" height="20"><rect width="20" height="20" fill="url(#planted-stripe)" stroke="url('#planted-glow')"/></svg>`,
      );
  });
  const found = await audit(page);
  expect(found.decoration.join()).toContain('fill uses pattern#planted-stripe');
  expect(found.decoration.join()).toContain('stroke uses radialGradient#planted-glow');
});
