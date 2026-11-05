import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { printableMessage, RunnerError } from './errors';
import { clientFromEnv, refreshAccessToken, TokenRefusal, withBearer } from './auth';
import {
  defaultEvidenceDir,
  writeEvidence,
  type EvidenceResult,
  type RunEvidence,
  type SkipReason,
} from './evidence';
import {
  createGuardedFetch,
  GuardRefusal,
  mergeRequests,
  readOnlyViolations,
  requestsSince,
  type GuardedFetch,
} from './guard';
import { createPacedFetch, UnitPacer } from './pacer';
import { createProbeState, defaultStateDir } from './state';
import { PROBES, probesFor } from './probes';
import { gitRevision, type Revision } from './revision';
import { acquireRunLock } from './run-lock';
import {
  emptyResult,
  TIERS,
  type LiveProvider,
  type ProbeContext,
  type ProbeResult,
  type RequestCount,
  type SmokeProbe,
  type Tier,
} from './types';
import {
  addressMatches,
  keychainReader,
  loadAccounts,
  preflight,
  reconnectBy,
  vaultDir,
  type AccountMeta,
  type Preflight,
  type SecretReader,
} from './vault';

/**
 * The live-provider runner (plan 20 section 5.4): checks HEAD against --expect-sha, loads the agent
 * test account from the vault, checks that its token will outlive the run by a day, takes the
 * one-run lock, proves the token is the signed-in account's, builds the guarded fetch, runs the
 * probes of one tier and writes the content-free evidence file outside the repository. Tier S
 * (sending to others) does not exist here.
 */

/** Every tier runs only on the agent test account, never on another vault label. */
const AGENT_ACCOUNT = 'agent';
const FULL_SHA = /^[0-9a-f]{40}$/;
const PHASE_NAME = /^[a-z]{1,20}$/;
/** A generous guess per probe plus slack; a token that would expire inside this window is skipped. */
const EXPECTED_MS_PER_PROBE = 2 * 60_000;
const EXPECTED_SLACK_MS = 60_000;

export interface RunArgs {
  provider: LiveProvider;
  tier: Tier;
  account: string;
  dryRun: boolean;
  /** Required for tiers M and S-self. */
  confirmMutating: boolean;
  /** The commit the run must be made from; the command line requires it for every real run. */
  expectSha?: string;
  /** `--phase <name>`: a fixed word for a probe that runs in steps across runs (never free text). */
  phase?: string;
}

export interface RunDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  readSecret: SecretReader;
  now(): number;
  sleep?(ms: number): Promise<void>;
  /** Monotonic milliseconds for timings. */
  clock?(): number;
  log(line: string): void;
  /** Where the evidence file goes. Default: `defaultEvidenceDir(<date>)`, outside the repository. */
  evidenceDir?: string;
  /** Where phased probes keep their state. Default: `defaultStateDir()`, outside the repository. */
  stateDir?: string;
  probes: readonly SmokeProbe[];
  /** HEAD and whether the working tree is clean; needed when `expectSha` is set. */
  revision?(): Promise<Revision>;
}

export interface RunOutcome {
  exitCode: number;
  evidencePath?: string;
  results: ProbeResult[];
  skipped?: SkipReason;
}

export function parseArgs(argv: string[]): RunArgs {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const tier = value('--tier');
  if (tier === 'S')
    throw new RunnerError('Tier S (sending to other people) does not exist in this runner');
  if (!TIERS.includes(tier as Tier)) throw new RunnerError('--tier must be R, M or S-self');
  const provider = value('--provider');
  if (provider !== 'gmail' && provider !== 'gcal')
    throw new RunnerError('--provider must be gmail or gcal');
  const account = value('--account');
  if (!account) throw new RunnerError('--account is required');
  const dryRun = argv.includes('--dry-run');
  const expectSha = value('--expect-sha');
  if (expectSha !== undefined && !FULL_SHA.test(expectSha))
    throw new RunnerError('--expect-sha must be the full 40-character commit SHA');
  if (!dryRun && expectSha === undefined)
    throw new RunnerError('--expect-sha <commit> is required: a live run names the code it runs');
  const phase = value('--phase');
  if (phase !== undefined && !PHASE_NAME.test(phase))
    throw new RunnerError('--phase must be a short lowercase word');
  return {
    provider,
    tier: tier as Tier,
    account,
    dryRun,
    confirmMutating: argv.includes('--confirm-mutating'),
    ...(expectSha ? { expectSha } : {}),
    ...(phase ? { phase } : {}),
  };
}

