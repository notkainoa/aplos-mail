// The pure part of the axe scorer, so the maths is testable without a browser.

export type Impact = 'critical' | 'serious' | 'moderate' | 'minor';

export interface AxeFinding {
  state: string;
  theme: string;
  rule: string;
  impact: string | null | undefined;
  nodes: number;
  target: string;
  /** Listed in `axeKnownDefects`: still real, counted at half weight. */
  known: boolean;
}

export const IMPACT_WEIGHT: Record<Impact, number> = {
  critical: 8,
  serious: 5,
  moderate: 2,
  minor: 1,
};
export const NODE_CAP = 3;
export const KNOWN_FACTOR = 0.5;
/** 20 serious violations at NODE_CAP nodes each score 0. */
export const NORMALISER = 20 * IMPACT_WEIGHT.serious * NODE_CAP;

/** An unlabelled impact counts as minor. */
export function impactWeight(impact: string | null | undefined): number {
  return IMPACT_WEIGHT[impact as Impact] ?? IMPACT_WEIGHT.minor;
}

export function penalty(finding: AxeFinding): number {
  if (isOpenFailure(finding)) return NORMALISER;
  const base = impactWeight(finding.impact) * Math.min(Math.max(finding.nodes, 1), NODE_CAP);
  return finding.known ? base * KNOWN_FACTOR : base;
}

/** The rule of a finding for a page that could not be opened or scanned. */
export const OPEN_FAILURE_RULE = 'state-failed-to-open';

export function isOpenFailure(finding: AxeFinding): boolean {
  return finding.rule === OPEN_FAILURE_RULE;
}

/** A finding for a page that failed to open or to scan. */
export function openFailure(state: string, theme: string, message: string): AxeFinding {
  return {
    state,
    theme,
    rule: OPEN_FAILURE_RULE,
    impact: 'critical',
    nodes: 1,
    target: message,
    known: false,
  };
}

/**
 * 100 for a clean run, 0 at NORMALISER penalty or more. A page that failed to open or to scan makes
 * the whole score 0 (breaking or deleting a state must never beat fixing its violations), and so does
 * a run that visited no page at all.
 */
export function axeScore(findings: readonly AxeFinding[], pages: number): number {
  if (pages <= 0 || findings.some(isOpenFailure)) return 0;
  const total = findings.reduce((sum, finding) => sum + penalty(finding), 0);
  return Math.max(0, 100 - (total / NORMALISER) * 100);
}

/** `state theme rule impact nodes target`, with `known:<impact>` for listed defects. */
export function formatFinding(finding: AxeFinding): string {
  const impact = finding.known ? `known:${finding.impact ?? 'none'}` : (finding.impact ?? 'none');
  return [finding.state, finding.theme, finding.rule, impact, finding.nodes, finding.target].join(
    ' ',
  );
}

/** Details worst first (largest penalty, then state order). */
export function axeDetails(findings: readonly AxeFinding[]): string[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => penalty(b.finding) - penalty(a.finding) || a.index - b.index)
    .map(({ finding }) => formatFinding(finding));
}

/** First detail line: how many pages were visited and how many of them failed. */
export function axeSummaryLine(pages: number, findings: readonly AxeFinding[]): string {
  const failed = new Set(
    findings.filter(isOpenFailure).map(finding => `${finding.state} ${finding.theme}`),
  ).size;
  return `scanned ${pages - failed} of ${pages} pages${failed ? ` (${failed} failed to open, score 0)` : ''}`;
}
