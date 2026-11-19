import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/mini';
import {
  Account,
  ContractError,
  Counts,
  Draft,
  Event,
  Frame,
  Message,
  parseArgs,
  Session,
  Settings,
  SettingsPatch,
  SetupStatus,
  Submission,
  ThreadRow,
  checkResult,
} from '../src/index';
import * as f from './fixtures';

/** Parse, cross the wire as JSON (what HTTP and the socket do) and as a structured clone (MessagePort), parse again: nothing may change. */
function roundTrip<T>(schema: z.ZodMiniType<T>, value: T) {
  const first = schema.parse(value);
  assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(first))), first);
  assert.deepEqual(schema.parse(structuredClone(first)), first);
  assert.deepEqual(first, value, 'no schema transforms or defaults change data');
}

test('every domain type survives JSON and structured-clone round trips unchanged', () => {
  roundTrip(Session, f.session);
  roundTrip(Account, f.account);
  roundTrip(ThreadRow, f.thread);
  roundTrip(Message, f.message);
  roundTrip(Draft, f.draft);
  roundTrip(Submission, f.submission);
  roundTrip(Event, f.event);
  roundTrip(Settings, f.settings);
  roundTrip(SetupStatus, f.setupStatus);
  roundTrip(Counts, f.counts);
  for (const frame of f.frames) roundTrip(Frame, frame);
});

test('binary arguments stay bytes and survive a structured clone, never base64', () => {
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const args = parseArgs('Blob/put', { bytes, mime: 'audio/webm' });
  assert.ok(args.bytes instanceof Uint8Array);
  assert.deepEqual([...structuredClone(args).bytes], [0, 1, 2, 255]);
  assert.throws(
    () => parseArgs('Blob/put', { bytes: 'AAEC/w==', mime: 'audio/webm' }),
    ContractError,
  );
});

/** Today's validators' sentences reach the UI unchanged (plan 10 E1 item 3). */
test("validation failures carry today's human sentences and the field path", () => {
  const failure = (method: Parameters<typeof parseArgs>[0], args: unknown) => {
    try {
      parseArgs(method, args);
    } catch (error) {
      assert.ok(error instanceof ContractError);
      return { message: error.message, path: error.body.path, type: error.type };
    }
    assert.fail(`${method} accepted ${JSON.stringify(args)}`);
  };
  assert.deepEqual(
    failure('Settings/set', { opId: 'o1', patch: { mail: { undoSendSeconds: 61 } } }),
    {
      message: 'Undo send must be between 0 and 60 seconds.',
      path: ['patch', 'mail', 'undoSendSeconds'],
      type: 'validation',
    },
  );
  assert.equal(
    failure('Settings/set', {
      opId: 'o1',
      patch: { ai: { providers: { custom: { address: 'not a url' } } } },
    }).message,
    'Enter the server address, e.g. http://localhost:11434/v1.',
  );
  assert.equal(
    failure('Settings/set', {
      opId: 'o1',
      patch: { ai: { providers: { custom: { address: 'http://me:pw@localhost:1234' } } } },
    }).message,
    'Use an http or https address without a password in it.',
  );
  assert.equal(
    failure('Settings/set', {
      opId: 'o1',
      patch: {
        ai: {
          features: { ...f.settings.ai.features, voice: { provider: 'anthropic', model: 'x' } },
        },
      },
    }).message,
    'Choose a Voice model on Groq or ChatGPT.',
  );
  assert.equal(
    failure('Settings/set', { opId: 'o1', patch: { ui: { theme: 'sepia' } } }).message,
    'Invalid option.',
  );
  assert.equal(
    failure('Settings/set', { opId: 'o1', patch: { ui: { zen: 'yes' } } }).message,
    'Invalid checkbox value.',
  );
  assert.equal(
    failure('Thread/act', {
      opId: 'o1',
      ids: ['a1:t1'],
      action: { type: 'due', date: '2026-02-30' },
    }).message,
    'Enter a valid due date.',
  );
  assert.equal(failure('Ask/run', { question: '   ' }).message, 'Write a question first.');
  assert.equal(
    failure('Account/discover', { address: 'nobody' }).message,
    'Enter a valid email address.',
  );
  assert.equal(
    failure('Event/set', {
      opId: 'o1',
      change: {
        type: 'create',
        calendarId: 'c1',
        fields: {
          title: ' ',
          start: { type: 'date', date: '2026-10-28' },
          end: { type: 'date', date: '2026-10-29' },
          allDay: true,
        },
      },
    }).message,
    'Give the event a title.',
  );
  assert.equal(
    failure('Draft/set', {
      opId: 'o1',
      fields: {
        ...f.draft,
        attachments: Array.from({ length: 31 }, (_, i) => ({
          id: `x${i}`,
          name: 'a',
          mime: 'text/plain',
          size: 1,
        })),
      },
    }).message,
    'Attach at most 30 files.',
  );
  assert.equal(failure('Thread/get', 'not an object').message, 'Expected an object.');
  assert.equal(
    failure('Account/connect', { provider: 'google', secret: 'a\nb' }).message,
    'Passwords and tokens cannot contain line breaks.',
  );
});

