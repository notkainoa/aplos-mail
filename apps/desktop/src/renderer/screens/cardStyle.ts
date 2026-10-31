/**
 * The card option on trial for the reader and the compose page (owner review 2026-10-31): 'off' is DESIGN 7.5 / 7.6 as
 * written, 'a' and 'b' the two card treatments. A screen's own `cardStyle` prop wins; otherwise the nearest
 * `CardStyleContext` decides (the visual harness wraps the app in one), else 'off'.
 */
import { createContext, useContext } from 'react';

/** How the reader and the compose page group their content. */
export type CardStyle = 'off' | 'a' | 'b';

/** The card option for every reader and compose page below it; 'off' when none is provided. */
export const CardStyleContext = createContext<CardStyle>('off');

/** The screen's own choice, else the context's. */
export function useCardStyle(chosen: CardStyle | undefined): CardStyle {
  const provided = useContext(CardStyleContext);
  return chosen ?? provided;
}
