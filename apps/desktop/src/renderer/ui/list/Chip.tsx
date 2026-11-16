// Chip (DESIGN §6 Chip, §4.1, §7.2, §7.3, §7.5, §7.15). Mockups: home.html, reader.html, later.html, search.html.
// Due, Later-until, label, attachment and operator chips: 24 px, radius 6, --raised; overdue on --stamp-tint
// with --stamp-ink and a clock so colour is never the only cue; pill only for operator tokens.

import type { CSSProperties } from 'react';
import type { ChipProps } from '../props';
import { Action } from './internal/Action';
import { formatBytes, formatDue, formatFull, formatLaterUntil } from './internal/format';
import { Icon } from './internal/Icon';

/** A due, Later-until, label, attachment or operator chip. */
export function Chip(props: ChipProps) {
  switch (props.kind) {
    case 'due': {
      const { due, format } = props;
      const found = due.source === 'ai';
      return (
        <span
          className="ui-chip"
          data-kind="due"
          data-overdue={due.overdue ? 'true' : undefined}
          data-source={due.source}
          title={found ? `${formatFull(due.at)} · from the email` : formatFull(due.at)}
        >
          <Icon name="clock" size="sm" />
          <span className="ui-chip__text">{formatDue(due.at, format)}</span>
        </span>
      );
    }
    case 'laterUntil': {
      const { until } = props;
      const overdue = until.kind === 'at' && until.overdue;
      return (
        <span
          className="ui-chip"
          data-kind="laterUntil"
          data-overdue={overdue ? 'true' : undefined}
          title={until.kind === 'at' ? formatFull(until.at) : undefined}
        >
          <Icon name="clock" size="sm" />
          <span className="ui-chip__text">
            {until.kind === 'someday' ? 'Someday' : formatLaterUntil(until.at)}
          </span>
        </span>
      );
    }
    case 'label': {
      const style = props.color
        ? ({ '--swatch': `var(--tag-${props.color})` } as CSSProperties)
        : undefined;
      return (
        <span className="ui-chip" data-kind="label" data-color={props.color} style={style}>
          <span className="ui-chip__text">{props.text}</span>
        </span>
      );
    }
    case 'attachment': {
      const { name, sizeBytes, state, icon, onOpen, onRetry } = props;
      const size = formatBytes(sizeBytes);
      return (
        <span className="ui-chip" data-kind="attachment" data-state={state}>
          <button
            type="button"
            className="ui-chip__open"
            title={state === 'failed' ? name : `Open ${name}`}
            aria-busy={state === 'downloading' ? true : undefined}
            onClick={onOpen}
          >
            <Icon name={state === 'failed' ? 'alert' : (icon ?? 'file-text')} />
            <span className="ui-chip__name">{name}</span>
            {state === 'ready' && size ? <span className="ui-chip__size">{size}</span> : null}
            {state === 'ready' ? <Icon name="download" size="sm" /> : null}
            {state === 'downloading' ? <span className="ui-chip__size">Downloading…</span> : null}
          </button>
          {state === 'failed' ? (
            <>
              <span className="ui-chip__error">Couldn’t download.</span>
              {onRetry ? (
                <Action
                  variant="text"
                  size="sm"
                  tone="danger"
                  label="Try again"
                  onPress={() => onRetry()}
                />
              ) : null}
            </>
          ) : null}
        </span>
      );
    }
    case 'operator': {
      const { operator, value, onRemove } = props;
      return (
        <span className="ui-chip" data-kind="operator">
          <span className="ui-chip__operator">{operator}:</span>
          <span className="ui-chip__text">{value}</span>
          <button
            type="button"
            className="ui-chip__remove"
            aria-label={`Remove ${operator}: ${value}`}
            title={`Remove ${operator}: ${value}`}
            onClick={onRemove}
          >
            <Icon name="close" size="xs" />
          </button>
        </span>
      );
    }
  }
}
