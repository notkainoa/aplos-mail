/** The catalog's `calendar.*` commands (renderer/commands, context `calendar`): their actions, `when` and palette target. */
import type { CommandId } from '../../../ui/props';
import { dayOf, longDay, timeOf } from '../../../ui/calendar/dates';
import { planIdOf } from './entries';
import {
  entryById,
  inviteOpen,
  type CalendarAction,
  type CalendarContext,
  type CalendarState,
} from './state';

/** Every calendar command the screen attaches a handler to. */
export const CALENDAR_COMMAND_IDS = [
  'calendar.today',
  'calendar.dayView',
  'calendar.weekView',
  'calendar.monthView',
  'calendar.nextPeriod',
  'calendar.previousPeriod',
  'calendar.newEvent',
  'calendar.open',
  'calendar.edit',
  'calendar.delete',
  'calendar.answerYes',
  'calendar.answerMaybe',
  'calendar.answerNo',
] as const satisfies readonly CommandId[];

export type CalendarCommandId = (typeof CALENDAR_COMMAND_IDS)[number];

/** The action a command runs. Y/M/N reach `answer` only while the `invite` condition holds; the registry routes M and N otherwise. */
export function actionForCommand(id: CalendarCommandId): CalendarAction {
  switch (id) {
    case 'calendar.today':
      return { type: 'today' };
    case 'calendar.dayView':
      return { type: 'view', view: 'day' };
    case 'calendar.weekView':
      return { type: 'view', view: 'week' };
    case 'calendar.monthView':
      return { type: 'view', view: 'month' };
    case 'calendar.nextPeriod':
      return { type: 'period', dir: 1 };
    case 'calendar.previousPeriod':
      return { type: 'period', dir: -1 };
    case 'calendar.newEvent':
      return { type: 'newEvent' };
    case 'calendar.open':
      return { type: 'return' };
    case 'calendar.edit':
      return { type: 'edit' };
    case 'calendar.delete':
      return { type: 'delete' };
    case 'calendar.answerYes':
      return { type: 'answer', answer: 'yes' };
    case 'calendar.answerMaybe':
      return { type: 'answer', answer: 'maybe' };
    case 'calendar.answerNo':
      return { type: 'answer', answer: 'no' };
  }
}

/** A command's `when`: open, edit and delete need a selection; answers need an open invite; the rest always run. */
export function commandEnabled(
  id: CalendarCommandId,
  state: CalendarState,
  ctx: CalendarContext,
): boolean {
  if (!ctx.windowReady || state.editor) return false;
  // Explicit targets only: the day rail's passive first entry is never one (review2 1).
  const selected = entryById(ctx, state.detailId ?? state.selectedId);
  switch (id) {
    case 'calendar.open':
      return selected !== undefined || inviteOpen(state, ctx);
    case 'calendar.edit':
      return selected?.kind === 'event';
    case 'calendar.delete':
      return selected?.kind === 'event' && selected.persisted;
    case 'calendar.answerYes':
    case 'calendar.answerMaybe':
    case 'calendar.answerNo':
      return inviteOpen(state, ctx);
    default:
      return true;
  }
}

/** The palette's context line for the open or selected entry: "Q4 review · Fri 11:00 AM". */
export function commandTarget(
  state: CalendarState,
  ctx: CalendarContext,
): { kind: 'event' | 'plan'; id: string; title: string; detail: string } | null {
  const entry = entryById(ctx, state.detailId ?? state.selectedId);
  if (!entry) return null;
  const planId = planIdOf(entry.id);
  const when = entry.allDay
    ? `${longDay(dayOf(entry.start))} · all day`
    : `${longDay(dayOf(entry.start))} · ${timeOf(entry.start)}`;
  return {
    kind: planId ? 'plan' : 'event',
    id: planId ?? entry.id,
    title: entry.title,
    detail: when,
  };
}
