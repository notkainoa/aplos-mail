/**
 * ProgressSegments: first-sync progress by engine checkpoints, never a fake percentage (DESIGN 6, 7.12).
 * Neutral colours: done --ink-2, paused --dusk, failed --stamp. A count fills its segment to the real n of m and
 * the motion sits on the checklist marker, not the bar. Every bar is labelled "<address> sync"; one visually
 * hidden role="status" speaks phase changes only (`live="off"` drops it for a parent that owns the one `aria-live="polite" aria-atomic="false"` region). The same part draws "Importing N of M", the OAuth wait and
 * the ready check.
 */
import type { CSSProperties } from 'react';
import type {
  ComponentPropsMap,
  ErrorLineKind,
  ProgressSegment,
  ProgressSegmentsProps,
  SegmentState,
  SyncAccount,
  SyncCheckpoint,
} from '../props';
import { PartButton, PartIcon, formatCount, formatTime } from '../surfaces/parts';
import { SpinnerGlyph } from './Spinner';

type CheckpointsProps = Extract<ProgressSegmentsProps, { variant: 'checkpoints' }>;

/** DESIGN 7.15 / 7.12 wording for an inline failure. */
export function failureCopy(failure: ErrorLineKind): string {
  switch (failure.kind) {
    case 'writeRejected':
      return `Couldn’t ${failure.op}.`;
    case 'sendFailed':
      return `Couldn’t send to ${failure.recipient}. Your draft is saved.`;
    case 'bodyFailed':
      return 'Couldn’t load this email.';
    case 'listFailed':
      return 'Couldn’t load this list.';
    case 'askFailed':
      return `${failure.provider} didn’t answer.`;
    case 'consentNeeded':
      return 'Background summaries are paused until you agree to the new provider.';
    case 'keyRefused':
      return `${failure.provider} refused the saved key, so nothing was sent.`;
    case 'sortFailed': {
      const why =
        failure.cause === 'keyRefused'
          ? 'the key was refused'
          : failure.cause === 'unreachable'
            ? `${failure.provider} didn’t answer`
            : 'today’s AI limit is reached';
      return `Couldn’t sort with ${failure.provider}: ${why}. Mail is ready; sorting will retry.`;
    }
    case 'reason':
      return failure.text;
  }
}

/** The checklist line for one checkpoint (DESIGN 7.12). */
function lineFor(cp: SyncCheckpoint): string {
  switch (cp.step) {
    case 'connect':
      return cp.state === 'done' ? 'Connected' : cp.state === 'current' ? 'Connecting…' : 'Connect';
    case 'find':
      if (cp.state === 'done')
        return cp.estimate !== undefined
          ? `Found about ${formatCount(cp.estimate)} recent emails`
          : 'Found recent mail';
      return cp.state === 'current' ? 'Finding recent mail…' : 'Find recent mail';
    case 'read': {
      const count = `${formatCount(cp.read)} of ${formatCount(cp.of)}`;
      if (cp.state === 'done') return `Read your newest mail · ${count}`;
      if (cp.state === 'current') return `Reading your newest mail · ${count}`;
      if (cp.state === 'paused') return `Reading your newest mail · paused at ${count}`;
      if (cp.state === 'partial') return `Read ${count} of your newest mail`;
      return 'Read your newest mail';
    }
    case 'sort': {
      const count = `${formatCount(cp.sorted)} of ${formatCount(cp.of)}`;
      if (cp.state === 'done') return `Sorted ${count}`;
      if (cp.state === 'partial') return `Sorted ${count}. The rest continue in the background.`;
      if (cp.state === 'current') return `Sorting what matters · ${count}`;
      if (cp.state === 'paused') return `Sorting what matters · paused at ${count}`;
      return 'Sorting what matters';
    }
  }
}

/** Real progress inside a segment, 0–1, when the step reports a count. */
function fractionOf(cp: SyncCheckpoint): number | null {
  if (cp.step === 'read') return cp.of > 0 ? Math.min(1, cp.read / cp.of) : 0;
  if (cp.step === 'sort') return cp.of > 0 ? Math.min(1, cp.sorted / cp.of) : 0;
  // Connect and Find have no count to show: a quiet indeterminate bar while current.
  return null;
}

const MARKER: Record<SegmentState, 'check' | 'circle' | 'pause' | 'clock' | 'alert' | 'spin'> = {
  done: 'check',
  pending: 'circle',
  paused: 'pause',
  partial: 'clock',
  failed: 'alert',
  current: 'spin',
};

