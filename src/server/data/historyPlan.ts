/**
 * Történeti adatlefedettség – TISZTA tervező modul (hálózat és állapot nélkül).
 *
 * Két dolgot ír le, ugyanabban a formában (csapat-menetrend kérések listája):
 *  1. `baselineRequests`: amit az éles `EspnProvider.getResultsForAnalysis` MA letölt
 *     (a szolgáltató kódjának szabályai – egy teszt a valódi szolgáltató kéréseivel veti össze),
 *  2. `extendedRequests`: a bővítések, okkal megjelölve:
 *     - előző nemzetközi kupaidény (BL/EL/KL),
 *     - kiesett csapat előző élvonalbeli idénye,
 *     - válogatott: az ESPN naptári idényeinek megfelelő ablak (vb-selejtező, barátságos),
 *     - „csak kupából ismert” klub hazai bajnoksága egy csak-előzmény forrásból (pl. por.1, ned.1, sco.1).
 *
 * A bővítés az éles `xg-poisson-1`-et NEM érinti: csak a külön
 * `EspnProvider.getResultsForAnalysisExtended` és az offline mérés használja.
 *
 * Idény-szemantika (az ESPN `season` paramétere, élő végpontokon ellenőrizve):
 *  - klubsorozatok és Nemzetek Ligája: a kezdő év, júliustól júniusig (2024 = 2024-07 … 2025-06),
 *  - MLS, vb-selejtező, válogatott barátságos: naptári év.
 */
import type { MatchResult } from '../../shared/types';

/** Az ESPN-ben elérhető, de a felületen NEM megjelenő hazai bajnokságok – csak előzményhez. */
export const HISTORY_ONLY_DOMESTIC: Record<string, { slug: string; name: string }> = {
  'por-pl': { slug: 'por.1', name: 'Primeira Liga (Portugália)' },
  'ned-ed': { slug: 'ned.1', name: 'Eredivisie (Hollandia)' },
  'sco-pr': { slug: 'sco.1', name: 'Premiership (Skócia)' },
  'bel-pl': { slug: 'bel.1', name: 'Pro League (Belgium)' },
  'tur-sl': { slug: 'tur.1', name: 'Süper Lig (Törökország)' },
  'aut-bl': { slug: 'aut.1', name: 'Bundesliga (Ausztria)' },
  'sui-sl': { slug: 'sui.1', name: 'Super League (Svájc)' },
  'gre-sl': { slug: 'gre.1', name: 'Super League (Görögország)' },
  'den-sl': { slug: 'den.1', name: 'Superliga (Dánia)' },
  'nor-el': { slug: 'nor.1', name: 'Eliteserien (Norvégia)' },
  'swe-al': { slug: 'swe.1', name: 'Allsvenskan (Svédország)' },
  'isr-pl': { slug: 'isr.1', name: 'Premier League (Izrael)' },
  'cyp-1d': { slug: 'cyp.1', name: 'First Division (Ciprus)' },
  'rou-l1': { slug: 'rou.1', name: 'Liga I (Románia)' },
  'nir-pr': { slug: 'nir.1', name: 'Premiership (Észak-Írország)' },
  'wal-pr': { slug: 'wal.1', name: 'Cymru Premier (Wales)' },
  'mlt-pl': { slug: 'mlt.1', name: 'Premier League (Málta)' },
};

/** Naptári idényű sorozatok (ESPN). */
const CALENDAR = new Set(['usa-mls', 'fifa-wcq-uefa', 'fifa-friendly']);
export const NATIONAL_COMPETITIONS = new Set(['uefa-nl', 'fifa-wcq-uefa', 'fifa-friendly']);
export const INTERNATIONAL_CLUB = new Set(['uefa-ucl', 'uefa-uel', 'uefa-uecl']);
/** első osztály → másodosztály (mint a szolgáltatóban) */
export const SECOND_TIER: Record<string, string> = { 'eng-pl': 'eng-ch', 'esp-ll': 'esp-l2', 'ita-sa': 'ita-sb', 'ger-bl': 'ger-b2', 'fra-l1': 'fra-l2' };
/** másodosztály → első osztály (kiesett csapatokhoz) */
export const FIRST_TIER: Record<string, string> = Object.fromEntries(Object.entries(SECOND_TIER).map(([a, b]) => [b, a]));

