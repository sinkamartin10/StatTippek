/**
 * Modell-tanulási irányítópult – tiszta megjelenítési segédfüggvények (DOM nélkül tesztelhetők).
 *
 * Minden érték a backend válaszából jön; hiányzó vagy nem véges szám SOHA nem
 * jelenik meg 0-ként vagy sikerként, hanem „Nincs adat”-ként.
 */
import type { DiagnosticsReport, LearningStatus } from '@shared/modelLearning';

export const NO_DATA = 'Nincs adat';
export const NOT_AVAILABLE = 'Nem érhető el';

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function fmtNum(x: unknown, digits = 4): string {
  return finite(x) ? x.toFixed(digits).replace('.', ',') : NO_DATA;
}

export function fmtPct(x: unknown, digits = 1): string {
  return finite(x) ? `${(x * 100).toFixed(digits).replace('.', ',')}%` : NO_DATA;
}

export function fmtInt(x: unknown): string {
  return finite(x) ? String(Math.round(x)) : NO_DATA;
}

export function fmtCi(ci: unknown, digits = 4): string {
  return Array.isArray(ci) && ci.length === 2 && finite(ci[0]) && finite(ci[1]) ? `${fmtNum(ci[0], digits)} … ${fmtNum(ci[1], digits)}` : NO_DATA;
}

