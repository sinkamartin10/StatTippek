/**
 * Az alap motor (xg-poisson-1) hibáinak elemzése – TISZTA, determinisztikus,
 * CSAK OLVASÓ riport (nincs I/O, nincs illesztés, nem módosít modellt).
 *
 * Miért kell: az `evaluate()` jelöltet csak elegendő adatnál illeszt; addig a
 * production modell kalibrációs hibáiról semmilyen kimutatás nem készült. Ez a
 * riport a lezárt, kezdés előtti, ÉRVÉNYES megfigyeléseken (ugyanaz a
 * `buildObservations` szűrés, ugyanaz a nyers `model_prob`) mutatja:
 *  - log loss, Brier, ECE (mérkőzés-átlag / megfigyelés-súlyozott),
 *  - megbízhatósági táblázat: előrejelzett vs. tényleges gyakoriság sávonként,
 *    Wilson-intervallummal,
 *  - piactípus és bajnokság szerinti bontás,
 *  - összevetés egy NAIV, SZIVÁRGÁSMENTES baseline-nal: piaconkénti
 *    tapasztalati gyakoriság, KIZÁRÓLAG olyan korábbi meccsekből, amelyek
 *    eredménye a tipp generálásakor (embargóval) már ismert volt; páros,
 *    mérkőzés-szintű bootstrap-CI-vel,
 *  - elegendőségi jelzés: kis vagy időben koncentrált mintán kimondja, hogy
 *    következtetés nem vonható le.
 *
 * Pénzügyi állítást nem tesz (odds nélkül nem is tehet).
 */
import type { DiagnosticsGroup, DiagnosticsReport, NaiveBaselineComparison, ReliabilityBin } from '../../shared/modelLearning';

export type { DiagnosticsGroup, DiagnosticsReport, NaiveBaselineComparison, ReliabilityBin };
import { bootstrapMeanCi, byMatch, perMatchScores, scoreSummary, type Observation, type Thresholds } from './calibration';

export const DIAGNOSTICS_METHOD = 'diagnostics-v1';

