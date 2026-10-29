/**
 * Text: the closed typography primitive, so screens never set type themselves (DESIGN 4.3, 12.2).
 * Roles map to --type-<role> with --track-<role>; 'lede' is `base` --dim and 'label' is `small` 500 --dim.
 * The serif roles (summary, answer) belong to Summary and AskTurn and are not offered here.
 */
import type { ComponentPropsMap, TextVariant } from '../props';
import { PartIcon } from './parts';

const DEFAULT_ELEMENT: Record<TextVariant, 'h1' | 'p'> = {
  display: 'h1',
  heading: 'h1',
  title: 'p',
  lede: 'p',
  label: 'p',
  small: 'p',
  caption: 'p',
};

const DEFAULT_TONE: Record<TextVariant, 'ink' | 'ink-2' | 'dim'> = {
  display: 'ink',
  heading: 'ink',
  title: 'ink',
  lede: 'dim',
  label: 'dim',
  small: 'dim',
  caption: 'dim',
};

export function Text({ variant, as, tone, icon, id, children }: ComponentPropsMap['Text']) {
  const Element = as ?? DEFAULT_ELEMENT[variant];
  return (
    <Element
      className="ui-text"
      data-variant={variant}
      data-tone={tone ?? DEFAULT_TONE[variant]}
      data-icon={icon ? 'true' : undefined}
      id={id}
    >
      {icon ? <PartIcon name={icon} size="sm" /> : null}
      {icon ? <span className="ui-text__body">{children}</span> : children}
    </Element>
  );
}
