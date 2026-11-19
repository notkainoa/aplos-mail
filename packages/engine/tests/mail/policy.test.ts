import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readRemoteImages, resolveImagePolicy, senderAllowed } from '../../src/mail/policy';
import { frameOf, IDS, mailWorld, serve, text } from './harness';

// The one image-policy mapping, and the render cache keyed on its result.

describe('resolveImagePolicy', () => {
  const list = ['ada@corp.example', '@example.com', 'BOB@Mixed.Example '];
  const table: [requested: unknown, sender: unknown, expected: 'block' | 'allow', why: string][] = [
    ['load', 'anyone@else.example', 'allow', 'the owner asked'],
    ['load', null, 'allow', 'the owner asked, no sender'],
    ['block', 'stranger@else.example', 'block', 'not listed'],
    ['block', 'ada@corp.example', 'allow', 'listed address'],
    ['block', 'ADA@Corp.Example', 'allow', 'case-insensitive'],
    ['block', ' ada@corp.example ', 'allow', 'trimmed'],
    ['block', 'bob@mixed.example', 'allow', 'a listed entry is normalised too'],
    ['block', 'news@example.com', 'allow', '@domain'],
    ['block', 'news@EXAMPLE.COM', 'allow', '@domain, case'],
    ['block', 'evil@exampleXcom', 'block', 'look-alike domain'],
    ['block', 'a@example.com.evil', 'block', 'domain suffix'],
    ['block', 'a@sub.example.com', 'block', 'subdomain is not the domain'],
    ['block', 'xada@corp.example', 'block', 'address suffix'],
    ['block', 'ada@corp.example.evil', 'block', 'address prefix'],
    ['block', '"ada@corp.example"@evil.example', 'block', 'quoted local part'],
    ['block', '@example.com', 'block', 'a domain is not a sender'],
    ['block', undefined, 'block', 'no sender'],
    ['block', '', 'block', 'empty sender'],
    ['allow', 'stranger@else.example', 'block', 'not a contract value'],
    ['Load', 'ada@corp.example', 'block', 'not a contract value'],
    [undefined, 'ada@corp.example', 'block', 'missing'],
    [{ toString: () => 'load' }, 'x@y.example', 'block', 'not a string'],
  ];
  for (const [requested, sender, expected, why] of table) {
    it(`${String(requested)} from ${String(sender)}: ${expected} (${why})`, () => {
      assert.equal(resolveImagePolicy(requested, sender, list), expected);
    });
  }

  it('the owner’s global remoteImages setting allows before the allow-list is even read', () => {
    assert.equal(resolveImagePolicy('block', 'stranger@else.example', [], 'allow'), 'allow');
    assert.equal(resolveImagePolicy('block', 'stranger@else.example', [], 'block'), 'block');
    assert.equal(
      resolveImagePolicy('load', 'stranger@else.example', [], 'block'),
      'allow',
      'an explicit load still wins',
    );
    assert.equal(
      resolveImagePolicy('block', 'ada@corp.example', list),
      'allow',
      'no global arg: the list alone decides',
    );
  });

  it('readRemoteImages reads the settings document and defaults to block', async () => {
    const w = await mailWorld();
    assert.equal(w.store.read(readRemoteImages), 'block');
    w.rawSql(
      'INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      JSON.stringify({ mail: { remoteImages: 'allow' } }),
    );
    assert.equal(w.store.read(readRemoteImages), 'allow');
    for (const value of ['ALLOW', 'load', 'block', 'yes', 'true', 1, true]) {
      w.rawSql(
        'INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
        JSON.stringify({ mail: { remoteImages: value } }),
      );
      assert.equal(
        w.store.read(readRemoteImages),
        'block',
        `${JSON.stringify(value)} is not the literal 'allow'`,
      );
    }
    w.rawSql(
      'INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      'not json',
    );
    assert.equal(w.store.read(readRemoteImages), 'block', 'unreadable settings block');
    await w.cleanup();
  });

  it('ignores unreadable list entries', () => {
    const odd: unknown[] = [null, 42, '', '@', 'not an address', { address: 'a@b.example' }];
    assert.equal(senderAllowed('a@b.example', odd), false);
  });
});

describe('the cache is keyed on the resolved policy', () => {
  it('re-renders when the allow-list changes what "block" means, both ways', async () => {
    const w = await mailWorld({ from: 'ada@corp.example' });
    try {
      const blocked = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      const blockedHtml = text((await serve(w, blocked.url, '', w.ids.windowA)).body);
      assert.doesNotMatch(blockedHtml, /img\/0/);
      const allow = { opId: 'allow-1', sender: '@corp.example', allow: true };
      await w.windowA.call('Mail/allowImages', allow);
      const allowed = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      assert.equal(w.renders.length, 2, 'a new render, not the blocked one from the cache');
      assert.equal(w.renders[1].imagePolicy, 'allow');
      assert.match(text((await serve(w, allowed.url, '', w.ids.windowA)).body), /img\/0/);
      assert.equal((await serve(w, allowed.url, 'img/0', w.ids.windowA)).status, 200);
      const remove = { opId: 'allow-2', sender: '@corp.example', allow: false };
      await w.windowA.call('Mail/allowImages', remove);
      const again = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      assert.equal(w.renders.length, 2, 'the blocked render is the cached one');
      const againHtml = text((await serve(w, again.url, '', w.ids.windowA)).body);
      assert.doesNotMatch(againHtml, /img\/0/, 'never the allowed render');
      assert.equal((await serve(w, again.url, 'img/0', w.ids.windowA)).status, 404);
      assert.equal(
        (await serve(w, allowed.url, 'img/0', w.ids.windowA)).status,
        200,
        'old token kept',
      );
    } finally {
      await w.cleanup();
    }
  });
});