/** 95%-os Wilson-intervallum egy arányra. */
export function wilson(k: number, n: number, z = 1.959964): [number, number] | null {
  if (n <= 0) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export function reliabilityTable(obs: Observation[], bins = 10): ReliabilityBin[] {
  const acc = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  for (const o of obs) {
    const b = acc[Math.min(bins - 1, Math.floor(o.prob * bins))];
    b.n++; b.p += o.prob; b.y += o.y;
  }
  return acc.map((b, i) => ({
    from: i / bins, to: (i + 1) / bins, observations: b.n,
    meanPredicted: b.n ? b.p / b.n : null,
    observedRate: b.n ? b.y / b.n : null,
    observedCi: wilson(b.y, b.n),
  }));
}

function groups(obs: Observation[], keyOf: (o: Observation) => string, minMatches: number): DiagnosticsGroup[] {
  const m = new Map<string, Observation[]>();
  for (const o of obs) m.set(keyOf(o), [...(m.get(keyOf(o)) ?? []), o]);
  return [...m.entries()]
    .map(([key, list]) => {
      const s = scoreSummary(list, (o) => o.prob);
      return {
        key, matches: s.matches, observations: s.observations, logLoss: s.logLoss, brier: s.brier,
        meanPredicted: list.reduce((a, o) => a + o.prob, 0) / list.length,
        observedRate: list.reduce((a, o) => a + o.y, 0) / list.length,
      };
    })
    .filter((g) => g.matches >= minMatches)
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** a naiv baseline-hoz legalább ennyi korábbi, ismert kimenetelű megfigyelés kell piaconként */
export const NAIVE_MIN_HISTORY = 20;

/**
 * Naiv, szivárgásmentes baseline: az `o` megfigyelés piacának tapasztalati
 * gyakorisága (Laplace-simítással) KIZÁRÓLAG olyan korábbi megfigyelésekből,
 * amelyek meccse `embargoMs`-sel az `o` generálása ELŐTT kezdődött (vagyis az
 * eredmény a tipp idején ismert volt). Piac-szinten, ha kevés, piactípus-
 * szinten; ha az sem elég: nincs baseline-érték (null).
 */
export function naiveBaselineProbs(obs: Observation[], embargoMs: number, minHistory = NAIVE_MIN_HISTORY): Map<string, number | null> {
  const history = [...obs].sort((a, b) => a.kickoff - b.kickoff || a.id.localeCompare(b.id));
  const targets = [...obs].sort((a, b) => a.generatedAt - b.generatedAt || a.id.localeCompare(b.id));
  const byMarket = new Map<string, { n: number; y: number }>();
  const byType = new Map<string, { n: number; y: number }>();
  const add = (m: Map<string, { n: number; y: number }>, k: string, y: number) => {
    const c = m.get(k) ?? { n: 0, y: 0 };
    c.n++; c.y += y;
    m.set(k, c);
  };
  const out = new Map<string, number | null>();
  let h = 0;
  for (const t of targets) {
    // minden olyan meccs eredménye, amely embargóval a tipp generálása előtt kezdődött
    while (h < history.length && history[h].kickoff + embargoMs <= t.generatedAt) {
      add(byMarket, history[h].market, history[h].y);
      add(byType, history[h].marketType, history[h].y);
      h++;
    }
    const m = byMarket.get(t.market), ty = byType.get(t.marketType);
    const c = m && m.n >= minHistory ? m : ty && ty.n >= minHistory ? ty : null;
    out.set(t.id, c ? (c.y + 1) / (c.n + 2) : null);
  }
  return out;
}

export function diagnose(obs: Observation[], excluded: Record<string, number>, ctx: { baseEngineVersion: string; now: Date; t: Thresholds; seed?: number }): DiagnosticsReport {
  const t = ctx.t;
  const limitations = [
    'Csak a production modell (xg-poisson-1) MÚLTBELI, lezárt előrejelzéseit írja le; jövőbeli teljesítményt nem bizonyít.',
    'A naiv baseline csak viszonyítási pont (piaconkénti korábbi gyakoriság), nem piaci odds; pénzügyi eredményességről nem mond semmit.',
    'Egy meccs piacai összefüggnek: minden pontszám mérkőzés-átlag, a bizonytalanság mérkőzés-szintű bootstrap.',
  ];
  if (!obs.length) {
    return {
      method: DIAGNOSTICS_METHOD, baseEngineVersion: ctx.baseEngineVersion, generatedAt: ctx.now.toISOString(),
      period: null, sizes: { matches: 0, observations: 0 }, excluded, model: null, reliability: reliabilityTable([]),
      byMarketType: [], byLeague: [], naiveBaseline: null,
      sufficiency: { enoughForConclusions: false, notes: ['Nincs érvényes, lezárt, kezdés előtti megfigyelés.'] },
      limitations,
    };
  }
  const matches = byMatch(obs).size;
  const kickoffs = obs.map((o) => o.kickoff);
  const days = new Set(obs.map((o) => new Date(o.kickoff).toISOString().slice(0, 10))).size;
  const model = scoreSummary(obs, (o) => o.prob);

  // naiv baseline – páros összevetés a lefedett megfigyeléseken
  const naive = naiveBaselineProbs(obs, t.embargoMs);
  const covered = obs.filter((o) => naive.get(o.id) != null);
  let naiveBaseline: NaiveBaselineComparison | null = null;
  if (covered.length) {
    const pm = perMatchScores(covered, (o) => o.prob);
    const pb = perMatchScores(covered, (o) => naive.get(o.id)!);
    const ids = [...pm.keys()].sort();
    const dLl = ids.map((id) => pb.get(id)!.ll - pm.get(id)!.ll);
    const dBr = ids.map((id) => pb.get(id)!.br - pm.get(id)!.br);
    naiveBaseline = {
      description: `Piaconkénti tapasztalati gyakoriság (Laplace-simítás), csak a tipp generálásakor már ismert eredményekből (embargó ${Math.round(t.embargoMs / 3600_000)} óra; legalább ${NAIVE_MIN_HISTORY} korábbi megfigyelés, különben piactípus-szint).`,
      coveredMatches: ids.length, coveredObservations: covered.length, uncoveredObservations: obs.length - covered.length,
      model: scoreSummary(covered, (o) => o.prob),
      baseline: scoreSummary(covered, (o) => naive.get(o.id)!),
      modelLogLossAdvantage: dLl.reduce((s, x) => s + x, 0) / dLl.length,
      modelLogLossAdvantageCi: bootstrapMeanCi(dLl, t.bootstrapResamples, t.confidenceLevel, ctx.seed ?? 20261014),
      modelBrierAdvantage: dBr.reduce((s, x) => s + x, 0) / dBr.length,
    };
  }

  const notes: string[] = [];
  if (matches < t.minHoldoutMatches) notes.push(`Kevés mérkőzés: ${matches} (következtetéshez legalább ${t.minHoldoutMatches}).`);
  if (obs.length < t.minHoldoutObservations) notes.push(`Kevés megfigyelés: ${obs.length} (legalább ${t.minHoldoutObservations}).`);
  if (days < 14) notes.push(`Időben koncentrált minta: ${days} különböző kezdési nap – az egy fordulón belüli eredmények összefüggnek, a tényleges bizonytalanság nagyobb, mint amit a darabszám sugall.`);
  if (naiveBaseline && naiveBaseline.coveredMatches < t.minHoldoutMatches) notes.push(`A naiv baseline-nal páros összevetés csak ${naiveBaseline.coveredMatches} mérkőzésen lehetséges.`);
  if (!naiveBaseline) notes.push('A naiv baseline-hoz nincs elég korábbi, ismert kimenetelű adat.');

  return {
    method: DIAGNOSTICS_METHOD, baseEngineVersion: ctx.baseEngineVersion, generatedAt: ctx.now.toISOString(),
    period: { firstKickoff: new Date(Math.min(...kickoffs)).toISOString(), lastKickoff: new Date(Math.max(...kickoffs)).toISOString(), distinctKickoffDays: days },
    sizes: { matches, observations: obs.length }, excluded, model,
    reliability: reliabilityTable(obs),
    byMarketType: groups(obs, (o) => o.marketType, 1),
    byLeague: groups(obs, (o) => o.leagueId, t.marketGuardMinMatches),
    naiveBaseline,
    sufficiency: { enoughForConclusions: notes.length === 0, notes },
    limitations,
  };
}
