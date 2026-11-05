/**
 * ⌘K as the host draws it (DESIGN §7.9): `Palette` fed by `paletteView`. Presentational: the host owns the state and
 * the registry; this file only attaches callbacks. The component handles its own focused keys (↑/↓, Return, ⇧Return,
 * 1–9 while empty, Esc, ⌘K) and calls back here.
 */
import { Palette } from '../../ui/ask';
import type { Announce } from '../../ui/props';
import type { PaletteState, PaletteView } from './palette.model';

export interface PaletteScreenHandlers {
  onQueryChange: (query: string) => void;
  onActiveChange: (id: string) => void;
  onRun: (id: string) => void;
  /** Esc: up a level (confirm → list, page → parent). */
  onBack: () => void;
  /** Esc at the top, ⌘K again, or the scrim. */
  onClose: () => void;
  /** ⇧Return on a destructive confirm, Return on any other. */
  onConfirm: () => void;
  /** Return on a destructive confirm, Esc, or the Cancel row. */
  onCancelConfirm: () => void;
}

export interface PaletteScreenProps {
  readonly state: PaletteState;
  readonly view: PaletteView;
  readonly handlers: PaletteScreenHandlers;
  readonly announce?: Announce;
}

export const PALETTE_LISTBOX_ID = 'palette-results';

export function PaletteScreen({ state, view, handlers, announce }: PaletteScreenProps) {
  const confirm = view.confirm;
  return (
    <Palette
      open={state.open}
      query={state.query}
      onQueryChange={handlers.onQueryChange}
      context={view.context}
      trail={view.trail}
      sections={view.sections}
      activeId={view.activeId}
      onActiveChange={handlers.onActiveChange}
      onRun={handlers.onRun}
      confirm={
        confirm
          ? {
              question: confirm.title,
              consequence: confirm.prompt,
              confirmLabel: confirm.confirmLabel,
              destructive: confirm.destructive,
              presentation: 'inline',
              onConfirm: handlers.onConfirm,
              onCancel: handlers.onCancelConfirm,
              announce,
            }
          : undefined
      }
      listboxId={PALETTE_LISTBOX_ID}
      onBack={handlers.onBack}
      onClose={handlers.onClose}
      announce={announce}
    />
  );
}
