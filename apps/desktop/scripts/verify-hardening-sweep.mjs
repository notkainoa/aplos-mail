// verify-hardening-sweep.mjs — real-engine screen sweep of a packaged Aplos Mail .app: launches it
// with APLOS_TEST=1 + APLOS_ENGINE=real on a pre-seeded isolated data dir (copy of a signed-in
// mailbox, .aplos-test marker added by the caller; the run MUTATES it (UI prefs, read state), so pass a
// disposable copy only), drives every screen over CDP headless and
// records a screenshot, the visible text and console errors for each. Every DevTools command has an 8 s
// deadline, so a stale seed that never reaches Home (it opens to onboarding) or a window that never
// paints fails rows instead of hanging the run; screenshots then drop out and the text checks remain. FAILS a screen on the legacy
// fatal copy, an 'aplos:invoke' refusal or a 'Couldn't load' state it notices.
//
// Usage:
//   node scripts/verify-hardening-sweep.mjs <path-to-.app> --data-dir <seeded dir> --out <dir> [--port N]
// Results: <out>/sweep.json, <out>/sweep.md, <out>/<screen>.png. Exit 1 on any FAIL row.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appArg = process.argv.find(a => a.endsWith('.app'));
const flag = n => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dataDir = flag('--data-dir');
const outDir = flag('--out');
const PORT = Number(flag('--port') ?? 0) || 9257;
if (!appArg || !dataDir || !outDir) {
  console.error('usage: verify-hardening-sweep.mjs <.app> --data-dir <dir> --out <dir> [--port N]');
  process.exit(2);
}
const exe = resolve(appArg, 'Contents/MacOS/Aplos Mail');
if (!existsSync(exe)) {
  console.error(`sweep: no executable ${exe}`);
  process.exit(2);
}
mkdirSync(join(outDir, 'shots'), { recursive: true });

