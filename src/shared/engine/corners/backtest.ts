/**
 * Időrendi visszatesztelés a corners-nb-1 modellhez – tiszta függvények.
 *
 * SZIVÁRGÁS ELLEN: minden célmeccs becslése a `cornerCutoff(kezdés)` előtti
 * adatokból készül (a CornerIndex szigorúan szűr). A célmeccs saját eredménye
 * csak az értékeléshez (y) kerül elő.
 *
 * HANGOLÁS ÉS HOLDOUT ELKÜLÖNÍTVE: a paramétereket kizárólag a hangolási
 * időszak célmeccsein választjuk; a holdout időszak célmeccsei a döntésben nem
 * szerepelnek, csak a végső értékelésben. (A holdout becslései természetesen
 * láthatják a korábbi – akár hangolási időszakbeli – meccsek EREDMÉNYÉT
 * előzményként, ahogy élesben is.)
 *
 * ÖSSZEHASONLÍTÁS: a modell és a liga-átlag baseline UGYANAZOKON a
 * meccseken (a modell feltételeit teljesítőkön) értékelődik – páros
 * összevetés, meccsenkénti bootstrap-pal (a vonalak egy meccsen belül
 * összefüggnek, ezért a meccs az újramintavételezés egysége).
 */
import type { CornerResult } from '../../types';
import { CORNER_LINES, type CornerScope } from './markets';
import { baselineExpectation, cornerExpectation, cornerLineProbabilities, type CornerMissing, type CornerModelParams } from './model';
import { CornerIndex, cornerCutoff } from './stats';

export interface EvalRecord {
  matchId: string;
  leagueId: string;
  scope: CornerScope;
  line: number;
  pModel: number;
  pBase: number;
  y: 0 | 1;
}

export interface EvalRun {
  records: EvalRecord[];
  targets: number;
  eligible: number;
  skipped: Partial<Record<CornerMissing, number>>;
}

const EPS = 1e-6;
const clamp = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));
export const brier = (p: number, y: number) => (p - y) ** 2;
export const logLoss = (p: number, y: number) => -(y ? Math.log(clamp(p)) : Math.log(1 - clamp(p)));

/** A célmeccsek becslése kizárólag a kezdés előtti adatokból. */
export function evaluateTargets(idx: CornerIndex, targets: CornerResult[], params: CornerModelParams): EvalRun {
  const records: EvalRecord[] = [];
  const skipped: Partial<Record<CornerMissing, number>> = {};
  let eligible = 0;
  for (const t of targets) {
    const cutoff = cornerCutoff(t.date);
    const e = cornerExpectation(idx, t.homeTeamId, t.awayTeamId, t.leagueId, cutoff, params);
    if (!e.ok) {
      for (const m of e.missing) skipped[m] = (skipped[m] ?? 0) + 1;
      continue;
    }
    const b = baselineExpectation(idx, t.leagueId, cutoff, params);
    if (!b) { skipped.league = (skipped.league ?? 0) + 1; continue; }
    eligible++;
    const pm = cornerLineProbabilities(e, params.maxCorners);
    const pb = cornerLineProbabilities(b, params.maxCorners);
    const actual: Record<CornerScope, number> = { total: t.homeCorners + t.awayCorners, home: t.homeCorners, away: t.awayCorners };
    for (const scope of ['total', 'home', 'away'] as CornerScope[]) {
      CORNER_LINES[scope].forEach((line, i) => {
        records.push({ matchId: t.matchId, leagueId: t.leagueId, scope, line, pModel: pm[scope][i].over, pBase: pb[scope][i].over, y: actual[scope] > line ? 1 : 0 });
      });
    }
  }
  return { records, targets: targets.length, eligible, skipped };
}

export interface MetricSummary {
  records: number;
  matches: number;
  brierModel: number;
  brierBase: number;
  logLossModel: number;
  logLossBase: number;
}

export function summarize(records: EvalRecord[]): MetricSummary {
  const n = records.length || 1;
  let bm = 0, bb = 0, lm = 0, lb = 0;
  for (const r of records) { bm += brier(r.pModel, r.y); bb += brier(r.pBase, r.y); lm += logLoss(r.pModel, r.y); lb += logLoss(r.pBase, r.y); }
  return { records: records.length, matches: new Set(records.map((r) => r.matchId)).size, brierModel: bm / n, brierBase: bb / n, logLossModel: lm / n, logLossBase: lb / n };
}

/** Determinisztikus álvéletlen (mulberry32) – a bootstrap reprodukálható. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DiffCI { mean: number; lo: number; hi: number }

/**
 * Páros meccsenkénti bootstrap a (modell − baseline) különbségre.
 * Negatív érték = a modell jobb (kisebb veszteség).
 */
