/** Settings → Help & about: the version, shortcuts, the welcome window, demo mail, diagnostics and the queue inspector (DESIGN 7.10; plan 30 section 4.5). */
import { Button } from '../../../ui/buttons-keys';
import { Switch } from '../../../ui/controls';
import { EmptyLine } from '../../../ui/list';
import { Group, NotAvailable, Row } from '../parts';
import {
  DATA_EXPORT_LINE,
  DATA_EXPORTED_LINE,
  demoControls,
  hasCapability,
  queueRows,
  verboseLine,
  verboseOn,
  versionLine,
} from '../settings.model';
import type { SectionProps } from './types';

export function Help(props: SectionProps) {
  const { data, view, actions, host } = props;
  if (view.queue) return <QueueInspector {...props} />;
  const demo = demoControls(data.accounts);
  return (
    <>
      <Group id="set-help-about" label="About">
        <Row section="help" anchor="version" description={versionLine(data.session)} />
        <Row
          section="help"
          anchor="shortcutSheet"
          description="Every key, always matching the keys you have set."
          control={
            <Button
              variant="text"
              label="Show shortcuts"
              disabled={!host.openShortcuts}
              onPress={() => host.openShortcuts?.()}
            />
          }
        />
        <Row
          section="help"
          anchor="showWelcome"
          description="Go through the welcome steps again. Your mail and settings stay as they are."
          control={
            <Button
              variant="text"
              label="Show welcome"
              disabled={!host.showWelcome}
              onPress={() => actions.showWelcome()}
            />
          }
        />
        {demo.helpAction === 'load' ? (
          <Row
            section="help"
            anchor="demoLoad"
            description="Sample mail and events, so you can try Aplos without an account."
            control={
              <Button
                variant="text"
                label="Load"
                busy={view.busy.demo === true}
                onPress={() => void actions.loadDemo()}
              />
            }
          />
        ) : null}
      </Group>

      <Group id="set-help-data" label="Your data">
        <Row
          section="help"
          anchor="exportData"
          description={view.dataExported ? DATA_EXPORTED_LINE : DATA_EXPORT_LINE}
          control={
            <Button
              variant="text"
              label="Export"
              busy={view.busy.dataExport === true}
              onPress={() => void actions.exportData()}
            />
          }
        />
      </Group>

      <Group id="set-help-support" label="Support">
        {hasCapability(data.session, 'diagnostics') ? (
          <Row
            section="help"
            anchor="diagnostics"
            description="A report with no mail in it. Preview it first."
            control={
              <Button
                variant="text"
                label="Preview"
                busy={view.busy.diagnostics === true}
                onPress={() => void actions.openDiagnostics()}
              />
            }
          />
        ) : (
          <NotAvailable section="help" anchor="diagnostics" />
        )}
        {hasCapability(data.session, 'diagnostics') ? (
          <Row
            section="help"
            anchor="verboseLogging"
            description={verboseLine(data.verbose, data.now)}
            control={id => (
              <Switch
                label="Verbose logging"
                labelledBy={id}
                checked={verboseOn(data.verbose, data.now)}
                onChange={on => void actions.setVerbose(on)}
              />
            )}
          />
        ) : (
          <NotAvailable section="help" anchor="verboseLogging" />
        )}
        {hasCapability(data.session, 'queueInspector') ? (
          <Row
            section="help"
            anchor="queue"
            description="Changes, AI jobs and messages that are waiting or stuck."
            control={<Button variant="text" label="Open" onPress={() => actions.openQueue()} />}
          />
        ) : (
          <NotAvailable section="help" anchor="queue" />
        )}
        <Row
          section="help"
          anchor="devDetails"
          description="Show model names, scores and other details on screen."
          control={id => (
            <Switch
              label="Developer details"
              labelledBy={id}
              checked={data.settings.ui.devDetails}
              onChange={on => void actions.setUi({ devDetails: on })}
            />
          )}
        />
      </Group>
    </>
  );
}

/** The queue inspector: what is waiting or stuck, with Retry and Discard. A message that is discarded stops a send, so it asks first. */
function QueueInspector({ data, actions }: SectionProps) {
  const rows = queueRows(data.queue);
  return (
    <div
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          actions.closeQueue();
        }
      }}
    >
      <Group id="set-help-queue" label="Queue">
        <div className="settings-back">
          <Button
            variant="text"
            size="sm"
            icon="chevron-left"
            label="Help & about"
            keys="Esc"
            keyHint="hint"
            onPress={() => actions.closeQueue()}
          />
        </div>
        {rows.length === 0 ? (
          <EmptyLine text="Nothing is waiting" />
        ) : (
          rows.map(r => (
            <Row
              key={r.id}
              section="help"
              anchor="queue"
              idSuffix={r.id}
              label={r.label}
              meta={r.kind}
              description={[r.state, r.detail, r.problem].filter(Boolean).join(' · ')}
              descriptionTone={r.problem ? 'attention' : 'default'}
              control={
                <>
                  {r.canRetry ? (
                    <Button
                      variant="text"
                      label="Retry"
                      onPress={() => void actions.retryQueueItem(r.id)}
                    />
                  ) : null}
                  {r.canDiscard ? (
                    <Button
                      variant="text"
                      label="Discard"
                      onPress={() => actions.askDiscardQueueItem(r.id, r.label, r.confirmDiscard)}
                    />
                  ) : null}
                </>
              }
            />
          ))
        )}
      </Group>
    </div>
  );
}
