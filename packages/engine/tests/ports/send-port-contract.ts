import assert from 'node:assert/strict';
import test from 'node:test';
import type { AccountId } from '../../src/ports/base';
import type { SendPort } from '../../src/ports';

/**
 * The reusable `SendPort.findSent` contract (PR #105 follow-up; one Message-ID is never delivered twice).
 *
 * Why it exists: the outbox reuses a synced draft's Message-ID (`drafts.remote_internet_id`) for the submission, so
 * the unsent Gmail draft copy carries the SAME id as the message about to leave. `findSent` is documented as searching
 * Sent only. An adapter that searches everything (Gmail without `in:sent`, Graph falling back to `/me/messages`) would
 * find the unsent draft after a `drafts.send` timeout and the outbox would mark the row `sent` when nothing left.
 *
 * WHO MUST RUN IT (Providers): the Gmail adapter, the Microsoft adapter, and the Gmail emulator-backed fake server
 * (every adapter built over the provider's search, and every fake that stands in for one). Call it from a test file:
 *
 *   sendPortContract('gmail', () => gmailHarness());
 *
 * The harness gives the contract a `SendPort` plus two server-side controls it cannot get through the port: put a
 * message in Sent, and put a DRAFT with a given Message-ID in Drafts. The harness must write to the same store the
 * port searches (for an emulator: the emulator's message store, with the DRAFT label or Drafts folder for `keepDraft`,
 * and the SENT label or Sent folder for `deliver`). The fake in `tests/outbox/helpers.ts` is run against it by
 * `tests/outbox/send-port-fake.test.ts`.
 *
 * What it asserts of `findSent(account, internetId, since)`:
 *   1. a message that really went out (it is in Sent) is found;
 *   2. a message that exists only as a DRAFT is NOT found, even with the same Message-ID;
 *   3. another message's id does not match;
 *   4. `since` is honoured: a message that arrived long before `since` is not returned.
 * Case 4 uses a gap of days, not minutes: IMAP `SINCE` and Gmail `after:` have day granularity, and the outbox only
 * needs a bound that never hides a message newer than `since`.
 */

export interface SendPortHarness {
  port: SendPort;
  account: AccountId;
  /** The message really left: it is in Sent with this Message-ID, arrived at `at` (epoch ms). */
  deliver(internetId: string, at: number): void | Promise<void>;
  /** An unsent draft copy exists in Drafts with this Message-ID, saved at `at`. Never in Sent. */
  keepDraft(internetId: string, at: number): void | Promise<void>;
  /** Releases the server or emulator, if the harness started one. */
  close?(): void | Promise<void>;
}

const DAY = 86_400_000;
const AT = Date.UTC(2026, 9, 28, 9, 0, 0);
const ID = '<contract-sent-1@mail.example>';
const OTHER = '<contract-other-1@mail.example>';

async function inHarness(
  make: () => SendPortHarness | Promise<SendPortHarness>,
  fn: (h: SendPortHarness) => Promise<void>,
) {
  const harness = await make();
  try {
    await fn(harness);
  } finally {
    await harness.close?.();
  }
}

/** Registers the four `findSent` cases for `makeSendPort`; call once per adapter or fake, from a `*.test.ts` file. */
export function sendPortContract(
  name: string,
  makeSendPort: () => SendPortHarness | Promise<SendPortHarness>,
) {
  test(`${name}: findSent finds a message that really went out in Sent`, () =>
    inHarness(makeSendPort, async h => {
      await h.deliver(ID, AT);
      const found = await h.port.findSent(h.account, ID, AT - 5 * 60_000);
      assert.equal(found.kind, 'found');
    }));

  test(`${name}: findSent does NOT find a message that exists only as a draft, even with the same Message-ID`, () =>
    inHarness(makeSendPort, async h => {
      await h.keepDraft(ID, AT);
      const result = await h.port.findSent(h.account, ID, AT - 5 * 60_000);
      assert.equal(
        result.kind,
        'absent',
        'an unsent draft copy must never settle a submission as sent',
      );
    }));

  test(`${name}: findSent does not match another message's id`, () =>
    inHarness(makeSendPort, async h => {
      await h.deliver(OTHER, AT);
      const result = await h.port.findSent(h.account, ID, AT - 5 * 60_000);
      assert.equal(result.kind, 'absent');
    }));

  test(`${name}: findSent honours since (a message from days before it is not returned)`, () =>
    inHarness(makeSendPort, async h => {
      await h.deliver(ID, AT);
      const old = await h.port.findSent(h.account, ID, AT + 7 * DAY);
      assert.equal(old.kind, 'absent', 'arrived 7 days before since');
      const fresh = await h.port.findSent(h.account, ID, AT - 7 * DAY);
      assert.equal(fresh.kind, 'found', 'arrived after since');
    }));
}
