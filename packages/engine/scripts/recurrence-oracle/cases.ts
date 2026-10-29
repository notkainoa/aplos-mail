/**
 * Golden corpus INPUTS (hand-written). Expected outputs are never written here: generate.ts runs
 * both oracles over these inputs and records only what they agree on.
 *
 * The case list lives in the `cases-rules.ts` and `cases-editing.ts` chunks (with the builders in
 * `cases-shared.ts`); this file concatenates them in the same order as before the split.
 */
import type { Case, CaseEvent, CaseOverride, EventTime } from './cases-shared';
import { casesEditing } from './cases-editing';
import { casesRules } from './cases-rules';

export type { Case, CaseEvent, CaseOverride, EventTime };

export const cases: Case[] = [...casesRules, ...casesEditing];
