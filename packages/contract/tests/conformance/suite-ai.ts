import assert from 'node:assert/strict';
import { ContractError, type Input } from '../../src/index';
import { opId } from './samples';
import { rejects, type SuiteTools } from './suite-helpers';

/** The AI consent and account-exclusion rules. */
export function aiSuite({ scenario }: SuiteTools) {
  /** FR-8: "Use this account's mail for AI" bounds every AI scope; naming an excluded account never widens it. */
  scenario('ai/excluded-account-stays-out', async (engine, c) => {
    const accounts = (await c.call('Account/get', {})).list;
    if (accounts.length < 2) return;
    const [kept, excluded] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    await c.call('Account/set', { opId: opId(), accountId: excluded.id, aiAllowed: false });
    let run;
    try {
      run = await c.call('Ask/run', {
        question: 'What needs my reply today?',
        scope: { accountIds: [excluded.id, kept.id] },
      });
    } catch (error) {
      if (error instanceof ContractError && error.type === 'notConfigured') return;
      throw error;
    }
    await engine.advance(3_000);
    const turn = (
      await c.call('Conversation/get', { ids: [run.conversationId] })
    ).list[0]!.turns.at(-1)!;
    const threads = new Set(
      turn.citations.flatMap(x => (x.kind === 'message' ? [x.threadId] : [])),
    );
    const rows = (await c.call('Thread/get', { ids: [...threads] })).list;
    assert.ok(
      rows.every(t => t.accountId !== excluded.id),
      'no source from an account left out of AI',
    );
    assert.ok(turn.excludedAccountIds?.includes(excluded.id));
    const excludedThread = (
      await c.call('View/query', {
        spec: { kind: 'mailbox', role: 'inbox', accountId: excluded.id },
      })
    ).ids[0];
    if (excludedThread)
      await rejects(
        c.session.call('Ai/request', {
          opId: opId(),
          kind: 'summary',
          threadId: excludedThread,
          force: true,
        }),
        'forbidden',
      );
    // A draft in that account carries its mail as context, so Ai/draft and Ai/polish refuse it too (R2B-5).
    const { draft } = await c.call('Draft/set', {
      opId: opId('draft'),
      fields: {
        accountId: excluded.id,
        mode: 'new',
        to: [{ address: 'someone@conformance.example' }],
        cc: [],
        bcc: [],
        subject: 'Excluded',
        html: '<p>Private</p>',
        attachments: [],
        signature: false,
      },
    });
    const refused = [
      c.session.call('Ai/draft', {
        requestId: opId('ai'),
        instruction: 'Say thanks.',
        draftId: draft.id,
      }),
      c.session.call('Ai/polish', {
        requestId: opId('ai'),
        html: '<p>Private</p>',
        draftId: draft.id,
      }),
    ];
    // Pasted text and Ask's draft context have no draft row, so they name the composing account instead.
    refused.push(
      c.session.call('Ai/polish', {
        requestId: opId('ai'),
        html: '<p>Private</p>',
        accountId: excluded.id,
      }),
      c.session.call('Ask/run', {
        question: 'Tighten this.',
        context: { draft: { html: '<p>Private</p>', accountId: excluded.id } },
      }),
    );
    for (const call of refused) {
      const error = await rejects(call, 'forbidden');
      assert.equal(error?.body.reasonCode, 'ai.accountExcluded');
    }
  });

  /** R2B-4: background consent covers every model background jobs run on, not only Summaries. */
  scenario('ai/consent-covers-background-features', async (_e, c) => {
    for (const feature of ['plans', 'drafts'] as const) {
      const consent = await c.call('Consent/get', {});
      const { features } = (await c.call('Settings/get', {})).ai;
      await c.call('Consent/grant', {
        scope: 'background',
        version: consent.currentVersion,
        provider: features.summaries.provider as Input<'Consent/grant'>['provider'],
        model: features.summaries.model,
      });
      const other =
        features[feature].provider === 'ollama'
          ? ({ provider: 'groq', model: 'openai/gpt-oss-120b' } as const)
          : ({ provider: 'ollama', model: 'llama3.2' } as const);
      await c.call('Settings/set', {
        opId: opId(),
        patch: { ai: { features: { ...features, [feature]: other } } },
      });
      const after = await c.call('Consent/get', {});
      assert.equal(
        after.needsReconsent,
        true,
        `moving ${feature} to another provider needs the card again`,
      );
      assert.ok(after.currentVersion > consent.currentVersion);
    }
  });
}
