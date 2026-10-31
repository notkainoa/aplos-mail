/**
 * The engine calls the composer makes, as one small interface: the running app passes the data layer's `api`, and the
 * tests pass the stand-in's typed client, so the same session code runs in both. Never sends anything itself.
 */
import type { DataApi, Draft, DraftFields, Submission, SubmissionAction } from '../../../data';
import type { Refusal } from '../model/composeState';

export interface ComposeApi {
  /** `Draft/set`: create (no `id`, with the create's `opId` so a retry replays it) or save with `baseRevision`. */
  saveDraft(args: {
    readonly opId?: string;
    readonly id?: string;
    readonly baseRevision?: number;
    readonly fields: DraftFields;
  }): Promise<{ readonly draft: Draft }>;
  /** `Draft/destroy`. */
  destroyDraft(args: { readonly id: string }): Promise<unknown>;
  /** `Submission/set` with the caller's `opId` (the send's idempotency key) when it has one. */
  setSubmission(args: {
    readonly opId?: string;
    readonly action: SubmissionAction;
  }): Promise<{ readonly submission: Submission }>;
}

/** The data layer's `api` as a `ComposeApi`. */
export function dataComposeApi(api: Pick<DataApi, 'draft' | 'submission'>): ComposeApi {
  return {
    saveDraft: args => api.draft.set(args),
    destroyDraft: args => api.draft.destroy(args),
    setSubmission: args => api.submission.set(args),
  };
}

function field<T>(
  source: object,
  key: string,
  check: (value: unknown) => value is T,
): T | undefined {
  const value = (source as Record<string, unknown>)[key];
  return check(value) ? value : undefined;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';

/** A refused call's type, sentence, copy key and resume time, from a `ContractError` or anything shaped like one. */
export function refusalOf(error: unknown): Refusal {
  if (typeof error !== 'object' || error === null)
    return { type: 'unknown', message: String(error) };
  const body =
    field(error, 'body', (v): v is object => typeof v === 'object' && v !== null) ?? error;
  const reasonCode = field(body, 'reasonCode', isString);
  const resumeAt = field(body, 'resumeAt', isNumber);
  return {
    type: field(body, 'type', isString) ?? field(error, 'type', isString) ?? 'unknown',
    message: field(body, 'message', isString) ?? '',
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    ...(resumeAt !== undefined ? { resumeAt } : {}),
  };
}
