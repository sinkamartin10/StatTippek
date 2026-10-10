/**
 * Kalibrációs statisztika – TISZTA, determinisztikus függvények (nincs I/O).
 *
 * MÓDSZER: zsugorított Platt-kalibráció a logit térben:
 *     p' = σ(a + b · logit(p))
 * ahol p az alap motor (xg-poisson-1) kezdés előtti valószínűsége. Az (a, b)
 * paramétereket súlyozott, L2-büntetett logisztikus regresszió adja, amely az
 * IDENTITÁS (a = 0, b = 1 → p' = p) felé zsugorít; λ-t a validációs szakasz
 * választja. Kis adaton ez gyakorlatilag nem változtat a valószínűségeken –
 * ez szándékos: két paraméter (piactípusonként legfeljebb kettő, a globális
 * felé zsugorítva) nem tud túltanulni úgy, mint egy izotonikus vagy ML-modell.
 *
 * FÜGGETLENSÉG: ugyanannak a meccsnek a piacai korreláltak, ezért minden
 * megfigyelés súlya 1 / (a meccs megfigyeléseinek száma) – egy meccs
 * összesen 1 súlyt kap –, a pontszámok mérkőzés-átlagok, a bizonytalanság
 * pedig mérkőzés-szintű (páros) bootstrap.
 */
import { LEARNING_THRESHOLDS, type CalibrationParams, type ComparisonSummary, type GateResult, type ScoreSummary } from '../../shared/modelLearning';

export const EPS = 1e-6;

/** Egy tanító / értékelő megfigyelés: egy lezárt, kezdés előtti tipp. */
export interface Observation {
  id: string;
  matchId: string;
  market: string;
  marketType: string;
  leagueId: string;
  /** a meccs (elszámoláskor ismert) kezdése, ms */
  kickoff: number;
  /** a tipp generálásának ideje, ms */
  generatedAt: number;
  /** az alap motor NYERS valószínűsége a generáláskor – az illesztés kizárólag ezt használja */
  prob: number;
  /** 1 = a piac bejött, 0 = nem */
  y: 0 | 1;
  /** a ténylegesen kiszolgált érték és modell (csak 'recorded' sornál; régi sornál null) */
  servedProb?: number | null;
  servedModel?: string | null;
}

export type Thresholds = typeof LEARNING_THRESHOLDS;

export const clampProb = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));
export const logit = (p: number) => { const q = clampProb(p); return Math.log(q / (1 - q)); };
export const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Egy megfigyelés log loss-a és Brier-pontja. */
export const logLossOf = (p: number, y: 0 | 1) => { const q = clampProb(p); return -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); };
export const brierOf = (p: number, y: 0 | 1) => (p - y) * (p - y);

/** A kalibrált valószínűség (a piactípus saját paraméterével, ha van). */
export function applyCalibration(p: number, params: CalibrationParams, marketType: string): number {
  const { a, b } = params.byMarketType[marketType] ?? params.global;
  return sigmoid(a + b * logit(p));
}

/** Determinisztikus PRNG (mulberry32) – a bootstrap reprodukálhatóságához. */
export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mérkőzések szerint csoportosítva, stabil sorrendben. */
export function byMatch(obs: Observation[]): Map<string, Observation[]> {
  const m = new Map<string, Observation[]>();
  for (const o of obs) m.set(o.matchId, [...(m.get(o.matchId) ?? []), o]);
  return m;
}

/**
 * Súlyozott, L2-büntetett logisztikus illesztés két paraméterre (Newton-
 * módszer vonalkereséssel). A büntetés középpontja `prior` – a globális
 * illesztésnél az identitás, a piactípusnál a globális paraméter.
 */
