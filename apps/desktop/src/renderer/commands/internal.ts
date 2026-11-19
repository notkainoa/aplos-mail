// Internal entry point: building blocks for tests and for this folder. Screens
// use index.ts; a registry built here without the catalog's DISABLED_IN would
// let E mark done rows Done.

export { COMMANDS, CONTROLS, DISABLED_IN } from './catalog';
export { BANNED_PHRASES, copyProblem } from './copy';
export { chordFromEvent, chordId, parseChord } from './keys';
export { createRegistry, expandKeys, findConflicts, findShadows } from './registry';
export type { RegistryOptions } from './registry';
export { pickBinding, resolve } from './resolver';
export type { ResolveOptions } from './resolver';
export { canShareStack, MODAL_CONTEXTS, ONBOARDING_WINDOW_CONTEXTS } from './stacks';
export { APP_SETTINGS, createSettingsTable } from './settings';
export type { SettingsTable } from './settings';
