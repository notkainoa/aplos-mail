import type { Migration } from '../migrate';
import { migration0001 } from './0001_initial';
import { migration0002 } from './0002_drafts_sync';

/** Every migration in order. Append only. */
export const MIGRATIONS: readonly Migration[] = [migration0001, migration0002];
