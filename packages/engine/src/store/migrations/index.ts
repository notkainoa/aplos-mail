import type { Migration } from '../migrate';
import { migration0001 } from './0001_initial';
import { migration0002 } from './0002_drafts_sync';
import { migration0003 } from './0003_account_settings';
import { migration0004 } from './0004_reminder_index';
import { migration0005 } from './0005_list_auth';
import { migration0006 } from './0006_calendar_listed';
import { migration0007 } from './0007_plans';

/** Every migration in order. Append only. */
export const MIGRATIONS: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
];
