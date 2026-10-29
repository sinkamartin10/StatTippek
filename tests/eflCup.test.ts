/**
 * EFL Cup (Carabao Cup, `domesticCup`) – a valódi `EspnProvider` hamisított ESPN-válaszokkal, hálózat nélkül.
 *
 * A válaszok alakja és az azonosítók a valódi ESPN-adatból (eng.league_cup, liga-azonosító 3920,
 * „English Carabao Cup”, 2026-os idény): Everton (368) – Newcastle United (361) 2026. 10. 29., DraftKings-vonal
 * (+130 / +240 / +185, 2,5 gól: -155 / +120); Rochdale (303) – Tranmere Rovers (345), 2–2 után 11-esek (FT-Pens).
 *
 * Ellenőrzi: a kupa scoreboardjának lekérését és feldolgozását, a „Kupamérkőzés” címkét, a valódi odds
 * értelmezését (és hogy odds nélkül nincs kitalált érték), a Premier League / Championship csapatok elsődleges
 * sorozatát, a csak kupából ismert alsóbb osztályú csapatot, a 11-essel eldőlt meccs jelölését, a tabella
 * hiányát, a csapatok bajnokságából számolt alapértéket, a külön kupás motorverziót és a szelvényből kizárt
 * odds nélküli lábat.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ESPN_LEAGUES, EspnProvider, SLUG } from '../src/server/data/espnProvider';
import { XS_KINDS } from '../src/server/model/xsCompetitions';
import { competitionFormat, hasLeagueTable } from '../src/shared/competitionFormat';
import { chooseBaseline } from '../src/shared/engine/baseline';
import { computeLeagueAverages } from '../src/shared/engine/stats';
import { analyzeMatch } from '../src/shared/engine/analysis';
import { buildSlips } from '../src/shared/engine/slips';
import { CUP_ENGINE_VERSION } from '../src/shared/engine/version';
import { baseModelInfo } from '../src/shared/engine/xsAnalysis';
import { engineOf } from '../src/server/tipArchive/service';
import { AnalysisService } from '../src/server/services/analysisService';
import type { Container } from '../src/server/container';
import type { League, Match, MatchResult, ResearchResult, SlipLeg, Team } from '../src/shared/types';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/';
const T = { everton: 368, newcastle: 361, middlesbrough: 369, wrexham: 352, rochdale: 303, tranmere: 345 } as const;
const NAME: Record<number, string> = {
  [T.everton]: 'Everton', [T.newcastle]: 'Newcastle United', [T.middlesbrough]: 'Middlesbrough', [T.wrexham]: 'Wrexham',
  [T.rochdale]: 'Rochdale', [T.tranmere]: 'Tranmere Rovers',
};
const TEAMS: Record<string, number[]> = {
  'eng.1': [T.everton, T.newcastle],
  'eng.2': [T.middlesbrough, T.wrexham],
  'eng.league_cup': Object.values(T),
};
const team = (id: number) => ({ id: String(id), displayName: NAME[id], shortDisplayName: NAME[id], abbreviation: NAME[id].slice(0, 3).toUpperCase() });
/** a valódi ESPN odds-objektum alakja (DraftKings) */
const DK_ODDS = {
  provider: { name: 'DraftKings' }, details: 'EVE +130', overUnder: 2.5,
  moneyline: { home: { open: { odds: '+125' }, close: { odds: '+130' } }, draw: { open: { odds: '+215' }, close: { odds: '+240' } }, away: { open: { odds: '+185' }, close: { odds: '+185' } } },
  total: { over: { close: { line: 'o2.5', odds: '-155' } }, under: { close: { line: 'u2.5', odds: '+120' } } },
};
const scheduled = (id: string, date: string, home: number, away: number, odds?: unknown) => ({
  id, date,
  competitions: [{
    status: { type: { name: 'STATUS_SCHEDULED', state: 'pre', completed: false } },
    competitors: [{ homeAway: 'home', team: team(home) }, { homeAway: 'away', team: team(away) }],
    ...(odds ? { odds: [odds] } : {}),
  }],
});
/** 2026. 10. 29.: a valódi Everton – Newcastle (oddsszal) + egy odds nélküli meccs */
const DAY = [
  scheduled('401921844', '2026-10-29T19:45Z', T.everton, T.newcastle, DK_ODDS),
  scheduled('401921845', '2026-10-29T19:45Z', T.wrexham, T.middlesbrough),
];
const SCHEDULES: Record<string, unknown[]> = {};
/** csak összefoglalóból elérhető kupameccs: két League Two-csapat (egyikük bajnoksága sincs a rendszerben) */
const EXTRA_EVENTS = [scheduled('401921846', '2026-10-29T19:45Z', T.rochdale, T.tranmere)];

