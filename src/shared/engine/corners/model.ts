/**
 * corners-nb-1 – determinisztikus szöglet-előrejelző modell, a gólmodelltől
 * (`xg-poisson-1`) teljesen függetlenül. Csak szögletadatot olvas.
 *
 * VÁRHATÓ ÉRTÉK (szorzós szerkezet a liga-átlaghoz mérve):
 *   λ_hazai = r(hazai csapat otthon kiharcolt) × r(vendég idegenben kapott) / liga hazai átlag
 *   λ_vendég = r(vendég idegenben kiharcolt) × r(hazai otthon kapott) / liga vendég átlag
 * ahol r(·) a csapat utolsó `window` releváns meccsének átlaga, a liga-átlag
 * felé húzva: (összeg + k·μ) / (n + k). A `k` NEM bizonyítottan optimális –
 * értékét kizárólag az időrendi visszateszt hangolási szakasza választja.
 *
 * ELOSZLÁS: negatív binomiális (a szöglet túlszóródó), a szóródási paramétert
 * a liga hazai/vendég szögleteinek átlagából és szórásából becsüljük
 * (momentum-módszer); ha a szórás nem nagyobb az átlagnál, Poisson. A
 * `distribution: 'poisson'` változat a visszateszt összehasonlításához van.
 *
 * ÖSSZES SZÖGLET: a hazai és vendég eloszlás konvolúciója. FELTÉTELEZÉS: a
 * két csapat szögletszáma (a várható értékek ismeretében) független. Ezt a
 * visszateszt ellenőrzi (a két oldal empirikus korrelációját jelenti).
 *
 * A valószínűségek 0 és 1 közöttiek, a vonalak mentén monoton csökkenők, és
 * a teljes eloszlás összege 1 (a farok a legutolsó cellába kerül).
 */
import type { CornerMarketProbability, CornerPrediction } from '../../types';
import { CORNER_LINES, cornerMarketCode, cornerMarketLabel, type CornerScope } from './markets';
import { CornerIndex, leagueCornerAverages, perspective } from './stats';

export const CORNER_MODEL_VERSION = 'corners-nb-1';

export interface CornerModelParams {
  /** zsugorítás erőssége (meccs-egyenérték) */
  k: number;
  /** a csapat-ráták ablaka (releváns helyszínű érvényes meccsek) */
  window: number;
  distribution: 'negbin' | 'poisson';
  minTeamMatches: number;
  minVenueMatches: number;
  minLeagueMatches: number;
  /** a liga-átlaghoz használt legutóbbi meccsek száma */
  leagueWindow: number;
  /** az eloszlás csonkolása (a farok az utolsó cellába kerül) */
  maxCorners: number;
}

export const DEFAULT_CORNER_PARAMS: CornerModelParams = {
  k: 5, window: 10, distribution: 'negbin',
  minTeamMatches: 8, minVenueMatches: 4, minLeagueMatches: 40,
  leagueWindow: 300, maxCorners: 40,
};

export type CornerMissing = 'league' | 'home_team' | 'away_team' | 'home_venue' | 'away_venue';

export interface CornerExpectation {
  ok: boolean;
  missing: CornerMissing[];
  reasons: string[];
  homeExpected: number;
  awayExpected: number;
  /** negatív binomiális alakparaméter (Infinity = Poisson) */
  rHome: number;
  rAway: number;
  counts: { league: number; home: number; away: number; homeVenue: number; awayVenue: number };
}

/** Zsugorított átlag: n=0 esetén maga a prior. */
export function shrink(sum: number, n: number, prior: number, k: number): number {
  return n + k > 0 ? (sum + k * prior) / (n + k) : prior;
}

/** Momentum-becslés: r = μ² / (σ² − μ); ha nincs túlszóródás, Infinity (Poisson). */
export function dispersion(mean: number | null, variance: number | null): number {
  if (mean == null || variance == null || !(mean > 0) || variance <= mean * 1.0001) return Infinity;
  return (mean * mean) / (variance - mean);
}

/**
 * Darabszám-eloszlás 0..maxK-ig (az utolsó cella a ≥maxK farok), összege 1.
 * r = Infinity → Poisson, különben negatív binomiális (átlag μ, szórásnégyzet μ + μ²/r).
 */
