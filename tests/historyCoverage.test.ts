/**
 * Történeti adatlefedettség: tervező modul + a KÍSÉRLETI bővített letöltés.
 *
 * A valódi `EspnProvider`-t hamisított ESPN-válaszokkal (hálózat nélkül) futtatjuk; a
 * hamis szerver az ESPN valódi idény-szemantikáját követi (klubsorozat: július–június,
 * vb-selejtező/barátságos: naptári év). Ellenőrizzük:
 *  - a tervező „baseline”-ja PONTOSAN azokat a menetrendeket kéri, amiket az éles szolgáltató letölt,
 *  - idényváltás, feljutó/kieső csapat, csak-kupából ismert klub, válogatott naptári ablak,
 *  - egy meccs egyszer, hibás/hiányzó válasz, időbeli szivárgás,
 *  - a bővített letöltés nem módosítja a szolgáltató közös állapotát (az éles elemzés változatlan).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ESPN_LEAGUES, EspnProvider, SLUG } from '../src/server/data/espnProvider';
import {
  HISTORY_ONLY_DOMESTIC, baselineRequests, closedBefore, dedupeResults, espnSeasonOf, extendedRequests, providerSeasonYear,
  type ScheduleRequest,
} from '../src/server/data/historyPlan';
import type { Match, MatchResult } from '../src/shared/types';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/';
const LEAGUE_OF_SLUG: Record<string, string> = Object.fromEntries([
  ...Object.entries(SLUG).map(([id, s]) => [s, id]),
  ...Object.entries(HISTORY_ONLY_DOMESTIC).map(([id, v]) => [v.slug, id]),
]);

interface Ev { id: number; slug: string; date: string; home: number; away: number; hg: number; ag: number; completed?: boolean }
interface World { teams: Record<string, number[]>; names: Record<number, string>; events: Ev[]; failing?: RegExp }

const ev = (e: Ev) => ({
  id: String(e.id), date: e.date,
  competitions: [{ status: { type: { completed: e.completed !== false } }, competitors: [
    { homeAway: 'home', team: { id: String(e.home), displayName: `T${e.home}` }, score: String(e.hg) },
    { homeAway: 'away', team: { id: String(e.away), displayName: `T${e.away}` }, score: String(e.ag) },
  ] }],
});

/** Hamis ESPN-szerver. A paraméter nélküli kérés az ESPN „aktuális” idényét adja (a hamis „most” szerint). */
function serve(world: World, now: () => string, log: string[]) {
  return vi.fn(async (url: string) => {
    const path = String(url).replace(BASE, '');
    log.push(path);
    if (world.failing?.test(path)) return new Response('hiba', { status: 500 });
    let m = path.match(/^([^/]+)\/teams$/);
    if (m) {
      const list = (world.teams[m[1]] ?? []).map((id) => ({ team: { id: String(id), displayName: world.names[id] ?? `T${id}`, shortDisplayName: `T${id}`, abbreviation: `T${id}` } }));
      return new Response(JSON.stringify({ sports: [{ leagues: [{ teams: list }] }] }));
    }
    m = path.match(/^([^/]+)\/teams\/(\d+)\/schedule(?:\?season=(\d+))?$/);
    if (m) {
      const [, slug, id, season] = m;
      const league = LEAGUE_OF_SLUG[slug];
      const want = season ? Number(season) : espnSeasonOf(league, now());
      const events = world.events.filter((e) => e.slug === slug && (e.home === Number(id) || e.away === Number(id)) && espnSeasonOf(league, e.date) === want).map(ev);
      return new Response(JSON.stringify({ events }));
    }
    return new Response(JSON.stringify({ events: [], leagues: [] }));
  });
}

let evId = 1000;
const play = (slug: string, date: string, home: number, away: number, hg = 1, ag = 0, completed = true): Ev => ({ id: evId++, slug, date, home, away, hg, ag, completed });
const match = (leagueId: string, home: number, away: number, kickoff: string): Match => ({ id: 'cél', leagueId, homeTeamId: `espn-${home}`, awayTeamId: `espn-${away}`, kickoff, status: 'scheduled', importance: 'normal', importanceReasons: [], origin: 'live' });

