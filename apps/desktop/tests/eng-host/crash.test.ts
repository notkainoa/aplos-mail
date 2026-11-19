import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHeartbeatSupervisor,
  createLoopMonitor,
  startCrashReporting,
  SILENT_ACTOR_MS,
  type DelayHistogram,
} from '../../src/host/crash';

const timers = { every: () => 0, cancel: () => {} };

test('a silent actor restarts after 120 s, alone and once; a new beat re-arms it', () => {
  let now = 10_000;
  const beats = new Map<string, number>([
    ['quiet', 10_000],
    ['chatty', 10_000],
  ]);
  const restarted: string[] = [];
  const supervisor = createHeartbeatSupervisor({
    now: () => now,
    accounts: () => ['quiet', 'chatty'],
    lastHeartbeat: account => beats.get(account),
    restart: account => void restarted.push(account),
    timers,
  });
  supervisor.check();
  now += SILENT_ACTOR_MS - 1;
  beats.set('chatty', now);
  supervisor.check();
  assert.deepEqual(restarted, []);
  now += 1;
  supervisor.check();
  supervisor.check();
  now += 60_000;
  supervisor.check();
  assert.deepEqual(restarted, ['quiet']);
  beats.set('quiet', now);
  now += SILENT_ACTOR_MS;
  supervisor.check();
  assert.deepEqual(restarted, ['quiet', 'quiet', 'chatty']);
});

test('an actor that never beats counts as silent from when it was first seen', () => {
  let now = 0;
  const restarted: string[] = [];
  const supervisor = createHeartbeatSupervisor({
    now: () => now,
    accounts: () => ['new'],
    lastHeartbeat: () => undefined,
    restart: account => void restarted.push(account),
    timers,
  });
  supervisor.check();
  now = SILENT_ACTOR_MS - 1;
  supervisor.check();
  assert.deepEqual(restarted, []);
  now = SILENT_ACTOR_MS;
  supervisor.check();
  assert.deepEqual(restarted, ['new']);
});

test('the loop monitor logs one numbers-only line when p99 passes 500 ms', () => {
  let p99ms = 40;
  let sample = () => {};
  const lines: string[] = [];
  const histogram: DelayHistogram = {
    enable: () => {},
    disable: () => {},
    reset: () => {},
    percentile: () => p99ms * 1e6,
  };
  const monitor = createLoopMonitor({
    histogram,
    timers: { every: run => void (sample = run), cancel: () => {} },
    log: line => void lines.push(line),
  });
  monitor.start();
  sample();
  p99ms = 700;
  sample();
  assert.deepEqual(lines, ['main event loop delay p99 700 ms']);
});

test('the app is named before the crash reporter starts, and nothing is uploaded', () => {
  // Starting the reporter fixes userData from the app name at that moment.
  const calls: string[] = [];
  startCrashReporting(
    { setName: name => void calls.push(`setName ${name}`) },
    { start: options => void calls.push(`start upload=${options.uploadToServer}`) },
    'Aplos Mail',
  );
  assert.deepEqual(calls, ['setName Aplos Mail', 'start upload=false']);
});

test('the main lifecycle module starts the crash reporter only through startCrashReporting', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', '..', 'src', 'main', 'lifecycle.ts'),
    'utf8',
  );
  assert.match(source, /startCrashReporting\(app, crashReporter,/);
  assert.doesNotMatch(source, /crashReporter\.start\(/);
  assert.doesNotMatch(source, /app\.setName\(/);
  // The single-instance lock is the first thing that reads the app name; the name must already be set.
  assert.ok(
    source.indexOf('startCrashReporting(app') < source.indexOf('requestSingleInstanceLock()'),
  );
});
