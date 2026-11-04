/**
 * The card treatment of the reader and the compose page. Owner review 2026-11-03 chose option A ("each message is its
 * own card") as the default; 'off' is DESIGN 7.5 / 7.6 as first written (no card) and stays behind the switch. Option B
 * (sectioned cards) is gone. A screen's own `cardStyle` prop wins; otherwise the nearest `CardStyleContext` decides
 * (the visual harness wraps the app in one), else 'a'.
 */
import { createContext, useContext } from 'react';

/** How the reader and the compose page group their content. */
export type CardStyle = 'off' | 'a';

/** The card treatment for every reader and compose page below it; 'a' when none is provided. */
export const CardStyleContext = createContext<CardStyle>('a');

/** The screen's own choice, else the context's. */
export function useCardStyle(chosen: CardStyle | undefined): CardStyle {
  const provided = useContext(CardStyleContext);
  return chosen ?? provided;
}
