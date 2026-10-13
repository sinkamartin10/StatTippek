/**
 * Meccsadat-szolgáltató interfész.
 * Új adatforrás hozzáadása: implementáld ezt az interfészt (lásd demoProvider.ts, apiFootballProvider.ts),
 * majd regisztráld a src/server/container.ts-ben.
 */
import type { CornerResult, DataOrigin, League, Match, MatchOdds, MatchResult, Team } from '../../shared/types';

/** Egy befejezett meccs, amelynek a szögletszáma kell. */
export interface CornerRef {
  matchId: string;
  leagueId: string;
  kickoff: string;
}

/** Szögletadat-lekérés eredménye: csak hiteles adat, a hiány okával. */
export interface CornerFetch {
  results: CornerResult[];
  missing: { matchId: string; reason: string }[];
  /** sikertelen (hálózati/cache) kérések száma */
  failedRequests: number;
}

export interface MatchQuery {
  /** YYYY-MM-DD (helyi nap) */
  date?: string;
  from?: string;
  to?: string;
  leagueId?: string;
  country?: string;
  teamId?: string;
  importance?: string;
  status?: string;
}

export interface MatchDataProvider {
  readonly name: string;
  readonly origin: DataOrigin;
  getLeagues(): Promise<League[]>;
  getTeams(): Promise<Team[]>;
  getTeam(id: string): Promise<Team | null>;
  getMatches(q: MatchQuery): Promise<Match[]>;
  getMatch(id: string): Promise<Match | null>;
  /**
   * Opcionális: a meccs állapota a szolgáltató memóriabeli gyorsítótárának
   * megkerülésével (a meglévő, gyorsítótárazott HTTP-úton). Akinek nincs ilyen
   * útja, az nem implementálja – a hívó ilyenkor tudja, hogy a `getMatch`
   * eredménye elavult lehet.
   */
  getMatchFresh?(id: string): Promise<Match | null>;
  /** Az elemzéshez szükséges lejátszott meccsek (a két csapat + a bajnokság). */
  getResultsForAnalysis(match: Match): Promise<MatchResult[]>;
  /** Egy csapat összes elérhető lejátszott meccse. */
  getTeamResults(teamId: string): Promise<MatchResult[]>;
  /** Egy bajnokság összes elérhető lejátszott meccse (tabellához). */
  getLeagueResults(leagueId: string): Promise<MatchResult[]>;
  getOdds(matchId: string): Promise<MatchOdds | null>;
  /** Az aktuális idény kezdete ISO formában (tabella-szűréshez). Ha nincs, minden eredmény számít. */
  getSeasonStart?(leagueId: string): Promise<string>;
  /**
   * Opcionális: a megadott befejezett meccsek hiteles szögletszáma. Aki nem
   * implementálja, annál szögletelemzés nem készül. Soha nem pótol adatot.
   */
  getCornerResults?(refs: CornerRef[]): Promise<CornerFetch>;
  /** Opcionális: a liga legutóbbi szögletadatai a `before` időpont előtt (liga-átlaghoz). */
  getLeagueCornerHistory?(leagueId: string, before: string, minMatches: number, maxMonths: number): Promise<CornerFetch>;
}
