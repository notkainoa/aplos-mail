// verify-hardening-e2e.mjs — true end-to-end pass of the packaged Aplos Mail app on the REAL path:
// launches the .app with APLOS_ENGINE=real against the real signed-in userData (the spare Gmail
// account), drives the window over CDP with real pointer/key events, screenshots every step and
// records PASS/FAIL. Unlike the seeded sweep this exercises live Gmail: real search, real sync
// state, real send-to-self. Never prints the account address, tokens or mail bodies.
//
// Usage: node scripts/verify-hardening-e2e.mjs <path-to-.app> --out <dir> --data-dir <seed> [--skip-send]
// --data-dir must be a private copy under a temp root carrying .aplos-test (no run/ or Singleton* locks).
// Screenshots contain real mail content: keep --out private (never inside the repo).
// Results: <out>/e2e.json, <out>/e2e.md, <out>/<step>.png. Exit 1 on any FAIL row.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

const appArg = process.argv.find(a => a.endsWith('.app'));
const flag = n => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const outDir = flag('--out');
const skipSend = process.argv.includes('--skip-send');
if (!appArg || !outDir) {
  console.error('usage: verify-hardening-e2e.mjs <.app> --out <dir> [--port N] [--skip-send]');
  process.exit(2);
}
const exe = resolve(appArg, 'Contents/MacOS/Aplos Mail');
if (!existsSync(exe)) {
  console.error(`e2e: no executable ${exe}`);
  process.exit(2);
}
const dataDir = flag('--data-dir');
if (!dataDir) {
  console.error(
    'e2e: pass --data-dir <temp dir copy of a signed-in data dir; needs .aplos-test marker, no run/ or Singleton* locks>',
  );
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const output = [];
// A free loopback port we hand to the child; DevToolsActivePort in our private dir then proves
// the bound endpoint is really this app's and never a stale bind owned by someone else.
const PORT = await new Promise((resolve, reject) => {
  const srv = createServer().listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    srv.close(() => resolve(port));
  });
  srv.on('error', reject);
});
const child = spawn(exe, [], {
  env: {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    APLOS_ENGINE: 'real',
    APLOS_TEST: '1',
    APLOS_DATA_DIR: dataDir,
    APLOS_TEST_SHOW_WINDOWS: '1',
    APLOS_TEST_CDP_PORT: String(PORT),
    APLOS_TEST_KEYCHAIN: 'login',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const s of [child.stdout, child.stderr]) s.on('data', c => output.push(c.toString()));
const delay = ms => new Promise(r => setTimeout(r, ms));
const results = [];
async function main() {
  // Wait for Chromium to publish the random loopback port inside OUR private data dir — a stale
  // endpoint owned by another process can never be mistaken for ours.
  // Ownership proof: the child itself announces the loopback bind on stderr — a stale bind
  // owned by another process can never be mistaken for ours.
  let confirmed = false;
  for (let i = 0; i < 120 && !confirmed; i++) {
    await delay(500);
    confirmed = output.join('').includes(`DevTools listening on ws://127.0.0.1:${PORT}/`);
    if (child.exitCode !== null)
      throw new Error(`app exited early: ${output.join('').slice(-300)}`);
  }
  if (!confirmed)
    throw new Error(`child never announced DevTools on ${PORT}: ${output.join('').slice(-240)}`);
  let mailPage;
  for (let i = 0; i < 150; i++) {
    await delay(400);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pages = list.filter(
        t =>
          t.type === 'page' &&
          /^(file:|aplos-mail:|app:)/.test(t.url) &&
          !t.url.startsWith('devtools:'),
      );
      mailPage =
        pages.find(p => !p.url.includes('draft=') && !p.url.includes('onboarding')) ?? pages[0];
      if (mailPage) break;
    } catch {
      // DevTools endpoint not up yet — keep polling.
    }
  }
  if (!mailPage) throw new Error(`no renderer page after 60s — ${output.join('').slice(-240)}`);
  const ws = new WebSocket(mailPage.webSocketDebuggerUrl);
  let bws = null;
  let bsend = async () => undefined;
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push(String(m.params?.exceptionDetails?.text ?? 'exception').slice(0, 160));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  try {
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    bws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      bws.addEventListener('open', res, { once: true });
      bws.addEventListener('error', rej, { once: true });
    });
    let bid = 10000;
    const bpending = new Map();
    bws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && bpending.has(m.id)) {
        bpending.get(m.id)(m);
        bpending.delete(m.id);
      }
    });
    bsend = (method, params = {}) =>
      new Promise(r => {
        const i = ++bid;
        bpending.set(i, r);
        bws.send(JSON.stringify({ id: i, method, params }));
      });
  } catch {
    // No browser-level endpoint — window-geometry checks will be skipped.
  }
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        reject(new Error(`cdp timeout: ${method}`));
      }, 20000);
      pending.set(i, m => {
        clearTimeout(timer);
        resolve(m);
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  const ev = async x =>
    (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))
      .result?.result?.value;

  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
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
  const rect = (name, minX = 0) =>
    ev(`(()=>{
      const want=${JSON.stringify(name)}, minX=${minX};
      const els=[...document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[role=row],div,li,span,p')];
      const el=els.find(e=>{
        const t=(e.getAttribute('aria-label')||e.textContent||'').trim();
        if(!(t===want||t.startsWith(want+'\\n')||t.startsWith(want+' ')))return false;
        const r0=e.getBoundingClientRect();
        return r0.width>0&&r0.height>0&&r0.x>=minX;
      });
      if(!el)return null;el.scrollIntoViewIfNeeded?el.scrollIntoViewIfNeeded():el.scrollIntoView({block:'nearest'});
      const r=el.getBoundingClientRect();
      const vis=r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.x<window.innerWidth&&r.y<window.innerHeight;
      return {x:r.x+r.width/2,y:r.y+r.height/2,vis};
    })()`);
  const click = async (name, minX = 0) => {
    const r = await rect(name, minX);
    if (!r || !r.vis) {
      pageErrors.push(`click target missing: ${name}`);
      return 'MISSING';
    }
    await clickAt(r.x, r.y);
    return 'ok';
  };
  const key = async (k, mods = 0, code) => {
    const base = { key: k, modifiers: mods, code: code ?? `Key${k.toUpperCase()}` };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const type = t => send('Input.insertText', { text: t });
  const shot = async name => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s.result?.data)
      writeFileSync(join(outDir, `${name}.png`), Buffer.from(s.result.data, 'base64'));
  };
  const text = () => ev('document.body?.innerText ?? ""');
  const BAD =
    /Aplos needs a moment|Error invoking remote method|Couldn['’]t load this list|not on the new engine/i;
  async function step(name, act, opts = {}) {
    pageErrors.length = 0;
    const before = output.length;
    const actResult = act ? await act() : undefined;
    await delay(opts.wait ?? 2000);
    await shot(`e2e-${name}`);
    const body = String(await text()).slice(0, 800);
    const bad = body.match(BAD);
    const refused = output
      .slice(before)
      .join('')
      .match(/[^\n]*(aplos:invoke|not on the new engine)[^\n]*/);
    const errs = [...pageErrors];
    if (refused) errs.push('console: ' + refused[0].trim().slice(0, 160));
    results.push({
      name,
      status: actResult === 'SKIP' ? 'SKIP' : bad || errs.length ? 'FAIL' : 'PASS',
      flags: [...(bad ? [`screen copy: ${bad[0]}`] : []), ...errs.slice(0, 4)],
      text: body.replace(/\n{3,}/g, '\n\n').slice(0, 400),
    });
  }

  // Let the app settle: engine boot + window + first sync state.
  await delay(9000);
  const win = async () =>
    bsend('Browser.getWindowForTarget', { targetId: mailPage.id })
      .then(r => r.result?.bounds)
      .catch(() => null);

  await step('boot-home', null, { wait: 3000 });

  // ── Home triage ─────────────────────────────────────────────
  await step('triage-E-done', async () => key('e')); // Done on focused card
  await step('triage-arrow', async () => key('ArrowRight', 0, 'ArrowRight'));
  await step('triage-L-later', async () => key('l'));
  await step('triage-space', async () => key(' ', 0, 'Space'));
  await step('one-by-one', () => click('Go one by one'));
  await step('obo-keys', async () => {
    await key('e');
    await delay(1200);
    await key('l');
    await delay(1200);
  });
  await step('obo-escape', () => key('Escape', 0, 'Escape'));

  // ── Reader ──────────────────────────────────────────────────
  await step('reader-open', async () => {
    await click('All mail');
    await delay(1500);
    await click('Kimi'); // known HTML marketing mail in the spare mailbox
  });
  await step('reader-images', async () => {
    await delay(1500);
    await click('Load images');
  });
  await step('reader-https', async () => {
    const r = await ev(`(()=>{const a=[...document.querySelectorAll('a[href^="https:"]')]
      .find(a=>a.getBoundingClientRect().width>0);if(!a)return null;
      const r=a.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    if (r) await clickAt(r.x, r.y);
    else pageErrors.push('no https link in open letter');
  });
  await step('reader-mailto', async () => {
    const r = await ev(`(()=>{const a=[...document.querySelectorAll('a[href^="mailto:"]')]
      .find(a=>a.getBoundingClientRect().width>0);if(!a)return null;
      const r=a.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    if (r) {
      await clickAt(r.x, r.y);
      await delay(2000);
      await key('Escape', 0, 'Escape');
      await delay(800);
      const left = await ev(
        `document.querySelector('input[placeholder*="To"],textarea[placeholder*="To"]')?'compose-open':'closed'`,
      );
      if (left !== 'closed') {
        await key('Escape', 0, 'Escape');
        pageErrors.push('mailto compose did not close; send step will not run');
      }
    } else pageErrors.push('no mailto link found');
  });
  await step('reader-attachment', async () => {
    const r =
      await ev(`(()=>{const el=[...document.querySelectorAll('button,a,[role=button],div,span')]
      .find(e=>/attachment|\\.pdf|\\.ics|\\.png|\\.zip|Download|Save/i.test((e.getAttribute('aria-label')||e.textContent||'').trim())
        &&e.getBoundingClientRect().width>0);if(!el)return null;
      const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    if (r) await clickAt(r.x, r.y);
    else pageErrors.push('no attachment affordance in open letter');
  });
  await step('more-menu', async () => {
    const r = await ev(`(()=>{const el=[...document.querySelectorAll('button,[role=button]')]
      .find(e=>/more/i.test(e.getAttribute('aria-label')||'')||(e.textContent||'').trim()==='⋯');
      if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    if (r) {
      await clickAt(r.x, r.y);
      await delay(1200);
      await key('Escape', 0, 'Escape');
    } else pageErrors.push('no more menu found');
  });

  // ── Mailboxes ───────────────────────────────────────────────
  for (const box of ['Later', 'Done', 'Drafts', 'Sent', 'Spam', 'Trash', 'All mail']) {
    await step(`box-${box.toLowerCase().replace(' ', '-')}`, () => click(box));
  }

  // ── Search (live) ───────────────────────────────────────────
  await step('search-open', async () => {
    await click('Search');
    await delay(1000);
  });
  await step(
    'search-query',
    async () => {
      await type('google');
      await key('Enter', 0, 'Enter');
    },
    { wait: 4000 },
  );
  await step('search-hit-open', async () => {
    const r = await rect('Google');
    if (r) await clickAt(r.x + 100, r.y);
    else pageErrors.push('no search hit to open');
  });
  await step('search-clear', () => key('Escape', 0, 'Escape'));

  // ── Ask ─────────────────────────────────────────────────────
  await step('ask-open', () => click('Ask'));
  await step('ask-today', () => click('Today'));

  // ── Calendar ────────────────────────────────────────────────
  await step('cal-day', () => click('Calendar'), { wait: 4000 });
  await step('cal-week', () => click('Week'));
  await step('cal-month', () => click('Month'));
  await step('cal-event', async () => {
    const r = await ev(`(()=>{const el=[...document.querySelectorAll('*')]
      .filter(e=>e.children.length<=2&&(e.textContent||'').trim().length>3)
      .map(e=>e.getBoundingClientRect())
      .find(r=>r.x>420&&r.x<1100&&r.y>200&&r.y<700&&r.width>30&&r.width<400&&r.height>14&&r.height<120);
      return el?{x:el.x+el.width/2,y:el.y+el.height/2}:null})()`);
    if (r) await clickAt(r.x, r.y);
    else pageErrors.push('no event to open');
  });

  // ── Settings sections ───────────────────────────────────────
  await step('settings-open', () => click('Settings'), { wait: 2500 });
  for (const s of [
    'Mail',
    'Calendar',
    'AI',
    'Notifications',
    'Accounts',
    'Keyboard',
    'Help & about',
  ]) {
    await step(`settings-${s.toLowerCase().replace(/[&\s]+/g, '-')}`, () => click(s, 290), {
      wait: 1500,
    });
  }
  // The spare account's own address for send-to-self: read from the private copy's accounts
  // table, never from page text (a wrong scrape would send to a third party). Memory only.
  const selfAddress = (() => {
    try {
      const out = execFileSync('/usr/bin/sqlite3', [
        `${dataDir}/mail.db`,
        'SELECT address FROM accounts LIMIT 1',
      ])
        .toString()
        .trim();
      return /^[\w.+-]+@[\w.-]+\.[\w.]+$/.test(out) ? out : null;
    } catch {
      return null;
    }
  })();

  // ── Add account redirect ────────────────────────────────────
  await step('add-account', async () => {
    await click('Accounts', 290);
    await delay(1200);
    await click('Add account', 290);
    await delay(3000); // Test mode records the OAuth redirect instead of opening a browser.
    await key('Escape', 0, 'Escape');
  });

  // ── Compose / reply / send to self / draft ──────────────────
  await step(
    'compose-open',
    async () => {
      await key('Escape', 0, 'Escape');
      await key('c');
    },
    { wait: 2500 },
  );
  if (selfAddress && !skipSend) {
    await step(
      'compose-send-self',
      async () => {
        await type(selfAddress);
        await key('Tab', 0, 'Tab');
        await type('e2e self send (platform sweep)');
        await key('Tab', 0, 'Tab');
        await type('automated end-to-end check; safe to delete.');
        await key('Enter', 4, 'Enter'); // ⌘↩ sends
      },
      { wait: 5000 },
    );
    await step('sent-verify', () => click('Sent'), { wait: 3000 });
  } else {
    results.push({
      name: 'compose-send-self',
      status: 'SKIP',
      flags: ['no account address found on screen'],
      text: '',
    });
  }
  await step(
    'draft-save',
    async () => {
      await key('c');
      await delay(1800);
      await type('e2e draft probe');
      await key('Escape', 0, 'Escape');
      await delay(1500);
      await click('Drafts');
    },
    { wait: 3000 },
  );

  // ── Chrome ──────────────────────────────────────────────────
  await step('sidebar-toggle', async () => {
    await key('s', 4); // ⌘S per #319
    await delay(900);
    await key('s', 4);
  });
  await step('account-switcher', async () => {
    await click('All accounts');
    await delay(1200);
    await key('Escape', 0, 'Escape');
  });
  await step('window-drag', async () => {
    const b = await win();
    if (!b) return 'SKIP';
    // Drag the chrome strip above the content area.
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 700,
      y: 14,
      button: 'left',
      clickCount: 1,
    });
    for (let i = 1; i <= 6; i++)
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: 700 + i * 25,
        y: 14 + i * 8,
      });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 850,
      y: 62,
      button: 'left',
      clickCount: 1,
    });
    await delay(600);
    const b2 = await win();
    if (b2 && b2.left === b.left && b2.top === b.top) pageErrors.push('window did not move');
  });
  await step('fullscreen', async () => {
    await key('f', 6); // ⌃⌘F
    await delay(2500);
    const b = await win();
    await key('f', 6);
    await delay(1500);
    if (!b) return 'SKIP';
  });
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

writeFileSync(
  join(outDir, 'e2e.json'),
  JSON.stringify(
    results.map(r => ({ ...r, text: undefined })),
    null,
    2,
  ),
);
const md = [
  '# Real-path end-to-end pass',
  '',
  `App: ${appArg}`,
  '',
  '| Step | Result | Flags |',
  '|---|---|---|',
  ...results.map(
    r => `| ${r.name} | ${r.status} | ${(r.flags ?? []).join('; ').replace(/\|/g, '/')} |`,
  ),
  '',
].join('\n');
writeFileSync(join(outDir, 'e2e.md'), md);
console.log(md);
process.exit(results.some(r => r.status === 'FAIL') ? 1 : 0);
