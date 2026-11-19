import assert from 'node:assert/strict';
import { Frame, parseDiagnosticsBundle } from '../../src/index';
import { SampleContext } from './samples';
import type { SuiteTools } from './suite-helpers';

/** Account reconnect, diagnostics, and mail-frame scenarios. */
export function miscSuite({ scenario }: SuiteTools) {
  /** FR-23: a reconnect sheet reopened anywhere finds its flow by account, and a cancel keeps its mode. */
  scenario('connect/reconnect-frames-carry-account', async (engine, c) => {
    const accountId = (await c.call('Account/get', {})).list[0]!.id;
    const start = await c.call('Account/reconnect', { accountId });
    await engine.advance(100);
    await c.call('Account/cancelConnect', { connectId: start.connectId });
    await engine.advance(100);
    const frames = c.frames.filter(
      (f): f is Extract<Frame, { frame: 'connect' }> =>
        f.frame === 'connect' && f.connectId === start.connectId,
    );
    assert.ok(frames.length > 0, 'the flow reports through connect frames');
    for (const f of frames) {
      assert.equal(f.accountId, accountId, `the ${f.state} frame names the account`);
      assert.equal(f.mode, 'reconnect', `the ${f.state} frame keeps the flow's mode`);
    }
    assert.ok(frames.some(f => f.state === 'cancelled'));
  });

  /** FR-32: the bundle the engine builds passes the host's strict production parse. */
  scenario('diagnostics/strict-bundle', async (_e, c) => {
    parseDiagnosticsBundle(await c.call('Diagnostics/preview', {}));
  });

  /** `Diagnostics/verbose` without `on` is a pure read of the deadline (Settings shows the real state on open). */
  scenario('diagnostics/verbose-read', async (_e, c) => {
    assert.equal((await c.call('Diagnostics/verbose', {})).until, undefined, 'off to begin with');
    const { until } = await c.call('Diagnostics/verbose', { on: true });
    assert.equal(typeof until, 'number');
    assert.equal(
      (await c.call('Diagnostics/verbose', {})).until,
      until,
      'a read answers the deadline',
    );
    assert.equal((await c.call('Diagnostics/verbose', {})).until, until, 'and does not move it');
    assert.equal((await c.call('Diagnostics/verbose', { on: false })).until, undefined);
    assert.equal((await c.call('Diagnostics/verbose', {})).until, undefined, 'off reads off');
  });

  /** FR-34: only the stand-in may hand the reader a `srcdoc`, and then with its own CSP. */
  scenario('mail/srcdoc-stand-in-only', async (engine, c) => {
    const message = await new SampleContext(c.session, async () => {}).message();
    const frame = await c.call('Mail/frame', { messageId: message, imagePolicy: 'block' });
    if (!engine.standIn) assert.equal(frame.srcdoc, undefined, 'the real engine never sets srcdoc');
    if (frame.srcdoc !== undefined)
      assert.match(
        frame.srcdoc,
        /<meta http-equiv="Content-Security-Policy" content="default-src 'none'[^"]*">/,
        'the stand-in document carries its own CSP',
      );
  });
}