/** The tier and account gates, checked before anything is read. */
function checkRunAllowed(args: RunArgs): void {
  if (args.account !== AGENT_ACCOUNT)
    throw new RunnerError(`Tier ${args.tier} runs only on the agent test account`);
  if (args.tier !== 'R' && !args.confirmMutating && !args.dryRun)
    throw new RunnerError(`Tier ${args.tier} changes the mailbox: add --confirm-mutating`);
}

/** With --expect-sha, HEAD must be that commit and the tree clean. Returns the checked SHA. */
async function checkedCommit(args: RunArgs, deps: RunDeps): Promise<string | undefined> {
  if (args.expectSha === undefined) return undefined;
  if (!FULL_SHA.test(args.expectSha))
    throw new RunnerError('--expect-sha must be the full 40-character commit SHA');
  const revision = await (deps.revision ?? gitRevision)();
  if (revision.head !== args.expectSha)
    throw new RunnerError('HEAD is not the commit named by --expect-sha; nothing was run');
  if (!revision.clean)
    throw new RunnerError('The working tree has changes; commit or remove them, then run again');
  return revision.head;
}

/** Loads the vault account the run targets, failing closed when it is missing or mismatched. */
async function accountFor(
  args: RunArgs,
  env: Record<string, string | undefined>,
): Promise<AccountMeta> {
  const accounts = await loadAccounts(vaultDir(env));
  const account = accounts[args.account];
  if (!account)
    throw new RunnerError(`No test account "${args.account}" in the vault; sign it in first`);
  if (account.provider !== args.provider)
    throw new RunnerError(`Test account "${args.account}" is not a ${args.provider} account`);
  return account;
}

/** Runs one probe against the guarded fetch; keeps only content-free counts, timings and classes. */
async function runOneProbe(
  probe: SmokeProbe,
  ctx: ProbeContext,
  pacer: UnitPacer,
  guards: readonly GuardedFetch[],
  sentBefore: RequestCount[],
): Promise<EvidenceResult> {
  const mark = pacer.mark();
  let result: ProbeResult;
  try {
    result = await probe.run(ctx);
  } catch (error) {
    // Only the class of the failure is kept; messages could carry content.
    const errorClass = error instanceof GuardRefusal ? 'guard' : 'other';
    result = {
      status: 'fail',
      counts: {},
      timingsMs: {},
      errorClasses: { [errorClass]: 1 },
      requests: [],
      unitsPerMinute: [],
    };
  }
  return {
    id: probe.id,
    ...result,
    requests: requestsSince(sentBefore, mergeRequests(...guards.map(g => g.requests()))),
    unitsPerMinute: pacer.series(mark),
  };
}

/**
 * The signed-in account's own address, read with a tier R request before any probe, in every tier.
 * It must hash to the one stored at sign-in: the token could belong to another account (the owner's
 * main one, say), and then nothing is read or changed. Sends are checked against it.
 */
async function checkedSelfAddress(
  bootstrap: GuardedFetch,
  account: AccountMeta,
  label: string,
): Promise<string> {
  const profile = await bootstrap(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress',
  );
  const self = ((await profile.json().catch(() => ({}))) as { emailAddress?: unknown })
    .emailAddress;
  if (!profile.ok || typeof self !== 'string')
    throw new RunnerError('Could not read the account profile');
  if (!addressMatches(account, self))
    throw new RunnerError(
      `The signed-in account does not match test account ${label}; nothing was changed`,
    );
  return self;
}