function Segment({ cp }: { cp: SyncCheckpoint }) {
  const fraction = fractionOf(cp);
  const filling = (cp.state === 'current' || cp.state === 'partial') && fraction !== null;
  const indeterminate = cp.state === 'current' && fraction === null;
  return (
    <i className="ui-progress-segments__seg" data-state={cp.state} data-step={cp.step}>
      {filling ? (
        <i
          className="ui-progress-segments__fill"
          style={{ '--fill': String(fraction) } as CSSProperties}
        />
      ) : null}
      {indeterminate ? <i className="ui-progress-segments__runner" /> : null}
    </i>
  );
}

function PlainSegment({ segment }: { segment: ProgressSegment }) {
  const fraction = segment.value === undefined ? null : Math.min(1, Math.max(0, segment.value));
  const filling = (segment.state === 'current' || segment.state === 'partial') && fraction !== null;
  const indeterminate = segment.state === 'current' && fraction === null;
  return (
    <i className="ui-progress-segments__seg" data-state={segment.state} title={segment.label}>
      {filling ? (
        <i
          className="ui-progress-segments__fill"
          style={{ '--fill': String(fraction) } as CSSProperties}
        />
      ) : null}
      {indeterminate ? <i className="ui-progress-segments__runner" /> : null}
    </i>
  );
}

function Dot({ color }: { color: SyncAccount['color'] }) {
  return <i className="ui-progress-segments__dot" data-color={color} aria-hidden="true" />;
}

function checkpointsStatus(p: CheckpointsProps): string {
  const { checkpoints } = p;
  if (p.notConnected) return 'Not connected';
  if (checkpoints.some(cp => cp.state === 'failed')) return 'Stopped';
  if (checkpoints.some(cp => cp.state === 'paused'))
    return p.pausedUntil ? `Paused until ${formatTime(p.pausedUntil)}` : 'Paused';
  const current = checkpoints.find(cp => cp.state === 'current');
  if (current) {
    if (current.step === 'read')
      return `Reading ${formatCount(current.read)} of ${formatCount(current.of)}`;
    if (current.step === 'sort') return 'Sorting';
    return current.step === 'find' ? 'Finding mail' : 'Connecting';
  }
  if (checkpoints.some(cp => cp.state === 'partial')) return 'Sorting continues';
  if (checkpoints.length > 0 && checkpoints.every(cp => cp.state === 'done')) return 'Ready';
  return '';
}

/** Phase only (connected, found, ready, stopped); unchanged while counts tick, so the live region stays quiet. */
function phaseOf(p: CheckpointsProps): string {
  const { address } = p.account;
  const { checkpoints } = p;
  if (p.notConnected || checkpoints.some(cp => cp.state === 'failed'))
    return `${address} sync stopped.`;
  if (
    checkpoints.length > 0 &&
    checkpoints.every(cp => cp.state === 'done' || cp.state === 'partial')
  )
    return `${address} is ready.`;
  if (checkpoints.some(cp => cp.state === 'paused')) return `${address} sync paused.`;
  if (checkpoints.some(cp => cp.step === 'find' && cp.state === 'done'))
    return `${address}: found recent mail.`;
  if (checkpoints.some(cp => cp.step === 'connect' && cp.state === 'done'))
    return `${address} connected.`;
  return '';
}

/** Phase only for the plain segments variant: stopped, paused or finished; empty while it simply works. */
function segmentsPhase(label: string, segments: readonly ProgressSegment[]): string {
  if (segments.some(s => s.state === 'failed')) return `${label} stopped.`;
  if (segments.some(s => s.state === 'paused')) return `${label} paused.`;
  if (segments.length > 0 && segments.every(s => s.state === 'done' || s.state === 'partial'))
    return `${label} finished.`;
  return '';
}