export function fmtTime(iso: unknown): string {
  if (typeof iso !== 'string') return NO_DATA;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? NO_DATA : d.toLocaleString('hu-HU', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Egy jelölt holdout-összevetése (a backend `metrics.holdout` mezőjéből), védekezően olvasva. */
export interface CandidateComparison {
  baseline: { matches: number | null; observations: number | null; logLoss: number | null; brier: number | null; ece: number | null };
  candidate: { matches: number | null; observations: number | null; logLoss: number | null; brier: number | null; ece: number | null };
  /** (alap − jelölt) log loss; pozitív = a jelölt jobb */
  logLossDelta: number | null;
  logLossDeltaCi: [number, number] | null;
  relativeLogLossImprovement: number | null;
  brierDelta: number | null;
  /** igaz, ha a két mérés UGYANAZON a mintán készült (azonos meccs- és megfigyelésszám) */
  samePairedSample: boolean;
}

export interface CandidateView {
  id: string;
  status: string;
  statusReason: string | null;
  createdAt: string;
  gatePassed: boolean | null;
  gateReasons: string[];
  sizes: { trainMatches: number | null; validationMatches: number | null; holdoutMatches: number | null; holdoutObservations: number | null };
  holdout: CandidateComparison | null;
  marketWarnings: { key: string; matches: number | null; relativeChange: number | null; guarded: boolean }[];
}

const num = (x: unknown): number | null => (finite(x) ? x : null);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? x as Record<string, unknown> : {});

function score(x: unknown) {
  const o = obj(x);
  return { matches: num(o.matches), observations: num(o.observations), logLoss: num(o.logLoss), brier: num(o.brier), ece: num(o.ece) };
}

export function parseCandidate(c: LearningStatus['candidates'][number]): CandidateView {
  const m = obj(c.metrics);
  const sizes = obj(m.sizes);
  const h = m.holdout ? obj(m.holdout) : null;
  let holdout: CandidateComparison | null = null;
  if (h) {
    const baseline = score(h.baseline), candidate = score(h.candidate);
    const ci = Array.isArray(h.logLossDeltaCi) && h.logLossDeltaCi.length === 2 && finite(h.logLossDeltaCi[0]) && finite(h.logLossDeltaCi[1])
      ? [h.logLossDeltaCi[0], h.logLossDeltaCi[1]] as [number, number] : null;
    holdout = {
      baseline, candidate,
      logLossDelta: num(h.logLossDelta), logLossDeltaCi: ci,
      relativeLogLossImprovement: num(h.relativeLogLossImprovement), brierDelta: num(h.brierDelta),
      samePairedSample: baseline.matches != null && baseline.matches === candidate.matches && baseline.observations === candidate.observations,
    };
  }
  const markets = Array.isArray(m.markets) ? m.markets.map(obj) : [];
  const gate = obj(c.gateResult);
  return {
    id: c.id, status: c.status, statusReason: c.statusReason, createdAt: c.createdAt,
    gatePassed: typeof gate.passed === 'boolean' ? gate.passed : null,
    gateReasons: Array.isArray(gate.reasons) ? gate.reasons.filter((r): r is string => typeof r === 'string') : [],
    sizes: { trainMatches: num(sizes.trainMatches), validationMatches: num(sizes.validationMatches), holdoutMatches: num(sizes.holdoutMatches), holdoutObservations: num(sizes.holdoutObservations) },
    holdout,
    marketWarnings: markets
      .map((g) => ({ key: String(g.key ?? '?'), matches: num(g.matches), relativeChange: num(g.relativeChange), guarded: g.guarded === true }))
      .filter((g) => g.relativeChange != null && g.relativeChange > 0),
  };
}

export const CANDIDATE_STATUS_LABEL: Record<string, string> = {
  shadow: 'Árnyék (nem kiszolgált)', eligible: 'Kapukon átment – nem aktív', active: 'Aktív', rejected: 'Elutasítva',
  rolled_back: 'Visszaállítva', retired: 'Lecserélve',
};

/**
 * Egy csoport (piac/liga/valószínűségi sáv) mintája elegendő-e bármilyen
 * összehasonlításhoz – a backend küszöbei szerint. Kis mintán figyelmeztetés.
 */
export function smallSample(matches: number | null | undefined, observations: number | null | undefined, t: Pick<LearningStatus['thresholds'], 'marketGuardMinMatches' | 'marketGuardMinObservations'>): boolean {
  return !(finite(matches) && finite(observations) && matches >= t.marketGuardMinMatches && observations >= t.marketGuardMinObservations);
}

export const EVENT_LABEL: Record<string, string> = {
  insufficient_data: 'Kiértékelés – kevés adat',
  evaluation: 'Jelölt kiértékelése',
  candidate_eligible: 'Jelölt: kapukon átment',
  candidate_rejected: 'Jelölt elutasítva',
  shadow_evaluation: 'Árnyék-kiértékelés',
  failure: 'Hiba',
  promotion: 'Aktiválás',
  promotion_refused: 'Aktiválás elutasítva',
  rollback: 'Visszaállítás',
  fallback: 'Visszaesés az alap motorra',
};

/** Egy esemény rövid, biztonságosan megjeleníthető összefoglalója. */
export function eventSummary(e: LearningStatus['recentEvents'][number]): { status: 'ok' | 'warn' | 'error' | 'info'; text: string } {
  const d = obj(e.details);
  const cut = (s: unknown) => (typeof s === 'string' ? (s.length > 200 ? `${s.slice(0, 200)}…` : s) : '');
  switch (e.kind) {
    case 'failure': return { status: 'error', text: cut(d.error) || 'A futás hibával zárult.' };
    case 'insufficient_data': return { status: 'warn', text: cut(Array.isArray(d.reasons) ? d.reasons[d.reasons.length - 1] : '') || 'Nincs elég adat.' };
    case 'evaluation': return { status: d.outcome === 'eligible' ? 'ok' : 'warn', text: `Eredmény: ${String(d.outcome ?? 'ismeretlen')}` };
    case 'candidate_eligible': return { status: 'ok', text: 'Minden kapu teljesült – aktiválás csak külön döntéssel.' };
    case 'candidate_rejected': return { status: 'warn', text: cut(Array.isArray(d.reasons) ? d.reasons.join(' ') : '') || 'Elutasítva.' };
    case 'shadow_evaluation': return { status: d.outcome === 'passed' ? 'ok' : d.outcome === 'failed' ? 'error' : 'warn', text: `Eredmény: ${String(d.outcome ?? 'ismeretlen')}${Array.isArray(d.reasons) && d.reasons[0] ? ` – ${cut(d.reasons[0])}` : ''}` };
    case 'promotion_refused': return { status: 'info', text: cut(d.message ?? d.reason) || 'Elutasítva.' };
    default: return { status: 'info', text: '' };
  }
}

export function lastEventAt(events: LearningStatus['recentEvents'], kinds: string[]): string | null {
  return events.find((e) => kinds.includes(e.kind))?.at ?? null;
}

/** Az élesítés előfeltételei – a backend tényleges küszöbeiből és állapotából. */
export function promotionRequirements(s: Pick<LearningStatus, 'thresholds' | 'promotionEnabled' | 'servingNote'>): string[] {
  const t = s.thresholds;
  return [
    `Legalább ${t.minTrainMatches} tanító, ${t.minValidationMatches} validációs és ${t.minHoldoutMatches} holdout mérkőzés (≥ ${t.minHoldoutObservations} holdout-megfigyelés), időrendben, ${Math.round(t.embargoMs / 3600_000)} órás embargóval.`,
    `A holdouton legalább ${(t.minRelativeLogLossImprovement * 100).toFixed(0)}% relatív log loss-javulás, amelynek ${(t.confidenceLevel * 100).toFixed(0)}%-os bootstrap-intervalluma teljesen 0 fölött van, és a Brier-score nem romlik.`,
    `Egyik megfelelően mintázott piactípus sem romlik ${(t.marketGuardMaxRelativeDegradation * 100).toFixed(0)}%-nál jobban (Bonferroni-korrekcióval).`,
    'Sikeres mintán kívüli (árnyék-) kiértékelés a jelölt létrejötte utáni meccseken.',
    'Explicit, auditált admin-döntés – automatikus aktiválás nincs.',
    s.promotionEnabled ? 'Az aktiválás a szerveren engedélyezett.' : `Az aktiválás jelenleg a szerveren TILTOTT: ${s.servingNote}`,
  ];
}

/** A diagnosztika fő mérőszámai összevethetők-e közvetlenül a naiv baseline-nal (csak a páros mintán). */
export function naiveComparable(r: DiagnosticsReport): boolean {
  const n = r.naiveBaseline;
  return !!n && n.model.matches === n.baseline.matches && n.model.observations === n.baseline.observations && n.coveredMatches > 0;
}
