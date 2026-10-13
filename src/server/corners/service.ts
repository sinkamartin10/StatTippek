/**
 * Szögletelemzés-szolgáltatás (corners-nb-1) – KÜLÖN réteg.
 *
 * NEM része az `AnalysisService.analyze()` útnak: a gólelemzés, a tippek, az
 * archívum és a tanulási réteg semmit nem kap innen, és ennek a hibája nem
 * érintheti őket. Csak a mérkőzésoldal PRO-végpontja hívja, egy meccsre
 * (a Tippek listán és a szelvényépítőben ezért nem indul tömeges ESPN-lekérés).
 *
 * Modell-valószínűség csak validált modellnél (CORNER_RELEASE.validated) és
 * teljesülő adatminimumoknál kerül a válaszba; szöglet-odds/value nincs.
 */
import type { CornerAnalysis, CornerResult, Match, MatchResult } from '../../shared/types';
import type { MatchDataProvider } from '../data/provider';
import { CORNER_UNSUPPORTED_LEAGUES } from '../data/espnCorners';
import { CornerIndex, cornerCutoff, leagueCornerAverages, teamCornerBlock, type FinishedRef } from '../../shared/engine/corners/stats';
import { cornerExpectation, cornerPrediction } from '../../shared/engine/corners/model';
import { CORNER_RELEASE, type CornerRelease } from '../../shared/engine/corners/release';

const OK_TTL_MS = 30 * 60_000;
const FAIL_TTL_MS = 2 * 60_000;
/**
 * KISZOLGÁLÁS = VALIDÁLÁS: a lekért előzmény mérete a kiadott paraméterekből
 * (CORNER_RELEASE.params) származik, hogy élesben ugyanaz a számítás fusson,
 * mint az időrendi visszatesztben (ablak = releváns helyszínű meccsek, liga-ablak).
 * Tartalék a hiányzó szögletadatú meccsek pótlására; felső korlát a lekérés méretére.
 */
const VENUE_MARGIN = 10;
const TEAM_HISTORY_CAP = 80;
/** liga-előzmény: legfeljebb ennyi (keleti idő szerinti) hónap visszafelé */
const LEAGUE_MAX_MONTHS = 24;

export interface CornerServiceOptions {
  release?: CornerRelease;
  now?: () => Date;
}

export class CornerService {
  private cache = new Map<string, { at: number; ttl: number; kickoffMs: number; value: CornerAnalysis }>();
  private inflight = new Map<string, Promise<CornerAnalysis | null>>();

  constructor(private data: MatchDataProvider, private opts: CornerServiceOptions = {}) {}

  private get release(): CornerRelease { return this.opts.release ?? CORNER_RELEASE; }
  private now(): Date { return this.opts.now?.() ?? new Date(); }

  async analyze(matchId: string): Promise<CornerAnalysis | null> {
    const hit = this.cache.get(matchId);
    const nowMs = this.now().getTime();
    // a kezdés előtt számolt előrejelzés a kezdés után a cache-ből sem szolgálható ki
    const stalePrematch = !!hit?.value.prediction && nowMs >= hit.kickoffMs;
    if (hit && !stalePrematch && nowMs - hit.at < hit.ttl) return hit.value;
    const running = this.inflight.get(matchId);
    if (running) return running;
    const p = this.compute(matchId).then((r) => {
      if (r) this.cache.set(matchId, { at: this.now().getTime(), ttl: r.value.status === 'unavailable' ? FAIL_TTL_MS : OK_TTL_MS, kickoffMs: r.kickoffMs, value: r.value });
      return r?.value ?? null;
    }).finally(() => this.inflight.delete(matchId));
    this.inflight.set(matchId, p);
    return p;
  }

  private base(matchId: string, status: CornerAnalysis['status'], reasons: string[]): CornerAnalysis {
    const r = this.release;
    return {
      matchId, modelVersion: r.modelVersion, generatedAt: this.now().toISOString(), status, reasons,
      source: this.data.name, coverage: { considered: 0, valid: 0, skipped: {} },
      league: null, home: null, away: null, prediction: null,
      validation: { validated: r.validated, note: r.note, scopes: r.validated ? [...r.validatedScopes] : [] },
      oddsAvailable: false,
    };
  }

  private async compute(matchId: string): Promise<{ value: CornerAnalysis; kickoffMs: number } | null> {
    const match = await this.data.getMatch(matchId);
    if (!match) return null;
    const kickoffMs = new Date(match.kickoff).getTime();
    const value = await this.computeFor(match);
    return { value, kickoffMs: Number.isFinite(kickoffMs) ? kickoffMs : -Infinity };
  }

  /**
   * Mérkőzés előtti előrejelzés csak még el nem kezdődött, ütemezett meccsre
   * adható: a státusz `scheduled` ÉS a kezdés a jövőben van (a szolgáltató
   * memóriabeli státusza elavult lehet, ezért az időpontot is nézzük). Élő,
   * befejezett, halasztott vagy érvénytelen kezdésű meccsre csak a (kezdés
   * előtti) leíró statisztika jelenik meg.
   */
  private prematchBlock(match: Match): string | null {
    const k = new Date(match.kickoff).getTime();
    if (!Number.isFinite(k)) return 'A mérkőzés kezdési időpontja nem ismert – mérkőzés előtti szöglet-előrejelzés nem készül.';
    if (match.status === 'postponed') return 'A mérkőzést elhalasztották, az új kezdés bizonytalan – mérkőzés előtti szöglet-előrejelzés nem készül.';
    if (match.status !== 'scheduled' || k <= this.now().getTime()) return 'A mérkőzés már elkezdődött vagy befejeződött – mérkőzés előtti szöglet-előrejelzés nem készül.';
    return null;
  }

