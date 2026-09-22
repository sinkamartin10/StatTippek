/**
 * DEMO ADAT szolgáltató – a generált adathalmazt szolgálja ki memóriából.
 * Napváltáskor újragenerálja a dátumokat (az eredmények determinisztikusak, így ugyanazok maradnak).
 */
import type { League, Match, MatchOdds, MatchResult, Team } from '../../shared/types';
import { buildDemoDataset, type DemoDataset } from './demo/generate';
import type { MatchDataProvider, MatchQuery } from './provider';

export function localDateKey(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class DemoMatchDataProvider implements MatchDataProvider {
  readonly name = 'DEMO adatkészlet (beépített)';
  readonly origin = 'demo' as const;
  private ds: DemoDataset;

  constructor() {
    this.ds = buildDemoDataset(new Date());
  }

  /** A demo adathalmaz (tesztekhez és a demo kutatómotorhoz). */
  dataset(): DemoDataset {
    if (this.ds.generatedFor !== new Date().toDateString()) this.ds = buildDemoDataset(new Date());
    return this.ds;
  }

  async getLeagues(): Promise<League[]> { return this.dataset().leagues; }
  async getTeams(): Promise<Team[]> { return this.dataset().teams; }
  async getTeam(id: string): Promise<Team | null> { return this.dataset().teams.find((t) => t.id === id) ?? null; }
  async getMatch(id: string): Promise<Match | null> { return this.dataset().matches.find((m) => m.id === id) ?? null; }

  async getMatches(q: MatchQuery): Promise<Match[]> {
    const ds = this.dataset();
    const leagueById = new Map(ds.leagues.map((l) => [l.id, l]));
    return ds.matches
      .filter((m) => {
        const day = localDateKey(m.kickoff);
        if (q.date && day !== q.date) return false;
        if (q.from && day < q.from) return false;
        if (q.to && day > q.to) return false;
        if (q.leagueId && m.leagueId !== q.leagueId) return false;
        if (q.country && leagueById.get(m.leagueId)?.country !== q.country) return false;
        if (q.teamId && m.homeTeamId !== q.teamId && m.awayTeamId !== q.teamId) return false;
        if (q.importance && m.importance !== q.importance) return false;
        if (q.status && m.status !== q.status) return false;
        return true;
      })
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  }

  async getResultsForAnalysis(match: Match): Promise<MatchResult[]> {
    const ds = this.dataset();
    return ds.results.filter(
      (r) => r.leagueId === match.leagueId || [match.homeTeamId, match.awayTeamId].includes(r.homeTeamId) || [match.homeTeamId, match.awayTeamId].includes(r.awayTeamId),
    );
  }

  async getTeamResults(teamId: string): Promise<MatchResult[]> {
    return this.dataset().results.filter((r) => r.homeTeamId === teamId || r.awayTeamId === teamId);
  }

  async getLeagueResults(leagueId: string): Promise<MatchResult[]> {
    return this.dataset().results.filter((r) => r.leagueId === leagueId);
  }

  async getOdds(matchId: string): Promise<MatchOdds | null> {
    return this.dataset().odds.get(matchId) ?? null;
  }
}
