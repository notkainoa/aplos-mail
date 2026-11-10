/** Settings → Tools on this Mac: Add a tool, the one-time key file path, Revoke with a question, device sync (DESIGN 7.10; ARCH 12.3). */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddToolDialog } from './toolDialogs';
import { createController } from './controller';
import type { SettingsApiPort, SettingsData, WriteFailure } from './ports';
import { clients, NOW } from './preview/fixtures';
import { STATES, staticScreen } from './preview/states';
import {
  EMPTY_TOOL_DRAFT,
  revokeConfirm,
  kindNote,
  scopeWarnings,
  toggleScope,
  toolDraftReady,
  withoutKeyPath,
  workflowLine,
  type ClientEntry,
} from './settings.model';
import { INITIAL_VIEW, type SettingsView } from './view';

const PATH = '/Users/someone/Library/Application Support/Aplos Mail/clients/abc.token';

function harness(ports: Partial<SettingsApiPort>, initial: Partial<SettingsData> = {}) {
  let view: SettingsView = { ...INITIAL_VIEW };
  let data = { clients: clients(), now: NOW, ...initial } as SettingsData;
  const failures: (WriteFailure | null)[] = [];
  const actions = createController({
    ports: ports as SettingsApiPort,
    host: {},
    data: () => data,
    view: () => view,
    setView: patch => {
      view = { ...view, ...patch };
    },
    setData: patch => {
      data = { ...data, ...patch };
    },
    overlay: () => {},
    accountOverlay: () => {},
    fail: failure => void failures.push(failure),
    failure: () => failures.at(-1) ?? null,
  });
  return { actions, view: () => view, data: () => data, failures };
}

const granted = (name: string): ClientEntry => ({
  id: 'client-new',
  name,
  kind: 'cli',
  scopes: ['read'],
  createdAt: NOW,
  tokenPath: PATH,
});