async function withProvider<T>(world: World, now: string, fn: (p: EspnProvider, log: string[]) => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  const log: string[] = [];
  vi.stubGlobal('fetch', serve(world, () => new Date().toISOString(), log));
  try { return await fn(new EspnProvider(), log); } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const isIntl = (l: string) => ESPN_LEAGUES.find((x) => x.id === l)?.international ?? false;
/** Tervezett kérés(ek) → ESPN-útvonal(ak), a résztvevők ismeretében. */
function toPaths(reqs: ScheduleRequest[], participants: (leagueId: string) => number[], ext: (teamId: string) => number, resultsIn: (teamId: string, leagueId: string) => number): Set<string> {
  const out = new Set<string>();
  for (const r of reqs) {
    if (r.onlyIfFewerThan && resultsIn(r.teamId, r.onlyIfFewerThan.leagueId) >= r.onlyIfFewerThan.count) continue;
    const slug = SLUG[r.leagueId] ?? HISTORY_ONLY_DOMESTIC[r.leagueId].slug;
    const ids = r.teamId === '*' ? participants(r.leagueId) : [ext(r.teamId)];
    for (const id of ids) out.add(`${slug}/teams/${id}/schedule${r.season === 'current' ? '' : `?season=${r.season}`}`);
  }
  return out;
}

describe('Idény-szemantika', () => {
  it('klubsorozat: július–június; MLS, vb-selejtező, barátságos: naptári év', () => {
    expect(espnSeasonOf('eng-pl', '2025-06-30T23:00:00Z')).toBe(2024);
    expect(espnSeasonOf('eng-pl', '2025-07-01T00:00:00Z')).toBe(2025);
    expect(espnSeasonOf('uefa-ucl', '2026-03-10T20:00:00Z')).toBe(2025);
    expect(espnSeasonOf('uefa-nl', '2025-03-23T20:00:00Z')).toBe(2024);
    expect(espnSeasonOf('fifa-wcq-uefa', '2025-03-21T20:00:00Z')).toBe(2025);
    expect(espnSeasonOf('fifa-friendly', '2026-06-01T18:00:00Z')).toBe(2026);
    expect(espnSeasonOf('usa-mls', '2025-10-01T00:00:00Z')).toBe(2025);
    expect(providerSeasonYear('fifa-friendly', '2026-03-01T00:00:00Z')).toBe(2025); // az éles szolgáltató itt is júliusi szabályt használ
    expect(providerSeasonYear('usa-mls', '2026-03-01T00:00:00Z')).toBe(2026);
  });
});

describe('A tervező „baseline”-ja = az éles szolgáltató tényleges letöltése', () => {
  it('bajnoki meccs (PL), két ismert csapat, kupaszereplővel – ugyanazok a menetrend-kérések', async () => {
    const world: World = {
      teams: { 'eng.1': [1, 2], 'uefa.champions': [1, 50] }, names: {},
      events: [play('eng.1', '2025-09-01T14:00:00Z', 1, 2), play('eng.1', '2026-08-20T14:00:00Z', 2, 1), play('uefa.champions', '2026-09-16T19:00:00Z', 1, 50)],
    };
    const now = '2026-10-01T10:00:00Z';
    await withProvider(world, now, async (p, log) => {
      const results = await p.getResultsForAnalysis(match('eng-pl', 1, 2, '2026-10-04T14:00:00Z'));
      const actual = new Set(log.filter((x) => x.includes('/schedule')));
      const home = { id: 'espn-1', leagueId: 'eng-pl', competitions: ['eng-pl', 'uefa-ucl'] }, away = { id: 'espn-2', leagueId: 'eng-pl', competitions: ['eng-pl'] };
      const planned = toPaths(baselineRequests({ leagueId: 'eng-pl' }, home, away, now, { international: isIntl }),
        (l) => world.teams[SLUG[l]] ?? [], (t) => Number(t.replace('espn-', '')),
        (t, l) => results.filter((r) => r.leagueId === l && (r.homeTeamId === t || r.awayTeamId === t)).length);
      expect(actual.size).toBe(7); // nem üres egyezés: PL 2 idény × 2 csapat, BL aktuális (1), feljutó-ellenőrzés: Championship előző idény × 2
      expect([...actual].sort()).toEqual([...planned].sort());
    });
  });

  it('válogatott meccs márciusban – ugyanazok a kérések (és a hiány is ugyanaz)', async () => {
    const world: World = { teams: { 'uefa.nations': [480, 481] }, names: {}, events: [] };
    const now = '2026-03-20T10:00:00Z';
    await withProvider(world, now, async (p, log) => {
      await p.getResultsForAnalysis(match('fifa-friendly', 480, 481, '2026-03-26T19:00:00Z'));
      const actual = new Set(log.filter((x) => x.includes('/schedule')));
      const t = (id: number) => ({ id: `espn-${id}`, leagueId: 'uefa-nl', competitions: ['uefa-nl'] });
      const planned = toPaths(baselineRequests({ leagueId: 'fifa-friendly' }, t(480), t(481), now, { international: isIntl }), () => [], (x) => Number(x.replace('espn-', '')), () => 0);
      expect(actual.size).toBe(12); // 2 csapat × 6 válogatott-előzmény kérés
      expect([...actual].sort()).toEqual([...planned].sort());
      // márciusban az éles szolgáltató a barátságos meccsekből csak 2026-ot (aktuális) és 2024-et kéri – 2025-öt nem
      expect([...actual].filter((x) => x.startsWith('fifa.friendly/teams/480'))).toEqual(expect.arrayContaining(['fifa.friendly/teams/480/schedule', 'fifa.friendly/teams/480/schedule?season=2024']));
      expect([...actual].some((x) => x.includes('fifa.friendly/teams/480/schedule?season=2025'))).toBe(false);
    });
  });
});

describe('Bővített letöltés (kísérleti) – új adatforrások', () => {
  it('kiesett csapat: az előző élvonalbeli idénye bekerül és ugyanahhoz a csapathoz kapcsolódik', async () => {
    const world: World = {
      teams: { 'eng.1': [1, 2], 'eng.2': [3, 4] }, names: {},
      events: [
        play('eng.1', '2025-11-01T15:00:00Z', 3, 1, 2, 2), play('eng.1', '2026-02-01T15:00:00Z', 2, 3, 0, 1), // 3-as az előző idényben még PL
        play('eng.2', '2026-08-10T14:00:00Z', 3, 4, 1, 0),
      ],
    };
    await withProvider(world, '2026-09-01T10:00:00Z', async (p) => {
      const m = match('eng-ch', 3, 4, '2026-09-05T14:00:00Z');
      const base = await p.getResultsForAnalysis(m);
      expect(base.filter((r) => r.leagueId === 'eng-pl')).toHaveLength(0); // frissen indult szerveren az éles adatkör ezt nem látja
      const ext = await p.getResultsForAnalysisExtended(m);
      const pl = ext.results.filter((r) => r.leagueId === 'eng-pl');
      expect(pl).toHaveLength(2);
      expect(pl.every((r) => r.homeTeamId === 'espn-3' || r.awayTeamId === 'espn-3')).toBe(true);
      expect(pl.every((r) => ext.sourceOf.get(r.id) === 'kieso_elozo_elsoosztaly')).toBe(true);
    });
  });

  it('kupameccs: előző kupaidény + a csak-kupából ismert klub hazai bajnoksága (por.1) a csak-előzmény forrásból', async () => {
    const world: World = {
      teams: { 'eng.1': [1, 2], 'uefa.champions': [1, 9], 'por.1': [9, 10] }, names: { 9: 'Benfica' },
      events: [
        play('uefa.champions', '2025-10-01T19:00:00Z', 9, 1, 2, 1), // előző kupaidény
        play('uefa.champions', '2026-09-17T19:00:00Z', 1, 9, 0, 0), // aktuális
        play('por.1', '2026-08-15T19:00:00Z', 9, 10, 3, 0), play('por.1', '2026-03-01T19:00:00Z', 10, 9, 1, 1),
      ],
    };
    await withProvider(world, '2026-10-20T10:00:00Z', async (p) => {
      const m = match('uefa-ucl', 9, 1, '2026-10-21T19:00:00Z');
      const base = await p.getResultsForAnalysis(m);
      expect(base.some((r) => r.leagueId === 'por-pl')).toBe(false);
      expect(base.some((r) => r.date.startsWith('2025-10-01'))).toBe(false);
      const ext = await p.getResultsForAnalysisExtended(m);
      const reasons = new Set(ext.results.map((r) => ext.sourceOf.get(r.id)));
      expect(reasons).toEqual(new Set(['alap', 'elozo_nemzetkozi_kupaidény', 'hazai_bajnoksag_csak_elozmeny_forrasbol']));
      expect(ext.results.filter((r) => r.leagueId === 'por-pl')).toHaveLength(2);
      // a csapatazonosító ugyanaz minden sorozatban
      expect(new Set(ext.results.flatMap((r) => [r.homeTeamId, r.awayTeamId]).filter((t) => t === 'espn-9'))).toEqual(new Set(['espn-9']));
    });
  });

  it('válogatott márciusban: az előző naptári év barátságos meccsei is bekerülnek', async () => {
    const world: World = { teams: { 'uefa.nations': [480, 481] }, names: {}, events: [play('fifa.friendly', '2025-06-06T18:00:00Z', 480, 481, 1, 1), play('fifa.friendly', '2025-06-10T18:00:00Z', 481, 480, 2, 0)] };
    await withProvider(world, '2026-03-20T10:00:00Z', async (p) => {
      const m = match('fifa-friendly', 480, 481, '2026-03-26T19:00:00Z');
      expect(await p.getResultsForAnalysis(m)).toHaveLength(0);
      const ext = await p.getResultsForAnalysisExtended(m);
      expect(ext.results).toHaveLength(2);
      expect(ext.results.every((r) => ext.sourceOf.get(r.id) === 'valogatott_naptari_ablak')).toBe(true);
    });
  });
});

describe('Egy meccs egyszer, hiányzó adat, szivárgás, mellékhatás-mentesség', () => {
  it('ugyanaz a meccs két csapat menetrendjéből és két forrásból is csak egyszer szerepel', async () => {
    const shared = play('uefa.champions', '2025-10-01T19:00:00Z', 9, 1, 2, 1);
    const world: World = { teams: { 'eng.1': [1], 'uefa.champions': [1, 9] }, names: {}, events: [shared, play('uefa.champions', '2026-09-17T19:00:00Z', 1, 9)] };
    await withProvider(world, '2026-10-20T10:00:00Z', async (p) => {
      const ext = await p.getResultsForAnalysisExtended(match('uefa-ucl', 9, 1, '2026-10-21T19:00:00Z'));
      expect(ext.results.filter((r) => r.id.endsWith(`-${shared.id}`))).toHaveLength(1);
      expect(new Set(ext.results.map((r) => r.id)).size).toBe(ext.results.length);
    });
    const a: MatchResult = { id: 'espn-eng.1-77', leagueId: 'eng-pl', date: '2026-01-01T15:00:00.000Z', homeTeamId: 'espn-1', awayTeamId: 'espn-2', homeGoals: 1, awayGoals: 0, origin: 'live' };
    const b = { ...a, id: 'espn-other.1-77' }, c = { ...a, id: 'espn-eng.1-78' }; // ugyanaz az esemény / ugyanaz a párosítás+időpont
    expect(dedupeResults([a, b, c])).toEqual({ results: [a], duplicates: 2 });
  });

  it('időbeli szivárgás: a kezdés után és a kezdés előtti 3 órában indult meccs kimarad', async () => {
    const world: World = {
      teams: { 'eng.1': [1, 2] }, names: {},
      events: [play('eng.1', '2026-09-01T14:00:00Z', 1, 2), play('eng.1', '2026-10-04T12:30:00Z', 1, 2), play('eng.1', '2026-10-05T14:00:00Z', 2, 1)],
    };
    await withProvider(world, '2026-10-10T10:00:00Z', async (p) => {
      const ext = await p.getResultsForAnalysisExtended(match('eng-pl', 1, 2, '2026-10-04T14:00:00Z'));
      expect(ext.results.map((r) => r.date.slice(0, 10))).toEqual(['2026-09-01']);
    });
    expect(closedBefore([{ date: '2026-10-04T11:00:00Z' }, { date: '2026-10-04T11:01:00Z' }], '2026-10-04T14:00:00Z')).toEqual([{ date: '2026-10-04T11:00:00Z' }]);
  });

  it('hiányzó/hibás adat: egy forrás 500-as hibája nem dönti el a letöltést, a többi adat megmarad', async () => {
    const world: World = {
      teams: { 'eng.1': [1], 'uefa.champions': [1, 9], 'por.1': [9] }, names: {}, failing: /^por\.1\/teams\/9\/schedule/,
      events: [play('uefa.champions', '2025-10-01T19:00:00Z', 9, 1), play('uefa.champions', '2026-09-17T19:00:00Z', 1, 9), play('por.1', '2026-08-15T19:00:00Z', 9, 10)],
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await withProvider(world, '2026-10-20T10:00:00Z', async (p) => {
      const ext = await p.getResultsForAnalysisExtended(match('uefa-ucl', 9, 1, '2026-10-21T19:00:00Z'));
      expect(ext.results.some((r) => r.leagueId === 'por-pl')).toBe(false);
      expect(ext.results.some((r) => ext.sourceOf.get(r.id) === 'elozo_nemzetkozi_kupaidény')).toBe(true);
    });
    err.mockRestore();
  });

  it('a bővített letöltés NEM módosítja a szolgáltató közös állapotát: az éles adatkör és a csapatlista változatlan', async () => {
    const world: World = {
      teams: { 'eng.1': [1, 2], 'eng.2': [3, 4], 'uefa.champions': [1, 9], 'por.1': [9, 10] }, names: {},
      events: [
        play('uefa.champions', '2025-10-01T19:00:00Z', 9, 1), play('uefa.champions', '2025-10-08T19:00:00Z', 1, 77), // 77: csak az előző kupaidényből ismert
        play('uefa.champions', '2026-09-17T19:00:00Z', 1, 9), play('por.1', '2026-08-15T19:00:00Z', 9, 10), play('eng.1', '2026-08-20T14:00:00Z', 1, 2),
      ],
    };
    const now = '2026-10-20T10:00:00Z';
    const m = match('uefa-ucl', 9, 1, '2026-10-21T19:00:00Z');
    const reference = await withProvider(world, now, async (p) => {
      const r1 = await p.getResultsForAnalysis(m);
      return { results: r1.map((r) => r.id).sort(), teams: (await p.getTeams()).map((t) => `${t.id}:${t.leagueId}`).sort() };
    });
    const after = await withProvider(world, now, async (p) => {
      await p.getResultsForAnalysis(m);
      await p.getResultsForAnalysisExtended(m);
      const r2 = await p.getResultsForAnalysis(m);
      return { results: r2.map((r) => r.id).sort(), teams: (await p.getTeams()).map((t) => `${t.id}:${t.leagueId}`).sort() };
    });
    expect(after).toEqual(reference);
    expect(after.teams.some((t) => t.startsWith('espn-77'))).toBe(false); // az előző kupaidény ellenfele nem került a csapatlistába
  });
});

describe('Bővítési terv – tiszta szabályok', () => {
  const kinds = { international: isIntl };
  it('kiesett csapat csak akkor kéri az élvonalat, ha kevés a másodosztályú eredménye; feljutó csapatra nem', () => {
    const relegated = extendedRequests({ leagueId: 'eng-ch' }, { id: 'R', leagueId: 'eng-ch', competitions: ['eng-ch'] }, { id: 'C', leagueId: 'eng-ch', competitions: ['eng-ch'] }, '2026-09-01T00:00:00Z', kinds, () => null);
    expect(relegated.filter((r) => r.reason === 'kieso_elozo_elsoosztaly')).toEqual([
      { leagueId: 'eng-pl', teamId: 'R', season: 2025, reason: 'kieso_elozo_elsoosztaly', onlyIfFewerThan: { leagueId: 'eng-ch', count: 10 } },
      { leagueId: 'eng-pl', teamId: 'C', season: 2025, reason: 'kieso_elozo_elsoosztaly', onlyIfFewerThan: { leagueId: 'eng-ch', count: 10 } },
    ]);
    const top = extendedRequests({ leagueId: 'eng-pl' }, { id: 'A', leagueId: 'eng-pl', competitions: ['eng-pl'] }, { id: 'B', leagueId: 'eng-pl', competitions: ['eng-pl'] }, '2026-09-01T00:00:00Z', kinds, () => null);
    expect(top).toEqual([]);
  });
  it('a csak-előzmény hazai bajnokság CSAK hazai bajnoki adat nélküli klubnál kerül be', () => {
    const r = extendedRequests({ leagueId: 'uefa-uel' }, { id: 'X', leagueId: 'uefa-uel', competitions: ['uefa-uel'] }, { id: 'A', leagueId: 'eng-pl', competitions: ['eng-pl', 'uefa-uel'] }, '2026-10-01T00:00:00Z', kinds, (id) => (id === 'X' || id === 'A' ? 'ned-ed' : null));
    expect(r.filter((x) => x.reason === 'hazai_bajnoksag_csak_elozmeny_forrasbol').map((x) => x.teamId)).toEqual(['X', 'X']);
  });
});