function serve(log: string[]) {
  return vi.fn(async (url: string) => {
    const path = String(url).replace(BASE, '');
    log.push(path);
    let m = path.match(/^([^/]+)\/teams$/);
    if (m) return new Response(JSON.stringify({ sports: [{ leagues: [{ teams: (TEAMS[m[1]] ?? []).map((id) => ({ team: team(id) })) }] }] }));
    m = path.match(/^([^/]+)\/scoreboard\?dates=(\d{8})$/);
    if (m) {
      const events = m[1] === 'eng.league_cup' && m[2] === '20261029' ? DAY : [];
      return new Response(JSON.stringify({ leagues: [{ id: '3920', slug: 'eng.league_cup', name: 'English Carabao Cup', season: { year: 2026, startDate: '2026-07-01T00:00Z' } }], events }));
    }
    // egy meccs összefoglalója (közvetlen meccsoldal / elemzés hidegindításkor): a napi lista eseményeiből
    m = path.match(/^eng\.league_cup\/summary\?event=(\d+)$/);
    if (m) {
      const ev = [...DAY, ...EXTRA_EVENTS].find((e) => e.id === m![1]);
      return new Response(JSON.stringify(ev ? { header: { competitions: [{ ...ev.competitions[0], date: ev.date }] } } : {}));
    }
    if (/\/teams\/\d+\/schedule/.test(path)) return new Response(JSON.stringify({ events: SCHEDULES[path] ?? [] }));
    return new Response(JSON.stringify({ events: [] }));
  });
}
async function withProvider<T>(fn: (p: EspnProvider, log: string[]) => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
  const log: string[] = [];
  vi.stubGlobal('fetch', serve(log));
  try { return await fn(new EspnProvider(), log); } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); for (const k of Object.keys(SCHEDULES)) delete SCHEDULES[k]; });

const EFL = ESPN_LEAGUES.find((l) => l.id === 'eng-efl')!;
const PL = ESPN_LEAGUES.find((l) => l.id === 'eng-pl')!;

describe('EFL Cup – sorozat', () => {
  it('hazai kupaként szerepel, a valódi ESPN-sluggal; nincs tabella, és nincs a bajnoki tanítókörben', () => {
    expect(EFL).toEqual({ id: 'eng-efl', name: 'EFL Cup (Carabao Cup)', country: 'Anglia', countryCode: 'ENG', tier: 0, international: false, domesticCup: true });
    expect(SLUG['eng-efl']).toBe('eng.league_cup');
    expect(competitionFormat(EFL)).toBe('domestic_cup');
    expect(hasLeagueTable(EFL)).toBe(false);
    expect(XS_KINDS['eng-efl']).toBeUndefined();
  });
});

