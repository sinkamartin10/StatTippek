/**
 * Meccsadat-szolgáltató interfész.
 * Új adatforrás hozzáadása: implementáld ezt az interfészt (lásd demoProvider.ts, apiFootballProvider.ts),
 * majd regisztráld a src/server/container.ts-ben.
 */
import type { DataOrigin, League, Match, MatchOdds, MatchResult, Team } from '../../shared/types';

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
  /** Az elemzéshez szükséges lejátszott meccsek (a két csapat + a bajnokság). */
  getResultsForAnalysis(match: Match): Promise<MatchResult[]>;
  /** Egy csapat összes elérhető lejátszott meccse. */
  getTeamResults(teamId: string): Promise<MatchResult[]>;
  /** Egy bajnokság összes elérhető lejátszott meccse (tabellához). */
  getLeagueResults(leagueId: string): Promise<MatchResult[]>;
  getOdds(matchId: string): Promise<MatchOdds | null>;
  /** Az aktuális idény kezdete ISO formában (tabella-szűréshez). Ha nincs, minden eredmény számít. */
  getSeasonStart?(leagueId: string): Promise<string>;
}
