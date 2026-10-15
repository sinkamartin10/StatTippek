/**
 * Offline ESPN-adatkészlet és az éles adatkör szimulációja – a visszatesztelő szkriptek közös része.
 *
 * - Az adat a helyi backtest-cache havi scoreboardjaiból jön (csak olvasás, hálózat nélkül).
 * - Az éles szolgáltató letöltését a `historyPlan` szabályaiból szimuláljuk (ugyanaz a modul, amelyet
 *   egy teszt a valódi szolgáltató kéréseivel vet össze), az ESPN valódi idény-szemantikájával.
 * - Két állapot: „frissen indult szerver” (csak az aktuális idény résztvevői ismertek – alsó korlát)
 *   és „bemelegedett szerver” (a korábban letöltött menetrendekből a csapatok más sorozatokhoz is
 *   hozzárendelődtek – felső korlát). Az éles szolgáltató lefedettsége e kettő között van, a
 *   folyamat előzményeitől függően.
 */
import { createRequire } from 'node:module';
import { ESPN_LEAGUES, SLUG } from '../../src/server/data/espnProvider';
import {
  HISTORY_ONLY_DOMESTIC, NATIONAL_COMPETITIONS, baselineRequests, closedBefore, espnSeasonOf, extendedRequests,
  type CoverageReason, type ScheduleRequest, type TeamState,
} from '../../src/server/data/historyPlan';
import type { CompetitionKind, XsMatch } from '../../src/shared/engine/experimental/crossLeague';
import { parseScoreboardResults } from '../../src/server/data/scoreboardResults';

export interface Row extends XsMatch { regulation: boolean; espnSeason: number }

const LEAGUE_BY_SLUG: Record<string, string> = Object.fromEntries([
  ...Object.entries(SLUG).map(([id, slug]) => [slug, id]),
  ...Object.entries(HISTORY_ONLY_DOMESTIC).map(([id, v]) => [v.slug, id]),
]);
const NATIONAL = NATIONAL_COMPETITIONS;
export const KINDS: Record<string, CompetitionKind> = {
  ...Object.fromEntries(ESPN_LEAGUES.map((l) => [l.id, NATIONAL.has(l.id) ? 'national' : l.international ? 'club_intl' : 'domestic'])),
  ...Object.fromEntries(Object.keys(HISTORY_ONLY_DOMESTIC).map((id) => [id, 'domestic' as const])),
};
export const COVERED = new Set(ESPN_LEAGUES.map((l) => l.id));
export const isIntl = (l: string) => ESPN_LEAGUES.find((x) => x.id === l)?.international ?? false;
// a node:sqlite beépített modul – createRequire-rel töltjük be, hogy a Vite (tesztek) ne próbálja feloldani
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** A cache-elt nyers havi scoreboardokból a végeredmények. `includeHistoryOnly`: a csak-előzmény hazai bajnokságok is. */
export function loadDataset(file: string, opts: { includeHistoryOnly?: boolean } = {}): { rows: Row[]; scoreboards: number; skipped: Record<string, number> } {
  const db = new DatabaseSync(file, { readOnly: true });
  const sb = db.prepare(`SELECT url, body FROM http_cache WHERE url LIKE '%/scoreboard?dates=______'`).all() as { url: string; body: string }[];
  const byId = new Map<string, Row>();
  const skipped: Record<string, number> = {};
  const skip = (r: string) => { skipped[r] = (skipped[r] ?? 0) + 1; };
  let used = 0;
  for (const { url, body } of sb) {
    const slug = url.split('/soccer/')[1].split('/scoreboard')[0];
    const competitionId = LEAGUE_BY_SLUG[slug];
    if (!competitionId || (!COVERED.has(competitionId) && !opts.includeHistoryOnly)) continue;
    used++;
    const parsed = parseScoreboardResults(JSON.parse(body), slug, competitionId);
    for (const k of parsed.skipped) skip(k);
    for (const r of parsed.results) if (!byId.has(r.id)) byId.set(r.id, { ...r, espnSeason: espnSeasonOf(competitionId, r.date) });
  }
  return { rows: [...byId.values()].sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id)), scoreboards: used, skipped };
}

const ORDER = ESPN_LEAGUES.map((l) => l.id);

export class Index {
  byComp = new Map<string, Row[]>();
  byTeam = new Map<string, Row[]>();
  /** csapat → sorozat → ESPN-idények, amelyekben szerepel */
  part = new Map<string, Map<string, Set<number>>>();
  constructor(public rows: Row[]) {
    for (const r of rows) {
      (this.byComp.get(r.competitionId) ?? this.byComp.set(r.competitionId, []).get(r.competitionId)!).push(r);
      for (const t of [r.homeTeamId, r.awayTeamId]) {
        (this.byTeam.get(t) ?? this.byTeam.set(t, []).get(t)!).push(r);
        const per = this.part.get(t) ?? this.part.set(t, new Map()).get(t)!;
        (per.get(r.competitionId) ?? per.set(r.competitionId, new Set()).get(r.competitionId)!).add(r.espnSeason);
      }
    }
  }
  /** a csak-előzmény hazai bajnokság, ha a csapat ott szerepel (az ESPN csapatlistájának megfelelője) */
  historyLeagueOf(teamId: string, nowIso: string): string | null {
    const per = this.part.get(teamId);
    if (!per) return null;
    for (const [c, seasons] of per) if (HISTORY_ONLY_DOMESTIC[c] && (seasons.has(espnSeasonOf(c, nowIso)) || seasons.has(espnSeasonOf(c, nowIso) - 1))) return c;
    return null;
  }
}

