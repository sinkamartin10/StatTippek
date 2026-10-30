/**
 * A-League Men (rendes bajnokság) – a valódi `EspnProvider` hamisított ESPN-válaszokkal, hálózat nélkül.
 *
 * A válaszok alakja, a csapatok, az eredmények és az árak a valódi ESPN-adatból (aus.1, liga-azonosító 3906,
 * „Australian A-League Men”, 2026-os idény, kezdete 2026-07-01):
 *  - a 2026. októberi 11 lejátszott forduló-mérkőzés valódi eredménye,
 *  - 2026. 11. 01.: Melbourne Victory – Central Coast Mariners (DraftKings -235 / +380 / +500, 3,5 gól: +125 / -175),
 *    Perth Glory – Adelaide United (DraftKings +175 / +255 / +135, 2,5 gól: -160 / +115),
 *  - 2026. 11. 06.: Sydney FC – Central Coast Mariners: odds-objektum ár és iroda NÉLKÜL (így szerepel az ESPN-ben).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ESPN_LEAGUES, EspnProvider, SLUG } from '../src/server/data/espnProvider';
import { XS_KINDS, XS_TRAINING_COMPETITIONS } from '../src/server/model/xsCompetitions';
import { competitionFormat, hasLeagueTable } from '../src/shared/competitionFormat';
import { computeLeagueAverages, computeStandings } from '../src/shared/engine/stats';
import { analyzeMatch } from '../src/shared/engine/analysis';
import { buildSlips } from '../src/shared/engine/slips';
import { CUP_ENGINE_VERSION, ENGINE_VERSION } from '../src/shared/engine/version';
import { baseModelInfo } from '../src/shared/engine/xsAnalysis';
import { engineOf } from '../src/server/tipArchive/service';
import type { Match, MatchAnalysis, ResearchResult, SlipLeg, Team } from '../src/shared/types';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/';
const NAME: Record<number, string> = {
  5321: 'Adelaide United FC', 22344: 'Auckland FC', 5326: 'Brisbane Roar FC', 5325: 'Central Coast Mariners FC', 19340: 'Macarthur FC',
  11143: 'Melbourne City FC', 5328: 'Melbourne Victory', 5323: 'Newcastle Jets', 5322: 'Perth Glory FC', 5327: 'Sydney FC',
  8352: 'Wellington Phoenix', 13696: 'Western Sydney Wanderers FC',
};
const IDS = Object.keys(NAME).map(Number);
/** a 2026. októberi valódi eredmények: [esemény, kezdés, hazai, vendég, hazai gól, vendég gól] */
const OCTOBER: [string, string, number, number, number, number][] = [
  ['401892162', '2026-10-16T09:00Z', 5327, 13696, 0, 0], ['401892161', '2026-10-17T04:00Z', 22344, 11143, 3, 1],
  ['401892160', '2026-10-17T06:00Z', 19340, 5322, 2, 1], ['401892159', '2026-10-17T08:40Z', 5325, 5323, 2, 2],
  ['401892158', '2026-10-18T02:00Z', 8352, 5328, 2, 1], ['401892156', '2026-10-23T09:00Z', 5326, 5322, 2, 1],
  ['401892155', '2026-10-24T04:00Z', 5323, 19340, 1, 1], ['401892154', '2026-10-24T06:00Z', 13696, 22344, 5, 2],
  ['401892153', '2026-10-24T08:40Z', 5328, 11143, 1, 1], ['401892152', '2026-10-25T02:00Z', 8352, 5325, 2, 0],
  ['401892151', '2026-10-25T04:00Z', 5327, 5321, 2, 1],
];
const team = (id: number) => ({ id: String(id), displayName: NAME[id], shortDisplayName: NAME[id], abbreviation: NAME[id].slice(0, 3).toUpperCase() });
const played = ([id, date, h, a, hg, ag]: (typeof OCTOBER)[number]) => ({
  id, date,
  competitions: [{
    status: { type: { name: 'STATUS_FULL_TIME', shortDetail: 'FT', completed: true } },
    competitors: [
      { homeAway: 'home', team: team(h), score: { value: hg, displayValue: String(hg) } },
      { homeAway: 'away', team: team(a), score: { value: ag, displayValue: String(ag) } },
    ],
  }],
});
const ml = (h: string, d: string, a: string) => ({ home: { close: { odds: h } }, draw: { close: { odds: d } }, away: { close: { odds: a } } });
const scheduled = (id: string, date: string, home: number, away: number, odds: unknown) => ({
  id, date,
  competitions: [{
    status: { type: { name: 'STATUS_SCHEDULED', state: 'pre', completed: false } },
    competitors: [{ homeAway: 'home', team: team(home) }, { homeAway: 'away', team: team(away) }],
    odds: [odds],
  }],
});
const DAYS: Record<string, unknown[]> = {
  20261101: [
    scheduled('401892146', '2026-11-01T04:00Z', 5328, 5325, { provider: { name: 'DraftKings' }, overUnder: 3.5, moneyline: ml('-235', '+380', '+500'),
      total: { over: { close: { line: 'o3.5', odds: '+125' } }, under: { close: { line: 'u3.5', odds: '-175' } } } }),
    scheduled('401892145', '2026-11-01T07:00Z', 5322, 5321, { provider: { name: 'DraftKings' }, overUnder: 2.5, moneyline: ml('+175', '+255', '+135'),
      total: { over: { close: { line: 'o2.5', odds: '-160' } }, under: { close: { line: 'u2.5', odds: '+115' } } } }),
  ],
  // valódi alak: van odds-objektum, de sem iroda, sem ár
  20261106: [scheduled('401892144', '2026-11-06T08:40Z', 5327, 5325, { moneyline: { home: {}, draw: {}, away: {} } })],
};