export function bootstrapDiff(records: EvalRecord[], metric: 'logLoss' | 'brier', B = 1000, seed = 20261013): DiffCI {
  const f = metric === 'logLoss' ? logLoss : brier;
  const byMatch = new Map<string, { d: number; n: number }>();
  for (const r of records) {
    const x = byMatch.get(r.matchId) ?? { d: 0, n: 0 };
    x.d += f(r.pModel, r.y) - f(r.pBase, r.y);
    x.n++;
    byMatch.set(r.matchId, x);
  }
  const groups = [...byMatch.values()];
  if (!groups.length) return { mean: NaN, lo: NaN, hi: NaN };
  const total = groups.reduce((s, g) => ({ d: s.d + g.d, n: s.n + g.n }), { d: 0, n: 0 });
  const rand = rng(seed);
  const stats: number[] = [];
  for (let b = 0; b < B; b++) {
    let d = 0, n = 0;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[Math.floor(rand() * groups.length)];
      d += g.d; n += g.n;
    }
    stats.push(d / n);
  }
  stats.sort((a, b) => a - b);
  return { mean: total.d / total.n, lo: stats[Math.floor(0.025 * B)], hi: stats[Math.min(B - 1, Math.floor(0.975 * B))] };
}

export interface CalibrationBin { from: number; to: number; n: number; meanP: number; observed: number }

export function calibrationTable(records: EvalRecord[], which: 'pModel' | 'pBase' = 'pModel', bins = 10): CalibrationBin[] {
  const out: CalibrationBin[] = Array.from({ length: bins }, (_, i) => ({ from: i / bins, to: (i + 1) / bins, n: 0, meanP: 0, observed: 0 }));
  for (const r of records) {
    const p = r[which];
    const b = out[Math.min(bins - 1, Math.floor(p * bins))];
    b.n++; b.meanP += p; b.observed += r.y;
  }
  for (const b of out) if (b.n) { b.meanP /= b.n; b.observed /= b.n; }
  return out;
}

/** Paraméter-kiválasztás KIZÁRÓLAG a hangolási célmeccseken (átlagos log loss). */
export function selectParams(idx: CornerIndex, tuneTargets: CornerResult[], grid: CornerModelParams[]): { best: CornerModelParams; table: { params: CornerModelParams; logLoss: number; brier: number; eligible: number }[] } {
  const table = grid.map((params) => {
    const run = evaluateTargets(idx, tuneTargets, params);
    const s = summarize(run.records);
    return { params, logLoss: s.logLossModel, brier: s.brierModel, eligible: run.eligible };
  });
  const valid = table.filter((t) => t.eligible > 0);
  if (!valid.length) throw new Error('A hangolási időszakban nincs értékelhető meccs.');
  const best = [...valid].sort((a, b) => a.logLoss - b.logLoss)[0].params;
  return { best, table };
}

export interface GateInput {
  eligibleMatches: number;
  logLoss: DiffCI;
  brier: DiffCI;
  byScope: Record<CornerScope, DiffCI>;
}

export interface GateResult { passed: boolean; reasons: string[] }

export const GATE_MIN_HOLDOUT_MATCHES = 300;

/**
 * Kiadási kapu: a modell csak akkor validált, ha a rögzített holdouton
 * - elég a minta,
 * - a log loss javulása meggyőző (a 95%-os CI felső széle is < 0),
 * - a Brier-score sem romlik (pontbecslés < 0),
 * - és egyik piaccsoportban sem romlik meggyőzően (CI alsó széle > 0).
 */
export function releaseGate(g: GateInput): GateResult {
  const reasons: string[] = [];
  if (g.eligibleMatches < GATE_MIN_HOLDOUT_MATCHES) reasons.push(`Túl kicsi a holdout minta: ${g.eligibleMatches} meccs (legalább ${GATE_MIN_HOLDOUT_MATCHES} kell).`);
  if (!(g.logLoss.hi < 0)) reasons.push(`A log loss javulása nem meggyőző: Δ = ${g.logLoss.mean.toFixed(5)} (95% CI ${g.logLoss.lo.toFixed(5)} … ${g.logLoss.hi.toFixed(5)}).`);
  if (!(g.brier.mean < 0)) reasons.push(`A Brier-score nem javul: Δ = ${g.brier.mean.toFixed(5)}.`);
  for (const [scope, ci] of Object.entries(g.byScope)) {
    if (ci.lo > 0) reasons.push(`A(z) „${scope}” piaccsoportban a modell meggyőzően rosszabb (log loss Δ CI ${ci.lo.toFixed(5)} … ${ci.hi.toFixed(5)}).`);
  }
  return { passed: reasons.length === 0, reasons };
}