/** What the locked part of a run needs from the checks before it. */
interface RunPlan {
  args: RunArgs;
  deps: RunDeps;
  account: AccountMeta;
  probes: readonly SmokeProbe[];
  evidenceDir: string;
  evidenceBase: Omit<RunEvidence, 'results' | 'unitsPerMinute' | 'peakUnitsPerWindow'>;
  probeIds: string[];
}

/** Every tier needs the stored account check: the token could belong to another account. */
function requireAccountCheck(account: AccountMeta, label: string, tier: Tier): void {
  if (account.addressHash === undefined || account.addressSalt === undefined)
    throw new RunnerError(
      `Test account ${label} has no stored account check; sign it in again before tier ${tier}`,
    );
}

function logDryRun(plan: RunPlan, check: Preflight): RunOutcome {
  const { args, deps, account, probes } = plan;
  deps.log(`Plan: ${args.provider} tier ${args.tier} on test account ${args.account}`);
  deps.log(
    `Probes: ${probes.length ? probes.map(probe => probe.id).join(', ') : 'none registered'}`,
  );
  deps.log(
    `Token reconnect by ${new Date(reconnectBy(account)).toISOString().slice(0, 10)} (${check.daysLeft} days left)`,
  );
  deps.log(check.ok ? 'Preflight: ok' : `Preflight: would skip, ${check.message}`);
  deps.log('Dry run: nothing was read from the keychain and no request was made.');
  return { exitCode: 0, results: [] };
}

/** Writes a skip for every probe of the run, with the reason, and says why in plain words. */
async function skipRun(plan: RunPlan, reason: SkipReason, message: string): Promise<RunOutcome> {
  plan.deps.log(message);
  const results: EvidenceResult[] = plan.probes.map(probe => ({
    ...emptyResult('skip'),
    id: probe.id,
  }));
  const evidencePath = await writeEvidence(
    plan.evidenceDir,
    {
      ...plan.evidenceBase,
      skipReason: reason,
      results,
      unitsPerMinute: [],
      peakUnitsPerWindow: 0,
    },
    plan.probeIds,
  );
  return { exitCode: 0, evidencePath, results, skipped: reason };
}

export async function runLive(args: RunArgs, deps: RunDeps): Promise<RunOutcome> {
  checkRunAllowed(args);
  const commit = await checkedCommit(args, deps);
  const account = await accountFor(args, deps.env);
  requireAccountCheck(account, args.account, args.tier);

  // `--phase` names a step of a probe that has phases; it must not also authorise the tier's other probes.
  const probes = probesFor(args.provider, args.tier, deps.probes).filter(
    probe => args.phase === undefined || probe.phased === true,
  );
  const expectedRunMs = probes.length * EXPECTED_MS_PER_PROBE + EXPECTED_SLACK_MS;
  const started = deps.now();
  const check = preflight(account, args.account, expectedRunMs, started);
  const startedAt = new Date(started).toISOString();
  const date = startedAt.slice(0, 10);
  const plan: RunPlan = {
    args,
    deps,
    account,
    probes,
    evidenceDir: deps.evidenceDir ?? defaultEvidenceDir(date),
    evidenceBase: {
      provider: args.provider,
      tier: args.tier,
      date,
      startedAt,
      node: process.versions.node,
      daysToExpiry: check.daysLeft,
      ...(commit ? { commit } : {}),
    },
    probeIds: deps.probes.map(probe => probe.id),
  };

  if (args.dryRun) return logDryRun(plan, check);
  if (!check.ok) return skipRun(plan, 'token-expiry', check.message);
  if (!probes.length) {
    deps.log(`No probes are registered for ${args.provider} tier ${args.tier}.`);
    return { exitCode: 0, results: [], skipped: 'no-probes' };
  }

  // One run at a time on this Mac, so two runners cannot double the unit budget between them.
  const lock = await acquireRunLock(vaultDir(deps.env));
  try {
    return await runLocked(plan);
  } finally {
    await lock.release();
  }
}

