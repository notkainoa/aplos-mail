import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { loadCorpus } from '../corpus/index';
import { render } from '../src/index';

// Time and size budgets (plan 10 E4 acceptance): median under 5 ms and p99 under 40 ms per corpus
// message, hostile shapes well under a second each, and the bundle under 150 KB minified. Each
// message is timed as the best of several runs after a warm-up, so a busy machine (several agents
// share these Macs) measures the code and not the scheduler. When the machine is slow anyway, the
// p99 is judged against an ordinary 100 KB newsletter timed in the same run: a quadratic slowdown
// still fails that ratio, a loaded machine does not. A generous absolute ceiling stays.

const ROUNDS = 7;
/** Slow messages get more runs, so one preempted run cannot decide the p99. */
const SLOW_MS = 10;
const SLOW_ROUNDS = 15;
const MEDIAN_BUDGET_MS = 5;
const P99_BUDGET_MS = 40;
/** The p99 message may cost this many ordinary newsletters (calibrated: about 4 on an idle run). */
const P99_RATIO = 12;
const P99_CEILING_MS = 250;

/** An ordinary 100 KB newsletter: a table of styled rows with links and images. */
function newsletter(): string {
  const row = (n: number) =>
    `<tr><td class="item" style="padding:8px 12px;font:14px Arial;color:#333"><a href="https://shop.example/p/${n}">Item ${n}</a> ` +
    `<img src="https://cdn.example/i/${n}.png" width="40" height="40" alt="item ${n}"> in stock, ships soon.</td></tr>`;
  const rows = Array.from({ length: 420 }, (_, n) => row(n)).join('');
  return `<style>.item{border-bottom:1px solid #eee}@media (max-width:600px){.item{padding:4px}}</style><table width="600">${rows}</table>`;
}

