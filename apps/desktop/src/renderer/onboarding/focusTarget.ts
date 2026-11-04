/**
 * Focus (F12): where the window puts focus when a step names its target, kept DOM-small so tests can exercise
 * it without the component tree. A button is found by its visible label (keycaps stripped), first inside the
 * step's own action containers — the actions row, the consent card's actions, the footer's buttons — so a
 * same-named button elsewhere in `main` (the window notice's "Try again") can never shadow the step's action;
 * other body buttons (a provider row's "Check again") still match, a notice's never do.
 */
import type { ActiveFocus, FocusTarget } from './flow';

/** A button's visible label: its text without keycaps. */
export function buttonLabel(button: Element): string {
  let text = '';
  button.childNodes.forEach(node => {
    if (node.nodeName === 'KBD') return;
    text += node.textContent ?? '';
  });
  return text.trim();
}

/**
 * Moves focus to a step's main action. Returns false when the target is not on screen or cannot take focus.
 * `keepTop` (a new step) focuses without scrolling and shows the step from its top, so a long step at 640 × 520
 * opens on its title, never part-way down (F13); within a step, focus scrolls the control into view.
 */
export function focusTarget(
  root: HTMLElement | null,
  target: FocusTarget,
  keepTop = false,
): boolean {
  if (!root) return false;
  let el: HTMLElement | null = null;
  if (target.kind === 'field') {
    el = root.querySelector<HTMLElement>(`#${CSS.escape(target.id)}`);
  } else {
    const match = (b: HTMLButtonElement) => !b.disabled && buttonLabel(b) === target.label;
    el =
      Array.from(
        root.querySelectorAll<HTMLButtonElement>(
          '.ui-onboarding-step__actions button, .ui-consent-card__actions button, .ui-onboarding-step__buttons button',
        ),
      ).find(match) ??
      Array.from(root.querySelectorAll<HTMLButtonElement>('main button, footer button')).find(
        b => match(b) && b.closest('[data-notice]') === null,
      ) ??
      null;
  }
  if (!el || (el as HTMLButtonElement | HTMLInputElement).disabled) return false;
  el.focus(keepTop ? { preventScroll: true } : undefined);
  if (keepTop) showTop(root);
  return document.activeElement === el;
}

/** Where focus is, for `shouldMoveFocus`: nowhere, on the step's footer, or on a control the owner chose. */
export function activeFocus(root: HTMLElement | null): ActiveFocus {
  const active = document.activeElement;
  if (!active || active === document.body || !active.isConnected) return 'none';
  return root?.querySelector('footer')?.contains(active) ? 'footer' : 'elsewhere';
}

/** Scrolls the step's body back to its top. */
export function showTop(root: HTMLElement | null): void {
  const body = root?.querySelector('main');
  if (body) body.scrollTop = 0;
}
