/**
 * Edge Radar – a felület tiszta logikája (szűrés, rendezés, csoportosítás, kizárási okok szövege).
 * A böngésző NEM számol edge-et: az API érvényességi döntése az irányadó (`excluded`, `edgePp`).
 */
import type { EdgeRadarItem } from '@shared/types';

/** Emberileg érthető indok a gépi kizárási okhoz. Ismeretlen kódnál általános szöveg (a kód zárójelben). */
export const EXCLUDE_REASON_HU: Record<string, string> = {
  not_prematch: 'A mérkőzés már nem kezdés előtti (élő, befejezett vagy halasztott).',
  kickoff_passed: 'A mérkőzés kezdési ideje elmúlt.',
  unknown_observation: 'Az odds megfigyelési ideje nem igazolható.',
  observed_in_play: 'Az oddsot élő mérkőzés közben rögzítettük.',
  observed_after_kickoff: 'Az odds a kezdés után rögzült.',
  observed_in_future: 'Hibás (jövőbeli) megfigyelési idő.',
  stale: 'Az odds megfigyelése túl régi.',
  invalid_time: 'Hibás időadat.',
  analysis_unavailable: 'Nincs elérhető modellelemzés.',
  match_mismatch: 'Az elemzés és az odds nem ugyanahhoz a mérkőzéshez tartozik.',
  analysis_odds_mismatch: 'Az elemzés egy korábbi odds-állapotból készült – a frissítés folyamatban.',
  model_prob_missing: 'Ehhez a piachoz nincs modell-valószínűség.',
  market_not_mapped: 'Ezen a piacon nem készül árrésmentes összevetés.',
  invalid_odds: 'Érvénytelen odds.',
  invalid_probability: 'Érvénytelen valószínűség.',
  missing_outcome: 'Hiányzik a piac egy kimenetele – az árrés nem számolható.',
  mixed_bookmakers: 'A kimenetelek különböző irodáktól származnak.',
  unknown_bookmaker: 'Az iroda vagy az ár eredete nem igazolható (pl. kézi vagy összefésült odds, nyitó ár).',
  mixed_observations: 'A kimenetelek különböző időpontban rögzültek.',
  overround_out_of_range: 'Szokatlan árrés – az odds nem használható.',
  line_mismatch: 'Eltérő gólvonal.',
  market_not_supported: 'Nem támogatott piac.',
};
export const reasonText = (code: string | null | undefined): string => (code ? EXCLUDE_REASON_HU[code] ?? `Nem használható (${code}).` : '');

/** Forrás emberi neve; az igazolatlan forrást külön jelöli. */
export function sourceText(source: string): string {
  if (source === 'espn-scoreboard') return 'ESPN (eredménylista)';
  if (source === 'espn-summary') return 'ESPN (meccsadat)';
  if (source === 'the-odds-api') return 'The Odds API';
  if (source.startsWith('unverified:')) return source === 'unverified:manual' ? 'kézi bevitel (nem igazolt)' : 'nem igazolt forrás';
  return source;
}

/** Az edge CSAK akkor jeleníthető meg, ha az API nem zárta ki a sort, és az érték rendelkezésre áll. */
export const showEdge = (i: EdgeRadarItem): boolean => !i.excluded && typeof i.edgePp === 'number' && Number.isFinite(i.edgePp);

export type EdgeState = 'all' | 'usable' | 'excluded';
export interface EdgeFilters { leagueId: string; market: string; state: EdgeState; sort: 'kickoff' | 'edge' }
export const DEFAULT_FILTERS: EdgeFilters = { leagueId: '', market: '', state: 'all', sort: 'kickoff' };

export function filterItems(items: EdgeRadarItem[], f: EdgeFilters): EdgeRadarItem[] {
  return items.filter((i) => (!f.leagueId || i.leagueId === f.leagueId)
    && (!f.market || i.market === f.market)
    && (f.state === 'all' || (f.state === 'usable' ? showEdge(i) : !showEdge(i))));
}

const byKickoff = (a: EdgeRadarItem, b: EdgeRadarItem) => a.kickoff.localeCompare(b.kickoff) || a.matchId.localeCompare(b.matchId);

/**
 * Rendezés. 'edge': a HASZNÁLHATÓ sorok edge szerint csökkenőben elöl, utánuk a többi kezdés szerint –
 * kizárt sor soha nem kerül edge-sorrendbe. 'kickoff': kezdés, meccs, majd az API sorrendje.
 */
export function sortItems(items: EdgeRadarItem[], sort: EdgeFilters['sort']): EdgeRadarItem[] {
  const idx = new Map(items.map((i, n) => [i, n]));
  const stable = (a: EdgeRadarItem, b: EdgeRadarItem) => idx.get(a)! - idx.get(b)!;
  if (sort === 'edge') {
    const usable = items.filter(showEdge).sort((a, b) => b.edgePp! - a.edgePp! || byKickoff(a, b) || stable(a, b));
    const rest = items.filter((i) => !showEdge(i)).sort((a, b) => byKickoff(a, b) || stable(a, b));
    return [...usable, ...rest];
  }
  return [...items].sort((a, b) => byKickoff(a, b) || stable(a, b));
}

/** Választható bajnokságok és piacok (a válaszban ténylegesen előforduló értékekből). */
export function filterOptions(items: EdgeRadarItem[]): { leagues: string[]; markets: string[] } {
  return { leagues: [...new Set(items.map((i) => i.leagueId))].sort(), markets: [...new Set(items.map((i) => i.market))].sort() };
}

/** Lefedettség: hány meccsnek volt egyáltalán oddsa, és hány használható sor van. */
export function coverage(items: EdgeRadarItem[], matches: number): { matchesWithOdds: number; matches: number; usable: number } {
  return { matchesWithOdds: new Set(items.map((i) => i.matchId)).size, matches, usable: items.filter(showEdge).length };
}

/** A megfigyelés kora percben (null, ha ismeretlen). */
export const ageMinutes = (i: EdgeRadarItem): number | null => (typeof i.ageMs === 'number' && i.ageMs >= 0 ? Math.round(i.ageMs / 60_000) : null);