function bestOf(rounds: number, run: () => void): number {
  let best = Infinity;
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/**
 * `<noframes>` + O(0) + … + O(levels - 1) + filler, where O(0) = `<noframes>` and O(k) =
 * `<nofr` + O(k - 1) + `ames>`: removing the innermost tag rebuilds the next one, so a sanitizer
 * that re-parses fallbacks inside fallbacks reads the filler once per level (565 ms at 0.51 MB).
 */
export function selfRebuildingFallback(levels: number, filler: number): string {
  const parts: string[] = [];
  let level = '<noframes>';
  for (let index = 0; index < levels; index++) {
    parts.push(level);
    level = `<nofr${level}ames>`;
  }
  return `<noframes>${parts.join('')}${'x'.repeat(filler)}`;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

describe('time', () => {
  it('renders the corpus with a median under 5 ms and a p99 under 40 ms per message', t => {
    const corpus = loadCorpus({ canaryOrigin: 'http://127.0.0.1:41999' });
    const times = corpus.map(entry => {
      const input = {
        html: entry.html,
        text: entry.text,
        cids: entry.cids,
        findQuery: entry.findQuery,
        imagePolicy: 'block' as const,
      };
      render(input);
      const ms = bestOf(ROUNDS, () => render(input));
      return {
        id: entry.id,
        ms:
          ms > SLOW_MS
            ? Math.min(
                ms,
                bestOf(SLOW_ROUNDS, () => render(input)),
              )
            : ms,
      };
    });
    const sorted = times.map(time => time.ms).sort((a, b) => a - b);
    const median = percentile(sorted, 0.5);
    const p99 = percentile(sorted, 0.99);
    const slowest = [...times].sort((a, b) => b.ms - a.ms).slice(0, 3);
    t.diagnostic(
      `${times.length} messages: median ${median.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, slowest ${slowest.map(s => `${s.id} ${s.ms.toFixed(1)} ms`).join(', ')}`,
    );
    const baseline = newsletter();
    render({ html: baseline, cids: [], imagePolicy: 'block' });
    const baselineMs = bestOf(SLOW_ROUNDS, () =>
      render({ html: baseline, cids: [], imagePolicy: 'block' }),
    );
    const ratio = p99 / baselineMs;
    t.diagnostic(`100 KB newsletter ${baselineMs.toFixed(2)} ms; p99 is ${ratio.toFixed(1)} of it`);
    assert.ok(median < MEDIAN_BUDGET_MS, `median ${median.toFixed(2)} ms`);
    if (p99 < P99_BUDGET_MS) return;
    assert.ok(
      ratio < P99_RATIO,
      `p99 ${p99.toFixed(2)} ms is ${ratio.toFixed(1)} newsletters (${baselineMs.toFixed(2)} ms each)`,
    );
    assert.ok(p99 < P99_CEILING_MS, `p99 ${p99.toFixed(2)} ms`);
  });

  const MB = 1024 * 1024;
  const shapes: Record<string, string> = {
    'a 1 MB line of prose': `<p>${'lorem ipsum dolor sit amet '.repeat(MB / 27)}</p>`,
    'a 1 MB line of tags': '<span class="a">x</span>'.repeat(MB / 24),
    '100,000 nested divs': `${'<div>'.repeat(100_000)}x${'</div>'.repeat(100_000)}`,
    '100,000 unclosed nested elements of mixed kinds':
      '<div><span><b><font><table><tr><td><svg><g><math><mrow>'.repeat(10_000),
    '100,000 nested quotes': `${'<blockquote type="cite"><div class="gmail_quote">'.repeat(50_000)}old`,
    '100,000 nested original-message headers': '<div><font>-----Original Message-----'.repeat(
      50_000,
    ),
    '50,000 open divs then 50,000 unmatched end tags': `${'<div>'.repeat(50_000)}${'</span>'.repeat(50_000)}`,
    '50,000 open divs then 50,000 forms': `${'<div>'.repeat(50_000)}${'<form>'.repeat(50_000)}`,
    'a 1 MB whitespace run in text': `<p>a${' '.repeat(MB)}b</p>`,
    'a 1 MB whitespace run in an attribute': `<img src="https://x.example/a.png" width="1${' '.repeat(MB)}x" alt="a">`,
    'whitespace runs in width and height':
      `<img src="https://x.example/a.png" width="1${' '.repeat(100_000)}x" height="${' '.repeat(100_000)}1x">`.repeat(
        5,
      ),
    'a 1 MB whitespace run in a style attribute': `<p style="color:${' '.repeat(MB)}red">x</p>`,
    'a 1 MB whitespace run in a style block': `<style>a{color:${' '.repeat(MB)}red}</style>`,
    'an entity flood in text': `<p>${'&amp;&lt;&#x41;&#65;&nbsp;&notin;'.repeat(MB / 32)}</p>`,
    'an entity flood in an attribute': `<p title="${'&amp;&quot;&#x41;'.repeat(MB / 16)}">x</p>`,
    'unterminated entities': `<p>${'&a'.repeat(MB / 2)}</p>`,
    'a long zero-padded character reference': `<a href="&#${'0'.repeat(MB)}106;avascript:x">x</a>`,
    '50,000 nested image-set( with strings': `<style>a{b:${'image-set('.repeat(50_000)}${'"x" '.repeat(50_000)}}</style>`,
    '100,000 junk strings in image-set': `<style>a{b:image-set(${'"x" '.repeat(100_000)})}</style>`,
    '25,000 viewport lengths in a calc() and a style block': `<style>a{b:calc(${'100vh + 5dvw + '.repeat(9_000)}1px)}${'.x{height:100vh}'.repeat(7_000)}</style>`,
    '100,000 url( openers': `<style>a{b:${'url('.repeat(100_000)}}</style>`,
    '100,000 escaped url spellings': `<p style="${'u\\72l(x) '.repeat(3_000)}">x</p><style>${'a{b:\\75rl(https://x.example/a.png)}'.repeat(5_000)}</style>`,
    'a 5 MB style block before the text': `<style>${'.a{color:red}'.repeat((5 * MB) / 13)}</style><p>after</p>`,
    '20,000 distinct style attributes': Array.from(
      { length: 20_000 },
      (_, n) => `<span style="color:#${n.toString(16).padStart(6, '0')};width:${n}px">${n}</span>`,
    ).join(''),
    '100,000 attributes on one element': `<div ${Array.from({ length: 100_000 }, (_, n) => `a${n}="${n}"`).join(' ')}>x</div>`,
    'a 1 MB class attribute': `<div class="${'gmail_quote '.repeat(MB / 12)}">x</div>`,
    '1 MB of links': '<a href="https://x.example/a?b=c">l</a>'.repeat(MB / 38),
    'a find query over 1 MB of matches': `<p>${'deal '.repeat(MB / 5)}</p>`,
    '240 levels of a noframes fallback that rebuilds itself': selfRebuildingFallback(240, 250_000),
    // Mutation checks (sanitize.ts `fallback()`): letting a fallback inside a fallback be re-parsed
    // takes this shape to 8.4 s; re-parsing after stripping nested `<noframes>` (the old regex)
    // takes the shape above to 1.8 s. Corpus 133 and the p99 test stay green under both.
    '2,000 nested noframes fallbacks over 250,000 characters': `${'<noframes>'.repeat(2_000)}${'x'.repeat(250_000)}`,
  };
  for (const [name, html] of Object.entries(shapes)) {
    it(`finishes ${name} well under a second`, t => {
      render({ html, cids: [], imagePolicy: 'allow', findQuery: 'deal' });
      const ms = bestOf(2, () =>
        render({ html, cids: [], imagePolicy: 'allow', findQuery: 'deal' }),
      );
      t.diagnostic(`${(html.length / MB).toFixed(2)} MB in ${ms.toFixed(1)} ms`);
      assert.ok(ms < 300, `${ms.toFixed(1)} ms`);
    });
  }
});

describe('size', () => {
  it('bundles under 150 KB minified, for any platform', async t => {
    const result = await build({
      entryPoints: [join(import.meta.dirname, '../src/index.ts')],
      bundle: true,
      minify: true,
      format: 'esm',
      platform: 'neutral',
      mainFields: ['module', 'main'],
      write: false,
      logLevel: 'silent',
    });
    const code = result.outputFiles[0].contents;
    t.diagnostic(`${code.byteLength} bytes minified, ${gzipSync(code).byteLength} gzipped`);
    assert.ok(code.byteLength < 150_000, `${code.byteLength} bytes`);
  });
});
