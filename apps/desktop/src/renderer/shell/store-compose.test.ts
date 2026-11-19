import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAppRegistry, DEFAULT_KEY_PREFS, type CommandContext } from '../commands';
import { navigate } from './index';
import { closeCompose, getComposeRequest, openCompose } from './store-compose';
import { getScreen } from './store-route';
import { shellRegistryFor } from './ShellRegistry';

afterEach(() => {
  navigate('home');
});

test('openCompose shows the compose screen and remembers where it came from; closing goes back', () => {
  navigate('drafts');
  openCompose({ draftId: 'd1' });
  assert.deepEqual(getScreen(), { label: 'compose' });
  const request = getComposeRequest();
  assert.equal(request?.draftId, 'd1');
  assert.equal(request?.from, 'drafts');
  closeCompose();
  assert.equal(getScreen(), 'drafts');
  assert.equal(getComposeRequest(), null, 'cleared on leave');
});

test('any other screen clears the request, and closing from elsewhere does nothing', () => {
  openCompose({});
  assert.notEqual(getComposeRequest(), null);
  navigate('later');
  assert.equal(getComposeRequest(), null);
  closeCompose();
  assert.equal(getScreen(), 'later');
});

test('a bare open while the page shows keeps it; a draft or a reply replaces it', () => {
  navigate('sent');
  openCompose({});
  const first = getComposeRequest();
  openCompose({});
  assert.equal(getComposeRequest(), first, 'C on the compose page does not reset it');
  openCompose({ replyTo: { threadId: 't1', messageId: 'm1' } });
  assert.equal(getComposeRequest()?.from, 'sent', 'the way back is kept');
  assert.equal(getComposeRequest()?.replyTo?.messageId, 'm1');
});

test('C resolves to mail.compose and opens the compose route on every screen', () => {
  const registry = createAppRegistry();
  shellRegistryFor(registry);
  const context: CommandContext = {
    stack: ['global'],
    target: null,
    selection: [],
    conditions: {},
    prefs: DEFAULT_KEY_PREFS,
    focus: 'none',
  };
  navigate('later');
  const resolution = registry.resolve(
    { key: 'c', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
    context,
  );
  assert.equal(resolution?.commandId, 'mail.compose');
  assert.equal(registry.run('mail.compose', context).status, 'ran');
  assert.deepEqual(getScreen(), { label: 'compose' });
  assert.equal(getComposeRequest()?.from, 'later');
});

test('a forward opens the compose page from the screen it was asked on, and a second forward replaces the first', () => {
  navigate('home');
  openCompose({ forward: { threadId: 't1' } });
  assert.deepEqual(getScreen(), { label: 'compose' });
  const first = getComposeRequest();
  assert.equal(first?.forward?.threadId, 't1');
  assert.equal(first?.from, 'home');
  openCompose({ forward: { threadId: 't2' } });
  assert.equal(
    getComposeRequest()?.forward?.threadId,
    't2',
    'F on another thread starts a new page',
  );
  assert.equal(getComposeRequest()?.from, 'home', 'the way back is kept');
});