export function fitPlatt(
  points: { x: number; y: 0 | 1; w: number }[], prior: { a: number; b: number }, lambda: number,
): { a: number; b: number } {
  const loss = (a: number, b: number) => {
    let l = 0;
    for (const p of points) {
      const z = a + b * p.x;
      l += p.w * (Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z))) - p.y * z);
    }
    return l + (lambda / 2) * ((a - prior.a) ** 2 + (b - prior.b) ** 2);
  };
  let a = prior.a;
  let b = prior.b;
  let cur = loss(a, b);
  for (let it = 0; it < 100; it++) {
    let ga = lambda * (a - prior.a);
    let gb = lambda * (b - prior.b);
    let haa = lambda;
    let hab = 0;
    let hbb = lambda;
    for (const p of points) {
      const s = sigmoid(a + b * p.x);
      const r = p.w * (s - p.y);
      const v = p.w * s * (1 - s);
      ga += r; gb += r * p.x;
      haa += v; hab += v * p.x; hbb += v * p.x * p.x;
    }
    const det = haa * hbb - hab * hab;
    if (!(det > 0)) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    let t = 1;
    let next = loss(a - t * da, b - t * db);
    while (next > cur && t > 1e-8) { t /= 2; next = loss(a - t * da, b - t * db); }
    if (next > cur) break;
    a -= t * da; b -= t * db;
    const improved = cur - next;
    cur = next;
    if (Math.abs(t * da) + Math.abs(t * db) < 1e-12 || improved < 1e-14) break;
  }
  return { a, b };
}

/** Illesztési pontok: x = logit(p), súly = 1 / (a meccs megfigyelései). */
function pointsOf(obs: Observation[]) {
  const counts = new Map<string, number>();
  for (const o of obs) counts.set(o.matchId, (counts.get(o.matchId) ?? 0) + 1);
  return obs.map((o) => ({ x: logit(o.prob), y: o.y, w: 1 / counts.get(o.matchId)!, type: o.marketType, matchId: o.matchId }));
}

/** Globális + (elegendő adatnál) piactípus-szintű paraméterek adott λ-val. */
export function fitParams(train: Observation[], lambda: number, t: Thresholds = LEARNING_THRESHOLDS): CalibrationParams {
  const pts = pointsOf(train);
  const global = fitPlatt(pts, { a: 0, b: 1 }, lambda);
  const byMarketType: Record<string, { a: number; b: number }> = {};
  const types = [...new Set(train.map((o) => o.marketType))].sort();
  for (const type of types) {
    const tp = pts.filter((p) => p.type === type);
    if (new Set(tp.map((p) => p.matchId)).size < t.minTypeTrainMatches) continue;
    byMarketType[type] = fitPlatt(tp, global, lambda);
  }
  return { global, byMarketType, lambda };
}

/** Mérkőzésenkénti átlagos log loss és Brier egy valószínűség-függvénnyel. */
export function perMatchScores(obs: Observation[], probOf: (o: Observation) => number): Map<string, { ll: number; br: number }> {
  const out = new Map<string, { ll: number; br: number }>();
  for (const [matchId, list] of byMatch(obs)) {
    let ll = 0; let br = 0;
    for (const o of list) { const p = probOf(o); ll += logLossOf(p, o.y); br += brierOf(p, o.y); }
    out.set(matchId, { ll: ll / list.length, br: br / list.length });
  }
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

/** Pontszám-összesítés (mérkőzés-átlag) + várt kalibrációs hiba (10 sáv). */
export function scoreSummary(obs: Observation[], probOf: (o: Observation) => number): ScoreSummary {
  const pm = [...perMatchScores(obs, probOf).values()];
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const o of obs) {
    const p = probOf(o);
    const bin = bins[Math.min(9, Math.floor(p * 10))];
    bin.n++; bin.p += p; bin.y += o.y;
  }
  const ece = obs.length ? bins.reduce((s, b) => s + (b.n ? (b.n / obs.length) * Math.abs(b.p / b.n - b.y / b.n) : 0), 0) : NaN;
  return { matches: pm.length, observations: obs.length, logLoss: mean(pm.map((x) => x.ll)), brier: mean(pm.map((x) => x.br)), ece };
}

/** Páros, mérkőzés-szintű percentilis-bootstrap a különbségek átlagára. */
export function bootstrapMeanCi(deltas: number[], resamples: number, level: number, seed: number): [number, number] {
  if (!deltas.length) return [NaN, NaN];
  const rnd = prng(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < deltas.length; i++) s += deltas[Math.floor(rnd() * deltas.length)];
    means.push(s / deltas.length);
  }
  means.sort((x, y) => x - y);
  const lo = means[Math.floor(((1 - level) / 2) * resamples)];
  const hi = means[Math.min(resamples - 1, Math.ceil((1 - (1 - level) / 2) * resamples) - 1)];
  return [lo, hi];
}

