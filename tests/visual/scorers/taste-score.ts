import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The pure part of the taste judge (taste.score.ts): rubric loading, prompt building, answer parsing,
// the maths and the cache. The judge itself is injected, so tests need no network and no claude.

export const PROMPT_VERSION = 'taste-1';
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

/** Asks the model one question and returns its raw text answer. Throws when the call itself fails. */
export type Judge = (prompt: string) => Promise<string>;

export interface JudgeImage {
  /** What the image is, for the prompt: "SHOT light", "REFERENCE MOCKUP dark". */
  label: string;
  /** Absolute path the judge reads. */
  path: string;
}

export interface Answer {
  /** 0..10 per criterion id; null when the judge says it cannot be assessed here. */
  criteria: Record<string, number | null>;
  findings: string[];
}

export interface StateJudgement {
  stateId: string;
  ok: boolean;
  /** 0..100, present when ok. */
  score?: number;
  criteria?: Record<string, number | null>;
  findings: string[];
  error?: string;
  calls: number;
  cacheHits: number;
}

export function loadRubric(path: string): string {
  return readFileSync(path, 'utf8').trim();
}

/** The criterion ids listed under "Criteria" in the rubric: lines that start `- id:`. */
export function criterionIds(rubric: string): string[] {
  const start = rubric.indexOf('## Criteria');
  const end = rubric.indexOf('\n## ', start + 1);
  const section = start < 0 ? '' : rubric.slice(start, end < 0 ? undefined : end);
  return [...section.matchAll(/^- ([a-z][a-z-]*):/gm)].map(match => match[1] as string);
}

export interface PromptInput {
  rubric: string;
  criteria: readonly string[];
  stateId: string;
  title: string;
  images: readonly JudgeImage[];
  /** Why no reference mockup is attached, when none is. */
  referenceNote?: string;
}

export function buildPrompt(input: PromptInput): string {
  const images = input.images.map((image, index) => `${index + 1}. ${image.label}: ${image.path}`);
  const shape = input.criteria.map(id => `"${id}": 0-10 or null`).join(', ');
  return [
    'You are a strict, consistent UI design reviewer for the Aplos Mail app. Review the screenshots below against the rubric.',
    '',
    '<rubric>',
    input.rubric,
    '</rubric>',
    '',
    `View under review: ${input.stateId} (${input.title}).`,
    'Use the Read tool on every image path below, then judge. Read each file once; do nothing else.',
    ...images,
    input.referenceNote ? `Note: ${input.referenceNote}` : '',
    '',
    'Rules: score only what is visible. Do not reward text length or amount of detail. Numbers are for relative comparison between versions. Use null for a criterion that cannot be assessed from these images.',
    'Answer with one JSON object and nothing else, no code fence:',
    `{"criteria": {${shape}}, "findings": ["<located, specific, actionable sentence>", ...]}`,
    'Findings are worst first, at most 8, each naming where in the view and the fix.',
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n');
}

/** Every top-level `{...}` span in the text, in order (string-aware brace matching). */
export function jsonObjectSpans(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"' && depth > 0) inString = true;
    else if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) spans.push(text.slice(start, i + 1));
    }
  }
  return spans;
}

function clampCriterion(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.min(10, Math.max(0, value));
}

/**
 * Takes the last JSON object in the text that has a `criteria` object. Unknown ids are dropped and
 * missing ones become null. Throws when no object parses or fewer than half the ids carry a number.
 */
export function parseAnswer(text: string, criteria: readonly string[]): Answer {
  const spans = jsonObjectSpans(text).reverse();
  for (const span of spans) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(span);
    } catch {
      continue;
    }
    const answer = toAnswer(parsed, criteria);
    if (answer) return answer;
  }
  throw new Error('no JSON object with usable "criteria" in the answer');
}

function toAnswer(parsed: unknown, ids: readonly string[]): Answer | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = (parsed as { criteria?: unknown }).criteria;
  if (typeof raw !== 'object' || raw === null) return null;
  const values = raw as Record<string, unknown>;
  const criteria: Record<string, number | null> = {};
  for (const id of ids) criteria[id] = clampCriterion(values[id]);
  const numeric = Object.values(criteria).filter(value => value !== null).length;
  if (numeric < Math.ceil(ids.length / 2)) return null;
  const found = (parsed as { findings?: unknown }).findings;
  const findings = Array.isArray(found)
    ? found.filter((line): line is string => typeof line === 'string' && line.trim() !== '')
    : [];
  return { criteria, findings: findings.map(line => line.trim()) };
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : mean([sorted[middle - 1]!, sorted[middle]!]);
}

/** Per criterion the median over the runs that scored it; null when none did. */
export function medianCriteria(answers: readonly Answer[]): Record<string, number | null> {
  const ids = [...new Set(answers.flatMap(answer => Object.keys(answer.criteria)))];
  const result: Record<string, number | null> = {};
  for (const id of ids) {
    const scored = answers.flatMap(answer => answer.criteria[id] ?? []);
    result[id] = scored.length ? median(scored) : null;
  }
  return result;
}

