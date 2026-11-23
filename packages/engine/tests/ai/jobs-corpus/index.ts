import { readFileSync } from 'node:fs';
import type { LaneInput } from '../../../src/ports/content';

export type Job = 'ask' | 'update' | 'read' | 'newPerson' | 'record' | 'other';

export const JOBS: readonly Job[] = ['ask', 'update', 'read', 'newPerson', 'record', 'other'];

export interface JobCase {
  id: string;
  job: Job;
  hard: boolean;
  why: string;
  input: LaneInput & { text: string };
}

export function loadJobCases(): JobCase[] {
  return JOBS.flatMap(job => {
    const file = new URL(`./${job}.json`, import.meta.url);
    return JSON.parse(readFileSync(file, 'utf8')) as JobCase[];
  });
}