function serve(log: string[]) {
  return vi.fn(async (url: string) => {
    const path = String(url).replace(BASE, '');
    log.push(path);
    if (path === 'aus.1/teams') return new Response(JSON.stringify({ sports: [{ leagues: [{ teams: IDS.map((id) => ({ team: team(id) })) }] }] }));
    if (/^[^/]+\/teams$/.test(path)) return new Response(JSON.stringify({ sports: [{ leagues: [{ teams: [] }] }] }));
    let m = path.match(/^aus\.1\/scoreboard\?dates=(\d{8})$/);
    if (m) return new Response(JSON.stringify({ leagues: [{ id: '3906', slug: 'aus.1', name: 'Australian A-League Men', season: { year: 2026, startDate: '2026-07-01T04:00Z' } }], events: DAYS[m[1]] ?? [] }));
    // csapat-menetrend: az aktuális idény (season paraméter nélkül) a csapat októberi meccsei; az előző idény üres
    m = path.match(/^aus\.1\/teams\/(\d+)\/schedule$/);
    if (m) return new Response(JSON.stringify({ events: OCTOBER.filter((r) => r[2] === +m![1] || r[3] === +m![1]).map(played) }));
    return new Response(JSON.stringify({ events: [] }));
  });
}
async function withProvider<R>(fn: (p: EspnProvider, log: string[]) => Promise<R>): Promise<R> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  const log: string[] = [];
  vi.stubGlobal('fetch', serve(log));
  try { return await fn(new EspnProvider(), log); } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const AL = ESPN_LEAGUES.find((l) => l.id === 'aus-al')!;

describe('A-League Men – sorozat', () => {
  it('rendes bajnokságként szerepel a valódi ESPN-sluggal: van tabella, és a több ligás modell tanítóadatában van', () => {
    expect(AL).toEqual({ id: 'aus-al', name: 'A-League Men', country: 'Ausztrália', countryCode: 'AUS', tier: 1, international: false });
    expect(SLUG['aus-al']).toBe('aus.1');
    expect(competitionFormat(AL)).toBe('league');
    expect(hasLeagueTable(AL)).toBe(true);
    expect(XS_KINDS['aus-al']).toBe('domestic');
    expect(XS_TRAINING_COMPETITIONS).toContain('aus-al');
  });
});

describe('A-League Men – adatbetöltés, mérkőzések, odds', () => {
  it('a napi lista csak a bajnokság scoreboardját kéri; bajnoki meccs, nem kupamérkőzés', async () => {
    const { matches, log } = await withProvider(async (p, log) => ({ matches: await p.getMatches({ date: '2026-11-01', leagueId: 'aus-al' }), log }));
    expect(log.filter((l) => l.includes('/scoreboard'))).toEqual(['aus.1/scoreboard?dates=20261101']);
    expect(matches.map((m) => [m.id, m.homeTeamId, m.awayTeamId, m.kickoff])).toEqual([
      ['espn-aus.1-401892146', 'espn-5328', 'espn-5325', '2026-11-01T04:00:00.000Z'],
      ['espn-aus.1-401892145', 'espn-5322', 'espn-5321', '2026-11-01T07:00:00.000Z'],
    ]);
    for (const m of matches) {
      expect(m).toMatchObject({ leagueId: 'aus-al', status: 'scheduled', origin: 'live' });
      expect(m.importanceReasons.join(' ')).not.toMatch(/kupamérkőzés/i);
    }
  });

  it('valódi DraftKings-oddsok tizedesre váltva; ár nélküli odds-objektumból nincs kitalált érték', async () => {
    const [victory, perth, sydney] = await withProvider(async (p) => {
      await p.getMatches({ from: '2026-11-01', to: '2026-11-06', leagueId: 'aus-al' });
      return Promise.all(['401892146', '401892145', '401892144'].map((id) => p.getOdds(`espn-aus.1-${id}`)));
    });
    expect(victory).toMatchObject({ bookmaker: 'DraftKings (ESPN)', markets: { '1': 1.43, X: 4.8, '2': 6, 'O3.5': 2.25, 'U3.5': 1.57 } });
    expect(perth).toMatchObject({ bookmaker: 'DraftKings (ESPN)', markets: { '1': 2.75, X: 3.55, '2': 2.35, 'O2.5': 1.63, 'U2.5': 2.15 } });
    expect(sydney).toBeNull();
  });

  it('csapatok: mind a 12 klub (az új-zélandiak is) az A-League-hez tartozik', async () => {
    const teams = await withProvider((p) => p.getTeams());
    const al = teams.filter((t) => t.leagueId === 'aus-al');
    expect(al.map((t) => t.name).sort()).toEqual(Object.values(NAME).sort());
    expect(al.every((t) => t.country === 'Ausztrália')).toBe(true);
  });

  it('eredmények és tabella: a valódi októberi forduló 11 meccse, a tabella élén a Wellington Phoenix', async () => {
    const results = await withProvider((p) => p.getLeagueResults('aus-al'));
    expect(results).toHaveLength(11);
    expect(results.every((r) => r.leagueId === 'aus-al' && r.regulation !== false)).toBe(true);
    const table = computeStandings('aus-al', results);
    expect(table).toHaveLength(12);
    expect(table[0]).toMatchObject({ teamId: 'espn-8352', played: 2, wins: 2, points: 6, gf: 4, ga: 1, position: 1 });
    expect(table[1]).toMatchObject({ teamId: 'espn-13696', played: 2, points: 4, gd: 3, position: 2 });
    expect(computeLeagueAverages('aus-al', results)).toMatchObject({ matches: 11 });
  });
});

