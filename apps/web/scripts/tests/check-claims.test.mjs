import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeDir, run } from './helpers.mjs';

after(cleanup);

const claim = (id, over = {}) => ({
  id,
  says: `says ${id}`,
  pages: ['landing'],
  evidence: [{ kind: 'design', ref: 'ARCHITECTURE.md section 1', maxAgeDays: null }],
  status: 'verified',
  verifiedAt: '2026-10-27',
  ...over,
});
const registry = (...claims) => ({ version: 1, claims });
const landing = (...ids) =>
  `export const L = () => <div>${ids.map(i => `<p data-claim="${i}">x</p>`).join('')}</div>;`;
const TODAY = ['--today', '2026-10-27'];

function setup({ claims, src = {}, status }) {
  const files = { 'src/Landing.tsx': landing('local-only'), ...src };
  if (claims) files['claims.json'] = claims;
  if (status) files['provider-status.json'] = status;
  const dir = makeDir(files);
  const args = [
    '--src',
    join(dir, 'src'),
    '--claims',
    join(dir, 'claims.json'),
    '--status',
    join(dir, 'provider-status.json'),
    ...TODAY,
  ];
  return (extra = []) => run('check-claims.mjs', [...args, ...extra]);
}

test('verified claims used in copy pass, also with --production', () => {
  const go = setup({ claims: registry(claim('local-only')) });
  assert.equal(go().code, 0, go().out);
  assert.equal(go(['--production']).code, 0);
});

test('an id used in copy but missing from claims.json fails', () => {
  const r = setup({ claims: registry(claim('other')) })();
  assert.equal(r.code, 1);
  assert.match(r.out, /"local-only" is not in claims\.json/);
});

test('a missing claims.json fails', () => {
  const r = setup({})();
  assert.equal(r.code, 1);
  assert.match(r.out, /claims\.json.* not found/);
});

test('several ids in one data-claim are all checked', () => {
  const r = setup({
    claims: registry(claim('a-one')),
    src: { 'src/Landing.tsx': '<p data-claim="a-one b-two">x</p>' },
  })();
  assert.equal(r.code, 1);
  assert.match(r.out, /"b-two" is not in claims\.json/);
});

test('malformed rows and duplicate ids fail', () => {
  const dup = setup({ claims: registry(claim('local-only'), claim('local-only')) })();
  assert.equal(dup.code, 1);
  assert.match(dup.out, /duplicate id/);
  for (const bad of [
    claim('local-only', { status: 'maybe' }),
    claim('local-only', { evidence: [] }),
    claim('local-only', { evidence: [{ kind: 'vibes', ref: 'x', maxAgeDays: null }] }),
    claim('local-only', { pages: ['pricing'] }),
    claim('local-only', { verifiedAt: null }),
    claim('Not Kebab'),
  ]) {
    const r = setup({ claims: registry(bad) })();
    assert.equal(r.code, 1, JSON.stringify(bad) + r.out);
  }
});

test('a pending claim passes in preview with a warning and fails with --production', () => {
  const go = setup({
    claims: registry(
      claim('local-only', {
        evidence: [{ kind: 'live', ref: 'gmail', maxAgeDays: 7 }],
        status: 'pending',
        verifiedAt: null,
      }),
    ),
  });
  const preview = go();
  assert.equal(preview.code, 0, preview.out);
  assert.match(preview.out, /WARN claim "local-only" is pending/);
  const prod = go(['--production']);
  assert.equal(prod.code, 1);
  assert.match(prod.out, /--production/);
});

test('VERCEL_ENV=production makes the check strict like --production', () => {
  const dir = makeDir({
    'src/Landing.tsx': landing('local-only'),
    'claims.json': registry(claim('local-only', { status: 'pending', verifiedAt: null })),
  });
  const args = ['--src', join(dir, 'src'), '--claims', join(dir, 'claims.json'), ...TODAY];
  assert.equal(run('check-claims.mjs', args).code, 0);
  assert.equal(run('check-claims.mjs', args, { VERCEL_ENV: 'production' }).code, 1);
  assert.equal(run('check-claims.mjs', args, { VERCEL_ENV: 'preview' }).code, 0);
});

const gmail = maxAgeDays =>
  claim('local-only', { evidence: [{ kind: 'live', ref: 'gmail', maxAgeDays }] });

