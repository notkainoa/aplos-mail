/**
 * Pane: the white surface on the gray shell, the main pane and the Ask dock (DESIGN 2.2, 4.4, 4.6, 6, 7.1).
 * Inset by --shell-pad on top, right and bottom, radius 12, --elev-pane. The main pane has the structured
 * 48 px header: back or close plus a quiet crumb on the left; at most three icon tools, then Ask, then the
 * calendar button on the right, all 28 px controls as in the mockup; bulk selection replaces the left side; a
 * hairline only after content scrolls.
 */
import { useState, type UIEvent } from 'react';
import type { ComponentPropsMap, PaneHeaderProps } from '../props';
import { PartButton, formatCount } from './parts';

/** Registry ids for the header's fixed controls (DESIGN 7.1, 8). */
const ASK_COMMAND = 'ask.open';
const TODAY_COMMAND = 'nav.today';
const BULK_MORE_COMMAND = 'list.more';
const BULK_CLEAR_COMMAND = 'list.clearSelection';

function PaneHeader({ header, scrolled }: { header: PaneHeaderProps; scrolled: boolean }) {
  const { lead, crumb, tools = [], onTool, ask, today, bulk } = header;
  const crumbText = crumb && crumb.showSubject && crumb.subject ? crumb.subject : crumb?.label;
  const position = crumb?.position && !(crumb.showSubject && crumb.subject) ? crumb.position : null;
  const centred = position !== null && crumb?.centrePosition === true;
  return (
    <header className="ui-pane__head" data-scrolled={scrolled ? 'true' : undefined}>
      {bulk ? (
        <div
          className="ui-pane__bulk"
          role="group"
          aria-label={`${formatCount(bulk.count)} selected`}
        >
          <span className="ui-pane__bulk-count">{formatCount(bulk.count)} selected</span>
          {bulk.actions.map(action => (
            <PartButton
              key={action.label}
              variant="text"
              size="sm"
              label={action.label}
              icon={action.icon}
              commandId={action.commandId}
              keys={action.keys}
              keyHint="hint"
              onPress={() => action.onSelect()}
            />
          ))}
          <PartButton
            variant="icon"
            size="sm"
            icon="more"
            label="More"
            commandId={BULK_MORE_COMMAND}
            onPress={e => bulk.onMore(e.currentTarget)}
          />
          <PartButton
            variant="icon"
            size="sm"
            icon="close"
            label="Clear the selection"
            commandId={BULK_CLEAR_COMMAND}
            onPress={() => bulk.onClear()}
          />
        </div>
      ) : (
        <div className="ui-pane__lead">
          {lead ? (
            <PartButton
              variant="icon"
              size="sm"
              icon={lead.kind === 'back' ? 'chevron-left' : 'close'}
              label={lead.label}
              commandId={lead.commandId}
              onPress={() => lead.onPress()}
            />
          ) : null}
          {crumb ? (
            <span
              className="ui-pane__crumb"
              data-subject={crumb.showSubject && crumb.subject ? 'true' : undefined}
            >
              <span className="ui-pane__crumb-text">{crumbText}</span>
              {position && !centred ? (
                <span className="ui-pane__crumb-pos">
                  {formatCount(position.index)} of {formatCount(position.of)}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      )}
      {position && centred && !bulk ? (
        <span className="ui-pane__pos-centre">
          {formatCount(position.index)} of {formatCount(position.of)}
        </span>
      ) : null}
      <div className="ui-pane__tools">
        {tools.map(tool => (
          <PartButton
            key={tool.commandId}
            variant="icon"
            size="sm"
            icon={tool.icon}
            label={tool.label}
            detail={tool.detail}
            commandId={tool.commandId}
            pressed={tool.pressed}
            disabled={tool.disabled}
            onPress={e => onTool?.(tool.commandId, e.currentTarget)}
          />
        ))}
        <PartButton
          variant="icon"
          size="sm"
          icon="bubble"
          label="Ask"
          labelVisible
          tipLabel={ask.scope === 'thisEmail' ? 'Ask about this email' : 'Ask about your mail'}
          commandId={ASK_COMMAND}
          pressed={ask.pressed}
          onPress={() => ask.onPress()}
        />
        <PartButton
          variant="icon"
          size="sm"
          icon="today"
          label="Today"
          commandId={TODAY_COMMAND}
          pressed={today.pressed}
          tipPlacement="below"
          onPress={() => today.onPress()}
        />
      </div>
    </header>
  );
}

export function Pane(props: ComponentPropsMap['Pane']) {
  const [scrolled, setScrolled] = useState(false);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const next = event.currentTarget.scrollTop > 0;
    if (next !== scrolled) setScrolled(next);
  };
  if (props.kind === 'dock') {
    return (
      <section
        ref={props.ref}
        className="ui-pane"
        data-kind="dock"
        data-region="dock"
        aria-label={props.label}
      >
        {props.children}
      </section>
    );
  }
  return (
    <section
      ref={props.ref}
      className="ui-pane"
      data-kind="main"
      data-region="main"
      aria-label={props.label}
    >
      {props.header ? <PaneHeader header={props.header} scrolled={scrolled} /> : null}
      <div className="ui-pane__body" onScroll={props.header ? onScroll : undefined}>
        {props.children}
      </div>
    </section>
  );
}