describe('ui-settings: Add a tool', () => {
  test('the form needs a name and one permission, starts with read only, and keeps the list order', () => {
    assert.deepEqual(EMPTY_TOOL_DRAFT.scopes, ['read']);
    assert.equal(toolDraftReady(EMPTY_TOOL_DRAFT), false, 'no name yet');
    assert.equal(toolDraftReady({ ...EMPTY_TOOL_DRAFT, name: '  ' }), false, 'a blank name');
    assert.equal(toolDraftReady({ ...EMPTY_TOOL_DRAFT, name: 'Helper' }), true);
    assert.equal(
      toolDraftReady({ name: 'Helper', kind: 'mcp', scopes: [] }),
      false,
      'no permission',
    );
    assert.deepEqual(toggleScope(['read'], 'send', true), ['read', 'send']);
    assert.deepEqual(toggleScope(['send', 'read'], 'read', false), ['send']);
    assert.deepEqual(toggleScope(['admin'], 'draft', true), ['draft', 'admin'], 'list order');
  });

  test('Send and settings carry a plain warning while they are ticked, and nothing else does', () => {
    assert.deepEqual(scopeWarnings(['read', 'draft']), []);
    assert.match(scopeWarnings(['read', 'send']).join(' '), /send mail as you/);
    assert.match(
      scopeWarnings(['admin']).join(' '),
      /change your settings and disconnect accounts/,
    );
  });

  test('grant: the new tool joins the list WITHOUT its key file path; the path goes back to the dialog only', async () => {
    const asked: unknown[] = [];
    const h = harness({
      clientsGrant: async input => {
        asked.push(input);
        return granted(input.name);
      },
    });
    let shown = null as ClientEntry | null;
    const ok = await h.actions.grantClient(
      { name: '  Terminal helper ', kind: 'cli', scopes: ['read'] },
      client => (shown = client),
    );
    assert.equal(ok, true);
    assert.equal(shown?.tokenPath, PATH, 'the dialog gets the path once');
    assert.deepEqual(
      asked,
      [{ name: 'Terminal helper', kind: 'cli', scopes: ['read'] }],
      'the name is trimmed',
    );
    const listed = h.data().clients?.find(c => c.id === 'client-new');
    assert.ok(listed, 'the tool is in the list');
    assert.equal(listed?.tokenPath, undefined, 'the list does not hold the path');
    assert.ok(
      !JSON.stringify([h.data(), h.view(), h.failures]).includes(PATH),
      'the path is in no Settings state',
    );
    assert.equal(h.view().busy.grant, false);
  });

  test('grant: a refusal says so; its Retry still hands the path to the dialog; a second press while it runs is ignored', async () => {
    let attempts = 0;
    const bad = harness({
      clientsGrant: async input => {
        attempts += 1;
        if (attempts === 1) throw new Error('refused');
        return granted(input.name);
      },
    });
    let shown = null as ClientEntry | null;
    const first = await bad.actions.grantClient(
      { name: 'X', kind: 'cli', scopes: ['read'] },
      client => (shown = client),
    );
    assert.equal(first, false);
    assert.equal(bad.failures.at(-1)?.op, 'allow that tool');
    assert.equal(bad.view().busy.grant, false);
    bad.failures.at(-1)?.retry();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(
      (shown as ClientEntry | null)?.tokenPath,
      PATH,
      'the retried grant shows its path',
    );

    const resolvers: ((c: ClientEntry) => void)[] = [];
    const slow = harness({ clientsGrant: () => new Promise(r => resolvers.push(r)) });
    const one = slow.actions.grantClient({ name: 'X', kind: 'cli', scopes: ['read'] }, () => {});
    assert.equal(
      await slow.actions.grantClient({ name: 'X', kind: 'cli', scopes: ['read'] }, () => {}),
      false,
    );
    resolvers[0](granted('X'));
    await one;
    assert.equal(resolvers.length, 1, 'one grant, not two');
  });

  test("opening Add a tool clears another action's failure line, and a list read never keeps a key path", () => {
    const h = harness({});
    h.actions.openAddTool();
    assert.equal(h.failures.at(-1), null, 'the dialog starts without a stale line');
    assert.equal(h.view().addTool, true);
    const row = { ...granted('Listed') };
    assert.equal('tokenPath' in withoutKeyPath(row), false);
  });

  test('Revoke asks first; only the answer revokes, and the tool leaves the list', async () => {
    const calls: string[] = [];
    const h = harness({ clientsRevoke: async id => void calls.push(id) });
    h.actions.askRevokeClient('client-cli', 'Terminal assistant');
    assert.deepEqual(calls, [], 'nothing is revoked before the answer');
    assert.equal(h.view().confirm?.kind, 'revokeClient');
    await h.actions.runConfirm({
      kind: 'revokeClient',
      id: 'client-cli',
      name: 'Terminal assistant',
    });
    assert.deepEqual(calls, ['client-cli']);
    assert.ok(!h.data().clients?.some(c => c.id === 'client-cli'));
    assert.match(revokeConfirm('Notes').question, /Revoke “Notes”\?/);
  });

  test('device sync reads one calm sentence and draws no control while the engine says it is not available', () => {
    assert.equal(
      workflowLine({ enabled: false, available: false }),
      'Device sync comes in a later version.',
    );
    assert.equal(workflowLine(undefined), 'Device sync comes in a later version.');
    assert.match(workflowLine({ enabled: true, available: true }), /between Macs/);
    const markup = renderToStaticMarkup(staticScreen(STATES['device-sync-later']));
    assert.match(markup, /Device sync comes in a later version\./);
    assert.doesNotMatch(markup, /set-general-deviceSync[^]*role="switch"/);
  });

  test('Cancel after a failed grant takes its Retry away; an MCP tool is told which permissions do nothing', async () => {
    const h = harness({
      clientsGrant: async () => {
        throw new Error('refused');
      },
    });
    await h.actions.grantClient({ name: 'X', kind: 'cli', scopes: ['read', 'send'] }, () => {});
    assert.equal(h.failures.at(-1)?.op, 'allow that tool');
    h.actions.openAddTool();
    h.actions.closeAddTool();
    assert.equal(h.failures.at(-1), null, 'no Retry is left behind the closed dialog');
    assert.equal(kindNote('cli', ['send']), null);
    assert.equal(kindNote('mcp', ['read', 'draft']), null);
    assert.match(kindNote('mcp', ['send']) ?? '', /do nothing yet/);
  });

  test('the key file step shows the path, the one-time note and one filled button', () => {
    const markup = renderToStaticMarkup(
      createElement(AddToolDialog, {
        actions: harness({}).actions,
        failure: null,
        initialGranted: { name: 'Terminal assistant', path: PATH },
      }),
    );
    assert.match(markup, /Terminal assistant” is allowed/);
    assert.ok(markup.includes(PATH.replace(/ /g, ' ')), 'the path is shown');
    assert.match(markup, /Aplos never shows the key itself/);
    assert.match(markup, /shown once/);
    assert.match(markup, />Copy path</);
    assert.equal((markup.match(/data-variant="filled"/g) ?? []).length, 1);
  });

  test('the Add dialog and the Revoke question draw: one filled button, no key path, plain copy', () => {
    const add = renderToStaticMarkup(staticScreen(STATES['tool-add']));
    assert.match(add, /Add a tool/);
    assert.match(add, />Allow tool</);
    assert.match(add, /Read your mail and calendar/);
    assert.equal((add.match(/data-variant="filled"/g) ?? []).length, 1);
    assert.doesNotMatch(add, /!/);
    const revoke = renderToStaticMarkup(staticScreen(STATES['tool-revoke-confirm']));
    assert.match(revoke, /Revoke “Terminal assistant”\?/);
    assert.match(revoke, />Revoke</);
  });
});
