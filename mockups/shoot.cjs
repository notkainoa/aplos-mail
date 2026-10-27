// Headless screenshots + DOM audit for every mockup page, every state, light and dark.
// Usage: node mockups/shoot.cjs [page.html ...]   (PLAYWRIGHT=/path/to/node_modules/playwright)
// Writes PNGs to mockups/_shots/ (gitignored) and prints audit findings.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/knewton/.t3/aplos-research/tools/node_modules/playwright');

const DIR = __dirname;
const OUT = path.join(DIR, '_shots');
fs.mkdirSync(OUT, { recursive: true });
const pages = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(DIR).filter(f => f.endsWith('.html') && f !== 'index.html').sort();

const BANNED = [/swipe through them/i, /hold to talk/i, /\bhide all\b/i, /\btodos?\b/i, /be here now/i, /sent with/i, /ask me anything/i, /\bmagic\b/i, /ai-powered/i, /copilot/i, /\bbeta\b/i, /✨|⭐|★|☆/];

// Rule: hovering never moves anything else. Hover each interactive element and diff every other box.
async function hoverShift(page) {
  const n = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(el).visibility !== 'hidden'; };
    window.__targets = [...document.querySelectorAll('.window :is(button, a, [data-row], .nav-item, [data-tip], .attachment, .chip)')].filter(vis).slice(0, 90);
    window.__watch = [...document.querySelectorAll('.window :is(button, a, .kbd, .row, .chip, .nav-item, .count, .label, .sender, .meta, .title, .page-title, .summary, p, h1, h2, h3)')].filter(vis);
    return window.__targets.length;
  });
  const out = [];
  for (let i = 0; i < n; i++) {
    const before = await page.evaluate(() => window.__watch.map(e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
    const box = await page.evaluate(i => { const r = window.__targets[i].getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 }; }, i);
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(40);
    const moved = await page.evaluate(([i, before]) => {
      const t = window.__targets[i]; const res = [];
      window.__watch.forEach((e, j) => {
        if (t.contains(e) || e.contains(t) || e.closest('.tooltip')) return;
        const r = e.getBoundingClientRect(); const b = before[j];
        if (Math.abs(r.x - b[0]) > 0.5 || Math.abs(r.y - b[1]) > 0.5 || Math.abs(r.width - b[2]) > 0.5 || Math.abs(r.height - b[3]) > 0.5)
          res.push((e.textContent || e.className).trim().slice(0, 24));
      });
      return res.length ? `hover "${(t.textContent || t.getAttribute('aria-label') || '').trim().slice(0, 24)}" moved: ${res.slice(0, 3).join(' | ')}` : null;
    }, [i, before]);
    if (moved) out.push('LAYOUT SHIFT ' + moved);
    await page.mouse.move(2, 2);
  }
  return [...new Set(out)];
}

async function audit(page) {
  return page.evaluate((bannedSrc) => {
    const banned = bannedSrc.map(s => new RegExp(s.src, s.flags));
    const out = [];
    const text = document.querySelector('.window')?.innerText || '';
    banned.forEach(r => { if (r.test(text)) out.push('banned phrase ' + r); });
    document.querySelectorAll('use').forEach(u => { if (/sparkle|wand|star|brain|bot/i.test(u.getAttribute('href'))) out.push('banned icon ' + u.getAttribute('href')); });
    const filled = [...document.querySelectorAll('.window .btn-filled')].filter(b => b.offsetParent && !b.closest('.ghost-paper') && getComputedStyle(b).visibility !== 'hidden');
    if (filled.length > 1) out.push(`${filled.length} filled buttons: ` + filled.map(b => b.textContent.trim().slice(0, 20)).join(' | '));
    // contrast + min size
    const parse = c => {
      let m = c.match(/rgba?\(([^)]+)\)/);
      if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] ?? 1]; }
      m = c.match(/color\(srgb ([^)]+)\)/);
      if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
      return null;
    };
    const over = (a, b) => [a[0] * a[3] + b[0] * (1 - a[3]), a[1] * a[3] + b[1] * (1 - a[3]), a[2] * a[3] + b[2] * (1 - a[3]), 1];
    const lum = c => { const f = v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    function bgOf(el) {
      const layers = [];
      for (let e = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.backgroundImage && cs.backgroundImage !== 'none' && !cs.backgroundImage.includes('linear-gradient(color')) {
          if (e.classList.contains('skyscene') || /gradient/.test(cs.backgroundImage) && !e.classList.contains('main')) return null;
        }
        const c = parse(cs.backgroundColor);
        if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
        if (e.classList.contains('onb') ) { const s = e.querySelector('.skyscene'); if (s && !el.closest('.sheet')) return null; }
      }
      let bg = [1, 1, 1, 1];
      for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
      return bg;
    }
    const seen = new Set();
    const walker = document.createTreeWalker(document.querySelector('.window') || document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode; if (!n.textContent.trim()) continue;
      const el = n.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
      if (el.closest('.ghost-paper, .sr-only, [aria-hidden="true"], .mockbar, .tooltip')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      const fs = parseFloat(cs.fontSize);
      if (fs < 11) out.push(`text under 11px (${fs}px): "${n.textContent.trim().slice(0, 30)}"`);
      const fg = parse(cs.color); const bg = bgOf(el);
      if (!fg || !bg) continue;
      let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity;
      const f = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
      const L1 = lum(f), L2 = lum(bg); const r = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
      const large = fs >= 18.66 && +cs.fontWeight >= 700 || fs >= 24;
      if (r < (large ? 3 : 4.5)) out.push(`contrast ${r.toFixed(2)} "${n.textContent.trim().slice(0, 36)}"`);
    }
    return [...new Set(out)];
  }, BANNED.map(r => ({ src: r.source, flags: r.flags })));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let issues = 0;
  for (const file of pages) {
    const probe = await browser.newPage();
    await probe.goto('file://' + path.join(DIR, file));
    const meta = await probe.evaluate(() => ({ states: (document.documentElement.dataset.states || '').split(',').map(s => s.trim()).filter(Boolean), win: document.documentElement.dataset.window }));
    await probe.close();
    const vp = meta.win === 'onboarding' ? { width: 640, height: 600 } : { width: 1440, height: 900 };
    const states = meta.states.length ? meta.states : [''];
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, colorScheme: theme });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push(e.message));
      for (const st of states) {
        await page.goto(`file://${path.join(DIR, file)}?shot=1&theme=${theme}${st ? '&state=' + st : ''}`);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(700);
        const name = `${file.replace('.html', '')}${st ? '-' + st : ''}-${theme}.png`;
        await page.screenshot({ path: path.join(OUT, name) });
        const a = await audit(page);
        if (process.env.HOVER && theme === 'light' && st === states[0]) a.push(...await hoverShift(page));
        const all = [...errs.splice(0).map(e => 'JS ERROR ' + e), ...a];
        if (all.length) { issues += all.length; console.log(`\n${name}`); all.forEach(x => console.log('  - ' + x)); }
        else console.log(`ok ${name}`);
      }
      await ctx.close();
    }
  }
  await browser.close();
  console.log(`\n${issues} issue(s)`);
})();
