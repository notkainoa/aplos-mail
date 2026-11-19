import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createClient,
  routeByHost,
  type EngineConnection,
  type EngineSession,
} from '../src/client/index';
import { ContractError, fromReply, parseArgs, toReply, type Frame } from '../src/index';
import * as f from './fixtures';

/** A fake engine behind the `EngineConnection` interface: answers through real reply envelopes and pushes frames. */
function fakeEngine(answers: Record<string, unknown>) {
  const calls: { method: string; args: unknown }[] = [];
  const listeners = new Set<(frame: Frame) => void>();
  let closed = false;
  const connection: EngineConnection = {
    connect: (): EngineSession => ({
      async call(method, args) {
        calls.push({ method, args });
        const outcome =
          method in answers
            ? { result: answers[method] }
            : {
                error: new ContractError({
                  type: 'notImplemented',
                  message: 'This part of Aplos is not built yet.',
                }),
              };
        return fromReply(JSON.parse(JSON.stringify(toReply(calls.length, outcome))));
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        closed = true;
      },
    }),
  };
  return {
    connection,
    calls,
    push: (frame: Frame) => listeners.forEach(l => l(frame)),
    isClosed: () => closed,
  };
}

test('api.<type>.<verb> calls the registry method and returns its typed result', async () => {
  const engine = fakeEngine({
    'Session/get': f.session,
    'Thread/act': { opId: 'o1', appliedState: f.state },
  });
  const { api } = createClient(engine.connection.connect());
  const session = await api.session.get();
  assert.equal(session.hasAccounts, true);
  const receipt = await api.thread.act({
    opId: 'o1',
    ids: ['a1:t1'],
    action: { type: 'later', until: f.session.now + 3_600_000 },
  });
  assert.deepEqual(receipt.appliedState, f.state);
  assert.deepEqual(
    engine.calls.map(c => c.method),
    ['Session/get', 'Thread/act'],
  );
  assert.deepEqual(engine.calls[0]!.args, {});
});

test("a failed call rejects with the host's ContractError, type and sentence intact", async () => {
  const { api } = createClient(fakeEngine({}).connection.connect());
  await assert.rejects(
    api.mail.frame({ messageId: 'a1:m1', imagePolicy: 'block' }),
    (error: unknown) =>
      error instanceof ContractError &&
      error.type === 'notImplemented' &&
      error.message === 'This part of Aplos is not built yet.',
  );
});

test('unknown methods are refused before they leave, and validation runs when asked', async () => {
  const engine = fakeEngine({});
  const client = createClient(engine.connection.connect(), {
    validate: (method, args) => parseArgs(method, args),
  });
  await assert.rejects(
    (client.api as unknown as { thread: { explode(): Promise<unknown> } }).thread.explode(),
    (e: unknown) => e instanceof ContractError && e.type === 'unsupported',
  );
  await assert.rejects(
    client.call('Settings/set', { opId: 'o1', patch: { mail: { undoSendSeconds: 99 } } }),
    /Undo send must be between 0 and 60 seconds\./,
  );
  assert.equal(engine.calls.length, 0);
});

test('frames reach subscribers and close reaches the session', () => {
  const engine = fakeEngine({});
  const client = createClient(engine.connection.connect());
  const seen: string[] = [];
  const stop = client.subscribe(frame => seen.push(frame.frame));
  for (const frame of f.frames) engine.push(frame);
  stop();
  engine.push(f.frames[0]!);
  assert.deepEqual(
    seen,
    f.frames.map(frame => frame.frame),
  );
  client.close();
  assert.ok(engine.isClosed());
});

test('routeByHost sends desktop methods to main and the rest to the engine', async () => {
  const main = fakeEngine({ 'File/save': { canceled: true } }),
    engine = fakeEngine({
      'Attachment/get': { blobId: 'b1', name: 'layouts.pdf', mime: 'application/pdf', size: 1 },
    });
  const { api } = createClient(
    routeByHost({ engine: engine.connection.connect(), desktop: main.connection.connect() }),
  );
  const blob = await api.attachment.get({ messageId: 'a1:m1', attachmentId: 'p1' });
  await api.file.save({ blobId: blob.blobId, name: blob.name });
  assert.deepEqual(
    engine.calls.map(c => c.method),
    ['Attachment/get'],
  );
  assert.deepEqual(
    main.calls.map(c => c.method),
    ['File/save'],
  );
});

test("routeByHost merges main's desktop frames into the one stream, so the engine being down still reaches the window", () => {
  const main = fakeEngine({}),
    engine = fakeEngine({});
  const session = routeByHost({
    engine: engine.connection.connect(),
    desktop: main.connection.connect(),
  });
  const seen: string[] = [];
  const stop = session.subscribe(frame =>
    seen.push(frame.frame === 'desktop' ? `desktop:${frame.event.type}` : frame.frame),
  );
  main.push({ frame: 'desktop', event: { type: 'engine', state: 'unreachable', at: 1 } });
  engine.push(f.frames[0]!);
  stop();
  main.push({ frame: 'desktop', event: { type: 'shown' } });
  assert.deepEqual(seen, ['desktop:engine', 'state']);
});

/** Compile-time only: the client's types come from the registry, so a wrong call fails `npm run typecheck`. */
export function typeChecks(api: ReturnType<typeof createClient>['api']) {
  // @ts-expect-error an unknown verb
  void api.thread.explode;
  // @ts-expect-error `opId` is required
  void api.thread.act({ ids: ['a1:t1'], action: { type: 'done' } });
  // @ts-expect-error a closed input enum
  void api.thread.act({ opId: 'o1', ids: ['a1:t1'], action: { type: 'archive' } });
  void api.session.get();
  void api.ai.pasteKey({ provider: 'groq' }).then(result => result.keySource);
}