/** Az ESPN `season` értéke, amelyhez egy adott időpontban lejátszott meccs tartozik. */
export function espnSeasonOf(leagueId: string, iso: string): number {
  const d = new Date(iso);
  if (CALENDAR.has(leagueId)) return d.getUTCFullYear();
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

/** A szolgáltató `seasonYear` függvénye (MLS: naptári év, minden más: júliusi szabály) – a lekérés időpontjában. */
export function providerSeasonYear(leagueId: string, nowIso: string): number {
  const d = new Date(nowIso);
  if (leagueId === 'usa-mls') return d.getUTCFullYear();
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

export type CoverageReason =
  | 'aktualis_idény'
  | 'elozo_hazai_idény'
  | 'feljuto_elozo_masodosztaly'
  | 'valogatott_alap'
  | 'elozo_nemzetkozi_kupaidény'
  | 'kieso_elozo_elsoosztaly'
  | 'valogatott_naptari_ablak'
  | 'hazai_bajnoksag_csak_elozmeny_forrasbol';

export const BASELINE_REASONS: CoverageReason[] = ['aktualis_idény', 'elozo_hazai_idény', 'feljuto_elozo_masodosztaly', 'valogatott_alap'];

/**
 * Egy csapat-menetrend kérés. `teamId: '*'` = a sorozat összes (ismert) résztvevője (liga-eredmények).
 * `season: 'current'` = paraméter nélküli kérés (az ESPN aktuális idénye a lekérés időpontjában).
 * `onlyIfFewerThan`: feltételes kérés – csak ha a csapat adott ligabeli eredményeinek száma ennél kevesebb.
 */
export interface ScheduleRequest {
  leagueId: string;
  teamId: string;
  season: number | 'current';
  reason: CoverageReason;
  onlyIfFewerThan?: { leagueId: string; count: number };
}

/** A szolgáltató által ismert csapat-állapot (a meccs pillanatában). */
export interface TeamState {
  id: string;
  /** a szolgáltató `Team.leagueId`-ja (elsődleges liga) */
  leagueId: string;
  /** a sorozatok (belső azonosító), amelyekhez a szolgáltató a csapatot hozzárendelte */
  competitions: string[];
}

/**
 * Amit az éles szolgáltató MA letölt egy meccshez (`getResultsForAnalysis` =
 * `getLeagueResults(liga)` + `getTeamResults(hazai)` + `getTeamResults(vendég)`).
 */
export function baselineRequests(match: { leagueId: string }, home: TeamState, away: TeamState, nowIso: string, kinds: { international: (l: string) => boolean }): ScheduleRequest[] {
  const out: ScheduleRequest[] = [];
  const L = match.leagueId;
  // getLeagueResults
  out.push({ leagueId: L, teamId: '*', season: 'current', reason: 'aktualis_idény' });
  if (!kinds.international(L)) out.push({ leagueId: L, teamId: '*', season: providerSeasonYear(L, nowIso) - 1, reason: 'elozo_hazai_idény' });
  else if (L === 'uefa-nl') out.push({ leagueId: L, teamId: '*', season: providerSeasonYear(L, nowIso) - 2, reason: 'elozo_hazai_idény' });
  // getTeamResults
  for (const t of [home, away]) {
    if (t.competitions.some((c) => NATIONAL_COMPETITIONS.has(c))) {
      const y = providerSeasonYear('uefa-nl', nowIso);
      for (const [l, off] of [['uefa-nl', 0], ['uefa-nl', -2], ['fifa-wcq-uefa', -1], ['fifa-wcq-uefa', 0], ['fifa-friendly', 0], ['fifa-friendly', -1]] as const) {
        out.push({ leagueId: l, teamId: t.id, season: off === 0 ? 'current' : y + off, reason: 'valogatott_alap' });
      }
      continue;
    }
    for (const c of t.competitions) {
      out.push({ leagueId: c, teamId: t.id, season: 'current', reason: 'aktualis_idény' });
      if (!kinds.international(c)) out.push({ leagueId: c, teamId: t.id, season: providerSeasonYear(c, nowIso) - 1, reason: 'elozo_hazai_idény' });
    }
    const second = SECOND_TIER[t.leagueId];
    if (second) out.push({ leagueId: second, teamId: t.id, season: providerSeasonYear(t.leagueId, nowIso) - 1, reason: 'feljuto_elozo_masodosztaly', onlyIfFewerThan: { leagueId: t.leagueId, count: 10 } });
  }
  return out;
}

/**
 * A bővítések (a baseline FÖLÉ). `historyLeagueOf`: egy csak-kupából ismert klub hazai
 * bajnoksága a csak-előzmény forrásból (vagy null, ha nem ismert / nem érhető el).
 */
export function extendedRequests(
  match: { leagueId: string },
  home: TeamState,
  away: TeamState,
  nowIso: string,
  kinds: { international: (l: string) => boolean },
  historyLeagueOf: (teamId: string) => string | null,
): ScheduleRequest[] {
  const out: ScheduleRequest[] = [];
  const L = match.leagueId;
  // előző kupaidény a kupameccs liga-átlagához
  if (INTERNATIONAL_CLUB.has(L)) out.push({ leagueId: L, teamId: '*', season: providerSeasonYear(L, nowIso) - 1, reason: 'elozo_nemzetkozi_kupaidény' });
  // válogatott sorozatok liga-átlaga: az előző naptári év is
  if (L === 'fifa-wcq-uefa' || L === 'fifa-friendly') out.push({ leagueId: L, teamId: '*', season: espnSeasonOf(L, nowIso) - 1, reason: 'valogatott_naptari_ablak' });
  for (const t of [home, away]) {
    if (t.competitions.some((c) => NATIONAL_COMPETITIONS.has(c))) {
      // az ESPN naptári idényei szerint: az aktuális ÉS az előző naptári év (a baseline jan–jún. között kihagyja)
      const cal = new Date(nowIso).getUTCFullYear();
      for (const l of ['fifa-wcq-uefa', 'fifa-friendly']) out.push({ leagueId: l, teamId: t.id, season: cal - 1, reason: 'valogatott_naptari_ablak' });
      continue;
    }
    for (const c of t.competitions) {
      if (INTERNATIONAL_CLUB.has(c)) out.push({ leagueId: c, teamId: t.id, season: providerSeasonYear(c, nowIso) - 1, reason: 'elozo_nemzetkozi_kupaidény' });
    }
    const first = FIRST_TIER[t.leagueId];
    if (first) out.push({ leagueId: first, teamId: t.id, season: providerSeasonYear(t.leagueId, nowIso) - 1, reason: 'kieso_elozo_elsoosztaly', onlyIfFewerThan: { leagueId: t.leagueId, count: 10 } });
    const hasDomestic = t.competitions.some((c) => !kinds.international(c));
    if (!hasDomestic) {
      const h = historyLeagueOf(t.id);
      if (h) {
        out.push({ leagueId: h, teamId: t.id, season: 'current', reason: 'hazai_bajnoksag_csak_elozmeny_forrasbol' });
        out.push({ leagueId: h, teamId: t.id, season: providerSeasonYear(h, nowIso) - 1, reason: 'hazai_bajnoksag_csak_elozmeny_forrasbol' });
      }
    }
  }
  return out;
}

/** Kérés-kulcs a duplikált letöltések kiszűréséhez. A 'current' a lekérés idején konkrét idényt jelent. */
export function requestKey(r: ScheduleRequest, nowIso: string): string {
  const season = r.season === 'current' ? espnSeasonOf(r.leagueId, nowIso) : r.season;
  return `${r.leagueId}|${r.teamId}|${season}`;
}

/**
 * Egy meccs egyszer: az ESPN eseményazonosító (a slug nélkül) szerint, és – ha két
 * különböző azonosító ugyanazt a párosítást ugyanarra az időpontra adja – a pár+idő szerint is.
 * Determinisztikus: az előbb kapott példány marad.
 */
export function dedupeResults<T extends MatchResult>(results: T[]): { results: T[]; duplicates: number } {
  const byEvent = new Set<string>(), byPair = new Set<string>();
  const out: T[] = [];
  let duplicates = 0;
  for (const r of results) {
    const ev = r.id.replace(/^espn-.+-(\d+)$/, '$1');
    const pair = `${r.homeTeamId}|${r.awayTeamId}|${r.date.slice(0, 13)}`;
    if (byEvent.has(ev) || byPair.has(pair)) { duplicates++; continue; }
    byEvent.add(ev); byPair.add(pair);
    out.push(r);
  }
  return { results: out, duplicates };
}

/**
 * Időbeli szivárgás ellen: csak a kezdés előtt legalább `closedHours` órával indult
 * (tehát a kezdéskor már lezárt) meccsek maradnak. Élő előrejelzésnél ez minden
 * befejezett meccs; visszatesztben ez zárja ki a jövőt.
 */
export function closedBefore<T extends { date: string }>(results: T[], kickoffIso: string, closedHours = 3): T[] {
  const limit = Date.parse(kickoffIso) - closedHours * 3600_000;
  return results.filter((r) => Date.parse(r.date) <= limit);
}