/** Alap vs. jelölt összevetés egy halmazon (páros, mérkőzés-szintű). */
export function compare(
  obs: Observation[], candidate: (o: Observation) => number, t: Thresholds, seed: number, level: number = t.confidenceLevel,
): ComparisonSummary & { perMatchLogLossDeltas: number[] } {
  const base = perMatchScores(obs, (o) => o.prob);
  const cand = perMatchScores(obs, candidate);
  const ids = [...base.keys()].sort();
  const dLl = ids.map((id) => base.get(id)!.ll - cand.get(id)!.ll);
  const dBr = ids.map((id) => base.get(id)!.br - cand.get(id)!.br);
  const baseline = scoreSummary(obs, (o) => o.prob);
  const candidateS = scoreSummary(obs, candidate);
  return {
    baseline,
    candidate: candidateS,
    logLossDelta: mean(dLl),
    logLossDeltaCi: bootstrapMeanCi(dLl, t.bootstrapResamples, level, seed),
    relativeLogLossImprovement: baseline.logLoss > 0 ? (baseline.logLoss - candidateS.logLoss) / baseline.logLoss : 0,
    brierDelta: mean(dBr),
    perMatchLogLossDeltas: dLl,
  };
}

export interface Split {
  train: Observation[];
  validation: Observation[];
  holdout: Observation[];
  embargoed: number;
}

/**
 * Időrendi felosztás MÉRKŐZÉS-határokon: tanító (60%) → validáció (20%) →
 * holdout (20%). A validáció és a holdout eleje elől egy embargó-ablakban
 * kezdődő meccsek kiesnek, így a korábbi szakasz eredményei a későbbi
 * előrejelzések idején biztosan ismertek (és fordítva sem szivároghat).
 * A holdoutot SEMMILYEN illesztés vagy λ-választás nem látja.
 */
export function chronologicalSplit(obs: Observation[], t: Thresholds): Split {
  const groups = [...byMatch(obs).entries()]
    .map(([id, list]) => ({ id, kickoff: Math.max(...list.map((o) => o.kickoff)), list }))
    .sort((x, y) => x.kickoff - y.kickoff || x.id.localeCompare(y.id));
  const n = groups.length;
  const trainEnd = Math.floor(n * 0.6);
  const valEnd = Math.floor(n * 0.8);
  const train = groups.slice(0, trainEnd);
  let embargoed = 0;
  const after = (list: typeof groups, boundary: number) => list.filter((g) => {
    const ok = g.kickoff >= boundary + t.embargoMs;
    if (!ok) embargoed++;
    return ok;
  });
  const lastTrain = train.length ? train[train.length - 1].kickoff : -Infinity;
  const validation = after(groups.slice(trainEnd, valEnd), lastTrain);
  const lastVal = Math.max(lastTrain, ...validation.map((g) => g.kickoff));
  const holdout = after(groups.slice(valEnd), lastVal);
  return {
    train: train.flatMap((g) => g.list),
    validation: validation.flatMap((g) => g.list),
    holdout: holdout.flatMap((g) => g.list),
    embargoed,
  };
}

/** λ-választás a validáción, majd végső illesztés tanító + validáción. */
export function fitCandidate(split: Split, t: Thresholds): { params: CalibrationParams; validationLogLoss: Record<string, number> } {
  const validationLogLoss: Record<string, number> = {};
  let best: { lambda: number; ll: number } | null = null;
  for (const lambda of t.lambdaGrid) {
    const p = fitParams(split.train, lambda, t);
    const ll = scoreSummary(split.validation, (o) => applyCalibration(o.prob, p, o.marketType)).logLoss;
    validationLogLoss[String(lambda)] = ll;
    // egyenlőségnél a nagyobb λ (konzervatívabb) nyer
    if (!best || ll < best.ll - 1e-12 || (Math.abs(ll - best.ll) <= 1e-12 && lambda > best.lambda)) best = { lambda, ll };
  }
  return { params: fitParams([...split.train, ...split.validation], best!.lambda, t), validationLogLoss };
}

export interface GroupReport { key: string; matches: number; observations: number; baselineLogLoss: number; candidateLogLoss: number; relativeChange: number }

