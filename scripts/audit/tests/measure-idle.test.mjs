import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  childrenOf,
  chooseEngineProcess,
  cputimeSeconds,
  cpuPercent,
  descendantsOf,
  devToolsFetch,
  evaluateOn,
  launchApp,
  median,
  parseArgs,
  parsePsSample,
  parsePsTree,
  parseTopSamples,
  rendererPids,
  shown,
  tailLines,
} from '../measure-idle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'measure-idle.mjs');

const helper =
  'Aplos Mail.app/Contents/Frameworks/Aplos Mail Helper.app/Contents/MacOS/Aplos Mail Helper';
const psTreeFixture = [
  '    1     0 /sbin/launchd',
  '  100     1 /Applications/Aplos Mail.app/Contents/MacOS/Aplos Mail --remote-debugging-port=0',
  `  200   100 /Applications/${helper} --type=renderer --enable-sandbox`,
  `  201   100 /Applications/${helper} --type=utility --utility-sub-type=node.mojom.NodeService --service-name=Aplos Mail Engine (new) --aplos-engine=real`,
  '  202   100 /Applications/Aplos Mail Helper (GPU).app --type=gpu-process',
  `  300   200 /Applications/${helper} --type=utility --utility-sub-type=node.mojom.NodeService`,
  'not a ps row',
  '',
].join('\n');

describe('measure-idle cputime', () => {
  it('reads M:SS.cc, H:MM:SS and D-H:MM:SS', () => {
    assert.equal(cputimeSeconds('0:05.23'), 5.23);
    assert.equal(cputimeSeconds('12:34'), 12 * 60 + 34);
    assert.equal(cputimeSeconds('1:02:03.5'), 3723.5);
    assert.equal(cputimeSeconds('2-01:00:00'), 2 * 86_400 + 3600);
    assert.equal(cputimeSeconds('45'), 45);
    assert.equal(cputimeSeconds('45.5'), 45.5);
  });

  it('returns NaN for malformed input', () => {
    for (const bad of ['abc', '', '  ', '1:2:3:4', '-1:00', 'aa:bb', '1:x.5', null, undefined])
      assert.ok(Number.isNaN(cputimeSeconds(bad)), JSON.stringify(bad));
  });
});

describe('measure-idle ps parsing', () => {
  it('parses pid,ppid,command rows and skips malformed lines', () => {
    const rows = parsePsTree(psTreeFixture);
    assert.equal(rows.length, 6);
    assert.deepEqual(rows[1], {
      pid: 100,
      ppid: 1,
      command: '/Applications/Aplos Mail.app/Contents/MacOS/Aplos Mail --remote-debugging-port=0',
    });
    assert.deepEqual(parsePsTree(''), []);
    assert.deepEqual(parsePsTree('x y z\n'), []);
  });

  it('parses a ps -o pid=,rss=,pcpu=,time= sample into a pid map', () => {
    const text = [
      '  101   23456   0.0   0:03.45',
      '  102   100     12.3  1:02:03',
      'bad line',
      '  103   200', // too few columns
      '  104   -1    0.0   0:01.00', // a negative rss is malformed
      '  105   300   0.0   nope', // an unparseable cputime drops the row
    ].join('\n');
    const rows = parsePsSample(text);
    assert.equal(rows.size, 2);
    assert.deepEqual(rows.get(101), { rssKb: 23456, pcpu: 0, cputime: 3.45 });
    assert.deepEqual(rows.get(102), { rssKb: 100, pcpu: 12.3, cputime: 3723 });
    assert.deepEqual(parsePsSample('').size, 0);
  });

  it('walks children and descendants by ppid', () => {
    const rows = parsePsTree(psTreeFixture);
    assert.deepEqual(
      childrenOf(rows, 100).map(r => r.pid),
      [200, 201, 202],
    );
    assert.deepEqual(new Set(descendantsOf(rows, 100)), new Set([200, 201, 202, 300]));
    assert.deepEqual(descendantsOf(rows, 201), []);
    assert.deepEqual(descendantsOf(rows, 999), []);
  });
});

