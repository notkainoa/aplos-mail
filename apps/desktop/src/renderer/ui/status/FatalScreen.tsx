/**
 * FatalScreen: the whole-pane fatal error (DESIGN 6, 7.15). Sans `display` "Aplos can't reach its mail engine."
 * and "Your mail is safe on this Mac.", then Restart engine (filled, Return) · Copy diagnostics. The parked engine
 * offers Try again · Export diagnostics. Never a stack trace, never an exclamation mark. While restarting the
 * primary is aria-disabled, not disabled, so the focus it holds is never dropped to the page.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { ComponentPropsMap } from '../props';
import { PartButton } from '../surfaces/parts';

export function FatalScreen({
  kind,
  restarting,
  onRestart,
  onDiagnostics,
}: ComponentPropsMap['FatalScreen']) {
  const primary = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    primary.current?.focus({ preventScroll: true });
  }, []);

  const restartLabel = restarting
    ? 'Restarting…'
    : kind === 'parked'
      ? 'Try again'
      : 'Restart engine';
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.metaKey || restarting)
      return;
    if ((event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    onRestart();
  };

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
