import type { ReactElement, Ref } from 'react';
import type { CommandId, IconName, KeyHint, LiteralKey } from './shared';

/* ───────────────────────── buttons-keys ───────────────────────── */

/** Button heights 28 / 32 / 40 px (DESIGN §4.4 control heights, §6 Button). 'lg' is the onboarding primary. There is no 24 px button: 24 px belongs to chips, and the mockups' `.btn.xs` (status slot, undo tray, Cc, Reset, "Try demo mail") render at 'sm'. */
export type ButtonSize = 'sm' | 'md' | 'lg';

/** Fields every Button variant shares. */
interface ButtonBase {
  /** Visible text; for the icon variant it is the required accessible name and tooltip label (DESIGN §11.3). */
  label: string;
  /** 28 / 32 / 40 px; default 'md'. */
  size?: ButtonSize;
  /** Leading icon. */
  icon?: IconName;
  /** Trailing disclosure glyph for pickers and "More options". */
  trailingIcon?: 'chevron-down' | 'chevron-right' | 'up-down';
  /** Registry command for the keycap and tooltip. */
  commandId?: CommandId;
  /** Literal keycap where DESIGN requires one (Return, ⇧Return, Esc, Tab). */
  keys?: LiteralKey;
  /** Where the keycap shows; default 'tooltip'. Main actions pass 'always'. */
  keyHint?: KeyHint;
  /** 'danger' uses `--stamp-ink` text (Reconnect in the status slot); never a red fill. */
  tone?: 'default' | 'danger';
  /** Disabled: `--dim` text, `--faint` icon (DESIGN §4.1). */
  disabled?: boolean;
  /** Tooltip explaining why it is disabled, e.g. a key that comes from the environment (DESIGN §7.10). */
  disabledReason?: string;
  /** Working: label stays, Spinner after 150 ms (DESIGN §5 rule 12). */
  busy?: boolean;
  /** Toggle state for `aria-pressed`, e.g. the pane header Ask button while the dock is open. */
  pressed?: boolean;
  /** Popup wiring for menu and picker triggers. Pickers are a Menu with `checkedId` (menuitemradio), so they use 'menu'; there is no listbox popup. */
  popup?: { kind: 'menu' | 'dialog'; expanded: boolean; controls: string };
  /** Replaces the accessible name (`aria-label`). It must contain the visible text (start with it for voice control; WCAG 2.5.3 Label in Name), e.g. "Groq, Provider" for a button reading "Groq"; `nameContainsVisibleText` checks it in tests. Ignored when `labelledBy` is given. Omit it to use the visible text. */
  ariaLabel?: string;
  /** Id of an element that names this button's context, e.g. its row's label. The name becomes that element's text plus the button's own visible text (`aria-labelledby="<labelledBy> <own text id>"`), so the visible text is always part of the name. */
  labelledBy?: string;
  /** Click handler. */
  onPress: () => void;
  /** Form role; default 'button'. */
  type?: 'button' | 'submit';
  /** DOM id. */
  id?: string;
  /** Element ref (anchors, focus return). */
  ref?: Ref<HTMLButtonElement>;
}

/** The three button idioms (DESIGN §4.6, §6 Button): radius 8, press inset; one filled per screen, owned by the topmost surface. Mockups: every page. Plain + refines: ui-foundation; used by all lanes. */
export type ButtonProps =
  | (ButtonBase & {
      /** 'filled' = the one ink-blue action; 'text' = quiet verb. */
      variant: 'filled' | 'text';
    })
  | (ButtonBase & {
      /** Icon-only control. */
      variant: 'icon';
      /** Required for the icon variant. */
      icon: IconName;
      /** Show `label` beside the icon (the pane header "Ask" button, DESIGN §4.7). */
      labelVisible?: boolean;
    });

/** One keycap: 18 px, radius 4, `caption`, `--sunken` (DESIGN §6 Kbd). One size only: the drill prompt's larger caps in onboarding-drill.html follow DESIGN and use this Kbd. Mockups: every page (`.kbd`). Plain + refines: ui-foundation. */
export interface KbdProps {
  /** Display chord as one cap, e.g. "E", "⌘↩", "⇧A", "Space", "Return", "⌃1". */
  chord: string;
  /** 'always' = inline cap; 'hint' = only in the "Show all key hints" mode; 'badge' = overlay while ⌘ is held. Never hover. Default 'always'. */
  reveal?: 'always' | 'hint' | 'badge';
}

/** Label plus keycaps from the registry, `reveal`, `--elev-float`; where key hints live (DESIGN §6 Tooltip, §8). Mockups: shell.js `[data-tip]`, reader.html sender hover. Plain + refines: ui-foundation. */
export interface TooltipProps {
  /** First line, e.g. "Done" or "Today". */
  label: string;
  /** Optional second line, e.g. "jordan@parkandpine.co · 14 emails both ways since March" (DESIGN §7.5 sender hover). */
  detail?: string;
  /** Registry command whose keys appear after the label. */
  commandId?: CommandId;
  /** Literal keycap where DESIGN requires one. */
  keys?: LiteralKey;
  /** The trigger element; it must accept a ref and focus/hover handlers. */
  children: ReactElement;
  /** Side of the trigger; default 'below'. */
  placement?: 'below' | 'above';
  /** Suppress, e.g. while a menu from the same trigger is open. */
  disabled?: boolean;
}