  private async computeFor(match: Match): Promise<CornerAnalysis> {
    const matchId = match.id;
    if (!this.data.getCornerResults || !this.data.getLeagueCornerHistory) {
      return this.base(matchId, 'unsupported', [`Az aktuális adatforrás (${this.data.name}) nem ad szögletadatot.`]);
    }
    const unsupported = CORNER_UNSUPPORTED_LEAGUES[match.leagueId];
    if (unsupported) return this.base(matchId, 'unsupported', [unsupported]);

    try {
      const cutoff = cornerCutoff(match.kickoff);
      const [results, leagues, homeTeam, awayTeam] = await Promise.all([
        this.data.getResultsForAnalysis(match), this.data.getLeagues(), this.data.getTeam(match.homeTeamId), this.data.getTeam(match.awayTeamId),
      ]);
      const iso = (s: string) => new Date(s).toISOString();
      const params = this.release.params;
      /** a legfrissebb befejezett meccsek, amíg a releváns helyszínen (hazai/idegen) meg nincs az ablak + tartalék */
      const teamFinished = (teamId: string, venue: 'home' | 'away'): MatchResult[] => {
        const all = results
          .filter((r) => (r.homeTeamId === teamId || r.awayTeamId === teamId) && iso(r.date) < cutoff)
          .sort((a, b) => iso(b.date).localeCompare(iso(a.date)));
        const out: MatchResult[] = [];
        let atVenue = 0;
        for (const r of all) {
          if (out.length >= TEAM_HISTORY_CAP || (atVenue >= params.window + VENUE_MARGIN && out.length >= 10)) break;
          out.push(r);
          if ((venue === 'home' ? r.homeTeamId : r.awayTeamId) === teamId) atVenue++;
        }
        return out;
      };
      const refsById = new Map<string, MatchResult>();
      for (const r of [...teamFinished(match.homeTeamId, 'home'), ...teamFinished(match.awayTeamId, 'away')]) refsById.set(r.id, r);
      const refs = [...refsById.values()];

      const [teamFetch, leagueFetch] = await Promise.all([
        this.data.getCornerResults(refs.map((r) => ({ matchId: r.id, leagueId: r.leagueId, kickoff: r.date }))),
        this.data.getLeagueCornerHistory(match.leagueId, cutoff, params.leagueWindow, LEAGUE_MAX_MONTHS),
      ]);
      const idx = new CornerIndex([...teamFetch.results, ...leagueFetch.results]);
      const corners = new Map<string, CornerResult>(idx.all.map((r) => [r.matchId, r]));
      const finished: FinishedRef[] = refs.map((r) => ({ matchId: r.id, date: r.date, homeTeamId: r.homeTeamId, awayTeamId: r.awayTeamId }));

      const skipped: Record<string, number> = {};
      for (const m of teamFetch.missing) skipped[m.reason] = (skipped[m.reason] ?? 0) + 1;
      const valid = refs.filter((r) => corners.has(r.id)).length;
      const lg = leagueCornerAverages(idx, match.leagueId, cutoff, this.release.params.leagueWindow);
      const failed = teamFetch.failedRequests + leagueFetch.failedRequests;

      const out = this.base(matchId, 'ok', []);
      out.coverage = { considered: refs.length, valid, skipped };
      if (valid === 0 && lg.sampleSize === 0) {
        out.status = 'unavailable';
        out.reasons = [failed ? 'A szögletadat-forrás most nem érhető el – próbáld újra később.' : 'Ehhez a mérkőzéshez nem érhető el hiteles szögletadat.'];
        return out;
      }
      out.league = { leagueId: lg.leagueId, sampleSize: lg.sampleSize, homeAvg: lg.homeAvg, awayAvg: lg.awayAvg, totalAvg: lg.totalAvg };
      out.home = teamCornerBlock(match.homeTeamId, 'home', finished, corners, cutoff);
      out.away = teamCornerBlock(match.awayTeamId, 'away', finished, corners, cutoff);

      const league = leagues.find((l) => l.id === match.leagueId);
      const exp = cornerExpectation(idx, match.homeTeamId, match.awayTeamId, match.leagueId, cutoff, this.release.params, {
        home: homeTeam?.name, away: awayTeam?.name, league: league?.name,
      });
      out.status = exp.ok ? 'ok' : 'insufficient';
      out.reasons = [...exp.reasons];
      if (failed) out.reasons.push(`${failed} szögletadat-lekérés sikertelen volt – a statisztika részleges lehet.`);
      const blocked = this.prematchBlock(match);
      if (blocked) out.reasons.push(blocked);
      if (this.release.validated && exp.ok && !blocked) {
        const p = cornerPrediction(exp, this.release.params);
        // csak a validált piaccsoportok valószínűsége kerül ki
        const scopes = new Set(this.release.validatedScopes);
        p.markets = p.markets.filter((m) => scopes.has(m.scope));
        // a nem validált összes-szöglet becslés a várható értékként sem kerülhet ki
        if (!scopes.has('total')) p.totalExpected = null;
        out.prediction = p.markets.length ? p : null;
      }
      return out;
    } catch (e) {
      console.error('[corners]', matchId, (e as Error).message);
      return this.base(matchId, 'unavailable', ['A szögletadat most nem érhető el – próbáld újra később.']);
    }
  }
}