const output = [];
const child = spawn(exe, [`--remote-debugging-port=${PORT}`], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    APLOS_TEST: '1',
    APLOS_DATA_DIR: dataDir,
    APLOS_ENGINE: 'real',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let resolveReady;
const engineReady = new Promise(r => (resolveReady = r));
for (const s of [child.stdout, child.stderr])
  s.on('data', c => {
    const t = c.toString();
    output.push(t);
    if (t.includes('engine: real engine ready')) resolveReady();
  });
const delay = ms => new Promise(r => setTimeout(r, ms));
const results = [];

async function main() {
  await Promise.race([
    engineReady,
    delay(45000).then(() => {
      throw new Error('engine never ready');
    }),
  ]);
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find(
        t => t.type === 'page' && t.url.startsWith('file:') && !t.url.includes('draft='),
      );
    } catch {
      // CDP list not up yet — retry.
    }
    if (!page) await delay(300);
  }
  if (!page) throw new Error('no renderer page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  let shotWarned = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push(m.params?.exceptionDetails?.text ?? 'exception');
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error')
      pageErrors.push(String(m.params.entry.text).slice(0, 200));
  });
  await send('Runtime.enable');
  await send('Log.enable');
  // Every DevTools command has a deadline: one that is never answered (a window that cannot paint, a
  // renderer stuck on a stale seed) resolves to { timedOut: true } after 8 s instead of hanging the
  // sweep, and is pushed into pageErrors so the row FAILs — an evaluate that timed out returns
  // undefined, which would otherwise let empty text and a blank-pane check pass.
  function send(method, params = {}) {
    return new Promise(r => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        pageErrors.push(`devtools timeout: ${method}`);
        r({ timedOut: true, method });
      }, 8000);
      pending.set(i, m => {
        clearTimeout(timer);
        r(m);
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  const ev = async x =>
    (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))
      .result?.result?.value;
  // Click the first element whose accessible name contains `name` (button, link, list row, tab).
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  };
  const click = async name => {
    const r = await ev(`(()=>{
      const want=${JSON.stringify(name)};
      const els=[...document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[role=row],div,li,span')];
      const el=els.find(e=>{
        const t=(e.getAttribute('aria-label')||e.textContent||'').trim();
        return t===want||t.startsWith(want+'\\n')||t.startsWith(want+' ');
      });
      if(!el)return null;
      const r=el.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    if (!r) {
      pageErrors.push(`click target missing: ${name}`);
      return 'MISSING';
    }
    // Real pointer events — message rows ignore synthetic MouseEvent('click').
    await clickAt(r.x, r.y);
    return 'ok';
  };
  const key = (k, mods = 0) =>
    send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, modifiers: mods }).then(() =>
      send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, modifiers: mods }),
    );
  const shot = async name => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s.timedOut && !shotWarned++)
      console.error('sweep: screenshots unavailable (the window did not answer); text checks only');
    if (s.result?.data)
      writeFileSync(join(outDir, 'shots', `${name}.png`), Buffer.from(s.result.data, 'base64'));
  };
  const BAD =
    /Aplos needs a moment|Error invoking remote method|Couldn['’]t load|not on the new engine/i;
  async function reset() {
    await key('Escape');
    await delay(400);
    await key('Escape');
    await delay(400);
    await click('Home');
    await delay(900);
  }
  async function visit(name, act) {
    pageErrors.length = 0;
    const before = output.length;
    await reset();
    if (act) await act();
    await delay(2200);
    await shot(name);
    const text = String((await ev('document.body?.innerText ?? ""')) || '').slice(0, 900);
    // Blank-pane check: visible text left of the sidebar is chrome; count characters right of it.
    const paneLen = await ev(`(()=>{
      let n=0;for(const e of document.querySelectorAll('body *')){
        const r=e.getBoundingClientRect();
        if(r.x>300&&r.width>0&&r.height>0&&e.children.length===0)n+=(e.textContent||'').trim().length;
      }return n})()`);
    // "Couldn't load" next to the Reconnect copy is the expected state of a seed whose token is dead.
    // A pane that never reported (paneLen undefined — its evaluate timed out) or a page with no
    // visible text counts as blank: both mean the screen did not paint.
    const reconnect = /sign in again/i.test(text);
    const blank = !text.trim() || !Number.isFinite(paneLen) || paneLen < 8;
    const bad = (!reconnect && text.match(BAD)) || (blank ? ['blank pane'] : null);
    const refused = output
      .slice(before)
      .join('')
      .match(/[^\n]*(aplos:invoke|not on the new engine)[^\n]*/);
    const errs = [...pageErrors];
    if (refused) errs.push('console: ' + refused[0].trim().slice(0, 160));
    results.push({
      name,
      status: bad || errs.length ? 'FAIL' : 'PASS',
      flags: [...(bad ? [`screen copy: ${bad[0]}`] : []), ...errs.slice(0, 4)],
      text: text.replace(/\n{3,}/g, '\n\n').slice(0, 500),
      shot: `shots/${name}.png`,
    });
  }

  // Let the seeded mailbox settle (sync may still be running).
  await delay(4000);
  // A seed whose sidebar was last COLLAPSED to the strip (localStorage aplos.sidebar.collapsed) has no
  // nav rows to click: open it once, or every nav row reads "click target missing". The separate
  // "Sidebar minimised" setting (a ☰ menu, no toggle) is not handled: un-minimise it in the seed.
  const sidebarOpen = await ev(`!!document.querySelector('[aria-label="Sidebar"]')`);
  if (!sidebarOpen) {
    await click('Show or hide the sidebar');
    await delay(600);
  }
  const rowClick = async () => {
    const rect = await ev(`(()=>{const r=[...document.querySelectorAll('*')]
      .filter(e=>e.children.length<=2&&/^[A-Z][\\w ]{2,30}$/.test((e.textContent||'').trim()))
      .map(e=>e.getBoundingClientRect())
      .find(r=>r.y>140&&r.y<700&&r.x>400);
      return r?{x:r.x+150,y:r.y+r.height/2}:null})()`);
    if (rect) await clickAt(rect.x, rect.y);
    return rect ? 'ok' : 'none';
  };
  const screens = [
    ['home', null],
    ['one-by-one', () => click('Go one by one')],
    [
      'reader',
      async () => {
        await click('All mail');
        await delay(1500);
        await rowClick();
      },
    ],
    ['reader-menu', () => click('Thread actions')],
    ['later', () => click('Later')],
    ['calendar', () => click('Calendar')],
    [
      'calendar-week',
      async () => {
        await click('Calendar');
        await delay(1500);
        await click('Week');
      },
    ],
    [
      'calendar-month',
      async () => {
        await click('Calendar');
        await delay(1500);
        await click('Month');
      },
    ],
    ['all-mail', () => click('All mail')],
    ['done', () => click('Done')],
    ['drafts', () => click('Drafts')],
    ['sent', () => click('Sent')],
    ['spam', () => click('Spam')],
    ['trash', () => click('Trash')],
    [
      'search',
      async () => {
        await click('Search');
        await delay(800);
        await send('Input.insertText', { text: 'receipt' });
        await key('Enter');
      },
    ],
    ['palette', () => key('k', 4)],
    ['ask', () => click('Ask')],
    [
      'compose',
      async () => {
        await key('c');
        await delay(1500);
      },
    ],
    [
      'settings',
      async () => {
        await click('Settings');
        await delay(1200);
      },
    ],
    [
      'settings-sections',
      async () => {
        await click('Settings');
        await delay(1200);
        // Click through whatever section nav Settings renders; record the last section text.
        const navs =
          await ev(`(()=>[...document.querySelectorAll('aside a,nav a,aside button,nav button')]
        .map(n=>(n.getAttribute('aria-label')||n.textContent||'').trim()).filter(Boolean).slice(0,12))()`);
        // The app shell's own rows are not Settings sections: clicking them would leave Settings.
        const shellRow =
          /^(New message|Search|Home|Later|Calendar|All mail|Done|Drafts|Sent|Spam|Trash|Settings|Help|Show or hide the sidebar)/;
        for (const n of (navs || []).filter(label => !shellRow.test(label))) {
          await click(n);
          await delay(500);
        }
      },
    ],
    ['help', () => click('Help')],
  ];
  for (const [name, act] of screens) await visit(name, act);
  ws.close();
}

try {
  await main();
} catch (error) {
  results.push({ name: 'run', status: 'FAIL', flags: [error?.message ?? String(error)] });
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    const t = Date.now();
    while (child.exitCode === null && Date.now() - t < 15000) await delay(200);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

writeFileSync(join(outDir, 'sweep.json'), JSON.stringify(results, null, 2));
const md = [
  '# Real-engine screen sweep',
  '',
  `App: ${appArg}`,
  '',
  '| Screen | Result | Flags |',
  '|---|---|---|',
  ...results.map(r => `| ${r.name} | ${r.status} | ${r.flags.join('; ').replace(/\|/g, '/')} |`),
  '',
].join('\n');
writeFileSync(join(outDir, 'sweep.md'), md);
console.log(md);
process.exit(results.some(r => r.status === 'FAIL') ? 1 : 0);