describe('EFL Cup – adatbetöltés és mérkőzések', () => {
  it('a napi lista lekéri a kupa scoreboardját, és a mérkőzéseket „Kupamérkőzés” címkével adja', async () => {
    const { matches, log } = await withProvider(async (p, log) => ({ matches: await p.getMatches({ date: '2026-10-29', leagueId: 'eng-efl' }), log }));
    expect(log.filter((l) => l.includes('/scoreboard'))).toEqual(['eng.league_cup/scoreboard?dates=20261029']);
    expect(matches.map((m) => [m.id, m.homeTeamId, m.awayTeamId, m.kickoff])).toEqual([
      ['espn-eng.league_cup-401921844', `espn-${T.everton}`, `espn-${T.newcastle}`, '2026-10-29T19:45:00.000Z'],
      ['espn-eng.league_cup-401921845', `espn-${T.wrexham}`, `espn-${T.middlesbrough}`, '2026-10-29T19:45:00.000Z'],
    ]);
    for (const m of matches) {
      expect(m).toMatchObject({ leagueId: 'eng-efl', status: 'scheduled', origin: 'live' });
      expect(m.importanceReasons).toContain('Kupamérkőzés');
      expect(m.importanceReasons).not.toContain('Nemzetközi kupamérkőzés');
    }
  });

  it('a valódi DraftKings-vonal tizedes oddsra váltva; odds nélküli meccshez nincs kitalált érték', async () => {
    const [withOdds, without] = await withProvider(async (p) => {
      await p.getMatches({ date: '2026-10-29', leagueId: 'eng-efl' });
      return Promise.all([p.getOdds('espn-eng.league_cup-401921844'), p.getOdds('espn-eng.league_cup-401921845')]);
    });
    expect(withOdds).toMatchObject({ bookmaker: 'DraftKings (ESPN)', markets: { '1': 2.3, X: 3.4, '2': 2.85 } });
    expect(withOdds!.markets['O2.5']).toBeCloseTo(1.65, 2);
    expect(withOdds!.markets['U2.5']).toBeCloseTo(2.2, 2);
    expect(without).toBeNull();
  });

  it('csapatok: PL / Championship elsődleges sorozata a bajnokság; a csak kupából ismert League Two-csapaté a kupa, Anglia', async () => {
    const teams = await withProvider((p) => p.getTeams());
    const byId = new Map(teams.map((t) => [t.id, t]));
    expect(byId.get(`espn-${T.everton}`)).toMatchObject({ leagueId: 'eng-pl', country: 'Anglia' });
    expect(byId.get(`espn-${T.middlesbrough}`)).toMatchObject({ leagueId: 'eng-ch', country: 'Anglia' });
    for (const id of [T.rochdale, T.tranmere]) expect(byId.get(`espn-${id}`)).toMatchObject({ leagueId: 'eng-efl', country: 'Anglia' });
  });

  it('11-essel eldőlt kupameccs (FT-Pens): nem rendes játékidős eredményként jelölve; a kupa előző idénye nem töltődik', async () => {
    SCHEDULES[`eng.league_cup/teams/${T.tranmere}/schedule`] = [{
      id: '401900500', date: '2026-08-12T18:45Z',
      competitions: [{
        status: { type: { name: 'STATUS_FINAL_PEN', shortDetail: 'FT-Pens', completed: true } },
        competitors: [
          { homeAway: 'home', team: team(T.tranmere), score: { value: 2, displayValue: '2', shootoutScore: 2 } },
          { homeAway: 'away', team: team(T.rochdale), score: { value: 2, displayValue: '2', shootoutScore: 1 } },
        ],
      }],
    }];
    const { results, log } = await withProvider(async (p, log) => {
      await p.getMatches({ date: '2026-10-29', leagueId: 'eng-efl' });
      return { results: await p.getTeamResults(`espn-${T.tranmere}`), log };
    });
    expect(results).toEqual([expect.objectContaining({ leagueId: 'eng-efl', homeGoals: 2, awayGoals: 2, regulation: false, decidedBy: 'pen', shootout: { home: 2, away: 1 } })]);
    expect(log.filter((l) => l.includes(`/teams/${T.tranmere}/schedule`))).toEqual([`eng.league_cup/teams/${T.tranmere}/schedule`]);
  });
});

