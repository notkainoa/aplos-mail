import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import type { ChoiceRowProps, KeySource } from '../props';
import { OnbIcon } from './icons';

/** A provider's key source as a second line; the variable is mono, key characters are never passed in. */
function keySourceLine(source: KeySource): ReactNode {
  switch (source.kind) {
    case 'environment':
      return (
        <>
          Key found in the environment as <code>{source.variable}</code>
        </>
      );
    case 'keychain':
      return 'Saved in Keychain';
    case 'none':
      return (
        <>
          No key yet · reads <code>{source.variable}</code>
        </>
      );
    case 'local':
      return 'On this Mac · no key needed';
  }
}

/**
 * A quiet onboarding row: a provider to go on with ("Google ›"), a found provider, a connected account, an AI
 * provider radio, a permission (DESIGN 7.11). Hairlines between rows, no box; the row is 48 px, taller when it has a
 * second line. 'link' is one button that goes on, 'radio' is one of a radiogroup the step provides, 'static' is
 * information with an optional trailing control. A status word always comes with an icon or text, never colour alone.
 */
export function ChoiceRow({
  id,
  role,
  label,
  icon,
  mark,
  tag,
  detail,
  keySource,
  detailDot,
  status,
  control,
  selected,
  onPress,
}: ChoiceRowProps) {
  const labelId = `${id}-label`;
  const detailId = `${id}-detail`;
  const second: ReactNode = keySource ? keySourceLine(keySource) : detail;
  const hasSecond = second !== undefined && second !== null && second !== '';

  const lead: ReactNode = mark ? (
    <span className="ui-choice-row__mark" aria-hidden="true" style={{ '--swatch': `var(--tag-${mark})` } as CSSProperties} />
  ) : icon ? (
    <span className="ui-choice-row__icon">
      <OnbIcon name={icon} />
    </span>
  ) : null;

  const text = (
    <span className="ui-choice-row__stack">
      <span className="ui-choice-row__line">
        <span className="ui-choice-row__name" id={labelId} dir="auto">
          {label}
        </span>
        {tag ? <span className="ui-choice-row__tag">{tag}</span> : null}
      </span>
      {hasSecond ? (
        <span className="ui-choice-row__detail" id={detailId}>
          {detailDot ? <i className="ui-choice-row__dot" data-state={detailDot} aria-hidden="true" /> : null}
          <span>{second}</span>
        </span>
      ) : null}
    </span>
  );

  const end = (
    <>
      {status ? (
        <span className="ui-choice-row__status" data-tone={status.tone}>
          {status.tone === 'ok' ? <OnbIcon name="check" /> : status.tone === 'attention' ? <OnbIcon name="alert" /> : null}
          {status.text}
        </span>
      ) : null}
      {control}
    </>
  );

  const describedBy = hasSecond ? detailId : undefined;

  if (role === 'link') {
    return (
      <button
        type="button"
        id={id}
        className="ui-choice-row"
        data-role="link"
        data-has-detail={hasSecond ? 'true' : 'false'}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        onClick={onPress}
      >
        {lead}
        {text}
        <span className="ui-choice-row__end">
          {end}
          <span className="ui-choice-row__go">
            <OnbIcon name="chevron-right" />
          </span>
        </span>
      </button>
    );
  }

  if (role === 'radio') {
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        onPress?.();
      }
    };
    return (
      <div id={id} className="ui-choice-row" data-role="radio" data-selected={selected ? 'true' : 'false'} data-has-detail={hasSecond ? 'true' : 'false'}>
        <div
          role="radio"
          className="ui-choice-row__pick"
          aria-checked={Boolean(selected)}
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          tabIndex={0}
          onClick={onPress}
          onKeyDown={onKeyDown}
        >
          <span className="ui-choice-row__radio" aria-hidden="true" />
          {lead}
          {text}
        </div>
        <span className="ui-choice-row__end">{end}</span>
      </div>
    );
  }

  return (
    <div id={id} className="ui-choice-row" data-role="static" data-has-detail={hasSecond ? 'true' : 'false'}>
      {lead}
      {text}
      <span className="ui-choice-row__end">{end}</span>
    </div>
  );
}