test('inputs strip unknown fields instead of failing, so a newer client can talk to an older engine within v1', () => {
  const args = parseArgs('Thread/act', {
    opId: 'o1',
    ids: ['a1:t1'],
    action: { type: 'done', extra: 1 },
    future: true,
  });
  assert.deepEqual(args, { opId: 'o1', ids: ['a1:t1'], action: { type: 'done' } });
});

test('open enums accept values a newer engine may add; closed input enums refuse them', () => {
  assert.equal(
    ThreadRow.parse({ ...f.thread, rank: { ...f.thread.rank, lane: 'someday' } }).rank.lane,
    'someday',
  );
  assert.throws(
    () =>
      parseArgs('Thread/act', {
        opId: 'o1',
        ids: ['a1:t1'],
        action: { type: 'lane', lane: 'someday' },
      }),
    ContractError,
  );
});

test('a settings patch is partial per section', () => {
  assert.deepEqual(SettingsPatch.parse({ mail: { undoSendSeconds: 10 } }), {
    mail: { undoSendSeconds: 10 },
  });
  assert.throws(() => SettingsPatch.parse({ mail: { undoSendSeconds: 10.5 } }));
});

test('checkResult catches a host answering outside its schema', () => {
  assert.deepEqual(checkResult('Session/get', f.session), f.session);
  assert.throws(
    () => checkResult('Session/get', { ...f.session, apiVersion: 'one' }),
    /Session\/get returned a result outside its schema/,
  );
});

/** The gaps closed for the UI threads (GAPS.md). */
test('Thread/act takes ids or a selector at the state the owner saw, never both or neither', () => {
  const selector = { spec: { kind: 'home' }, section: 'fromLater', atState: f.state };
  assert.deepEqual(
    parseArgs('Thread/act', { opId: 'o1', selector, action: { type: 'later' } }).selector,
    selector,
  );
  assert.equal(
    parseArgs('Thread/act', {
      opId: 'o1',
      ids: ['a1:t1'],
      action: { type: 'lane', lane: 'do', alsoForSender: true },
    }).action.type,
    'lane',
  );
  for (const args of [
    { opId: 'o1', action: { type: 'done' } },
    { opId: 'o1', ids: [], action: { type: 'done' } },
    { opId: 'o1', ids: ['a1:t1'], selector, action: { type: 'done' } },
  ]) {
    assert.throws(
      () => parseArgs('Thread/act', args),
      (e: ContractError) => e.message === 'Choose at least one conversation.',
    );
  }
});

test('new methods validate their arguments and answers', () => {
  assert.deepEqual(parseArgs('MessageBody/prefetch', { threadIds: ['a1:t1', 'a1:t2'] }), {
    threadIds: ['a1:t1', 'a1:t2'],
  });
  assert.throws(() => parseArgs('MessageBody/prefetch', {}), ContractError);
  assert.equal(
    parseArgs('Mail/allowImages', { opId: 'o1', sender: '@news.example', allow: true }).sender,
    '@news.example',
  );
  assert.throws(
    () => parseArgs('Mail/allowImages', { opId: 'o1', sender: 'news', allow: true }),
    (e: ContractError) => e.message === 'Enter a valid email address.',
  );
  assert.deepEqual(parseArgs('Setup/retry', { accountId: 'a1' }), { accountId: 'a1' });
  const why = {
    threadId: 'a1:t1',
    sentence: 'Jordan asked you a question.',
    quote: 'Which one do you prefer?',
    lane: 'do',
    rankSource: 'ai',
  };
  assert.deepEqual(checkResult('Thread/why', why), why);
  assert.deepEqual(parseArgs('System/openSettings', { pane: 'microphone' }), {
    pane: 'microphone',
  });
  assert.deepEqual(checkResult('Diagnostics/copy', { source: 'host' }), { source: 'host' });
});

test('no key characters ever leave a key method or the provider table', () => {
  assert.deepEqual(checkResult('Ai/setKey', { keySource: 'keychain', last4: 'wxyz' }), {
    keySource: 'keychain',
  });
  assert.deepEqual(checkResult('Ai/pasteKey', { keySource: 'keychain', last4: 'wxyz' }), {
    keySource: 'keychain',
  });
});

test("Settings.ui holds UI-core's frozen fields with their documented shapes", () => {
  const patch = SettingsPatch.parse({
    ui: {
      keymap: { 'mail.done': [{ chord: 'y' }] },
      palette: { recents: ['mail.later'] },
      calendar: { weekStart: 1 },
      sidebarMinimised: true,
    },
  });
  assert.deepEqual(patch.ui?.calendar, { weekStart: 1 });
  assert.throws(() => SettingsPatch.parse({ ui: { keymap: { 'mail.done': 'y' } } }));
  assert.throws(() => SettingsPatch.parse({ ui: { holdMs: 0 } }));
  assert.throws(() => SettingsPatch.parse({ ui: { calendar: { weekStart: 7 } } }));
  assert.equal(Settings.parse(f.settings).ui.holdMs, 250);
});

test('Window/finishOnboarding takes an optional destination, additive: no input still parses, only settings.ai is named', () => {
  assert.deepEqual(parseArgs('Window/finishOnboarding', {}), {});
  assert.deepEqual(parseArgs('Window/finishOnboarding', { to: 'settings.ai' }), {
    to: 'settings.ai',
  });
  assert.throws(() => parseArgs('Window/finishOnboarding', { to: 'inbox' }));
});