describe('EFL Cup – elemzés', () => {
  let seq = 0;
  const res = (leagueId: string, home: string, away: string, hg: number, ag: number, day: number, o: Partial<MatchResult> = {}): MatchResult =>
    ({ id: `r${++seq}`, leagueId, date: new Date(Date.parse('2026-08-01T15:00:00Z') + day * 86_400_000).toISOString(), homeTeamId: home, awayTeamId: away, homeGoals: hg, awayGoals: ag, origin: 'live', ...o });
  const PL_TEAMS = ['everton', 'newcastle', 'arsenal', 'chelsea'];
  const scores: [number, number][] = [[2, 0], [1, 1], [0, 1], [3, 2]];
  const plSeason: MatchResult[] = [];
  let k = 0;
  for (const h of PL_TEAMS) for (const a of PL_TEAMS) if (h !== a) { const [hg, ag] = scores[k % 4]; plSeason.push(res('eng-pl', h, a, hg, ag, k++)); }
  const cup = [res('eng-efl', 'tranmere', 'everton', 0, 6, 10), res('eng-efl', 'rochdale', 'newcastle', 2, 2, 11, { regulation: false, decidedBy: 'pen', shootout: { home: 1, away: 3 } })];
  const all = [...plSeason, ...cup];
  const t = (id: string): Team => ({ id, name: id, shortName: id.slice(0, 3).toUpperCase(), country: 'Anglia', leagueId: 'eng-pl' });
  const research: ResearchResult = { matchId: 'm', origin: 'live', performedAt: '', provider: 'x', news: [], availability: { home: { teamId: 'h', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] }, away: { teamId: 'a', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] } }, externalPredictions: [], sources: [], warnings: [] };
  const match: Match = { id: 'm-efl', leagueId: 'eng-efl', homeTeamId: 'everton', awayTeamId: 'newcastle', kickoff: '2026-10-29T19:45:00Z', status: 'scheduled', importance: 'high', importanceReasons: ['Kupamérkőzés'], origin: 'live' };

  it('alapérték a csapatok bajnokságából (Premier League), nem a kupa torzított eredményeiből; nincs tabella-helyezés', () => {
    expect(chooseBaseline({ league: EFL, teamLeagues: { home: PL, away: PL }, results: all })).toMatchObject({ source: 'teams_league', leagueIds: ['eng-pl'], label: 'Premier League' });
    const a = analyzeMatch({ match, league: EFL, homeTeam: t('everton'), awayTeam: t('newcastle'), results: all, odds: null, research, now: '2026-10-29T12:00:00Z', teamLeagues: { home: PL, away: PL } });
    expect(a.leagueAverages).toEqual(computeLeagueAverages('eng-pl', all));
    expect(a.standings).toEqual({ home: null, away: null, total: 0 });
    expect(a.oneXtwoFactors.join(' ')).toMatch(/Kupamérkőzés: a liga-alapérték a\(z\) Premier League/);
    // odds nélkül egyetlen tipp sem kap kitalált oddsot
    expect(a.tips.every((x) => x.odds == null && x.impliedProb == null)).toBe(true);
  });

  it('külön kupás motorverzió → a kupás tippek és kalibráció nem keveredik a bajnokival', () => {
    expect(baseModelInfo(EFL).id).toBe(CUP_ENGINE_VERSION);
    expect(baseModelInfo(PL).id).not.toBe(CUP_ENGINE_VERSION);
    const a = analyzeMatch({ match, league: EFL, homeTeam: t('everton'), awayTeam: t('newcastle'), results: all, odds: null, research, now: '2026-10-29T12:00:00Z', teamLeagues: { home: PL, away: PL } });
    expect(engineOf({ ...a, model: baseModelInfo(EFL) })).toBe(CUP_ENGINE_VERSION);
  });

  it('odds nélküli kupaláb nem kerül szelvényre', () => {
    const leg = (matchId: string, odds: number): SlipLeg => ({
      matchId, matchLabel: matchId, leagueName: EFL.name, kickoff: '2026-10-29T19:45:00Z', market: '1', label: 'Hazai győzelem', modelProb: 0.8,
      odds, bookmaker: odds > 1 ? 'DraftKings (ESPN)' : null, impliedProb: odds > 1 ? 1 / odds : 0, diffPoints: 0, category: 'biztonságos' as SlipLeg['category'], supportingIndicators: 4, dataQuality: 'magas',
    });
    const slips = buildSlips([leg('a', 1.5), leg('b', 1.6), leg('no-odds', Number.NaN), leg('zero', 0)], { legs: 2, minTotalOdds: 1, minLegProb: 0.5 });
    expect(slips.length).toBeGreaterThan(0);
    for (const s of slips) expect(s.legs.map((l) => l.matchId).sort()).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Hidegindítás: az ELSŐ kérés közvetlenül egy kupameccs elemzése (üres gyorsítótár)
// ---------------------------------------------------------------------------

describe('EFL Cup – elemzés hidegindítás után (első kérés egy kupameccs)', () => {
  /** lejátszott meccs a csapat-menetrendben */
  const fin = (id: string, date: string, home: number, away: number, hg: number, ag: number) => ({
    id, date,
    competitions: [{
      status: { type: { name: 'STATUS_FULL_TIME', shortDetail: 'FT', completed: true } },
      competitors: [
        { homeAway: 'home', team: { ...team(home), displayName: NAME[home] ?? `Team ${home}` } , score: { value: hg, displayValue: String(hg) } },
        { homeAway: 'away', team: { ...team(away), displayName: NAME[away] ?? `Team ${away}` }, score: { value: ag, displayValue: String(ag) } },
      ],
    }],
  });
  for (const id of [9101, 9102, 9103]) NAME[id] = `PL ${id}`;
  /** Premier League: 12 meccs, alacsony gólszám (≥ MIN_BASELINE_MATCHES) */
  const plSchedules = (): void => {
    const opp = [9101, 9102, 9103];
    SCHEDULES[`eng.1/teams/${T.everton}/schedule`] = opp.flatMap((o, i) => [
      fin(`70${i}1`, `2026-08-${10 + i}T14:00Z`, T.everton, o, 1, 0), fin(`70${i}2`, `2026-09-${10 + i}T14:00Z`, o, T.everton, 1, 1)]);
    SCHEDULES[`eng.1/teams/${T.newcastle}/schedule`] = opp.flatMap((o, i) => [
      fin(`71${i}1`, `2026-08-${20 + i}T14:00Z`, T.newcastle, o, 0, 0), fin(`71${i}2`, `2026-09-${20 + i}T14:00Z`, o, T.newcastle, 1, 0)]);
    // a kupa saját eredményei: kiugró gólszám – ha ebből számolna, az alapérték torzulna
    SCHEDULES[`eng.league_cup/teams/${T.everton}/schedule`] = [fin('7201', '2026-08-26T18:45Z', T.tranmere, T.everton, 0, 6)];
    SCHEDULES[`eng.league_cup/teams/${T.newcastle}/schedule`] = [fin('7202', '2026-08-27T18:45Z', T.rochdale, T.newcastle, 1, 5)];
    SCHEDULES[`eng.league_cup/teams/${T.tranmere}/schedule`] = [fin('7201', '2026-08-26T18:45Z', T.tranmere, T.everton, 0, 6)];
    SCHEDULES[`eng.league_cup/teams/${T.rochdale}/schedule`] = [fin('7202', '2026-08-27T18:45Z', T.rochdale, T.newcastle, 1, 5)];
  };
  const service = (p: EspnProvider) => new AnalysisService({
    data: p, oddsApi: null,
    research: { research: async ({ match }: { match: Match }) => ({ matchId: match.id, origin: 'live', performedAt: '', provider: 'x', news: [], availability: { home: { teamId: 'h', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] }, away: { teamId: 'a', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] } }, externalPredictions: [], sources: [], warnings: [] }) },
    db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined },
  } as unknown as Container);

  it('a csapatok bajnoki adatai előbb betöltődnek, és az elemzés a Premier League statisztikáiból számol (nem a kupáéból)', async () => {
    plSchedules();
    const { a, log } = await withProvider(async (p, log) => ({ a: await service(p).analyze('espn-eng.league_cup-401921844'), log }));
    expect(a).not.toBeNull();
    // a meccs a kupa összefoglalójából ismert lett, a csapatok bajnoksága mégis a Premier League
    expect(log[0]).toBe('eng.league_cup/summary?event=401921844');
    expect(a!.homeTeam).toMatchObject({ name: 'Everton', leagueId: 'eng-pl' });
    expect(a!.awayTeam).toMatchObject({ name: 'Newcastle United', leagueId: 'eng-pl' });
    // a bajnoki csapatlista és a bajnoki menetrendek lekérődtek
    expect(log).toContain('eng.1/teams');
    expect(log).toContain(`eng.1/teams/${T.everton}/schedule`);
    expect(log).toContain(`eng.1/teams/${T.newcastle}/schedule`);
    // alapérték: a 12 Premier League-meccs (1,0 gól/meccs alatti átlag), NEM a kupa 6–0 / 5–1 eredményei
    expect(a!.oneXtwoFactors.join(' ')).toMatch(/Kupamérkőzés: a liga-alapérték a\(z\) Premier League/);
    expect(a!.leagueAverages.matches).toBe(12);
    expect(a!.leagueAverages.avgTotalGoals).toBeCloseTo(12 / 12, 5); // Everton 9 + Newcastle 3 gól (a kupában 6–0, 5–1 volt)
    expect(a!.standings).toEqual({ home: null, away: null, total: 0 });
    expect(a!.model?.id).toBe(CUP_ENGINE_VERSION);
    // nincs felesleges ismételt lekérés: minden csapatlista pontosan egyszer
    const lists = log.filter((l) => /^[^/]+\/teams$/.test(l));
    expect(lists.length).toBeGreaterThan(0);
    expect(new Set(lists).size).toBe(lists.length);
  });

  it('fallback: ha egyik csapat bajnoksága sem állapítható meg, a kupa saját eredményeiből számol (biztonságosan)', async () => {
    plSchedules();
    const { a, log } = await withProvider(async (p, log) => ({ a: await service(p).analyze('espn-eng.league_cup-401921846'), log }));
    expect(a).not.toBeNull();
    expect(a!.homeTeam.leagueId).toBe('eng-efl');
    expect(a!.awayTeam.leagueId).toBe('eng-efl');
    // alapérték: a kupa saját rendes játékidős eredményei (6–0, 5–1) – bajnoki adat nem keveredik bele
    expect(a!.leagueAverages.matches).toBe(2);
    expect(a!.leagueAverages.avgTotalGoals).toBeCloseTo(6, 5);
    expect(a!.oneXtwoFactors.join(' ')).not.toMatch(/Premier League/);
    // ennyi adatból nincs megalapozott gólmodell → nincs kitalált tipp sem
    expect(a!.poisson).toBeNull();
    // a csapatlisták itt is legfeljebb egyszer kérődtek le
    const lists = log.filter((l) => /^[^/]+\/teams$/.test(l));
    expect(new Set(lists).size).toBe(lists.length);
  });

  it('a bajnoki meccs elemzése hidegindításkor változatlanul a saját bajnokságából számol', async () => {
    plSchedules();
    const p0 = await withProvider(async (p) => {
      const t = await p.getTeam(`espn-${T.everton}`);
      return t;
    });
    expect(p0).toMatchObject({ leagueId: 'eng-pl' });
  });
});