describe('measure-idle engine pick', () => {
  const utility = (pid, extra = '') => ({
    pid,
    ppid: 100,
    command: `/Applications/${helper} --type=utility ${extra}`,
  });

  it('prefers the utility child carrying both the service name and --aplos-engine=real', () => {
    const pick = chooseEngineProcess(parsePsTree(psTreeFixture), 100);
    assert.equal(pick.pid, 201);
    assert.match(pick.how, /service-name/);
  });

  it('prefers --aplos-engine=real over the generic node.mojom.NodeService marker', () => {
    const pick = chooseEngineProcess(
      [
        utility(201, '--utility-sub-type=node.mojom.NodeService'),
        utility(202, '--aplos-engine=real'),
      ],
      100,
    );
    assert.equal(pick.pid, 202);
    assert.match(pick.how, /aplos-engine=real/);
  });

  it('prefers the named engine service when several children carry --aplos-engine=real', () => {
    const pick = chooseEngineProcess(
      [
        utility(203, '--aplos-engine=real'),
        utility(204, '--aplos-engine=real --service-name=Aplos Mail Engine (new)'),
      ],
      100,
    );
    assert.equal(pick.pid, 204);
    assert.match(pick.how, /service-name/);
  });

  it('falls back to the node.mojom marker, the sole child, then the lowest pid', () => {
    const marker = chooseEngineProcess(
      [
        utility(201, '--utility-sub-type=other'),
        utility(202, '--utility-sub-type=node.mojom.NodeService'),
      ],
      100,
    );
    assert.equal(marker.pid, 202);
    assert.match(marker.how, /node\.mojom\.NodeService/);
    const sole = chooseEngineProcess([utility(201)], 100);
    assert.equal(sole.pid, 201);
    assert.match(sole.how, /only utility child/);
    const lowest = chooseEngineProcess([utility(300), utility(250)], 100);
    assert.equal(lowest.pid, 250);
    assert.match(lowest.how, /lowest pid/);
  });

  it('ignores utility processes that are not children of the main pid', () => {
    const rows = parsePsTree(psTreeFixture).filter(row => row.pid !== 201);
    assert.equal(chooseEngineProcess(rows, 100), null);
    assert.equal(chooseEngineProcess(rows, 999), null);
  });

  it('lists only --type=renderer children as renderers', () => {
    assert.deepEqual(rendererPids(parsePsTree(psTreeFixture), 100), [200]);
    assert.deepEqual(rendererPids(parsePsTree(psTreeFixture), 201), []);
  });
});

const topBlock = (cpu, idlew) => `Processes: 500 total, 2 running, 498 sleeping
2026/11/10 10:00:00
Load Avg: 2.00, 2.10, 2.20
CPU usage: 5.0% user, 10.0% sys, 85.0% idle
SharedLibs: 100M resident

PID    %CPU IDLEW
555    ${cpu}   ${idlew}
556    1.0  20
`;

describe('measure-idle top parsing', () => {
  it('returns every post-first sample for the pid in order', () => {
    const pairs = [
      ['12.0', '40'],
      ['0.3', '7'],
      ['0.4', '9'],
      ['0.2', '5'],
      ['0.5', '11'],
      ['0.1', '3'],
    ];
    const text = pairs.map(([cpu, idlew]) => topBlock(cpu, idlew)).join('\n');
    assert.deepEqual(parseTopSamples(text, 555), [
      { cpu: 0.3, idlew: 7 },
      { cpu: 0.4, idlew: 9 },
      { cpu: 0.2, idlew: 5 },
      { cpu: 0.5, idlew: 11 },
      { cpu: 0.1, idlew: 3 },
    ]);
  });

  it('returns an empty list without a second table or when the pid is gone', () => {
    assert.deepEqual(parseTopSamples(topBlock('1.0', '2'), 555), []);
    const two = topBlock('1.0', '2') + '\n' + 'Processes: 1 total\n\nPID    %CPU IDLEW\n';
    assert.deepEqual(parseTopSamples(two, 555), []);
    assert.deepEqual(parseTopSamples('', 555), []);
  });

  it('skips a later table where the pid printed no row', () => {
    const text =
      topBlock('1.0', '2') +
      '\n' +
      topBlock('0.3', '7') +
      '\n' +
      'Processes: 1 total\n\nPID    %CPU IDLEW\n556    0.1  4\n';
    assert.deepEqual(parseTopSamples(text, 555), [{ cpu: 0.3, idlew: 7 }]);
  });

  it('reads the named columns from the right when a COMMAND column widens the row', () => {
    const wide = `PID    COMMAND                 %CPU IDLEW
555    Aplos Mail Engine (new)   0.4  9
`;
    const text = topBlock('1.0', '1') + '\n' + wide;
    assert.deepEqual(parseTopSamples(text, 555), [{ cpu: 0.4, idlew: 9 }]);
  });
});

