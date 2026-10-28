import { parseDocument } from 'htmlparser2';
import { render } from './src/index';
for (const n of [10_000, 20_000, 40_000]) {
  const deep = `${'<div>'.repeat(n)}bottom${'</div>'.repeat(n)}`;
  let t = performance.now(); parseDocument(deep); const p = performance.now() - t;
  t = performance.now(); render({ html: deep, cids: [], imagePolicy: 'block' }); console.log(n, 'parse', p.toFixed(0), 'render', (performance.now() - t).toFixed(0));
}