function Checkpoints(p: CheckpointsProps) {
  const {
    account,
    checkpoints,
    failure,
    notConnected,
    onRetry,
    onOpenSettings,
    compact,
    accountCount = 1,
    live = 'polite',
  } = p;
  const failed = notConnected || checkpoints.some(cp => cp.state === 'failed');
  const status = checkpointsStatus(p);
  const current = checkpoints.find(
    cp => cp.state === 'current' || cp.state === 'paused' || cp.state === 'failed',
  );
  const valuetext = current
    ? current.state === 'failed' && failure
      ? failureCopy(failure)
      : lineFor(current)
    : status;
  const lines = notConnected ? [] : checkpoints;
  return (
    <div
      className="ui-progress-segments"
      data-variant="checkpoints"
      data-state={failed ? 'failed' : status === 'Ready' ? 'ready' : 'working'}
      data-compact={compact ? 'true' : undefined}
    >
      <div className="ui-progress-segments__top">
        {accountCount >= 2 ? <Dot color={account.color} /> : null}
        <span className="ui-progress-segments__address">{account.address}</span>
        {failed && onRetry ? (
          <span className="ui-progress-segments__retry">
            {notConnected ? <span className="ui-progress-segments__status">{status}</span> : null}
            <PartButton variant="text" size="sm" label="Try again" onPress={() => onRetry()} />
          </span>
        ) : (
          <span className="ui-progress-segments__status">{status}</span>
        )}
      </div>
      <div
        className="ui-progress-segments__bar"
        role="progressbar"
        aria-label={`${account.address} sync`}
        aria-valuetext={valuetext || undefined}
      >
        {checkpoints.map(cp => (
          <Segment key={cp.step} cp={cp} />
        ))}
      </div>
      {compact || lines.length === 0 ? null : (
        <ul className="ui-progress-segments__checklist">
          {lines.map(cp => {
            const text = cp.state === 'failed' && failure ? failureCopy(failure) : lineFor(cp);
            const marker = MARKER[cp.state];
            return (
              <li key={cp.step} className="ui-progress-segments__line" data-state={cp.state}>
                <span className="ui-progress-segments__marker">
                  {marker === 'spin' ? <SpinnerGlyph /> : <PartIcon name={marker} />}
                </span>
                <span className="ui-progress-segments__text">{text}</span>
                {cp.state === 'failed' && failure?.kind === 'sortFailed' && onOpenSettings ? (
                  <PartButton
                    variant="text"
                    size="sm"
                    label="Open Settings"
                    onPress={() => onOpenSettings()}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {failure && !checkpoints.some(cp => cp.state === 'failed') && !compact ? (
        <p className="ui-progress-segments__failure">
          <PartIcon name="alert" />
          <span>{failureCopy(failure)}</span>
          {failure.kind === 'sortFailed' && onOpenSettings ? (
            <PartButton
              variant="text"
              size="sm"
              label="Open Settings"
              onPress={() => onOpenSettings()}
            />
          ) : null}
        </p>
      ) : null}
      <span className="ui-sr-only" role={live === 'off' ? undefined : 'status'}>
        {phaseOf(p)}
      </span>
    </div>
  );
}

export function ProgressSegments(props: ComponentPropsMap['ProgressSegments']) {
  if (props.variant === 'checkpoints') return <Checkpoints {...props} />;

  if (props.variant === 'importing') {
    const { account, done, of } = props;
    const fraction = of > 0 ? Math.min(1, done / of) : 0;
    return (
      <div className="ui-progress-segments" data-variant="importing">
        <span className="ui-progress-segments__importing">
          Importing <b>{formatCount(done)}</b> of {formatCount(of)}
        </span>
        <div
          className="ui-progress-segments__track"
          role="progressbar"
          aria-label={`${account.address} sync`}
          aria-valuemin={0}
          aria-valuemax={of}
          aria-valuenow={Math.min(done, of)}
          aria-valuetext={`Importing ${formatCount(done)} of ${formatCount(of)}`}
        >
          <i
            className="ui-progress-segments__fill"
            style={{ '--fill': String(fraction) } as CSSProperties}
          />
        </div>
      </div>
    );
  }

  if (props.variant === 'segments') {
    const current = props.segments.find(
      s => s.state === 'current' || s.state === 'paused' || s.state === 'failed',
    );
    return (
      <div className="ui-progress-segments" data-variant="segments">
        <div
          className="ui-progress-segments__bar"
          role="progressbar"
          aria-label={props.label}
          aria-valuetext={current?.label}
        >
          {props.segments.map(s => (
            <PlainSegment key={s.label} segment={s} />
          ))}
        </div>
        <span className="ui-sr-only" role={props.live === 'off' ? undefined : 'status'}>
          {segmentsPhase(props.label, props.segments)}
        </span>
      </div>
    );
  }

  if (props.variant === 'waiting') {
    return (
      <div className="ui-progress-segments" data-variant="waiting">
        <div className="ui-progress-segments__track" role="progressbar" aria-label={props.label}>
          <i className="ui-progress-segments__runner" />
        </div>
      </div>
    );
  }

  const label = props.label === 'ready' ? 'Your mail is ready' : 'Account connected';
  return (
    <div className="ui-progress-segments" data-variant="ready">
      <svg
        className="ui-progress-segments__check"
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M5 12.5l4.5 4.5L19 7.5" pathLength="1" />
      </svg>
      <p
        className="ui-progress-segments__ready-label"
        role={props.live === 'off' ? undefined : 'status'}
      >
        {label}
      </p>
      {props.accounts && props.accounts.length > 0 ? (
        <ul className="ui-progress-segments__accounts">
          {props.accounts.map(a => (
            <li key={a.address} className="ui-progress-segments__account">
              {(props.accounts?.length ?? 0) >= 2 ? <Dot color={a.color} /> : null}
              <span className="ui-progress-segments__address">{a.address}</span>
              <span className="ui-progress-segments__status">
                {`Newest ${formatCount(a.read)} read`}
                {a.sorted
                  ? ` · sorted ${formatCount(a.sorted.done)} of ${formatCount(a.sorted.of)}`
                  : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