describe('measure-idle statistics', () => {
  it('medians odd, even and empty lists', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([5]), 5);
    assert.ok(Number.isNaN(median([])));
  });

  it('computes CPU percent from the cputime delta over wall time', () => {
    assert.ok(Math.abs(cpuPercent(6, 10.8, 600) - 0.8) < 1e-9);
    assert.equal(cpuPercent(0, 30, 600), 5);
    assert.equal(cpuPercent(6, 10, 0), null);
    assert.equal(cpuPercent(6, 10, -5), null);
  });

  it('renders n/a for unmeasured numbers', () => {
    assert.equal(shown(12.3, ' MB'), '12.3 MB');
    assert.equal(shown(null, ' MB'), 'n/a');
    assert.equal(shown(NaN, ' %'), 'n/a');
  });
});

describe('measure-idle arguments', () => {
  it('parses the .app path and every flag', () => {
    assert.deepEqual(parseArgs(['Aplos Mail.app']), {
      app: 'Aplos Mail.app',
      minutes: 10,
      interval: 5,
      settle: 60,
      json: false,
      out: null,
    });
    assert.deepEqual(
      parseArgs([
        'a.app',
        '--json',
        '--minutes',
        '2',
        '--interval',
        '3',
        '--settle',
        '0',
        '--out',
        'x.json',
      ]),
      { app: 'a.app', minutes: 2, interval: 3, settle: 0, json: true, out: 'x.json' },
    );
  });

  it('rejects bad input', () => {
    assert.throws(() => parseArgs([]), /usage/);
    assert.throws(() => parseArgs(['a.app', '--nope']), /unknown argument/);
    assert.throws(() => parseArgs(['a.app', 'b.app']), /unexpected argument/);
    assert.throws(() => parseArgs(['a.app', '--minutes', 'x']), /--minutes/);
    assert.throws(() => parseArgs(['a.app', '--minutes', '0']), /--minutes/);
    assert.throws(() => parseArgs(['a.app', '--minutes', '-1']), /--minutes/);
    assert.throws(() => parseArgs(['a.app', '--minutes', 'NaN']), /--minutes/);
    assert.throws(() => parseArgs(['a.app', '--interval', '0']), /--interval/);
    assert.throws(() => parseArgs(['a.app', '--settle', '-1']), /--settle/);
    assert.throws(() => parseArgs(['a.app', '--settle', 'x']), /--settle/);
    assert.throws(() => parseArgs(['a.app', '--out']), /--out needs a file/);
  });
});

describe('measure-idle retained output', () => {
  it('keeps only the last lines so a chatty app cannot grow memory', () => {
    assert.deepEqual(tailLines(['a', 'b', 'c'], 2), ['b', 'c']);
    assert.deepEqual(tailLines(['a'], 2), ['a']);
    const kept = tailLines(
      Array.from({ length: 600 }, (_, index) => `line ${index}`),
      500,
    );
    assert.equal(kept.length, 500);
    assert.equal(kept[0], 'line 100');
    assert.equal(kept.at(-1), 'line 599');
  });
});

describe('measure-idle launch', () => {
  it('rejects the ready promise when the binary cannot be spawned', async () => {
    const run = launchApp('/no/such/aplos-mail-binary');
    await assert.rejects(run.engineReady, /could not be launched/);
  });
});

describe('measure-idle devtools io', () => {
  it('fetches a responding DevTools endpoint', async () => {
    const server = createServer((request, response) => response.end('[]'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/json/list`;
      const response = await devToolsFetch(url, {}, 1_000);
      assert.deepEqual(await response.json(), []);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('times out with a clear error on a hung DevTools endpoint', async () => {
    const server = createServer(() => {}); // accepts the request and never answers
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/json/list`;
      await assert.rejects(
        devToolsFetch(url, {}, 50),
        error => error.devToolsTimeout === true && /timed out after 50 ms/.test(error.message),
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('times out a WebSocket that never finishes opening', async () => {
    const sockets = new Set();
    const server = createTcpServer(socket => sockets.add(socket)); // holds the socket, says nothing
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const target = {
        id: 'p1',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/cdp`,
      };
      await assert.rejects(
        evaluateOn(target, 'window.close()', 50),
        error => error.devToolsTimeout === true && /did not open within 50 ms/.test(error.message),
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  });
});

describe('measure-idle cli', () => {
  it('exits 2 with usage and never launches without an .app', () => {
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /usage: node scripts\/audit\/measure-idle\.mjs/);
  });

  it('exits 2 when the executable is missing and 2 on an unknown flag', () => {
    const run = spawnSync(process.execPath, [script, '/no/such/Aplos Mail.app'], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /no executable at/);
    const bad = spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown argument/);
  });

  it('exits 2 on --minutes below 1, before any launch', () => {
    const run = spawnSync(process.execPath, [script, 'a.app', '--minutes', '0'], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--minutes needs a number of at least 1/);
  });
});
