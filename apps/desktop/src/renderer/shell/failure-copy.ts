/** The shell's failure sentences, shared by the hosts that toast a failed verb (DESIGN 7.15: what happened, what is safe). */

/** The engine would not restart. */
export const RESTART_FAILED_COPY = 'Couldn’t restart. Your mail is safe on this Mac.';

/** The diagnostics could not be copied or exported. */
export const DIAGNOSTICS_FAILED_COPY = 'Couldn’t get the diagnostics.';

/** A reconnect (or a forced retry of the connection) did not go through. */
export const RECONNECT_FAILED_COPY =
  'Couldn’t reconnect. Your mail is safe here and local changes are kept.';

/** A choice could not be saved. */
export const SAVE_FAILED_COPY = 'Couldn’t save that. Nothing changed.';

/** A mail list failed to load (the same sentence as the ErrorLine's list failure). */
export const LIST_FAILED_COPY = 'Couldn’t load this list.';

/** The engine cannot be reached (the FatalScreen's title). */
export const ENGINE_UNREACHABLE_COPY = 'Aplos can’t reach its mail engine.';
