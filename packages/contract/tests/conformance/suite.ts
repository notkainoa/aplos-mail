import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { open, openSession, type Check, type Scenario, type SuiteTools } from './suite-helpers';
import type { ConformanceTarget } from './target';
import { envelopeSuite } from './suite-envelope';
import { sessionSuite } from './suite-session';
import { receiptsSuite } from './suite-receipts';
import { setupSuite } from './suite-setup';
import { sendSuite } from './suite-send';
import { accessSuite } from './suite-access';
import { aiSuite } from './suite-ai';
import { miscSuite } from './suite-misc';

/**
 * The conformance suite (plan 10 section 4.1): one set of assertions any `EngineConnection` must pass, the stand-in
 * engine at C1 and the real engine from day 4. Every test has a stable id; an engine's known gaps go in
 * `expected-fail.<name>.json`, and a listed test that starts passing fails the run until it is taken off the list.
 * This file and its helpers import only the contract: an assertion that needs an engine's internals does not belong here.
 */

export const expectedFailPath = (name: string) =>
  join(import.meta.dirname, `expected-fail.${name}.json`);
export function readExpectedFail(name: string): string[] {
  return JSON.parse(readFileSync(expectedFailPath(name), 'utf8')) as string[];
}

/** Every test id the suite registers, so an expected-fail list can be checked for stale names. */
export const testIds = new Set<string>();

/**
 * Registers the suite for one engine. `collect` only records the test ids (for the expected-fail checks) and runs nothing.
 */
export function conformance(
  target: ConformanceTarget,
  expectedFail: readonly string[] = readExpectedFail(target.name),
  { collect = false } = {},
) {
  const test = collect ? ((() => undefined) as unknown as typeof nodeTest) : nodeTest;
  const check: Check = (register, id, body) => {
    testIds.add(id);
    return register(id, async t => {
      const expected = expectedFail.includes(id);
      try {
        await body(t);
      } catch (error) {
        if (expected) {
          t.diagnostic(`expected failure on ${target.name}: ${(error as Error).message}`);
          return;
        }
        throw error;
      }
      if (expected)
        assert.fail(
          `${id} passes on ${target.name} now: remove it from expected-fail.${target.name}.json.`,
        );
    });
  };
  /** A test with its own engine. */
  const scenario: Scenario = (id, body, skip) =>
    check(
      (name, fn) => test(name, fn),
      id,
      async t => {
        const engine = await target.create();
        try {
          const why = skip?.(engine);
          if (why) {
            t.skip(why);
            return;
          }
          await body(engine, open(engine), t);
        } finally {
          await engine.close?.();
        }
      },
    );

  const tools: SuiteTools = { target, testIds, test, check, scenario, open, openSession };

  envelopeSuite(tools);
  sessionSuite(tools);
  receiptsSuite(tools);
  setupSuite(tools);
  sendSuite(tools);
  accessSuite(tools);
  aiSuite(tools);
  miscSuite(tools);
}
