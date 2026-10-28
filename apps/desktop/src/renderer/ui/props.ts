/**
 * Frozen component props for the Paper component inventory (plans/DESIGN.md §6), artifact F9.
 *
 * This file only re-exports. The definitions live in ./props/, one module per component family (shared
 * vocabulary first, the COMPONENTS manifest last), so every name is still imported from here.
 *
 * Contract rules (see ./README.md):
 * - Data in, events out. Components never fetch; screens pass rows from data hooks.
 * - No raw colour, size, radius, duration or styling-class props. Variants are closed unions tied to DESIGN.
 * - Keycaps come from the CommandRegistry through `commandId`; a literal key is allowed only where DESIGN
 *   requires one (`LiteralKey`). Kbd is never revealed by hover (DESIGN §5 rule 17, §8).
 * - After day 3 changes are additive only: new optional props, new union members, new components. Never a rename.
 *
 * Each interface carries one line: DESIGN section · mockup file(s) · which lane writes the plain version and
 * which refines it. "used by" names the consuming screen lanes.
 */
export * from './props/shared';
export * from './props/buttons-keys';
export * from './props/surfaces';
export * from './props/list';
export * from './props/reader';
export * from './props/compose';
export * from './props/ask';
export * from './props/calendar';
export * from './props/settings';
export * from './props/status';
export * from './props/controls';
export * from './props/onboarding';
export * from './props/manifest';