test('live evidence: a recent pass verifies, a stale pass fails with --production', () => {
  const fresh = setup({
    claims: registry(gmail(7)),
    status: { gmail: { status: 'pass', checkedAt: '2026-10-25T08:00:00Z' } },
  });
  assert.equal(fresh(['--production']).code, 0, fresh(['--production']).out);
  const old = setup({
    claims: registry(gmail(7)),
    status: { providers: { gmail: { status: 'pass', checkedAt: '2026-10-01T08:00:00Z' } } },
  });
  assert.equal(old().code, 0, 'preview only warns');
  const r = old(['--production']);
  assert.equal(r.code, 1);
  assert.match(r.out, /stale/);
});

test('live evidence: a failing or missing provider-status is unproven', () => {
  const failing = setup({
    claims: registry(gmail(7)),
    status: { gmail: { status: 'fail', checkedAt: '2026-10-27T00:00:00Z' } },
  });
  assert.equal(failing(['--production']).code, 1);
  const absent = setup({ claims: registry(gmail(7)) });
  assert.equal(absent(['--production']).code, 1);
  assert.match(absent(['--production']).out, /no provider-status\.json/);
});

test('owner evidence needs a dated note', () => {
  const owner = ref =>
    claim('local-only', { evidence: [{ kind: 'owner', ref, maxAgeDays: null }] });
  assert.equal(
    setup({ claims: registry(owner('2026-10-27 owner note: invited testers only')) })([
      '--production',
    ]).code,
    0,
  );
  assert.equal(setup({ claims: registry(owner('the owner said so')) })(['--production']).code, 1);
});

test('design evidence with maxAgeDays goes stale after verifiedAt', () => {
  const c = claim('local-only', {
    evidence: [{ kind: 'design', ref: 'ARCHITECTURE.md section 12', maxAgeDays: 30 }],
    verifiedAt: '2026-08-01',
  });
  const go = setup({ claims: registry(c) });
  assert.equal(go().code, 0);
  assert.equal(go(['--production']).code, 1);
});

test('data-claim with an expression cannot be checked and fails', () => {
  const r = setup({
    claims: registry(claim('local-only')),
    src: { 'src/Landing.tsx': '<p data-claim={id}>x</p>' },
  })();
  assert.equal(r.code, 1);
  assert.match(r.out, /literal id/);
});

/** Writes each case as its own file in one src tree and checks that every one of them is reported. */
function everyCaseFails(cases, { ext = 'tsx', wrap = x => x, match = /./ } = {}) {
  const src = {};
  cases.forEach((c, i) => (src[`src/Case${i}.${ext}`] = wrap(c)));
  const r = setup({ claims: registry(claim('local-only')), src })();
  assert.equal(r.code, 1, r.out);
  cases.forEach((c, i) => {
    const lines = r.out.split('\n').filter(l => l.includes(`Case${i}.${ext}:`));
    assert.ok(
      lines.some(l => match.test(l)),
      `not reported: ${JSON.stringify(c)}\n${r.out}`,
    );
  });
}
const jsx = body => `export const C = () => <p>${body}</p>;`;

test('data-claim in .tsx: object keys, setAttribute, JSX braces and spreads', () => {
  everyCaseFails(
    [
      "export const a = createElement('p', {'data-claim': 'bogus-id'});",
      'export const a = <p {...{"data-claim": "bogus-id"}}>x</p>;',
      "export const a = (el) => el.setAttribute('data-claim', 'bogus-id');",
      "export const a = <p data-claim={'bogus-id'}>x</p>;",
      'export const a = <p data-claim={`bogus-id`}>x</p>;',
    ],
    { match: /bogus-id.*not in claims\.json/ },
  );
  everyCaseFails(
    [
      'export const a = (el) => el.dataset.claim = id;',
      'export const a = (props) => <p {...props} data-claim>x</p>;',
      'export const a = (id) => <p data-claim={`x-${id}`}>x</p>;',
    ],
    { match: /data-claim/ },
  );
});

test('unquoted and upper-case data-claim in html are read, and a registered id passes', () => {
  const ok = setup({
    claims: registry(claim('local-only')),
    src: { 'src/page.html': '<p data-claim=local-only>x</p><p DATA-CLAIM="local-only">y</p>' },
  })();
  assert.equal(ok.code, 0, ok.out);
  const bad = setup({
    claims: registry(claim('local-only')),
    src: { 'src/page.html': '<p data-claim=bogus-id>x</p>' },
  })();
  assert.equal(bad.code, 1);
  assert.match(bad.out, /"bogus-id" is not in claims\.json/);
});

