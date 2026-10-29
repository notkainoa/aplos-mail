import type { Migration } from '../migrate';
import { migration0001 } from './0001_initial';
import { migration0002 } from './0002_drafts_sync';
import { migration0003 } from './0003_account_settings';

/** Every migration in order. Append only. */
export const MIGRATIONS: readonly Migration[] = [migration0001, migration0002, migration0003];