export function countPmf(mu: number, r: number, maxK: number): number[] {
  const out = new Array<number>(maxK + 1).fill(0);
  if (!(mu > 0)) { out[0] = 1; return out; }
  let p: number;
  let step: (k: number) => number;
  if (!Number.isFinite(r)) {
    p = Math.exp(-mu);
    step = (k) => mu / (k + 1);
  } else {
    const q = mu / (r + mu);
    p = Math.exp(r * Math.log(r / (r + mu)));
    step = (k) => ((k + r) / (k + 1)) * q;
  }
  let acc = 0;
  for (let k = 0; k < maxK; k++) {
    out[k] = p;
    acc += p;
    p *= step(k);
  }
  out[maxK] = Math.max(0, 1 - acc);
  return out;
}

/** Két független darabszám összegének eloszlása (0..maxK, a farok az utolsó cellában). */
export function convolve(a: number[], b: number[], maxK: number): number[] {
  const out = new Array<number>(maxK + 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    for (let j = 0; j < b.length; j++) out[Math.min(maxK, i + j)] += a[i] * b[j];
  }
  return out;
}

/** P(X > line) – fél vonalra (pl. 9,5), így nincs „push”. */
export function probOver(pmf: number[], line: number): number {
  let s = 0;
  for (let k = Math.floor(line) + 1; k < pmf.length; k++) s += pmf[k];
  return Math.min(1, Math.max(0, s));
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/**
 * A mérkőzés várható szögletszámai a cutoff előtti adatokból. Ha bármely
 * minimum nem teljesül, `ok: false` és a hiány pontos oka.
 */
export function cornerExpectation(
  idx: CornerIndex, homeId: string, awayId: string, leagueId: string, cutoff: string,
  params: CornerModelParams = DEFAULT_CORNER_PARAMS, names: { home?: string; away?: string; league?: string } = {},
): CornerExpectation {
  const lg = leagueCornerAverages(idx, leagueId, cutoff, params.leagueWindow);
  const homeAll = idx.teamBefore(homeId, cutoff).length;
  const awayAll = idx.teamBefore(awayId, cutoff).length;
  const homeVenue = idx.teamBefore(homeId, cutoff, 'hazai', params.window);
  const awayVenue = idx.teamBefore(awayId, cutoff, 'idegen', params.window);
  const homeVenueAll = idx.teamBefore(homeId, cutoff, 'hazai').length;
  const awayVenueAll = idx.teamBefore(awayId, cutoff, 'idegen').length;

  const missing: CornerMissing[] = [];
  const reasons: string[] = [];
  const hn = names.home ?? 'A hazai csapat', an = names.away ?? 'A vendégcsapat';
  if (lg.sampleSize < params.minLeagueMatches) { missing.push('league'); reasons.push(`${names.league ?? 'A bajnokság'}: csak ${lg.sampleSize} érvényes szögletmeccs áll rendelkezésre (legalább ${params.minLeagueMatches} kell).`); }
  if (homeAll < params.minTeamMatches) { missing.push('home_team'); reasons.push(`${hn}: csak ${homeAll} érvényes korábbi szögletmeccs (legalább ${params.minTeamMatches} kell).`); }
  if (awayAll < params.minTeamMatches) { missing.push('away_team'); reasons.push(`${an}: csak ${awayAll} érvényes korábbi szögletmeccs (legalább ${params.minTeamMatches} kell).`); }
  if (homeVenueAll < params.minVenueMatches) { missing.push('home_venue'); reasons.push(`${hn}: csak ${homeVenueAll} érvényes hazai szögletmeccs (legalább ${params.minVenueMatches} kell).`); }
  if (awayVenueAll < params.minVenueMatches) { missing.push('away_venue'); reasons.push(`${an}: csak ${awayVenueAll} érvényes idegenbeli szögletmeccs (legalább ${params.minVenueMatches} kell).`); }

  const counts = { league: lg.sampleSize, home: homeAll, away: awayAll, homeVenue: homeVenueAll, awayVenue: awayVenueAll };
  if (missing.length || lg.homeAvg == null || lg.awayAvg == null || !(lg.homeAvg > 0) || !(lg.awayAvg > 0)) {
    if (!missing.includes('league') && (lg.homeAvg == null || !(lg.homeAvg > 0) || !(lg.awayAvg! > 0))) {
      missing.push('league');
      reasons.push('A liga szögletátlaga nem becsülhető.');
    }
    return { ok: false, missing, reasons, homeExpected: NaN, awayExpected: NaN, rHome: Infinity, rAway: Infinity, counts };
  }

  const muH = lg.homeAvg, muA = lg.awayAvg;
  const hv = homeVenue.map((r) => perspective(homeId, r));
  const av = awayVenue.map((r) => perspective(awayId, r));
  const homeFor = shrink(sum(hv.map((x) => x.for)), hv.length, muH, params.k);
  const homeAgainst = shrink(sum(hv.map((x) => x.against)), hv.length, muA, params.k);
  const awayFor = shrink(sum(av.map((x) => x.for)), av.length, muA, params.k);
  const awayAgainst = shrink(sum(av.map((x) => x.against)), av.length, muH, params.k);

  const homeExpected = (homeFor * awayAgainst) / muH;
  const awayExpected = (awayFor * homeAgainst) / muA;
  const nb = params.distribution === 'negbin';
  return {
    ok: true, missing, reasons, homeExpected, awayExpected,
    rHome: nb ? dispersion(lg.homeAvg, lg.homeVar) : Infinity,
    rAway: nb ? dispersion(lg.awayAvg, lg.awayVar) : Infinity,
    counts,
  };
}

/** Liga-átlag alapú alapmodell (baseline): minden meccsre a liga hazai/vendég átlaga. */
export function baselineExpectation(idx: CornerIndex, leagueId: string, cutoff: string, params: CornerModelParams = DEFAULT_CORNER_PARAMS): CornerExpectation | null {
  const lg = leagueCornerAverages(idx, leagueId, cutoff, params.leagueWindow);
  if (lg.sampleSize < params.minLeagueMatches || !(lg.homeAvg! > 0) || !(lg.awayAvg! > 0)) return null;
  const nb = params.distribution === 'negbin';
  return {
    ok: true, missing: [], reasons: [], homeExpected: lg.homeAvg!, awayExpected: lg.awayAvg!,
    rHome: nb ? dispersion(lg.homeAvg, lg.homeVar) : Infinity,
    rAway: nb ? dispersion(lg.awayAvg, lg.awayVar) : Infinity,
    counts: { league: lg.sampleSize, home: 0, away: 0, homeVenue: 0, awayVenue: 0 },
  };
}

/** Vonalankénti „több mint” valószínűségek egy várható-érték párból. */
export function cornerLineProbabilities(e: Pick<CornerExpectation, 'homeExpected' | 'awayExpected' | 'rHome' | 'rAway'>, maxK = DEFAULT_CORNER_PARAMS.maxCorners): Record<CornerScope, { line: number; over: number }[]> {
  const ph = countPmf(e.homeExpected, e.rHome, maxK);
  const pa = countPmf(e.awayExpected, e.rAway, maxK);
  const pt = convolve(ph, pa, 2 * maxK);
  const at = (pmf: number[], lines: number[]) => lines.map((line) => ({ line, over: probOver(pmf, line) }));
  return { total: at(pt, CORNER_LINES.total), home: at(ph, CORNER_LINES.home), away: at(pa, CORNER_LINES.away) };
}

export function cornerPrediction(e: CornerExpectation, params: CornerModelParams = DEFAULT_CORNER_PARAMS): CornerPrediction {
  const probs = cornerLineProbabilities(e, params.maxCorners);
  const markets: CornerMarketProbability[] = [];
  for (const scope of ['total', 'home', 'away'] as CornerScope[]) {
    for (const { line, over } of probs[scope]) {
      const market = cornerMarketCode(scope, 'O', line);
      markets.push({ market, label: cornerMarketLabel(market), scope, line, over, under: 1 - over });
    }
  }
  return {
    modelVersion: CORNER_MODEL_VERSION,
    distribution: Number.isFinite(e.rHome) || Number.isFinite(e.rAway) ? 'negbin' : 'poisson',
    homeExpected: e.homeExpected, awayExpected: e.awayExpected, totalExpected: e.homeExpected + e.awayExpected,
    markets,
  };
}
