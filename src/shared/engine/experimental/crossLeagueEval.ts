/**
 * Értékelő segédfüggvények a kísérleti modell offline összehasonlításához.
 * Tiszta függvények; determinisztikus (rögzített magú) bootstrap.
 */
import type { PoissonResult } from '../../types';

export interface Probs {
  /** 1X2 */
  p1: number; pX: number; p2: number;
  /** több mint 2,5 gól */
  pO25: number;
  /** mindkét csapat szerez gólt */
  pBtts: number;
}

export interface Outcome { homeGoals: number; awayGoals: number }

export const probsFromPoisson = (p: PoissonResult): Probs => ({ p1: p.homeWin, pX: p.draw, p2: p.awayWin, pO25: p.over['2.5'], pBtts: p.bttsYes });

const EPS = 1e-12;
const clamp = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));

/** Többosztályos (1X2) log loss: −ln p(tényleges kimenetel). */
export function logLoss1x2(p: Probs, o: Outcome): number {
  const s = p.p1 + p.pX + p.p2;
  const actual = o.homeGoals > o.awayGoals ? p.p1 : o.homeGoals === o.awayGoals ? p.pX : p.p2;
  return -Math.log(clamp(actual / s));
}

/** Többosztályos Brier: Σ (p_k − 1[k])². */
export function brier1x2(p: Probs, o: Outcome): number {
  const s = p.p1 + p.pX + p.p2;
  const y = [o.homeGoals > o.awayGoals, o.homeGoals === o.awayGoals, o.homeGoals < o.awayGoals].map((b) => (b ? 1 : 0));
  return [p.p1 / s, p.pX / s, p.p2 / s].reduce((acc, q, i) => acc + (q - y[i]) ** 2, 0);
}

export const logLossBin = (p: number, y: boolean) => -Math.log(clamp(y ? p : 1 - p));
export const brierBin = (p: number, y: boolean) => (p - (y ? 1 : 0)) ** 2;

export interface Scores { ll1x2: number; br1x2: number; llO25: number; brO25: number; llBtts: number; brBtts: number }

export function score(p: Probs, o: Outcome): Scores {
  const over = o.homeGoals + o.awayGoals > 2.5, btts = o.homeGoals > 0 && o.awayGoals > 0;
  return {
    ll1x2: logLoss1x2(p, o), br1x2: brier1x2(p, o),
    llO25: logLossBin(p.pO25, over), brO25: brierBin(p.pO25, over),
    llBtts: logLossBin(p.pBtts, btts), brBtts: brierBin(p.pBtts, btts),
  };
}

/**
 * Naiv alapmodell: a tanítóablak (cutoff előtt lezárt meccsek) relatív gyakoriságai,
 * Laplace-simítással. Ha a sorozatból kevés a minta, a teljes (azonos típusú) adat
 * gyakoriságát használja. Ez az a mérce, amit egy előrejelzésnek legalább hoznia kell.
 */
export function naiveProbs(history: Outcome[]): Probs {
  const n = history.length;
  const c = (f: (o: Outcome) => boolean) => history.filter(f).length;
  const h = c((o) => o.homeGoals > o.awayGoals), d = c((o) => o.homeGoals === o.awayGoals);
  return {
    p1: (h + 1) / (n + 3), pX: (d + 1) / (n + 3), p2: (n - h - d + 1) / (n + 3),
    pO25: (c((o) => o.homeGoals + o.awayGoals > 2.5) + 1) / (n + 2),
    pBtts: (c((o) => o.homeGoals > 0 && o.awayGoals > 0) + 1) / (n + 2),
  };
}

/** Determinisztikus álvéletlen-generátor (mulberry32). */
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

/**
 * Párosított, meccsenkénti bootstrap az átlagos különbségre (Δ = A − B; log
 * lossnál a negatív érték azt jelenti, hogy A a jobb). 95%-os percentilis-intervallum.
 */
export function pairedBootstrap(diffs: number[], iterations = 2000, seed = 20261015): { n: number; mean: number; lo: number; hi: number } {
  const n = diffs.length;
  if (!n) return { n: 0, mean: NaN, lo: NaN, hi: NaN };
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const r = rng(seed);
  const means: number[] = [];
  for (let b = 0; b < iterations; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(r() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { n, mean, lo: means[Math.floor(0.025 * iterations)], hi: means[Math.min(iterations - 1, Math.ceil(0.975 * iterations) - 1)] };
}

/** Kalibrációs táblázat (10 sáv) egy bináris eseményre. */
export function calibration(points: { p: number; y: boolean }[], bins = 10): { from: number; to: number; n: number; meanP: number; observed: number }[] {
  const out = Array.from({ length: bins }, (_, i) => ({ from: i / bins, to: (i + 1) / bins, n: 0, meanP: 0, observed: 0 }));
  for (const { p, y } of points) {
    const b = out[Math.min(bins - 1, Math.floor(p * bins))];
    b.n++; b.meanP += p; b.observed += y ? 1 : 0;
  }
  for (const b of out) if (b.n) { b.meanP /= b.n; b.observed /= b.n; }
  return out;
}

/** Várható kalibrációs hiba (ECE) a sávokból. */
export function ece(table: ReturnType<typeof calibration>): number {
  const n = table.reduce((s, b) => s + b.n, 0);
  return n ? table.reduce((s, b) => s + (b.n / n) * Math.abs(b.meanP - b.observed), 0) : NaN;
}

/** 1X2 egy-a-többi ellen kalibrációs pontjai (mindhárom kimenetel összevonva). */
export function calibrationPoints1x2(rows: { p: Probs; o: Outcome }[]): { p: number; y: boolean }[] {
  const out: { p: number; y: boolean }[] = [];
  for (const { p, o } of rows) {
    const s = p.p1 + p.pX + p.p2;
    out.push({ p: p.p1 / s, y: o.homeGoals > o.awayGoals }, { p: p.pX / s, y: o.homeGoals === o.awayGoals }, { p: p.p2 / s, y: o.homeGoals < o.awayGoals });
  }
  return out;
}
