/**
 * The first-sync loading screen (DESIGN 7.12; onboarding-sync.html progress, paused, ready, partial, failed), the last
 * step of the onboarding window. Presentational: it draws a `FirstSyncView` from `model.ts` with the onboarding parts
 * and reports intent through callbacks. It binds no keys: Esc (always "Open Aplos" [F8]), Return and the drill's
 * letters reach it through the registry's `firstSync` and `drill` contexts (`firstSyncCommands` in the model). The
 * footer says "Esc opens Aplos" in every state, including the drill.
 */
import { useId } from 'react';
import type { Registry } from '../../commands';
import { Button } from '../../ui/buttons-keys';
import { OnboardingStep } from '../../ui/onboarding';
import type { StepButton } from '../../ui/props';
import { ProgressSegments } from '../../ui/status';
import { Text } from '../../ui/surfaces';
import { Drill } from './Drill';
import { DRILL_COPY, type DrillKey, type DrillState } from './drill.model';
import { CONTINUE_ANYWAY, type FirstSyncRow, type FirstSyncView } from './model';
import type { WindowNotice } from '../flow';
import { WindowNoticeLine } from '../WindowNotice';

export interface FirstSyncProps {
  readonly view: FirstSyncView;
  /** The drill's state while "Try the keys" is showing; null shows progress. */
  readonly drill: DrillState | null;
  /** Epoch ms (the practice letters' dates). */
  readonly now: number;
  /** The registry the drill's keycaps resolve against (the owner's remaps). */
  readonly registry?: Registry;
  /** Open Aplos: the filled button, "Continue anyway", Esc, and the clean-finish handoff. */
  readonly onOpen: () => void;
  /** Try again on one account (`Setup/retry`). */
  readonly onRetry: (accountId: string) => void;
  /** Reconnect one account (the reconnect sheet). */
  readonly onReconnect: (accountId: string) => void;
  /** "Open Settings" after a sorting failure; without it the button is not offered. */
  readonly onOpenSettings?: () => void;
  /** "Try the keys while you wait". */
  readonly onTryKeys: () => void;
  /** "Back to progress". */
  readonly onLeaveDrill: () => void;
  /** A drill key's pointer duplicate. */
  readonly onDrillKey: (key: DrillKey) => void;
  /** A practice row was clicked. */
  readonly onDrillPick: (index: number) => void;
  /** The window's failed handoff, drawn visibly with Try again (DESIGN 7.15). */
  readonly notice?: WindowNotice;
}

function AccountRow({
  row,
  accountCount,
  compact,
  onRetry,
  onReconnect,
  onOpenSettings,
}: {
  row: FirstSyncRow;
  /** How many accounts the screen shows; the colour dot only appears with two or more (DESIGN decision 16). */
  accountCount: number;
  compact: boolean;
  onRetry: (accountId: string) => void;
  onReconnect: (accountId: string) => void;
  onOpenSettings?: () => void;
}) {
  return (
    <div className="fs-account">
      <ProgressSegments
        variant="checkpoints"
        account={row.account}
        accountCount={accountCount}
        checkpoints={row.checkpoints}
        pausedUntil={row.pausedUntil}
        failure={row.failure}
        notConnected={row.notConnected}
        onRetry={row.action === 'retry' ? () => onRetry(row.accountId) : undefined}
        onOpenSettings={row.sortFailed ? onOpenSettings : undefined}
        compact={compact}
      />
      {row.action === 'reconnect' && !compact ? (
        <div className="fs-account__action">
          <Button
            variant="text"
            size="sm"
            icon="refresh"
            label="Reconnect"
            onPress={() => onReconnect(row.accountId)}
          />
        </div>
      ) : null}
    </div>
  );
}

export function FirstSync(props: FirstSyncProps) {
  const {
    view,
    drill,
    now,
    onOpen,
    onRetry,
    onReconnect,
    onOpenSettings,
    onTryKeys,
    onLeaveDrill,
  } = props;
  const titleId = `${useId()}-title`;

  const rowProps = { onRetry, onReconnect, onOpenSettings };

  if (drill) {
    const finished = drill.step >= 4;
    const leave: StepButton = finished
      ? {
          label: DRILL_COPY.leave,
          emphasis: 'filled',
          keys: 'Return',
          keyHint: 'always',
          onSelect: onLeaveDrill,
        }
      : { label: DRILL_COPY.leave, emphasis: 'text', onSelect: onLeaveDrill };
    return (
      <div className="fs" data-keyctx="firstSync" data-outcome={view.outcome} data-mode="drill">
        <OnboardingStep
          layout="step"
          title={view.title}
          titleId={titleId}
          footer={{ note: 'escOpensAplos', buttons: [leave] }}
          phaseStatus={props.notice?.text ?? view.announcement}
        >
          <div className="fs-rows" data-compact="true">
            {view.rows.map(row => (
              <AccountRow
                key={row.accountId}
                row={row}
                accountCount={view.rows.length}
                compact
                {...rowProps}
              />
            ))}
          </div>
          <Drill
            state={drill}
            now={now}
            registry={props.registry}
            onKey={props.onDrillKey}
            onPick={props.onDrillPick}
          />
          <WindowNoticeLine notice={props.notice} />
        </OnboardingStep>
      </div>
    );
  }

  const buttons: StepButton[] = [];
  if (view.continueAnyway)
    buttons.push({ label: CONTINUE_ANYWAY, emphasis: 'text', onSelect: onOpen });
  buttons.push({
    label: view.primary.label,
    emphasis: 'filled',
    keys: 'Return',
    keyHint: 'always',
    disabled: !view.primary.enabled,
    onSelect: onOpen,
  });

  return (
    <div className="fs" data-keyctx="firstSync" data-outcome={view.outcome}>
      <OnboardingStep
        layout="step"
        title={view.title}
        titleId={titleId}
        lede={view.outcome === 'ready' ? undefined : view.lede}
        footer={{ note: 'escOpensAplos', buttons }}
        phaseStatus={props.notice?.text ?? view.announcement}
      >
        {view.outcome === 'ready' ? (
          <div className="fs-rows">
            <ProgressSegments
              variant="ready"
              label="ready"
              accounts={view.rows.map(r => ({
                ...r.account,
                read: r.ready.read,
                sorted: r.ready.sorted,
              }))}
            />
            {/* The result comes first, then what happens next: the title keeps its place across states (DESIGN 7.11). */}
            <Text variant="lede">{view.lede}</Text>
          </div>
        ) : view.rows.length > 0 ? (
          <div className="fs-rows">
            {view.rows.map(row => (
              <AccountRow
                key={row.accountId}
                row={row}
                accountCount={view.rows.length}
                compact={false}
                {...rowProps}
              />
            ))}
          </div>
        ) : null}
        {view.offerDrill ? (
          <div className="fs-extra">
            <Button variant="text" icon="keyboard" label={DRILL_COPY.heading} onPress={onTryKeys} />
          </div>
        ) : null}
        <WindowNoticeLine notice={props.notice} />
      </OnboardingStep>
    </div>
  );
}
