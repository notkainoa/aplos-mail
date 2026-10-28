import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { makeDir, run } from './helpers.mjs';

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

test('a placeholder or "to be added" in Privacy.tsx fails; code brackets do not', () => {
  const ok = setup({
    claims: registry(claim('local-only')),
    src: {
      'src/Privacy.tsx':
        'const rows = [1, 2]; const a = rows[0]; export const P = () => <p>We keep mail for 90 days. {rows.map(r => <i key={r}>x</i>)}</p>;',
    },
  })();
  assert.equal(ok.code, 0, ok.out);
  for (const body of [
    '<p>Write to [your address].</p>',
    '<p>Address: [TODO]</p>',
    '<p>Retention policy to be added.</p>',
    "const x = 'Contact [email]';",
  ]) {
    const r = setup({ claims: registry(claim('local-only')), src: { 'src/Privacy.tsx': body } })();
    assert.equal(r.code, 1, body + r.out);
    assert.match(r.out, /Privacy\.tsx/);
  }
});

test('banned phrases and glyphs fail in any copy file, in any case', () => {
  for (const bad of [
    'Airmail stripes',
    'It feels like MAGIC',
    'AI-powered inbox',
    'Your Copilot',
    'Hold A and say it',
    'Mac, Windows and Linux',
    'Summaries ✨',
    'Rated ★★★',
    '\u{1F31F}',
  ]) {
    const r = setup({
      claims: registry(claim('local-only')),
      src: { 'src/Download.tsx': `export const D = () => <p>${bad}</p>;` },
    })();
    assert.equal(r.code, 1, bad + r.out);
    assert.match(r.out, /banned phrase/, bad);
  }
  const html = setup({
    claims: registry(claim('local-only')),
    src: { 'src/page.html': '<p>airmail</p>' },
  })();
  assert.equal(html.code, 1);
});

test('data-claim with an expression cannot be checked and fails', () => {
  const r = setup({
    claims: registry(claim('local-only')),
    src: { 'src/Landing.tsx': '<p data-claim={id}>x</p>' },
  })();
  assert.equal(r.code, 1);
  assert.match(r.out, /literal id/);
});
