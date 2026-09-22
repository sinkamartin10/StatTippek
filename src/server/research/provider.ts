/**
 * Kutatómotor interfész. Egy mérkőzéshez híreket, hiányzókat, külső előrejelzéseket és forrásokat gyűjt.
 * Új forrás hozzáadása: implementáld a ResearchProvider-t és regisztráld a container.ts-ben.
 * Szabály: soha ne találj ki adatot. Ha nincs találat, üres listát és figyelmeztetést adj vissza.
 */
import type { League, Match, ResearchResult, Team, TeamAvailability } from '../../shared/types';

export interface ResearchContext {
  match: Match;
  league: League;
  homeTeam: Team;
  awayTeam: Team;
}

export interface ResearchProvider {
  readonly name: string;
  research(ctx: ResearchContext): Promise<ResearchResult>;
}

export function emptyAvailability(teamId: string): TeamAvailability {
  return { teamId, injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] };
}

export function emptyResearch(ctx: ResearchContext, provider: string, warnings: string[]): ResearchResult {
  return {
    matchId: ctx.match.id,
    origin: ctx.match.origin,
    performedAt: new Date().toISOString(),
    provider,
    news: [],
    availability: { home: emptyAvailability(ctx.homeTeam.id), away: emptyAvailability(ctx.awayTeam.id) },
    externalPredictions: [],
    sources: [],
    warnings,
  };
}