/**
 * A csapat állapota a szolgáltatóban a lekérés pillanatában.
 *  - cold: csak az aktuális idény (lefedett) résztvevői listái alapján,
 *  - warm: plusz minden lefedett sorozat, amelynek a szolgáltató által letöltött (aktuális,
 *    illetve hazai ligánál előző) idényében a csapat szerepelt.
 */
export function teamState(ix: Index, teamId: string, nowIso: string, mode: 'cold' | 'warm'): TeamState {
  const per = ix.part.get(teamId) ?? new Map<string, Set<number>>();
  const comps: string[] = [];
  for (const c of ORDER) {
    const seasons = per.get(c);
    if (!seasons) continue;
    const cur = espnSeasonOf(c, nowIso);
    const inCurrent = seasons.has(cur);
    const inFetchedPrev = mode === 'warm' && ((!isIntl(c) && seasons.has(cur - 1)) || (c === 'uefa-nl' && seasons.has(cur - 2)));
    if (inCurrent || inFetchedPrev) comps.push(c);
  }
  // válogatott: a szolgáltató a válogatott-sorozatok csapatlistáiból ismeri – akkor is, ha az idényben még nem játszott
  if (!comps.some((c) => NATIONAL.has(c)) && [...per.keys()].some((c) => NATIONAL.has(c))) comps.push([...per.keys()].find((c) => NATIONAL.has(c))!);
  // elsődleges liga: a szolgáltató előbb a hazai bajnokságok csapatlistáit tölti be (aktuális idény)
  const domesticNow = ORDER.filter((c) => !isIntl(c) && per.get(c)?.has(espnSeasonOf(c, nowIso)));
  const leagueId = domesticNow[0] ?? comps[0] ?? '';
  return { id: teamId, leagueId, competitions: comps };
}

export type Source = CoverageReason;

/**
 * A meccshez az adott szabálykészlettel letöltött eredmények (csak a kezdés előtt ≥3 órával indultak),
 * eredetenként (melyik kérés hozta először). Egy meccs egyszer.
 */
export function available(ix: Index, m: Row, opts: { mode: 'cold' | 'warm'; extended: boolean; closedHours?: number }): { rows: Row[]; sourceOf: Map<string, Source>; requests: Set<string> } {
  const now = m.date;
  const home = teamState(ix, m.homeTeamId, now, opts.mode), away = teamState(ix, m.awayTeamId, now, opts.mode);
  const target = { leagueId: m.competitionId };
  const reqs: ScheduleRequest[] = baselineRequests(target, home, away, now, { international: isIntl });
  if (opts.extended) reqs.push(...extendedRequests(target, home, away, now, { international: isIntl }, (id) => ix.historyLeagueOf(id, now)));
  const out = new Map<string, Row>();
  const sourceOf = new Map<string, Source>();
  /** a ténylegesen kiadott menetrend-kérések (liga|csapat|idény) – a terheléshez */
  const requests = new Set<string>();
  const cutoff = Date.parse(m.date) - (opts.closedHours ?? 3) * 3600_000;
  const teamsWith = (league: string, season: number) => {
    // a sorozat „ismert” résztvevői: aktuális idény (+ bemelegedett szervernél a letöltött előző idények szereplői)
    const s = new Set<string>();
    for (const r of ix.byComp.get(league) ?? []) {
      const cur = espnSeasonOf(league, now);
      if (r.espnSeason === cur || (opts.mode === 'warm' && ((!isIntl(league) && r.espnSeason === cur - 1) || (league === 'uefa-nl' && r.espnSeason === cur - 2)))) { s.add(r.homeTeamId); s.add(r.awayTeamId); }
    }
    void season;
    return s;
  };
  for (const req of reqs) {
    const season = req.season === 'current' ? espnSeasonOf(req.leagueId, now) : req.season;
    if (req.onlyIfFewerThan) {
      const n = [...out.values()].filter((r) => r.competitionId === req.onlyIfFewerThan!.leagueId && (r.homeTeamId === req.teamId || r.awayTeamId === req.teamId)).length;
      if (n >= req.onlyIfFewerThan.count) continue;
    }
    const ids = req.teamId === '*' ? teamsWith(req.leagueId, season) : new Set([req.teamId]);
    for (const id of ids) requests.add(`${req.leagueId}|${id}|${season}`);
    for (const r of ix.byComp.get(req.leagueId) ?? []) {
      if (r.espnSeason !== season || !(ids.has(r.homeTeamId) || ids.has(r.awayTeamId))) continue;
      if (Date.parse(r.date) > cutoff) continue;
      if (!out.has(r.id)) { out.set(r.id, r); sourceOf.set(r.id, req.reason); }
    }
  }
  return { rows: closedBefore([...out.values()], m.date, opts.closedHours ?? 3), sourceOf, requests };
}