describe('A-League Men – elemzés, motorverzió, szelvény', () => {
  const research: ResearchResult = { matchId: 'm', origin: 'live', performedAt: '', provider: 'x', news: [], availability: { home: { teamId: 'h', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] }, away: { teamId: 'a', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] } }, externalPredictions: [], sources: [], warnings: [] };
  const t = (id: number): Team => ({ id: `espn-${id}`, name: NAME[id], shortName: NAME[id].slice(0, 3), country: 'Ausztrália', leagueId: 'aus-al' });
  const match: Match = { id: 'espn-aus.1-401892146', leagueId: 'aus-al', homeTeamId: 'espn-5328', awayTeamId: 'espn-5325', kickoff: '2026-11-01T04:00:00Z', status: 'scheduled', importance: 'normal', importanceReasons: [], origin: 'live' };

  it('a meglévő bajnoki elemzés: saját liga-átlag és tabella-helyezés, nincs kupás alapérték', async () => {
    const results = await withProvider((p) => p.getLeagueResults('aus-al'));
    const a = analyzeMatch({ match, league: AL, homeTeam: t(5328), awayTeam: t(5325), results, odds: null, research, now: '2026-10-30T12:00:00Z', seasonStart: '2026-07-01T04:00:00Z' });
    expect(a.leagueAverages).toEqual(computeLeagueAverages('aus-al', results));
    expect(a.standings.total).toBe(12);
    expect(a.standings.home).toMatchObject({ teamId: 'espn-5328' });
    expect(a.standings.away).toMatchObject({ teamId: 'espn-5325' });
    expect(a.oneXtwoFactors.join(' ')).not.toMatch(/Kupamérkőzés/);
    // odds nélkül egyetlen tipp sem kap kitalált oddsot
    expect(a.tips.every((x) => x.odds == null && x.impliedProb == null)).toBe(true);
  });

  it('a bajnoki (nem a kupás) motorverzió', () => {
    expect(baseModelInfo(AL).id).toBe(ENGINE_VERSION);
    expect(baseModelInfo(AL).id).not.toBe(CUP_ENGINE_VERSION);
    expect(engineOf({ model: baseModelInfo(AL) } as MatchAnalysis)).toBe(ENGINE_VERSION);
  });

  it('odds nélküli láb nem kerül szelvényre (a Duplázó ugyanezt a szelvényépítőt használja)', () => {
    const leg = (matchId: string, odds: number): SlipLeg => ({
      matchId, matchLabel: matchId, leagueName: AL.name, kickoff: '2026-11-01T04:00:00Z', market: '1', label: 'Hazai győzelem', modelProb: 0.8,
      odds, bookmaker: odds > 1 ? 'DraftKings (ESPN)' : null, impliedProb: odds > 1 ? 1 / odds : 0, diffPoints: 0, category: 'biztonságos' as SlipLeg['category'], supportingIndicators: 4, dataQuality: 'magas',
    });
    const slips = buildSlips([leg('victory', 1.43), leg('perth', 2.75), leg('sydney', Number.NaN), leg('zero', 0)], { legs: 2, minTotalOdds: 1, minLegProb: 0.5 });
    expect(slips.length).toBeGreaterThan(0);
    for (const s of slips) expect(s.legs.map((l) => l.matchId).sort()).toEqual(['perth', 'victory']);
  });
});