/** The part of a run that makes requests. Runs only while the run lock is held. */
async function runLocked(plan: RunPlan): Promise<RunOutcome> {
  const { args, deps, account, probes } = plan;
  // One pipeline: probe -> guard -> pacer -> bearer -> network. The guard is the only fetch a probe gets.
  let accessToken = '';
  const pacer = new UnitPacer({ now: deps.now, sleep: deps.sleep });
  // Run-scoped calendar writes are tier M only (orchestrator decision 2026-10-28).
  const runId = `run-${randomUUID()}`;
  const pipeline = (guardTier: Tier, selfAddress?: string): GuardedFetch =>
    createGuardedFetch(
      createPacedFetch(
        withBearer(deps.fetch, () => accessToken),
        pacer,
      ),
      {
        tier: guardTier,
        selfAddress,
        ...(guardTier === 'M' ? { calendarRunId: runId } : {}),
      },
    );

  const bootstrap = pipeline('R');
  try {
    accessToken = await refreshAccessToken(
      bootstrap,
      clientFromEnv(deps.env),
      await deps.readSecret(account.keychainService),
    );
  } catch (error) {
    if (error instanceof TokenRefusal && error.code === 'invalid_grant') {
      return skipRun(
        plan,
        'token-refused',
        `test account ${args.account} was refused by Google, reconnect it first`,
      );
    }
    throw error;
  }

  // Every tier, tier R included, first proves the token belongs to the account that signed in.
  const self = await checkedSelfAddress(bootstrap, account, args.account);
  const guard = args.tier === 'R' ? bootstrap : pipeline(args.tier, self);
  const guards = guard === bootstrap ? [bootstrap] : [bootstrap, guard];

  const clock = deps.clock ?? (() => performance.now());
  // Frozen: one probe cannot swap the fetch (or anything else) the probes after it get.
  const contextFor = (probe: SmokeProbe): ProbeContext =>
    Object.freeze({
      fetch: guard,
      tier: args.tier,
      now: clock,
      runId,
      ...(args.phase ? { phase: args.phase } : {}),
      // Only a probe that runs in phases gets a state file, and only its own.
      ...(probe.phased
        ? { state: createProbeState(deps.stateDir ?? defaultStateDir(), probe.id) }
        : {}),
    });
  const results: EvidenceResult[] = [];
  for (const probe of probes) {
    const sentBefore = mergeRequests(...guards.map(g => g.requests()));
    results.push(await runOneProbe(probe, contextFor(probe), pacer, guards, sentBefore));
  }

  // Defence in depth for tier R: even if the guard had a hole, a write in the log fails the run.
  if (
    args.tier === 'R' &&
    readOnlyViolations(mergeRequests(...guards.map(g => g.requests()))).length
  ) {
    for (const result of results) result.status = 'fail';
  }

  const evidencePath = await writeEvidence(
    plan.evidenceDir,
    {
      ...plan.evidenceBase,
      results,
      unitsPerMinute: pacer.series(),
      peakUnitsPerWindow: pacer.peakWindow(),
    },
    plan.probeIds,
  );
  for (const result of results) deps.log(`${result.id}: ${result.status}`);
  deps.log(`Evidence: ${evidencePath}`);
  return {
    exitCode: results.some(result => result.status === 'fail') ? 1 : 0,
    evidencePath,
    results,
  };
}

/** Ctrl-C and kill end the process through 'exit', so the run lock is released on the way out. */
function exitOnSignals(): void {
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitOnSignals();
  try {
    const outcome = await runLive(parseArgs(process.argv.slice(2)), {
      env: process.env,
      fetch,
      readSecret: keychainReader,
      now: Date.now,
      log: line => console.log(line),
      probes: PROBES,
    });
    process.exitCode = outcome.exitCode;
  } catch (error) {
    console.error(printableMessage(error, 'Run failed'));
    process.exitCode = 1;
  }
}
