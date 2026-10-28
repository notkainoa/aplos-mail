import type { Migration } from '../migrate';
import { migration0001 } from './0001_initial';

/** Every migration in order. Append only. */
export const MIGRATIONS: readonly Migration[] = [migration0001];
