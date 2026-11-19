/**
 * FatalScreen: the whole-pane fatal error (DESIGN 6, 7.15). Sans `display` "Aplos can't reach its mail engine."
 * and "Your mail is safe on this Mac.", then Restart engine (filled, Return) · Copy diagnostics. The parked engine
 * offers Try again · Export diagnostics. Never a stack trace, never an exclamation mark. While restarting the
 * primary is aria-disabled, not disabled, so the focus it holds is never dropped to the page.
 *
 * `kind: 'damaged'` is the damaged mail database (plan 10 Decision 6): the same calm pane says nothing was deleted,
 * lists what exists only on this Mac first, then offers Export report (filled, Return) · Restore backup · Rebuild from
 * Google. Restore and Rebuild ask once, naming what they cannot bring back.
 */
import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import type { ComponentPropsMap, DamagedDatabase } from '../props';
import { PartButton } from '../surfaces/parts';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The "Only on this Mac" lines: each count that is not zero, and one line when some could not be read. */
export function localOnlyLines(localOnly: DamagedDatabase['localOnly']): string[] {
  const { drafts, scheduled, workflow, changes } = localOnly;
  const lines: string[] = [];
  if (drafts)
    lines.push(plural(drafts, 'draft not yet saved to Google', 'drafts not yet saved to Google'));
  if (scheduled) lines.push(plural(scheduled, 'scheduled send', 'scheduled sends'));
  if (workflow)
    lines.push(
      plural(workflow, 'Done, Later or reminder choice', 'Done, Later and reminder choices'),
    );
  if (changes)
    lines.push(plural(changes, 'change not yet sent to Google', 'changes not yet sent to Google'));
  if ([drafts, scheduled, workflow, changes].includes(null))
    lines.push('Some of it could not be read. The report keeps what can be.');
  return lines;
}

const dateOf = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

function confirmLine(d: DamagedDatabase, hasLocal: boolean): string {
  if (d.confirm === 'restore')
    return `Aplos goes back to the copy from ${dateOf(d.backup?.at ?? 0)}. Mail since then downloads from Google again${hasLocal ? '; what is only on this Mac is kept in the report, not brought back' : ''}. Sends waiting in that copy are paused in the Outbox until you check them.`;
  return `Aplos starts over and you sign in to Google again; your mail downloads from there${hasLocal ? '. What is only on this Mac is kept in the report, not brought back' : ''}.`;
}

function Damaged({
  d,
  primary,
}: {
  d: DamagedDatabase;
  primary: RefObject<HTMLButtonElement | null>;
}) {
  const lines = localOnlyLines(d.localOnly);
  const busy = d.busy !== undefined;
  if (d.confirm)
    return (
      <>
        <p className="ui-fatal-screen__confirm">{confirmLine(d, lines.length > 0)}</p>
        <div className="ui-fatal-screen__actions">
          <PartButton
            buttonRef={primary}
            variant="filled"
            label={
              d.confirm === 'restore'
                ? busy
                  ? 'Restoring…'
                  : 'Restore backup'
                : busy
                  ? 'Rebuilding…'
                  : 'Rebuild from Google'
            }
            keys="Return"
            keyHint="always"
            softDisabled={busy}
            onPress={() => (d.confirm === 'restore' ? d.onRestore() : d.onRebuild())}
          />
          <PartButton
            variant="text"
            label="Cancel"
            softDisabled={busy}
            onPress={() => d.onCancel()}
          />
        </div>
      </>
    );
  return (
    <>
      <section className="ui-fatal-screen__local" aria-label="Only on this Mac">
        <h2 className="ui-fatal-screen__local-title">Only on this Mac</h2>
        {lines.length ? (
          <ul className="ui-fatal-screen__local-list">
            {lines.map(line => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="ui-fatal-screen__local-none">Nothing. All of your mail is on Google.</p>
        )}
      </section>
      <div className="ui-fatal-screen__actions">
        <PartButton
          buttonRef={primary}
          variant="filled"
          label={d.busy === 'export' ? 'Exporting…' : 'Export report'}
          keys="Return"
          keyHint="always"
          softDisabled={busy}
          onPress={() => d.onExport()}
        />
        {d.backup ? (
          <PartButton
            variant="text"
            label={`Restore backup from ${dateOf(d.backup.at)}`}
            softDisabled={busy}
            onPress={() => d.onRestore()}
          />
        ) : null}
        <PartButton
          variant="text"
          label="Rebuild from Google"
          softDisabled={busy}
          onPress={() => d.onRebuild()}
        />
      </div>
    </>
  );
}

export function FatalScreen({
  kind,
  damaged,
  restarting,
  onRestart,
  onDiagnostics,
}: ComponentPropsMap['FatalScreen']) {
  const primary = useRef<HTMLButtonElement | null>(null);
  const confirm = damaged?.confirm;
  const ready = damaged !== undefined;
  useEffect(() => {
    primary.current?.focus({ preventScroll: true });
  }, [confirm, ready]);

  const restartLabel = restarting
    ? 'Restarting…'
    : kind === 'parked'
      ? 'Try again'
      : 'Restart engine';
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.metaKey) return;
    if ((event.target as HTMLElement).closest('button')) return;
    if (kind === 'damaged') {
      if (!damaged || damaged.busy) return;
      event.preventDefault();
      if (damaged.confirm === 'restore') damaged.onRestore();
      else if (damaged.confirm === 'rebuild') damaged.onRebuild();
      else damaged.onExport();
      return;
    }
    if (restarting) return;
    event.preventDefault();
    onRestart();
  };

  if (kind === 'damaged')
    return (
      <div
        className="ui-fatal-screen"
        role="alert"
        data-kind={kind}
        data-state={damaged?.busy ? 'working' : 'idle'}
        onKeyDown={onKeyDown}
      >
        <h1 className="ui-fatal-screen__title">Aplos found a problem with its mail database.</h1>
        <p className="ui-fatal-screen__safe">
          Nothing was deleted. A copy of the damaged file is kept on this Mac.
        </p>
        {damaged ? <Damaged d={damaged} primary={primary} /> : null}
      </div>
    );

  return (
    <div
      className="ui-fatal-screen"
      role="alert"
      data-kind={kind}
      data-state={restarting ? 'restarting' : 'idle'}
      onKeyDown={onKeyDown}
    >
      <h1 className="ui-fatal-screen__title">Aplos can’t reach its mail engine.</h1>
      <p className="ui-fatal-screen__safe">Your mail is safe on this Mac.</p>
      <div className="ui-fatal-screen__actions">
        <PartButton
          buttonRef={primary}
          variant="filled"
          label={restartLabel}
          keys="Return"
          keyHint="always"
          softDisabled={restarting}
          onPress={() => onRestart()}
        />
        <PartButton
          variant="text"
          label={kind === 'parked' ? 'Export diagnostics' : 'Copy diagnostics'}
          onPress={() => onDiagnostics()}
        />
      </div>
    </div>
  );
}
