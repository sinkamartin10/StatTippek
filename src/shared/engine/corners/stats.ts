/**
 * Leíró szögletstatisztikák – tiszta függvények, a gólmodelltől függetlenül.
 *
 * IDŐRENDI HELYESSÉG: minden számítás egy `cutoff` időpont ELŐTT kezdődött
 * meccseket lát csak. A cutoff a vizsgált meccs kezdése mínusz
 * `HISTORY_GAP_MS` (3 óra) – így a vizsgált meccs és a vele párhuzamosan
 * zajló, még be nem fejeződött meccsek sem szivároghatnak be.
 *
 * MINTAMÉRET: a hiányzó szögletadatú meccs kimarad az átlagokból (sosem
 * számít nullának); a `sampleSize` mindig az érvényes adatok száma, a
 * `considered` a vizsgált befejezett meccseké.
 */
import type { CornerLeagueAverages, CornerLineRate, CornerResult, CornerStats, CornerTeamBlock } from '../../types';
import { CORNER_LINES } from './markets';

export const HISTORY_GAP_MS = 3 * 3600_000;

export function cornerCutoff(kickoffIso: string): string {
  return new Date(new Date(kickoffIso).getTime() - HISTORY_GAP_MS).toISOString();
}

const iso = (s: string) => new Date(s).toISOString();

/** Az első index, ahol arr[i].date >= cutoff (arr dátum szerint növekvő). */
function lowerBound(arr: CornerResult[], cutoff: string): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].date < cutoff) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Időrendi index a szögletadatokhoz. Duplikált meccsazonosító esetén az első
 * előfordulás marad. Csak érvényes (nemnegatív egész) szögletszámú sor kerül be.
 */
export class CornerIndex {
  private byTeam = new Map<string, CornerResult[]>();
  private byLeague = new Map<string, CornerResult[]>();
  private byId = new Map<string, CornerResult>();
  readonly all: CornerResult[];

