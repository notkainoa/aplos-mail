/**
 * The `api` object of the data layer: each member forwards to the F2 client's method of the same name, minting the
 * `opId` or `requestId` a screen left out. `act`, `undo` and `command` come from the layer, which owns the overlay.
 */
import type { Receipt, OpId } from './contract-shapes';
import type { DataClient } from './client';
import type { ActResult, DataApi, ThreadActArgs, UndoArgs } from './index';

/** Sends a write through the layer's operation record and undo stack (see `command` in layer.ts). */
export type CommandRunner = <A extends { opId?: OpId }, R>(
  args: A,
  send: (args: A & { opId: OpId }) => Promise<R>,
  receiptOf: (result: R) => Receipt,
) => Promise<R>;

export interface ApiParts {
  readonly client: DataClient;
  readonly mint: (prefix: string) => string;
  readonly act: (args: ThreadActArgs) => ActResult;
  readonly undo: (args: UndoArgs) => ActResult;
  readonly command: CommandRunner;
}

export function buildApi({ client, mint, act, undo, command }: ApiParts): DataApi {
  const c = client.api;
  const op = <A extends { opId?: string }>(args: A) => ({ ...args, opId: args.opId ?? mint('op') });
  const req = <A extends { requestId?: string }>(args: A) => ({
    ...args,
    requestId: args.requestId ?? mint('req'),
  });
  return {
    thread: { act, why: args => c.thread.why(args), open: args => c.thread.open(args) },
    operation: { undo, retry: args => c.operation.retry(args) },
    submission: { set: args => c.submission.set(op(args) as never) },
    draft: {
      set: args => c.draft.set(op(args) as never),
      destroy: args => c.draft.destroy(op(args) as never),
      resolve: args => c.draft.resolve(op(args) as never),
    },
    messageBody: {
      get: args => c.messageBody.get(args),
      prefetch: args => c.messageBody.prefetch(args),
    },
    mail: {
      frame: args => c.mail.frame(args),
      release: args => c.mail.release(args),
      toggleQuotes: args => c.mail.toggleQuotes(args),
      allowImages: args => c.mail.allowImages(op(args) as never),
    },
    attachment: { get: args => c.attachment.get(args) },
    blob: {
      put: (args, transfer) => c.blob.put(args, transfer),
      get: args => c.blob.get(args),
      release: args => c.blob.release(args),
    },
    sync: { request: args => c.sync.request(args) },
    account: {
      discover: args => c.account.discover(args),
      disconnect: args =>
        command(
          args,
          a => c.account.disconnect(a),
          receipt => receipt,
        ),
      lease: args => c.account.lease(args),
      connect: args => c.account.connect(args),
      reconnect: args => c.account.reconnect(args),
      grantPermissions: args => c.account.grantPermissions(args),
      cancelConnect: args => c.account.cancelConnect(args),
      set: args => c.account.set(op(args) as never),
    },
    setup: {
      begin: args => c.setup.begin(args),
      end: args => c.setup.end(args),
      retry: args => c.setup.retry(args),
    },
    demo: {
      load: args => c.demo.load(args),
      reset: args => c.demo.reset(args),
      remove: args => c.demo.remove(args),
    },
    settings: {
      get: args => c.settings.get(args),
      set: args => c.settings.set(op(args) as never),
    },
    ask: {
      run: args => c.ask.run(args),
      cancel: args => c.ask.cancel(args),
      decide: args =>
        command(
          args,
          a => c.ask.decide(a),
          result => result.receipt,
        ),
      suggestions: args => c.ask.suggestions(args),
    },
    conversation: {
      destroy: args =>
        command(
          args,
          a => c.conversation.destroy(a),
          receipt => receipt,
        ),
    },
    calendar: {
      get: args => c.calendar.get(args),
      set: args =>
        command(
          args,
          a => c.calendar.set(a),
          result => result.receipt,
        ),
    },
    event: {
      set: args =>
        command(
          args,
          a => c.event.set(a),
          result => result.receipt,
        ),
      hide: args =>
        command(
          args,
          a => c.event.hide(a),
          receipt => receipt,
        ),
      rsvp: args =>
        command(
          args,
          a => c.event.rsvp(a),
          receipt => receipt,
        ),
    },
    plan: {
      confirm: args =>
        command(
          args,
          a => c.plan.confirm(a),
          result => result.receipt,
        ),
      dismiss: args =>
        command(
          args,
          a => c.plan.dismiss(a),
          receipt => receipt,
        ),
    },
    listener: { get: args => c.listener.get(args), set: args => c.listener.set(args) },
    clients: {
      list: args => c.clients.list(args),
      grant: args => c.clients.grant(args),
      revoke: args => c.clients.revoke(args),
      audit: args => c.clients.audit(args),
    },
    queue: {
      list: args => c.queue.list(args),
      retry: args => c.queue.retry(args),
      discard: args => c.queue.discard(args),
    },
    window: {
      openOnboarding: args => c.window.openOnboarding(args),
      finishOnboarding: args => c.window.finishOnboarding(args),
      closeReady: args => c.window.closeReady(args),
      closeCancel: args => c.window.closeCancel(args),
    },
    update: {
      status: args => c.update.status(args),
      check: args => c.update.check(args),
      restart: args => c.update.restart(args),
      later: args => c.update.later(args),
    },
    system: {
      login: args => c.system.login(args),
      defaultMail: args => c.system.defaultMail(args),
      microphone: args => c.system.microphone(args),
      notifications: args => c.system.notifications(args),
      openSettings: args => c.system.openSettings(args),
    },
    shell: { open: args => c.shell.open(args) },
    notification: { test: args => c.notification.test(args) },
    search: { remote: args => c.search.remote(op(args) as never) },
    ai: {
      providers: args => c.ai.providers(args),
      models: args => c.ai.models(args),
      status: args => c.ai.status(args),
      usage: args => c.ai.usage(args),
      setKey: args => c.ai.setKey(args),
      removeKey: args => c.ai.removeKey(args),
      testKey: args => c.ai.testKey(args),
      request: args => c.ai.request(op(args) as never),
      draft: args => c.ai.draft(req(args) as never),
      polish: args => c.ai.polish(req(args) as never),
      transcribe: args => c.ai.transcribe(req(args) as never),
      followup: args => c.ai.followup(args),
      dismissFollowup: args => c.ai.dismissFollowup(op(args) as never),
      cancel: args => c.ai.cancel(args),
    },
    unsubscribe: { run: args => c.unsubscribe.run(op(args) as never) },
    consent: {
      get: args => c.consent.get(args),
      grant: args => c.consent.grant(args),
      revoke: args => c.consent.revoke(args),
    },
    engine: {
      restart: args => c.engine.restart(args),
      recover: args => c.engine.recover(args),
    },
    diagnostics: {
      preview: args => c.diagnostics.preview(args),
      copy: args => c.diagnostics.copy(args),
      export: args => c.diagnostics.export(args),
      verbose: args => c.diagnostics.verbose(args),
    },
    contact: { suggest: args => c.contact.suggest(args) },
    data: { export: args => c.data.export(args) },
    workflow: {
      status: args => c.workflow.status(args),
      enable: args => c.workflow.enable(args),
      code: args => c.workflow.code(args),
      disable: args => c.workflow.disable(args),
    },
    file: { save: args => c.file.save(args) },
  };
}