test('placeholders fail in every copy file, not only Privacy.tsx', () => {
  everyCaseFails(
    [
      '<p>Write to [your address].</p>',
      '<p>Address: [TODO]</p>',
      '<p>Contact: TODO</p>',
      '<p>Contact email: TBD</p>',
      '<p>Retention policy to be added.</p>',
      '<p>Write to [contact email]; we reply within a week.</p>',
      '<p>Write to [contact email] or see {site.name}.</p>',
      '<p>{site.name}: write to [contact email].</p>',
      "export const x = 'Contact [email]';",
      "export const copy = { contact: 'Contact [email to be confirmed]' };",
      '<p>Lorem ipsum dolor sit amet</p>',
    ].map(x => (x.startsWith('export') ? x : jsx(x))),
    { match: /placeholder/ },
  );
  const privacy = setup({
    claims: registry(claim('local-only')),
    src: { 'src/Privacy.tsx': jsx('Write to [contact email].') },
  })();
  assert.equal(privacy.code, 1);
  assert.match(privacy.out, /Privacy\.tsx:1 placeholder/);
});

test('ordinary code brackets, selectors and words like "to-do" are not placeholders', () => {
  const r = setup({
    claims: registry(claim('local-only')),
    src: {
      'src/Privacy.tsx':
        "const rows = [1, 2]; const a = rows[0]; const el = document.querySelector('[data-reveal]'); export const P = () => <p>We keep mail for 90 days. Your to-do list stays on this Mac. {rows.map(r => <i key={r}>x</i>)}</p>;",
    },
  })();
  assert.equal(r.code, 0, r.out);
});

test('banned phrases and glyphs fail in any copy file, in any case', () => {
  everyCaseFails(
    [
      'Airmail stripes',
      'It feels like MAGIC',
      'AI-powered inbox',
      'Your Copilot',
      'Hold A and say it',
      'Mac, Windows and Linux',
      'Summaries ✨',
      'Rated ★★★',
      '\u{1F31F}',
    ].map(jsx),
    { match: /banned phrase/ },
  );
  const html = setup({
    claims: registry(claim('local-only')),
    src: { 'src/page.html': '<p>airmail</p>' },
  })();
  assert.equal(html.code, 1);
});

test('banned wording cannot hide behind tags, entities, escapes, line breaks or odd characters', () => {
  everyCaseFails(
    [
      'hold <Key>A</Key> and say it',
      "Hold A{' '}and say it",
      'Hold A\n      and say it',
      'AI\u2011powered inbox',
      'AI powered inbox',
      'Air<wbr />mail',
      'Air&shy;mail',
      'Air\u00admail',
      'Your co-pilot',
      "{'\u2728'}",
      '&#x2728; Summaries',
      '\u{1FA84} Draft',
      '\u2747 Draft',
      '{"✨"}',
      'Get <b>Smart</b> replies',
      '<span className="badge">Beta</span>',
      'Magi<b>c</b> replies',
    ].map(jsx),
    { match: /banned phrase/ },
  );
  everyCaseFails(
    [
      'import { Sparkles } from "lucide-react"; export const C = () => <Sparkles />;',
      'export const C = () => <WandIcon />;',
      'export const C = () => <StarFilled />;',
    ],
    {
      match: /sparkle-icon/,
    },
  );
  everyCaseFails(
    [
      '.a::after{content:"\\2728"}',
      '.airmail{border:1px solid red}',
      '.x{content:"✦"}',
      '/* sparkle */',
    ],
    { ext: 'css', match: /banned phrase/ },
  );
});

test("the owner's scope decisions are enforced, and a claims-allow comment is the only way around", () => {
  everyCaseFails(
    [
      'Windows support is planned.',
      'Works with Gmail, Outlook and iCloud.',
      'Add any IMAP account.',
      'Fastmail comes later.',
      'Needs macOS 12 or later.',
      'Updates install themselves.',
      'The app updates automatically.',
      'Download the AppImage.',
      'Linux builds soon.',
      '<a href="https://github.com/notkainoa/aplos-mail">Source</a>',
      'View on GitHub',
    ].map(jsx),
    { match: /banned phrase/ },
  );
  const allowed = setup({
    claims: registry(claim('local-only')),
    src: {
      'src/Privacy.tsx': `export const P = () => (\n  <div>\n    {/* claims-allow: later-providers */}\n    <p>We do not support Outlook yet.</p>\n    <p>We do not support iCloud yet.</p>\n  </div>\n);`,
    },
  })();
  assert.equal(allowed.code, 1, 'the marker covers one rule on its line and the next only');
  assert.doesNotMatch(allowed.out, /Privacy\.tsx:4 /);
  assert.match(allowed.out, /Privacy\.tsx:5 /);
});

