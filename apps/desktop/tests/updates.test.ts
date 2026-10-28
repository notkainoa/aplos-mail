import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  UpdateController,
  checkIntervalMs,
  disabledReason,
  firstCheckMs,
  teamIdentifier,
  type Updater,
} from '../src/main/updates';
import type { UpdateInfo } from '@aplos/contract/legacy/types';

/** Stands in for electron-updater: each check runs the scripted events, like the real updater emits them. */
class FakeUpdater extends EventEmitter implements Updater {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  checks = 0;
  installs: unknown[][] = [];
  script: (updater: FakeUpdater) => Promise<void> | void = () => {};
  async checkForUpdates() {
    this.checks++;
    this.emit('checking-for-update');
    await this.script(this);
    return null;
  }
  quitAndInstall(...args: unknown[]) {
    this.installs.push(args);
  }
}

function setup(script: FakeUpdater['script']) {
  const updater = new FakeUpdater();
  updater.script = script;
  const seen: UpdateInfo[] = [];
  const logs: string[] = [];
  const timers: { fn: () => void; ms: number; repeat: boolean }[] = [];
  const controller = new UpdateController({
    currentVersion: '0.1.0',
    updater: () => updater,
    emit: info => seen.push(info),
    log: line => logs.push(line),
    now: () => new Date('2026-10-23T12:00:00Z'),
    timers: {
      setTimeout: (fn, ms) => timers.push({ fn, ms, repeat: false }),
      setInterval: (fn, ms) => timers.push({ fn, ms, repeat: true }),
      clear: () => {},
    },
  });
  return {
    updater,
    controller,
    seen,
    logs,
    timers,
    states: () => seen.map(info => info.status.state),
  };
}

test('an available update downloads silently and waits for the owner to restart', async () => {
  const { updater, controller, states } = setup(u => {
    u.emit('update-available', { version: '0.2.0' });
    u.emit('download-progress', { percent: 40.2 });
    u.emit('download-progress', { percent: 40.9 });
    u.emit('update-downloaded', { version: '0.2.0' });
  });
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, false);
  const info = await controller.check();
  assert.deepEqual(states(), ['checking', 'checking', 'downloading', 'downloading', 'ready']);
  assert.deepEqual(info.status, { state: 'ready', version: '0.2.0' });
  assert.equal(info.lastCheck, '2026-10-23T12:00:00.000Z');
  assert.equal(updater.installs.length, 0, 'never installs without the owner');
  assert.equal(controller.install(), true);
  assert.deepEqual(updater.installs, [[false, true]]);
});

test('Later hides the ready notice until a manual check', async () => {
  const { controller } = setup(u => {
    u.emit('update-available', { version: '0.2.0' });
    u.emit('update-downloaded', { version: '0.2.0' });
  });
  await controller.check();
  controller.later();
  assert.equal(controller.info().dismissed, true);
  assert.equal(controller.info().status.state, 'ready', 'the update stays downloaded');
  await controller.check();
  assert.equal(controller.info().dismissed, true, 'a scheduled check does not nag again');
  await controller.check(true);
  assert.equal(controller.info().dismissed, false);
});

test('no update reports current; failures report a short reason and keep a ready update', async () => {
  const current = setup(u => {
    u.emit('update-not-available', { version: '0.1.0' });
  });
  assert.equal((await current.controller.check()).status.state, 'current');

  const failing = setup(() => {
    throw new Error('net::ERR_INTERNET_DISCONNECTED\n<html>long body</html>');
  });
  const info = await failing.controller.check();
  assert.deepEqual(info.status, { state: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' });
  assert.ok(info.lastCheck);
  assert.ok(failing.logs.some(line => line.includes('ERR_INTERNET_DISCONNECTED')));

  let online = true;
  const later = setup(u => {
    if (!online) throw new Error('offline');
    u.emit('update-available', { version: '0.2.0' });
    u.emit('update-downloaded', { version: '0.2.0' });
  });
  await later.controller.check();
  online = false;
  assert.deepEqual((await later.controller.check()).status, { state: 'ready', version: '0.2.0' });
  assert.equal(later.controller.install(), true);
});

test('concurrent checks share one request and the schedule is a minute, then every six hours', async () => {
  const { updater, controller, timers } = setup(async u => {
    await new Promise(resolve => setTimeout(resolve, 5));
    u.emit('update-not-available', {});
  });
  await Promise.all([controller.check(), controller.check(true)]);
  assert.equal(updater.checks, 1);
  controller.start();
  assert.deepEqual(
    timers.map(t => [t.ms, t.repeat]),
    [
      [firstCheckMs, false],
      [checkIntervalMs, true],
    ],
  );
  assert.equal(firstCheckMs, 60_000);
  assert.equal(checkIntervalMs, 21_600_000);
});

test('disabled builds never create the updater and explain why', async () => {
  let created = false;
  const logs: string[] = [];
  const controller = new UpdateController({
    currentVersion: '0.1.0',
    disabled: 'Updates are off in development builds.',
    updater: () => {
      created = true;
      return new FakeUpdater();
    },
    emit: () => {},
    log: line => logs.push(line),
  });
  assert.equal(created, false);
  assert.deepEqual((await controller.check(true)).status, {
    state: 'disabled',
    reason: 'Updates are off in development builds.',
  });
  assert.equal(controller.install(), false);
  assert.match(logs[0], /updates disabled: Updates are off in development builds/);
});

test('disabled reasons: platform, development, mounted disk image, unsigned build', () => {
  const base = {
    platform: 'darwin',
    packaged: true,
    devFeed: false,
    bundlePath: '/Applications/Aplos Mail.app',
    teamId: () => 'ABCDE12345',
  };
  assert.equal(disabledReason(base), undefined);
  assert.match(disabledReason({ ...base, platform: 'linux' })!, /only available on macOS/);
  assert.match(disabledReason({ ...base, packaged: false })!, /development builds/);
  assert.equal(
    disabledReason({ ...base, packaged: false, devFeed: true }),
    undefined,
    'APLOS_UPDATE_DEV checks the local feed',
  );
  assert.match(
    disabledReason({ ...base, bundlePath: '/Volumes/Aplos Mail 0.2.0/Aplos Mail.app' })!,
    /Applications folder/,
  );
  assert.match(
    disabledReason({
      ...base,
      bundlePath: '/private/var/folders/x/AppTranslocation/1/d/Aplos Mail.app',
    })!,
    /Applications folder/,
  );
  assert.match(
    disabledReason({ ...base, teamId: () => undefined })!,
    /not signed with a Developer ID/,
  );
});

test('team identifier is read from codesign output; ad-hoc signatures have none', () => {
  assert.equal(
    teamIdentifier(
      'Executable=/A.app/Contents/MacOS/A\nAuthority=Developer ID Application: K N (ABCDE12345)\nTeamIdentifier=ABCDE12345\n',
    ),
    'ABCDE12345',
  );
  assert.equal(
    teamIdentifier('Executable=/A.app/Contents/MacOS/A\nSignature=adhoc\nTeamIdentifier=not set\n'),
    undefined,
  );
  assert.equal(teamIdentifier('/A.app: code object is not signed at all\n'), undefined);
});