/** 10 x the mean of the criteria that were scored: 0..100. NaN when none were. */
export function stateScore(criteria: Record<string, number | null>): number {
  const scored = Object.values(criteria).filter((value): value is number => value !== null);
  return 10 * mean(scored);
}

/** The first run's findings, then new ones from later runs, dropping repeats. */
export function mergeFindings(answers: readonly Answer[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const finding of answers.flatMap(answer => answer.findings)) {
    const key = finding.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(finding);
  }
  return merged;
}

export interface CacheKeyInput {
  imageHashes: readonly string[];
  rubric: string;
  model: string;
  promptVersion: string;
  /** Run index, so the K runs of one state are K different samples. */
  run: number;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function cacheKey(input: CacheKeyInput): string {
  return sha256(
    JSON.stringify([
      ...input.imageHashes,
      input.rubric,
      input.model,
      input.promptVersion,
      input.run,
    ]),
  );
}

export function readCache(dir: string, key: string): Answer | null {
  const file = join(dir, `${key}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Answer;
  } catch {
    return null;
  }
}

export function writeCache(dir: string, key: string, answer: Answer): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}.json`), JSON.stringify(answer));
}

const RETRY_NOTE =
  '\n\nYour previous answer was not a valid JSON object of the required shape. Answer again with only the JSON object.';

/** One call, then one retry when the answer does not parse. A thrown judge error is not retried. */
export async function askJudge(
  judge: Judge,
  prompt: string,
  criteria: readonly string[],
): Promise<{ answer: Answer; calls: number }> {
  const first = await judge(prompt);
  try {
    return { answer: parseAnswer(first, criteria), calls: 1 };
  } catch {
    const second = await judge(prompt + RETRY_NOTE);
    return { answer: parseAnswer(second, criteria), calls: 2 };
  }
}

export interface JudgeStateInput {
  stateId: string;
  title: string;
  rubric: string;
  criteria: readonly string[];
  model: string;
  images: readonly JudgeImage[];
  referenceNote?: string;
  runs: number;
  judge: Judge;
  cacheDir: string;
}

/** Judges one state `runs` times (cache first) and takes the median per criterion. Never throws. */
export async function judgeState(input: JudgeStateInput): Promise<StateJudgement> {
  const result: StateJudgement = {
    stateId: input.stateId,
    ok: false,
    findings: [],
    calls: 0,
    cacheHits: 0,
  };
  try {
    const imageHashes = input.images.map(image => sha256(readFileSync(image.path)));
    const prompt = buildPrompt(input);
    const answers: Answer[] = [];
    for (let run = 0; run < input.runs; run += 1) {
      const key = cacheKey({
        imageHashes,
        rubric: input.rubric,
        model: input.model,
        promptVersion: PROMPT_VERSION,
        run,
      });
      const cached = readCache(input.cacheDir, key);
      if (cached) {
        result.cacheHits += 1;
        answers.push(cached);
        continue;
      }
      const asked = await askJudge(input.judge, prompt, input.criteria);
      result.calls += asked.calls;
      writeCache(input.cacheDir, key, asked.answer);
      answers.push(asked.answer);
    }
    result.criteria = medianCriteria(answers);
    result.score = stateScore(result.criteria);
    result.findings = mergeFindings(answers);
    result.ok = !Number.isNaN(result.score);
    if (!result.ok) result.error = 'no criterion was scored';
  } catch (error) {
    result.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
  }
  return result;
}

export interface Summary {
  score: number;
  details: string[];
  failures: number;
}

/** Overall = mean of the states that judged. Details: failures first, then findings of the lowest states first. */
export function summarise(
  results: readonly StateJudgement[],
  notes: readonly string[] = [],
): Summary {
  const good = results
    .filter(result => result.ok)
    .sort((a, b) => (a.score as number) - (b.score as number));
  const failed = results.filter(result => !result.ok);
  const details = [
    ...failed.map(result => `${result.stateId}: judge-failed ${result.error ?? 'unknown error'}`),
    ...good.flatMap(result => result.findings.map(finding => `${result.stateId}: ${finding}`)),
    ...notes,
  ];
  return {
    score: mean(good.map(result => result.score as number)),
    details,
    failures: failed.length,
  };
}

export interface MockupRef {
  file: string;
  /** The state label as written in states.ts: "default", "inbox zero", "status". */
  state: string;
}

/** `home.html (default)` -> { file: 'home.html', state: 'default' }; null when it does not look like that. */
export function parseMockupRef(mockup: string): MockupRef | null {
  const match = /^([\w-]+\.html) \(([^)]+)\)$/.exec(mockup.trim());
  return match ? { file: match[1] as string, state: match[2] as string } : null;
}

export function dataStatesOf(html: string): string[] {
  const match = /data-states="([^"]*)"/.exec(html);
  return (match?.[1] ?? '')
    .split(',')
    .map(state => state.trim())
    .filter(Boolean);
}

/**
 * The `state=` query for a mockup: '' for "default" (the page opens its first state), the state
 * itself when the page declares it, null when it does not (the reference is then skipped).
 */
export function mockupStateQuery(label: string, declared: readonly string[]): string | null {
  if (label === 'default') return '';
  const state = label.trim().replace(/\s+/g, '-');
  return declared.includes(state) ? state : null;
}