test('plain allowed copy passes: macOS 13, invited testers, smartphone, start, betamax', () => {
  const r = setup({
    claims: registry(claim('local-only')),
    src: {
      'src/Landing.tsx':
        'export const L = () => <p data-claim="local-only">Gmail is available to invited testers. Needs macOS 13 or later. Start on your smartphone. Keep your mail on this Mac.</p>;',
    },
  })();
  assert.equal(r.code, 0, r.out);
});

test('live evidence: an explicit failure cannot be rescued by a stray ok, and the future is not a pass', () => {
  const contradictory = setup({
    claims: registry(gmail(7)),
    status: { gmail: { status: 'fail', ok: true, checkedAt: '2026-10-27T00:00:00Z' } },
  });
  assert.equal(contradictory(['--production']).code, 1);
  assert.match(contradictory(['--production']).out, /not passing/);
  const failedFlag = setup({
    claims: registry(gmail(7)),
    status: { gmail: { passed: false, ok: true, checkedAt: '2026-10-27T00:00:00Z' } },
  });
  assert.equal(failedFlag(['--production']).code, 1);
  const future = setup({
    claims: registry(gmail(7)),
    status: { gmail: { status: 'pass', checkedAt: '2099-01-01T00:00:00Z' } },
  });
  assert.equal(future(['--production']).code, 1);
  assert.match(future(['--production']).out, /in the future/);
  const okOnly = setup({
    claims: registry(gmail(7)),
    status: { gmail: { ok: true, checkedAt: '2026-10-27T00:00:00Z' } },
  });
  assert.equal(okOnly(['--production']).code, 0, okOnly(['--production']).out);
});

// ---------- test evidence that lives on another branch (proofSource) ----------

/** A throwaway git repo whose one commit holds tests/kept.test.ts, then deletes it from the working tree. */
function proofRepo() {
  const dir = makeDir({ 'tests/kept.test.ts': 'test' });
  const git = (...a) =>
    execFileSync('git', a, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    }).trim();
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '--no-gpg-sign', '-m', 'proof');
  const commit = git('rev-parse', 'HEAD');
  rmSync(join(dir, 'tests/kept.test.ts'));
  return { dir, commit };
}
const tested = ref => claim('local-only', { evidence: [{ kind: 'test', ref, maxAgeDays: null }] });

test('a test file missing from the checkout fails production with no proofSource', () => {
  const { dir } = proofRepo();
  const r = setup({ claims: registry(tested('tests/kept.test.ts')) })([
    '--production',
    '--repo',
    dir,
  ]);
  assert.equal(r.code, 1);
  assert.match(r.out, /test file tests\/kept\.test\.ts not found/);
});

test('a test file missing here but present at the proofSource commit passes production', () => {
  const { dir, commit } = proofRepo();
  const claims = {
    ...registry(tested('tests/kept.test.ts')),
    proofSource: { branch: 'revamp', commit },
  };
  const r = setup({ claims })(['--production', '--repo', dir]);
  assert.equal(r.code, 0, r.out);
});

test('a test file missing here and at the proofSource commit still fails production', () => {
  const { dir, commit } = proofRepo();
  const claims = {
    ...registry(tested('tests/gone.test.ts')),
    proofSource: { branch: 'revamp', commit },
  };
  const r = setup({ claims })(['--production', '--repo', dir]);
  assert.equal(r.code, 1);
  assert.match(r.out, /not found here or on revamp at/);
});

test('a proofSource commit this clone lacks is a named warning, not a quiet pass', () => {
  const { dir } = proofRepo();
  const claims = {
    ...registry(tested('tests/kept.test.ts')),
    proofSource: { branch: 'revamp', commit: 'a'.repeat(40) },
  };
  const r = setup({ claims })(['--production', '--repo', dir]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /WARN .*proof is on revamp at aaaaaaaaaaaa, which this clone lacks/);
});

test('a malformed proofSource fails', () => {
  const claims = {
    ...registry(claim('local-only')),
    proofSource: { branch: 'revamp', commit: 'abc' },
  };
  const r = setup({ claims })();
  assert.equal(r.code, 1);
  assert.match(r.out, /"proofSource" needs/);
});
