/**
 * Élő meccsadat-szolgáltató: API-Football (api-sports.io, v3).
 * Csak akkor aktiválódik, ha az API_FOOTBALL_KEY környezeti változó be van állítva.
 * A kulcs kizárólag a szerveren él; a frontend soha nem látja.
 *
 * Rate limit tisztelete: minden végpont-válasz memóriában cache-elődik (fixtures 10 perc, eredmények 6 óra, odds 15 perc).
 * Ha egy hívás sikertelen, a szolgáltató üres listát ad vissza és a hibát naplózza – soha nem talál ki adatot.
 */
import type { League, Match, MatchOdds, MatchResult, Team } from '../../shared/types';
import { LEAGUES } from './demo/leagues';
import type { MatchDataProvider, MatchQuery } from './provider';
import { localDateKey } from './demoProvider';

const BASE = 'https://v3.football.api-sports.io';

interface CacheEntry { at: number; ttl: number; data: unknown }

export class ApiFootballProvider implements MatchDataProvider {
  readonly name = 'API-Football (élő)';
  readonly origin = 'live' as const;
  private cache = new Map<string, CacheEntry>();
  private teams = new Map<string, Team>();
  private matches = new Map<string, Match>();
  private leagues: League[] = LEAGUES.filter((l) => l.externalId);

  constructor(private apiKey: string) {}

  private season(league: League): number {
    const now = new Date();
    if (league.id === 'usa-mls') return now.getFullYear();
    return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  }