/** Csoportonkénti (piactípus / liga) jelentés a holdouton. */
export function groupReport(holdout: Observation[], keyOf: (o: Observation) => string, candidate: (o: Observation) => number): GroupReport[] {
  const groups = new Map<string, Observation[]>();
  for (const o of holdout) groups.set(keyOf(o), [...(groups.get(keyOf(o)) ?? []), o]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => {
    const b = scoreSummary(list, (o) => o.prob);
    const c = scoreSummary(list, candidate);
    return {
      key, matches: b.matches, observations: b.observations, baselineLogLoss: b.logLoss, candidateLogLoss: c.logLoss,
      relativeChange: b.logLoss > 0 ? (c.logLoss - b.logLoss) / b.logLoss : 0,
    };
  });
}

/**
 * A kapuk. MINDEN feltételnek teljesülnie kell; bármelyik elbukása
 * elutasítást jelent, indoklással.
 */
export function evaluateGates(
  holdout: Observation[], params: CalibrationParams, cmp: ComparisonSummary, t: Thresholds, seed: number,
): { gate: GateResult; markets: (GroupReport & { guarded: boolean; degradationCi?: [number, number] })[] } {
  const reasons: string[] = [];
  const cand = (o: Observation) => applyCalibration(o.prob, params, o.marketType);

  // 1) paraméterek értelmes tartományban
  const all = [params.global, ...Object.values(params.byMarketType)];
  for (const p of all) {
    if (!Number.isFinite(p.a) || !Number.isFinite(p.b)) reasons.push('Nem véges kalibrációs paraméter.');
    else if (p.b < t.slopeRange[0] || p.b > t.slopeRange[1] || Math.abs(p.a) > t.maxAbsIntercept) {
      reasons.push(`Szélsőséges paraméter (a=${p.a.toFixed(3)}, b=${p.b.toFixed(3)}).`);
    }
  }
  // 2) érdemi javulás a holdouton
  if (!(cmp.relativeLogLossImprovement >= t.minRelativeLogLossImprovement)) {
    reasons.push(`A holdout log loss relatív javulása ${(cmp.relativeLogLossImprovement * 100).toFixed(2)}% < ${(t.minRelativeLogLossImprovement * 100).toFixed(0)}%.`);
  }
  // 3) statisztikailag igazolt javulás (a CI alsó határa > 0)
  if (!(cmp.logLossDeltaCi[0] > 0)) {
    reasons.push(`A javulás nem igazolt: a log loss-különbség ${Math.round(t.confidenceLevel * 100)}%-os CI-je [${cmp.logLossDeltaCi[0].toFixed(5)}, ${cmp.logLossDeltaCi[1].toFixed(5)}] tartalmazza a 0-t vagy negatív.`);
  }
  // 4) a Brier-pont nem romolhat
  if (!(cmp.brierDelta >= 0)) reasons.push(`A Brier-pont romlik (különbség ${cmp.brierDelta.toFixed(5)}).`);

  // 5) piactípus-őr – Bonferroni-korrekcióval a megfelelően mintázott típusokra
  const markets = groupReport(holdout, (o) => o.marketType, cand).map((g) => ({ ...g, guarded: false as boolean, degradationCi: undefined as [number, number] | undefined }));
  const guarded = markets.filter((g) => g.matches >= t.marketGuardMinMatches && g.observations >= t.marketGuardMinObservations);
  const k = Math.max(1, guarded.length);
  const level = 1 - (1 - t.confidenceLevel) / k;
  guarded.forEach((g, i) => {
    g.guarded = true;
    const list = holdout.filter((o) => o.marketType === g.key);
    const c = compare(list, cand, t, seed + 1 + i, level);
    // (jelölt − alap) > 0 = romlás
    g.degradationCi = [-c.logLossDeltaCi[1], -c.logLossDeltaCi[0]];
    if (g.relativeChange > t.marketGuardMaxRelativeDegradation) {
      reasons.push(`Romlás a(z) „${g.key}” piactípusban: ${(g.relativeChange * 100).toFixed(2)}% > ${(t.marketGuardMaxRelativeDegradation * 100).toFixed(0)}%.`);
    } else if (g.degradationCi[0] > 0) {
      reasons.push(`Szignifikáns romlás a(z) „${g.key}” piactípusban (Bonferroni-korrigált CI alsó határa > 0).`);
    }
  });

  return { gate: { passed: reasons.length === 0, reasons }, markets };
}
