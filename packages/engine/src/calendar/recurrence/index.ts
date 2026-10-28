/**
 * Client-side recurrence (ARCH §5.5, ADR-20): masters plus overrides are stored, occurrences are
 * expanded on query, and edits to one occurrence, the series or "this and following" are pure.
 */
export type {
  EventTime,
  Weekday,
  Override,
  Series,
  Occurrence,
  ExpandRequest,
  ExpandResult,
} from './types';
export {
  parseRRule,
  formatRRule,
  type Rule,
  type Freq,
  type ByDay,
  type ParseResult,
} from './rule';
export { expand } from './expand';
export { occurrenceKey, googleInstanceId } from './keys';
export {
  editOccurrence,
  editSeries,
  splitFollowing,
  type OccurrenceChange,
  type SeriesChange,
  type EditOccurrenceResult,
  type EditSeriesResult,
  type SplitResult,
} from './edit';