  constructor(data: CornerResult[]) {
    const seen = new Set<string>();
    const ok = (n: number) => Number.isInteger(n) && n >= 0;
    this.all = data
      .filter((r) => ok(r.homeCorners) && ok(r.awayCorners) && !seen.has(r.matchId) && (seen.add(r.matchId), true))
      .map((r) => ({ ...r, date: iso(r.date) }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.matchId.localeCompare(b.matchId));
    for (const r of this.all) {
      this.byId.set(r.matchId, r);
      for (const t of [r.homeTeamId, r.awayTeamId]) {
        if (!this.byTeam.has(t)) this.byTeam.set(t, []);
        this.byTeam.get(t)!.push(r);
      }
      if (!this.byLeague.has(r.leagueId)) this.byLeague.set(r.leagueId, []);
      this.byLeague.get(r.leagueId)!.push(r);
    }
  }

  get(matchId: string): CornerResult | undefined {
    return this.byId.get(matchId);
  }

  /** A csapat cutoff előtti meccsei, a legfrissebb ELŐL. */
  teamBefore(teamId: string, cutoff: string, venue: 'összes' | 'hazai' | 'idegen' = 'összes', limit = Infinity): CornerResult[] {
    const arr = this.byTeam.get(teamId) ?? [];
    const out: CornerResult[] = [];
    for (let i = lowerBound(arr, cutoff) - 1; i >= 0 && out.length < limit; i--) {
      const r = arr[i];
      if (venue === 'hazai' && r.homeTeamId !== teamId) continue;
      if (venue === 'idegen' && r.awayTeamId !== teamId) continue;
      out.push(r);
    }
    return out;
  }

  /** A liga cutoff előtti meccsei, a legfrissebb ELŐL, legfeljebb `limit` darab. */
  leagueBefore(leagueId: string, cutoff: string, limit = Infinity): CornerResult[] {
    const arr = this.byLeague.get(leagueId) ?? [];
    const out: CornerResult[] = [];
    for (let i = lowerBound(arr, cutoff) - 1; i >= 0 && out.length < limit; i--) out.push(arr[i]);
    return out;
  }
}

/** A csapat szemszögéből: kiharcolt, kapott, összes. */
export function perspective(teamId: string, r: CornerResult): { for: number; against: number; total: number } {
  const home = r.homeTeamId === teamId;
  return { for: home ? r.homeCorners : r.awayCorners, against: home ? r.awayCorners : r.homeCorners, total: r.homeCorners + r.awayCorners };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Egy befejezett meccs a csapat előzményeiből (szögletadattól függetlenül). */
export interface FinishedRef {
  matchId: string;
  date: string;
  homeTeamId: string;
  awayTeamId: string;
}

/**
 * Csapat-összesítő: az utolsó `window` BEFEJEZETT meccs (cutoff előtt, a
 * kért helyszínen), ebből az érvényes szögletadatúak alapján.
 */
export function teamCornerStats(
  teamId: string, finished: FinishedRef[], corners: Map<string, CornerResult>, cutoff: string,
  window: number, venue: CornerStats['venue'],
): CornerStats {
  const rows = finished
    .filter((f) => iso(f.date) < cutoff)
    .filter((f) => (venue === 'hazai' ? f.homeTeamId === teamId : venue === 'idegen' ? f.awayTeamId === teamId : f.homeTeamId === teamId || f.awayTeamId === teamId))
    .sort((a, b) => iso(b.date).localeCompare(iso(a.date)))
    .slice(0, window);
  const valid = rows.map((f) => corners.get(f.matchId)).filter((r): r is CornerResult => !!r).map((r) => perspective(teamId, r));
  return {
    venue, window, considered: rows.length, sampleSize: valid.length,
    forAvg: mean(valid.map((v) => v.for)), againstAvg: mean(valid.map((v) => v.against)), totalAvg: mean(valid.map((v) => v.total)),
  };
}

/** Vonal-teljesülés: hány érvényes értéknél volt TÖBB a vonalnál. */
export function lineRates(values: number[], lines: number[]): CornerLineRate[] {
  return lines.map((line) => ({ line, over: values.filter((v) => v > line).length, sampleSize: values.length }));
}

export function teamCornerBlock(
  teamId: string, side: 'home' | 'away', finished: FinishedRef[], corners: Map<string, CornerResult>, cutoff: string,
): CornerTeamBlock {
  const last10Rows = finished
    .filter((f) => iso(f.date) < cutoff && (f.homeTeamId === teamId || f.awayTeamId === teamId))
    .sort((a, b) => iso(b.date).localeCompare(iso(a.date)))
    .slice(0, 10)
    .map((f) => corners.get(f.matchId))
    .filter((r): r is CornerResult => !!r)
    .map((r) => perspective(teamId, r));
  return {
    teamId,
    last5: teamCornerStats(teamId, finished, corners, cutoff, 5, 'összes'),
    last10: teamCornerStats(teamId, finished, corners, cutoff, 10, 'összes'),
    venue: teamCornerStats(teamId, finished, corners, cutoff, 10, side === 'home' ? 'hazai' : 'idegen'),
    totalLines: lineRates(last10Rows.map((v) => v.total), CORNER_LINES.total),
    forLines: lineRates(last10Rows.map((v) => v.for), CORNER_LINES[side]),
  };
}

export interface LeagueCornerSummary extends CornerLeagueAverages {
  homeVar: number | null;
  awayVar: number | null;
}

/** Liga-átlagok és -szórások a cutoff előtti legutóbbi `limit` meccsből. */
export function leagueCornerAverages(idx: CornerIndex, leagueId: string, cutoff: string, limit = 300): LeagueCornerSummary {
  const rows = idx.leagueBefore(leagueId, cutoff, limit);
  const h = rows.map((r) => r.homeCorners), a = rows.map((r) => r.awayCorners);
  const v = (xs: number[]) => {
    const m = mean(xs);
    return m == null || xs.length < 2 ? null : xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  };
  return {
    leagueId, sampleSize: rows.length,
    homeAvg: mean(h), awayAvg: mean(a), totalAvg: mean(rows.map((r) => r.homeCorners + r.awayCorners)),
    homeVar: v(h), awayVar: v(a),
  };
}
