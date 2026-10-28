import { useSyncExternalStore } from 'react';
import type { CalendarEvent } from '@aplos/contract/legacy/types';

/**
 * Plans Groq already found in an email this session (from Space on a suggestion, "Find plans in this email"
 * or the Calendar's "From your mail"). Today shows them beside the open email without asking Groq again.
 * "Not now" hides an email's plans from Today until they are found again or shown.
 */
export type FoundPlans = { found: Partial<CalendarEvent>[]; dismissed: boolean };
const plans = new Map<string, FoundPlans>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
export function rememberPlans(threadId: string, found: Partial<CalendarEvent>[]) {
  plans.set(threadId, { found, dismissed: false });
  emit();
}
export function dismissPlans(threadId: string, dismissed = true) {
  const entry = plans.get(threadId);
  if (!entry || entry.dismissed === dismissed) return;
  plans.set(threadId, { ...entry, dismissed });
  emit();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function usePlans(threadId: string | undefined) {
  return useSyncExternalStore(subscribe, () => (threadId ? plans.get(threadId) : undefined));
}
