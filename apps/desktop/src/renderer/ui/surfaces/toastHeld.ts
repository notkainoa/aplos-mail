/** The toast deck's shared hold (DESIGN 7.13; owner review of #548). */
import { createContext } from 'react';

/** True while the deck is fanned out (pointer over it or focus inside): every toast's clock holds until it folds. */
export const ToastStackHeld = createContext(false);
