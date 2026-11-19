// Accessible-name wiring for Button (WCAG 2.5.3 Label in Name). Pure, so tests can assert it.
import type { ButtonProps } from '../props';

/** The naming attributes of one button; `undefined` means "leave the attribute off". */
export interface ButtonNaming {
  buttonId: string | undefined;
  /** Id for the visible label span; set only when `labelledBy` needs to reference it. */
  labelId: string | undefined;
  ariaLabel: string | undefined;
  labelledby: string | undefined;
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when an accessible name contains the visible text (WCAG 2.5.3). Compared case-insensitively with whitespace collapsed. */
export function nameContainsVisibleText(ariaLabel: string, visible: string): boolean {
  return squash(ariaLabel).includes(squash(visible));
}

/** `labelledBy` wins over `ariaLabel`; with neither, today's behaviour (visible text, or `label` for a hidden-label icon). */
export function buttonNaming(
  props: ButtonProps,
  labelVisible: boolean,
  generatedId: string,
): ButtonNaming {
  const { id, labelledBy, ariaLabel, label } = props;
  if (labelledBy) {
    // A hidden-label icon button has no text span, so it names itself through its own aria-label.
    const ownId = labelVisible ? `${generatedId}-label` : (id ?? `${generatedId}-button`);
    return {
      buttonId: labelVisible ? id : ownId,
      labelId: labelVisible ? ownId : undefined,
      ariaLabel: labelVisible ? undefined : (ariaLabel ?? label),
      labelledby: `${labelledBy} ${ownId}`,
    };
  }
  return {
    buttonId: id,
    labelId: undefined,
    ariaLabel: ariaLabel ?? (labelVisible ? undefined : label),
    labelledby: undefined,
  };
}