  private async call<T>(path: string, ttlMs: number): Promise<T | null> {
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.data as T;
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { 'x-apisports-key': this.apiKey } });
      if (!res.ok) {
        console.error(`[api-football] ${path} -> HTTP ${res.status}`);
        return null;
      }
      const json = (await res.json()) as { errors?: unknown; response?: T };
      if (json.errors && Object.keys(json.errors as object).length) {
        console.error(`[api-football] ${path} -> hiba:`, json.errors);
        return null;
      }
      this.cache.set(path, { at: Date.now(), ttl: ttlMs, data: json.response });
      return json.response ?? null;
    } catch (e) {
      console.error(`[api-football] ${path} -> kivétel`, e);
      return null;
    }
  }

  private leagueByExternal(id: number): League | undefined {
    return this.leagues.find((l) => l.externalId === id);
  }

  private registerTeam(raw: { id: number; name: string }, league: League): Team {
    const id = `af-${raw.id}`;
    if (!this.teams.has(id)) {
      this.teams.set(id, { id, name: raw.name, shortName: raw.name.length > 14 ? raw.name.slice(0, 13) + '…' : raw.name, country: league.country, leagueId: league.id, externalId: raw.id });
    }
    return this.teams.get(id)!;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toMatch(f: any): Match | null {
    const league = this.leagueByExternal(f.league?.id);
    if (!league) return null;
    const home = this.registerTeam(f.teams.home, league);
    const away = this.registerTeam(f.teams.away, league);
    const short = f.fixture.status?.short as string;
    const status: Match['status'] = ['FT', 'AET', 'PEN'].includes(short) ? 'finished'
      : ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE'].includes(short) ? 'live'
      : ['PST', 'CANC', 'ABD', 'SUSP', 'INT'].includes(short) ? 'postponed' : 'scheduled';
    const m: Match = {
      id: `af-${f.fixture.id}`,
      leagueId: league.id,
      homeTeamId: home.id,
      awayTeamId: away.id,
      kickoff: f.fixture.date,
      status,
      round: f.league?.round ?? undefined,
      importance: league.international ? 'high' : 'normal',
      importanceReasons: league.international ? ['Nemzetközi kupamérkőzés'] : [],
      homeGoals: f.goals?.home ?? undefined,
      awayGoals: f.goals?.away ?? undefined,
      origin: 'live',
    };
    this.matches.set(m.id, m);
    return m;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toResult(f: any): MatchResult | null {
    const m = this.toMatch(f);
    if (!m || m.status !== 'finished' || m.homeGoals == null || m.awayGoals == null) return null;
    return {
      id: m.id, leagueId: m.leagueId, date: m.kickoff, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId,
      homeGoals: m.homeGoals, awayGoals: m.awayGoals,
      htHomeGoals: f.score?.halftime?.home ?? undefined, htAwayGoals: f.score?.halftime?.away ?? undefined,
      origin: 'live',
    };
  }

  async getLeagues(): Promise<League[]> { return this.leagues; }
  async getTeams(): Promise<Team[]> { return [...this.teams.values()]; }
  async getTeam(id: string): Promise<Team | null> { return this.teams.get(id) ?? null; }

  async getMatches(q: MatchQuery): Promise<Match[]> {
    const date = q.date ?? localDateKey(new Date().toISOString());
    const dates = q.from && q.to ? [q.from, q.to] : [date];
    const out: Match[] = [];
    for (const d of dates) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = await this.call<any[]>(`/fixtures?date=${d}&timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, 10 * 60_000);
      for (const f of resp ?? []) {
        const m = this.toMatch(f);
        if (m) out.push(m);
      }
    }
    const leagueById = new Map(this.leagues.map((l) => [l.id, l]));
    return out.filter((m) => {
      if (q.leagueId && m.leagueId !== q.leagueId) return false;
      if (q.country && leagueById.get(m.leagueId)?.country !== q.country) return false;
      if (q.teamId && m.homeTeamId !== q.teamId && m.awayTeamId !== q.teamId) return false;
      if (q.importance && m.importance !== q.importance) return false;
      if (q.status && m.status !== q.status) return false;
      return true;
    }).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  }

  async getMatch(id: string): Promise<Match | null> {
    if (this.matches.has(id)) return this.matches.get(id)!;
    const fid = id.replace('af-', '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await this.call<any[]>(`/fixtures?id=${fid}`, 10 * 60_000);
    return resp?.[0] ? this.toMatch(resp[0]) : null;
  }

  async getTeamResults(teamId: string): Promise<MatchResult[]> {
    const team = this.teams.get(teamId);
    if (!team?.externalId) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await this.call<any[]>(`/fixtures?team=${team.externalId}&last=20`, 6 * 3600_000);
    return (resp ?? []).map((f) => this.toResult(f)).filter((r): r is MatchResult => !!r);
  }

  async getLeagueResults(leagueId: string): Promise<MatchResult[]> {
    const league = this.leagues.find((l) => l.id === leagueId);
    if (!league) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await this.call<any[]>(`/fixtures?league=${league.externalId}&season=${this.season(league)}&status=FT`, 6 * 3600_000);
    return (resp ?? []).map((f) => this.toResult(f)).filter((r): r is MatchResult => !!r);
  }

  async getResultsForAnalysis(match: Match): Promise<MatchResult[]> {
    const [lg, h, a] = await Promise.all([
      this.getLeagueResults(match.leagueId),
      this.getTeamResults(match.homeTeamId),
      this.getTeamResults(match.awayTeamId),
    ]);
    const seen = new Set<string>();
    return [...lg, ...h, ...a].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }

  async getOdds(matchId: string): Promise<MatchOdds | null> {
    const fid = matchId.replace('af-', '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await this.call<any[]>(`/odds?fixture=${fid}`, 15 * 60_000);
    const book = resp?.[0]?.bookmakers?.[0];
    if (!book) return null;
    const markets: Record<string, number> = {};
    for (const bet of book.bets ?? []) {
      const name = String(bet.name).toLowerCase();
      for (const v of bet.values ?? []) {
        const odd = parseFloat(v.odd);
        const val = String(v.value).toLowerCase();
        if (name === 'match winner') markets[val === 'home' ? '1' : val === 'draw' ? 'X' : '2'] = odd;
        else if (name === 'goals over/under') {
          const m = val.match(/^(over|under)\s*(\d\.5)$/);
          if (m) markets[`${m[1] === 'over' ? 'O' : 'U'}${m[2]}`] = odd;
        } else if (name === 'both teams score') markets[val === 'yes' ? 'BTTS_Y' : 'BTTS_N'] = odd;
        else if (name === 'double chance') {
          if (val === 'home/draw') markets['1X'] = odd;
          else if (val === 'draw/away') markets['X2'] = odd;
          else if (val === 'home/away') markets['12'] = odd;
        }
      }
    }
    if (!Object.keys(markets).length) return null;
    return { matchId, source: 'live', bookmaker: book.name, retrievedAt: new Date().toISOString(), markets };
  }
}
