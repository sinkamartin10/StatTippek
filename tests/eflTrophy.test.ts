/**
 * EFL Trophy (2026-27: Jersey Mike's Trophy, `domesticCup`, csoportkörrel) – a valódi `EspnProvider` hamisított
 * ESPN-válaszokkal, hálózat nélkül.
 *
 * VALÓDI ESPN-ADAT (2026. 11. 09.; eng.trophy, liga-azonosító 18481, „English EFL Trophy”, 2026-os idény):
 *  - csapatlista: 64 csapat, köztük 16 U21-es akadémiai csapat – a „Sunderland U21” rövid neve csak „Sunderland”,
 *  - csoporttabella (apis/v2 …/standings): 16 csoport („Northern Group A” … „Southern Group H”), 4–4 csapattal;
 *    Northern Group A és B sorai pontosan így (a B csoport sorrendje a válaszban sem rang szerinti),
 *  - Barnet (280, League Two) – Leyton Orient (309, League One), 2026-11-10 19:00Z, Southern Group F, DraftKings:
 *    +140 / +260 / +140, 3,5 gól: +100 / -150,
 *  - Salford City (4703, League Two) – Sunderland U21 (18785), 2026-11-24, Northern Group A – még nincs odds,
 *  - Colchester United (339) – Luton Town (301) 1–1, tizenegyesek 3–4 (FT-Pens), 2026-10-03, Southern Group D,
 *  - Sunderland U21 menetrend: Sheffield Wednesday (399) – Sunderland U21 2–0; Accrington Stanley (2731) –
 *    Sunderland U21 3–3, tizenegyesek 3–1,
 *  - League One (eng.3, 3915) és League Two (eng.4, 3916), 2026-os idény, 24–24 csapat.
 * A TESZTHEZ SZERKESZTETT (élesben még nem létező / nem megfigyelt) adat: a kieséses köri eredmények (a legjobb 32
 * decemberben kezdődik), a bajnoki előzmények gólszámai, a hibás / hiányos válaszok – ezt a tesztek jelölik.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { apiRouter } from '../src/server/routes/api';
import type { AnalysisService as AnalysisServiceT } from '../src/server/services/analysisService';
import { ESPN_LEAGUES, EspnProvider, SLUG, groupLabel, isYouthTeamName, stageLabel } from '../src/server/data/espnProvider';
import { XS_KINDS, XS_TRAINING_COMPETITIONS } from '../src/server/model/xsCompetitions';
import { competitionFormat, hasLeagueTable, FORMAT_INFO, type CompetitionGroup, type CompetitionResultRow } from '../src/shared/competitionFormat';
import { computeLeagueAverages } from '../src/shared/engine/stats';
import { YOUTH_MIN_MATCHES, analyzeMatch } from '../src/shared/engine/analysis';
import { buildSlips } from '../src/shared/engine/slips';
import { CUP_ENGINE_VERSION } from '../src/shared/engine/version';
import { baseModelInfo } from '../src/shared/engine/xsAnalysis';
import { AnalysisService } from '../src/server/services/analysisService';
import { CompetitionResults, GroupTables, advancedSide } from '../src/client/pages/Stats';
import type { Container } from '../src/server/container';
import type { League, Match, MatchResult, ResearchResult, SlipLeg, Team } from '../src/shared/types';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/';
const V2 = 'https://site.api.espn.com/apis/v2/sports/soccer/';
const T = {
  barnet: 280, orient: 309, salford: 4703, sunderlandU21: 18785, arsenalU21: 19299, colchester: 339, luton: 301,
  shw: 399, accrington: 2731, blackpool: 346, wigan: 350, crewe: 396, villaU21: 20075,
} as const;
const NAME: Record<number, [string, string]> = {
  [T.barnet]: ['Barnet', 'Barnet'], [T.orient]: ['Leyton Orient', 'Leyton Orient'], [T.salford]: ['Salford City', 'Salford City'],
  [T.sunderlandU21]: ['Sunderland U21', 'Sunderland'], [T.arsenalU21]: ['Arsenal U21', 'Arsenal U21'], [T.colchester]: ['Colchester United', 'Colchester'],
  [T.luton]: ['Luton Town', 'Luton'], [T.shw]: ['Sheffield Wednesday', 'Sheffield Wed'], [T.accrington]: ['Accrington Stanley', 'Accrington'],
  [T.blackpool]: ['Blackpool', 'Blackpool'], [T.wigan]: ['Wigan Athletic', 'Wigan'], [T.crewe]: ['Crewe Alexandra', 'Crewe'], [T.villaU21]: ['Aston Villa U21', 'A Villa U21'],
  9301: ['L1 ellenfél A', 'L1 A'], 9302: ['L1 ellenfél B', 'L1 B'], 9401: ['L2 ellenfél A', 'L2 A'], 9402: ['L2 ellenfél B', 'L2 B'],
};
const TEAMS: Record<string, number[]> = {
  'eng.3': [T.orient, T.luton, T.shw, T.blackpool, T.wigan, 9301, 9302],
  'eng.4': [T.barnet, T.salford, T.colchester, T.accrington, T.crewe, 9401, 9402],
  'eng.trophy': [T.barnet, T.orient, T.salford, T.sunderlandU21, T.arsenalU21, T.colchester, T.luton, T.shw, T.accrington, T.blackpool, T.wigan, T.crewe, T.villaU21],
};
const team = (id: number) => ({ id: String(id), displayName: NAME[id][0], shortDisplayName: NAME[id][1], abbreviation: NAME[id][0].slice(0, 3).toUpperCase() });
const ml = (h: string, d: string, a: string) => ({ home: { close: { odds: h } }, draw: { close: { odds: d } }, away: { close: { odds: a } } });
const ev = (id: string, date: string, home: number, away: number, opts: { group?: string; slug?: string; odds?: unknown; status?: string } = {}) => ({
  id, date, season: { year: 2026, type: 14472, slug: opts.slug ?? 'group-stage' },
  competitions: [{
    status: { type: { name: opts.status ?? 'STATUS_SCHEDULED', state: 'pre', completed: false } },
    ...(opts.group ? { group: { groupId: '1', name: opts.group, abbreviation: opts.group } } : {}),
    competitors: [{ homeAway: 'home', team: team(home) }, { homeAway: 'away', team: team(away) }],
    ...(opts.odds !== undefined ? { odds: [opts.odds] } : {}),
  }],
});
/** valódi: Barnet – Leyton Orient (DraftKings), Salford – Sunderland U21 (odds nélkül) */
const DAY: Record<string, unknown[]> = {
  20261110: [ev('401906329', '2026-11-10T19:00Z', T.barnet, T.orient, {
    group: 'Southern Group F',
    odds: { provider: { name: 'DraftKings' }, overUnder: 3.5, moneyline: ml('+140', '+260', '+140'), total: { over: { close: { line: 'o3.5', odds: '+100' } }, under: { close: { line: 'u3.5', odds: '-150' } } } },
  })],
  20261124: [ev('401906341', '2026-11-24T20:00Z', T.salford, T.sunderlandU21, { group: 'Northern Group A' })],
  // TESZTHEZ SZERKESZTETT: kieséses köri (legjobb 32) meccs – csoport nélkül, a szakasz a season.slug-ban
  20261208: [ev('401999001', '2026-12-08T19:45Z', T.orient, T.salford, { slug: 'round-of-32' })],
};
const stat = (name: string, v: string) => ({ name, displayValue: v });
const row = (id: number, rank: number, gp: number, w: number, d: number, l: number, gf: number, ga: number, pts: number) => ({
  team: team(id),
  stats: [stat('gamesPlayed', String(gp)), stat('losses', String(l)), stat('pointDifferential', String(gf - ga)), stat('points', String(pts)), stat('pointsAgainst', String(ga)),
    stat('pointsFor', String(gf)), stat('ties', String(d)), stat('wins', String(w)), stat('advanced', '0'), stat('deductions', ''), stat('rank', String(rank))],
});
/** valódi Northern Group A és B (2026. 11. 09.) – a B csoport sorrendje a válaszban sem rang szerinti */
const STANDINGS = {
  name: 'English EFL Trophy',
  children: [
    { name: 'Northern Group A', standings: { entries: [row(T.shw, 1, 2, 2, 0, 0, 4, 1, 6), row(T.accrington, 2, 2, 0, 2, 0, 4, 4, 4), row(T.salford, 3, 2, 0, 1, 1, 2, 3, 1), row(T.sunderlandU21, 4, 2, 0, 1, 1, 3, 5, 1)] } },
    { name: 'Northern Group B', standings: { entries: [row(T.blackpool, 2, 3, 1, 1, 1, 7, 7, 5), row(T.wigan, 1, 2, 2, 0, 0, 6, 4, 6), row(T.crewe, 3, 2, 1, 1, 0, 6, 3, 4), row(T.villaU21, 4, 3, 0, 0, 3, 5, 10, 0)] } },
  ],
};
const SCHEDULES: Record<string, unknown[]> = {};
let standingsBody: unknown = STANDINGS;
let standingsStatus = 200;
let standingsDelay = 0;

function serve(log: string[]) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith(V2)) {
      log.push(`v2:${u.slice(V2.length)}`);
      if (standingsDelay) await new Promise((r) => setTimeout(r, standingsDelay));
      return new Response(JSON.stringify(standingsBody), { status: standingsStatus });
    }
    const path = u.replace(SITE, '');
    log.push(path);
    let m = path.match(/^([^/]+)\/teams$/);
    if (m) return new Response(JSON.stringify({ sports: [{ leagues: [{ teams: (TEAMS[m[1]] ?? []).map((id) => ({ team: team(id) })) }] }] }));
    m = path.match(/^([^/]+)\/scoreboard\?dates=(\d{8})$/);
    if (m) {
      const events = m[1] === 'eng.trophy' ? DAY[m[2]] ?? [] : [];
      return new Response(JSON.stringify({ leagues: [{ id: '18481', slug: 'eng.trophy', name: 'English EFL Trophy', season: { year: 2026, startDate: '2026-07-01T04:00Z' } }], events }));
    }
    m = path.match(/^eng\.trophy\/summary\?event=(\d+)$/);
    if (m) {
      const e = Object.values(DAY).flat().find((x) => (x as { id: string }).id === m![1]) as { date: string; competitions: unknown[] } | undefined;
      return new Response(JSON.stringify(e ? { header: { competitions: [{ ...(e.competitions[0] as object), date: e.date }] } } : {}));
    }
    if (/\/teams\/\d+\/schedule/.test(path)) return new Response(JSON.stringify({ events: SCHEDULES[path] ?? [] }));
    return new Response(JSON.stringify({ events: [] }));
  });
}
async function withProvider<R>(fn: (p: EspnProvider, log: string[]) => Promise<R>): Promise<R> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
  const log: string[] = [];
  vi.stubGlobal('fetch', serve(log));
  try { return await fn(new EspnProvider(), log); } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
}
afterEach(() => {
  vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks();
  for (const k of Object.keys(SCHEDULES)) delete SCHEDULES[k];
  standingsBody = STANDINGS; standingsStatus = 200; standingsDelay = 0;
});

/** lejátszott meccs a csapat-menetrendben (ESPN-alak, a valódi menetrendhez hasonlóan seasonType-pal) */
const fin = (id: string, date: string, home: number, away: number, hg: number, ag: number, o: { status?: string; short?: string; so?: [number, number]; stage?: string } = {}) => ({
  id, date, seasonType: { name: o.stage ?? 'Group Stage' },
  competitions: [{
    status: { type: { name: o.status ?? 'STATUS_FULL_TIME', shortDetail: o.short ?? 'FT', completed: true } },
    competitors: [
      { homeAway: 'home', team: team(home), score: { value: hg, displayValue: String(hg), ...(o.so ? { shootoutScore: o.so[0] } : {}) } },
      { homeAway: 'away', team: team(away), score: { value: ag, displayValue: String(ag), ...(o.so ? { shootoutScore: o.so[1] } : {}) } },
    ],
  }],
});

const EFT = ESPN_LEAGUES.find((l) => l.id === 'eng-eft')!;
const L1 = ESPN_LEAGUES.find((l) => l.id === 'eng-l1')!;
const L2 = ESPN_LEAGUES.find((l) => l.id === 'eng-l2')!;

// ---------------------------------------------------------------------------

describe('EFL Trophy – versenyazonosító és formátum', () => {
  it('hazai kupaként, a valódi ESPN-sluggal (eng.trophy); csoportkörös kupa-formátum, nincs közös tabella', () => {
    expect(EFT).toEqual({ id: 'eng-eft', name: "EFL Trophy (Jersey Mike's Trophy)", country: 'Anglia', countryCode: 'ENG', tier: 0, international: false, domesticCup: true });
    expect(SLUG['eng-eft']).toBe('eng.trophy');
    expect(competitionFormat(EFT)).toBe('domestic_cup_groups');
    expect(hasLeagueTable(EFT)).toBe(false);
    expect(FORMAT_INFO.domestic_cup_groups.text).toMatch(/első két helyezettje jut tovább/);
  });

  it('a League One és a League Two teljes bajnokság (eng.3, eng.4), tabellával', () => {
    expect(L1).toMatchObject({ id: 'eng-l1', name: 'League One', countryCode: 'ENG', tier: 3, international: false });
    expect(L2).toMatchObject({ id: 'eng-l2', name: 'League Two', countryCode: 'ENG', tier: 4, international: false });
    expect([SLUG['eng-l1'], SLUG['eng-l2']]).toEqual(['eng.3', 'eng.4']);
    for (const l of [L1, L2]) { expect(competitionFormat(l)).toBe('league'); expect(hasLeagueTable(l)).toBe(true); expect(l.domesticCup).toBeUndefined(); }
  });

  it('a kupa és az új bajnokságok NEM kerülnek a több ligás modell tanítóadatai közé; a kupa a külön kupamotort kapja', () => {
    for (const id of ['eng-eft', 'eng-l1', 'eng-l2']) {
      expect(XS_KINDS[id], id).toBeUndefined();
      expect(XS_TRAINING_COMPETITIONS, id).not.toContain(id);
    }
    expect(baseModelInfo(EFT).id).toBe(CUP_ENGINE_VERSION);
    expect(baseModelInfo(L1).id).not.toBe(CUP_ENGINE_VERSION);
  });

  it('szakasz- és csoportfeliratok; ismeretlen alak változatlanul (nincs kitalált felirat)', () => {
    expect(groupLabel('Northern Group A')).toBe('Északi A csoport');
    expect(groupLabel('Southern Group H')).toBe('Déli H csoport');
    expect(groupLabel('Group X1')).toBe('Group X1');
    expect(groupLabel(undefined)).toBeUndefined();
    expect(['Group Stage', 'round-of-32', 'Round of 16', 'Rd of 16', 'Quarterfinals', 'Semifinals', 'Final'].map(stageLabel))
      .toEqual(['Csoportkör', 'Legjobb 32', 'Nyolcaddöntő', 'Nyolcaddöntő', 'Negyeddöntő', 'Elődöntő', 'Döntő']);
    expect(stageLabel('Preliminary')).toBe('Preliminary');
  });
});

describe('EFL Trophy – csapatok és U21-es csapatok', () => {
  it('U21 a TELJES névből (a „Sunderland U21” rövid neve csak „Sunderland”); felnőtt csapat nem U21', () => {
    for (const n of ['Sunderland U21', 'Arsenal U21', 'Brighton & Hove Albion U21', 'Aston Villa U-21', 'Chelsea U23']) expect(isYouthTeamName(n), n).toBe(true);
    for (const n of ['Sunderland', 'Luton Town', 'AFC Wimbledon', 'Burton Albion', 'Crewe Alexandra']) expect(isYouthTeamName(n), n).toBe(false);
  });

  it('a csapat elsődleges sorozata a bajnoksága (League One / League Two); az U21-es csapaté a kupa, „youth” jelöléssel', async () => {
    const teams = await withProvider((p) => p.getTeams());
    const byId = new Map(teams.map((t) => [t.id, t]));
    for (const id of [T.orient, T.luton, T.shw]) expect(byId.get(`espn-${id}`)).toMatchObject({ leagueId: 'eng-l1', country: 'Anglia' });
    for (const id of [T.barnet, T.salford, T.colchester]) expect(byId.get(`espn-${id}`)).toMatchObject({ leagueId: 'eng-l2', country: 'Anglia' });
    for (const id of [T.sunderlandU21, T.arsenalU21, T.villaU21]) expect(byId.get(`espn-${id}`)).toMatchObject({ leagueId: 'eng-eft', youth: true });
    expect(byId.get(`espn-${T.sunderlandU21}`)!.name).toBe('Sunderland U21');
    for (const id of [T.orient, T.barnet]) expect(byId.get(`espn-${id}`)!.youth).toBeUndefined();
  });
});

describe('EFL Trophy – mérkőzések, csoportkör, kieséses szakasz, odds', () => {
  it('a napi lista a kupa scoreboardjából; csoportköri meccs a csoporttal, kieséses meccs a szakasszal', async () => {
    const { matches, log } = await withProvider(async (p, log) => ({ matches: await p.getMatches({ from: '2026-11-10', to: '2026-11-10', leagueId: 'eng-eft' }), log }));
    expect(log.filter((l) => l.includes('/scoreboard'))).toEqual(['eng.trophy/scoreboard?dates=20261110']);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ id: 'espn-eng.trophy-401906329', leagueId: 'eng-eft', homeTeamId: `espn-${T.barnet}`, awayTeamId: `espn-${T.orient}`, round: 'Déli F csoport', status: 'scheduled' });
    expect(matches[0].importanceReasons).toContain('Kupamérkőzés');
    const ko = await withProvider((p) => p.getMatches({ date: '2026-12-08', leagueId: 'eng-eft' }));
    expect(ko[0]).toMatchObject({ id: 'espn-eng.trophy-401999001', round: 'Legjobb 32' });
  });

  it('valódi DraftKings-odds tizedesre váltva; odds nélküli meccsnél nincs kitalált odds', async () => {
    const [withOdds, noOdds] = await withProvider(async (p) => {
      await p.getMatches({ date: '2026-11-10', leagueId: 'eng-eft' });
      await p.getMatches({ date: '2026-11-24', leagueId: 'eng-eft' });
      return Promise.all([p.getOdds('espn-eng.trophy-401906329'), p.getOdds('espn-eng.trophy-401906341')]);
    });
    expect(withOdds).toMatchObject({ bookmaker: 'DraftKings (ESPN)', markets: { '1': 2.4, X: 3.6, '2': 2.4, 'O3.5': 2 } });
    expect(withOdds!.markets['U3.5']).toBeCloseTo(1.67, 2);
    expect(noOdds).toBeNull();
  });

  it('odds nélküli kupaláb nem kerül szelvényre (valódi oddsot igénylő szelvényépítő)', () => {
    const leg = (matchId: string, odds: number): SlipLeg => ({
      matchId, matchLabel: matchId, leagueName: EFT.name, kickoff: '2026-11-24T20:00:00Z', market: '1', label: 'Hazai győzelem', modelProb: 0.7,
      odds, bookmaker: odds > 1 ? 'DraftKings (ESPN)' : null, impliedProb: odds > 1 ? 1 / odds : 0, diffPoints: 0, category: 'biztonságos' as SlipLeg['category'], supportingIndicators: 4, dataQuality: 'magas',
    });
    const slips = buildSlips([leg('barnet-orient', 2.4), leg('masik', 1.8), leg('salford-sunderland', Number.NaN)], { legs: 2, minTotalOdds: 1, minLegProb: 0.5 });
    expect(slips.length).toBeGreaterThan(0);
    for (const s of slips) expect(s.legs.map((l) => l.matchId)).not.toContain('salford-sunderland');
  });

  it('csoportköri döntetlen tizenegyesekkel (valódi: Colchester – Luton 1–1, 3–4) és kieséses h.u. / 11-es: külön jelölve, szakasszal', async () => {
    SCHEDULES[`eng.trophy/teams/${T.colchester}/schedule`] = [
      fin('401906352', '2026-10-03T14:00Z', T.colchester, T.luton, 1, 1, { status: 'STATUS_FINAL_PEN', short: 'FT-Pens', so: [3, 4] }),
      // TESZTHEZ SZERKESZTETT kieséses köri eredmények
      fin('401999002', '2026-12-09T19:45Z', T.colchester, T.barnet, 2, 1, { status: 'STATUS_FINAL_AET', short: 'AET', stage: 'Round of 32' }),
      fin('401999003', '2027-01-13T19:45Z', T.luton, T.colchester, 0, 0, { status: 'STATUS_FINAL_PEN', short: 'FT-Pens', so: [2, 4], stage: 'Round of 16' }),
    ];
    const results = await withProvider((p) => p.getTeamResults(`espn-${T.colchester}`));
    const byId = Object.fromEntries(results.filter((r) => r.leagueId === 'eng-eft').map((r) => [r.id, r]));
    const group = byId['espn-eng.trophy-401906352'];
    expect(group).toMatchObject({ homeGoals: 1, awayGoals: 1, regulation: false, decidedBy: 'pen', shootout: { home: 3, away: 4 }, stage: 'Csoportkör', groupStage: true });
    expect(byId['espn-eng.trophy-401999002']).toMatchObject({ homeGoals: 2, awayGoals: 1, regulation: false, decidedBy: 'aet', stage: 'Legjobb 32', groupStage: false });
    expect(byId['espn-eng.trophy-401999003']).toMatchObject({ decidedBy: 'pen', shootout: { home: 2, away: 4 }, stage: 'Nyolcaddöntő', groupStage: false });
    // továbbjutó: csoportkörben nincs; kiesésesnél h.u. után a gólok, 11-esnél a párbaj dönt
    expect(advancedSide(group)).toBeNull();
    expect(advancedSide(byId['espn-eng.trophy-401999002'])).toBe('home');
    expect(advancedSide(byId['espn-eng.trophy-401999003'])).toBe('away');
    expect(advancedSide({ stage: 'Döntő', groupStage: false, homeGoals: 1, awayGoals: 1, decidedBy: 'pen' })).toBeNull(); // párbaj-eredmény nélkül nem állapítható meg
  });

  it('a tizenegyespárbaj (és a hosszabbítás) nem torzítja a rendes játékidős gólátlagot', () => {
    const r = (id: string, hg: number, ag: number, extra: Partial<MatchResult> = {}): MatchResult => ({ id, leagueId: 'eng-eft', date: '2026-10-01T18:00:00Z', homeTeamId: 'a', awayTeamId: 'b', homeGoals: hg, awayGoals: ag, origin: 'live', ...extra });
    const avg = computeLeagueAverages('eng-eft', [r('1', 2, 0), r('2', 1, 1), r('3', 1, 1, { regulation: false, decidedBy: 'pen', shootout: { home: 9, away: 8 } }), r('4', 3, 2, { regulation: false, decidedBy: 'aet' })]);
    expect(avg.matches).toBe(2);
    expect(avg.avgTotalGoals).toBe(2);
  });
});

describe('EFL Trophy – csoporttabellák (hivatalos ESPN-adat)', () => {
  it('16-ból a megadott csoportok, rang szerint rendezve; a pontok a forráséi (döntetlen + 11-es bónuszpont), nem újraszámolva', async () => {
    const { groups, log } = await withProvider(async (p, log) => ({ groups: await p.getGroupStandings('eng-eft'), log }));
    expect(log).toEqual(['v2:eng.trophy/standings']);
    expect(groups!.map((g) => g.name)).toEqual(['Északi A csoport', 'Északi B csoport']);
    const a = groups![0].rows;
    expect(a.map((r) => r.teamId)).toEqual([T.shw, T.accrington, T.salford, T.sunderlandU21].map((id) => `espn-${id}`));
    // Accrington: 0 győzelem, 2 döntetlen, 4 pont – a Trophy bónuszpontja a forrásból (3-1-0 szerint 2 lenne)
    expect(a[1]).toEqual({ teamId: `espn-${T.accrington}`, rank: 2, played: 2, won: 0, drawn: 2, lost: 0, gf: 4, ga: 4, gd: 0, points: 4 });
    // a B csoportot a válasz nem rang szerint adja – rendezve
    expect(groups![1].rows.map((r) => [r.rank, r.teamId])).toEqual([[1, `espn-${T.wigan}`], [2, `espn-${T.blackpool}`], [3, `espn-${T.crewe}`], [4, `espn-${T.villaU21}`]]);
    expect(groups![1].rows[3]).toMatchObject({ gf: 5, ga: 10, gd: -5, points: 0 });
  });

  it('hiányos sor kimarad, üres / hibás / sikertelen válasz → null (nincs kitalált tabella); nem csoportos sorozat → null kérés nélkül', async () => {
    standingsBody = { children: [{ name: 'Northern Group A', standings: { entries: [row(T.shw, 1, 2, 2, 0, 0, 4, 1, 6), { team: team(T.salford), stats: [stat('rank', '3')] }, { stats: [] }] } }] };
    const partial = await withProvider((p) => p.getGroupStandings('eng-eft'));
    expect(partial![0].rows.map((r) => r.teamId)).toEqual([`espn-${T.shw}`]);
    for (const body of [{}, { children: [] }, { children: [{ name: 'X', standings: { entries: [] } }] }, null]) {
      standingsBody = body;
      expect(await withProvider((p) => p.getGroupStandings('eng-eft')), JSON.stringify(body)).toBeNull();
    }
    standingsBody = STANDINGS; standingsStatus = 500;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await withProvider((p) => p.getGroupStandings('eng-eft'))).toBeNull();
    standingsStatus = 200;
    const { none, log } = await withProvider(async (p, log) => ({ none: await Promise.all(['eng-efl', 'ger-dfb', 'eng-l1', 'nincs'].map((id) => p.getGroupStandings(id))), log }));
    expect(none).toEqual([null, null, null, null]);
    expect(log).toEqual([]);
  });

  it('cache és párhuzamos kérések: egyszerre több hívó → egy ESPN-kérés; utána a cache-ből, újabb kérés nélkül', async () => {
    standingsDelay = 20;
    const log = await withProvider(async (p, log) => {
      vi.useRealTimers(); // a késleltetett válaszhoz valódi időzítő kell
      const all = await Promise.all([1, 2, 3, 4].map(() => p.getGroupStandings('eng-eft')));
      expect(all.every((g) => g?.length === 2)).toBe(true);
      await p.getGroupStandings('eng-eft');
      return log;
    });
    expect(log.filter((l) => l.startsWith('v2:'))).toEqual(['v2:eng.trophy/standings']);
  });
});

// ---------------------------------------------------------------------------
// Elemzés: hidegindítás, League One / League Two alapérték, U21
// ---------------------------------------------------------------------------

const research = (match: Match): ResearchResult => ({ matchId: match.id, origin: 'live', performedAt: '', provider: 'x', news: [], availability: { home: { teamId: 'h', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] }, away: { teamId: 'a', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] } }, externalPredictions: [], sources: [], warnings: [] } as unknown as ResearchResult);
const service = (p: EspnProvider) => new AnalysisService({
  data: p, oddsApi: null,
  research: { research: async ({ match }: { match: Match }) => research(match) },
  db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined },
} as unknown as Container);

describe('EFL Trophy – elemzés hidegindítás után (első kérés egy Trophy-meccs)', () => {
  /** TESZTHEZ SZERKESZTETT bajnoki előzmények: League One 12 meccs (2,0 gól/meccs), League Two 12 meccs (3,0 gól/meccs) */
  const leagueSchedules = () => {
    SCHEDULES[`eng.3/teams/${T.orient}/schedule`] = [9301, 9302, 9301].flatMap((o, i) => [
      fin(`70${i}1`, `2026-08-${10 + i}T14:00Z`, T.orient, o, 1, 1, { stage: 'Regular Season' }), fin(`70${i}2`, `2026-09-${10 + i}T14:00Z`, o, T.orient, 2, 0, { stage: 'Regular Season' })]);
    SCHEDULES[`eng.3/teams/9301/schedule`] = [9302, 9302, 9302].flatMap((o, i) => [
      fin(`71${i}1`, `2026-08-${20 + i}T14:00Z`, 9301, o, 2, 0, { stage: 'Regular Season' }), fin(`71${i}2`, `2026-09-${20 + i}T14:00Z`, o, 9301, 1, 1, { stage: 'Regular Season' })]);
    SCHEDULES[`eng.4/teams/${T.barnet}/schedule`] = [9401, 9402, 9401].flatMap((o, i) => [
      fin(`72${i}1`, `2026-08-${10 + i}T14:00Z`, T.barnet, o, 2, 1, { stage: 'Regular Season' }), fin(`72${i}2`, `2026-09-${10 + i}T14:00Z`, o, T.barnet, 2, 1, { stage: 'Regular Season' })]);
    SCHEDULES[`eng.4/teams/9401/schedule`] = [9402, 9402, 9402].flatMap((o, i) => [
      fin(`73${i}1`, `2026-08-${20 + i}T14:00Z`, 9401, o, 3, 0, { stage: 'Regular Season' }), fin(`73${i}2`, `2026-09-${20 + i}T14:00Z`, o, 9401, 1, 2, { stage: 'Regular Season' })]);
    // a kupa saját (valódi) eredményei – az alapértékbe nem számítanak
    SCHEDULES[`eng.trophy/teams/${T.barnet}/schedule`] = [fin('401906383', '2026-08-18T18:45Z', T.barnet, T.arsenalU21, 5, 1)];
  };

  it('a kupa-liga-alap a két csapat bajnoksága (League Two + League One, egyenlő súllyal), nem a kupa 5–1-e; kupamotor; valódi odds', async () => {
    leagueSchedules();
    const { a, log } = await withProvider(async (p, log) => ({ a: await service(p).analyze('espn-eng.trophy-401906329'), log }));
    expect(a).not.toBeNull();
    expect(log[0]).toBe('eng.trophy/summary?event=401906329');
    expect(a!.homeTeam).toMatchObject({ name: 'Barnet', leagueId: 'eng-l2' });
    expect(a!.awayTeam).toMatchObject({ name: 'Leyton Orient', leagueId: 'eng-l1' });
    expect(log).toEqual(expect.arrayContaining(['eng.3/teams', 'eng.4/teams', `eng.4/teams/${T.barnet}/schedule`, `eng.3/teams/${T.orient}/schedule`]));
    expect(a!.leagueAverages.leagueId).toBe('eng-l2+eng-l1');
    expect(a!.leagueAverages.avgTotalGoals).toBeCloseTo((3 + 2) / 2, 5);
    expect(a!.oneXtwoFactors.join(' ')).toMatch(/League Two \+ League One/);
    expect(a!.standings).toEqual({ home: null, away: null, total: 0 });
    expect(a!.model?.id).toBe(CUP_ENGINE_VERSION);
    // minden csapatlista egyszer (a párhuzamos azonos kéréseket a HTTP-réteg összevonja)
    const lists = log.filter((l) => /^[^/]+\/teams$/.test(l));
    expect(new Set(lists).size).toBe(lists.length);
  });

  it('U21-es csapat (valódi: Salford – Sunderland U21) bajnoki adat nélkül: nincs tipp, az ok megnevezve; odds sincs', async () => {
    SCHEDULES[`eng.trophy/teams/${T.sunderlandU21}/schedule`] = [
      fin('401906363', '2026-10-06T18:00Z', T.shw, T.sunderlandU21, 2, 0),
      fin('401906379', '2026-09-22T18:00Z', T.accrington, T.sunderlandU21, 3, 3, { status: 'STATUS_FINAL_PEN', short: 'FT-Pens', so: [3, 1] }),
    ];
    const a = await withProvider((p) => service(p).analyze('espn-eng.trophy-401906341'));
    expect(a!.awayTeam).toMatchObject({ name: 'Sunderland U21', youth: true, leagueId: 'eng-eft' });
    expect(a!.tips).toEqual([]);
    expect(a!.insufficientData).toBe(true);
    expect(a!.insufficientReasons.join(' ')).toMatch(/Sunderland U21: utánpótlás- \(U21-es\) csapat – bajnoki adata nincs, csak 2 saját eredménye ismert/);
    expect(a!.odds).toBeNull();
  });
});

describe('U21-szabály az elemzőmotorban', () => {
  const lg: League = EFT;
  const mk = (id: string, youth: boolean): Team => ({ id, name: id, shortName: id, country: 'Anglia', leagueId: youth ? 'eng-eft' : 'eng-l2', ...(youth ? { youth: true as const } : {}) });
  /** TESZTHEZ SZERKESZTETT: n meccs csapatonként, fele hazai, fele idegenbeli; plusz 12 League Two-meccs alapnak */
  const results = (n: number): MatchResult[] => {
    const out: MatchResult[] = [];
    for (let i = 0; i < n; i++) {
      const d = `2026-${String(8 + Math.floor(i / 10)).padStart(2, '0')}-${String(1 + (i % 10) * 2).padStart(2, '0')}T18:00:00Z`;
      out.push({ id: `h${i}`, leagueId: 'eng-eft', date: d, homeTeamId: i % 2 ? 'x' : 'H', awayTeamId: i % 2 ? 'H' : 'x', homeGoals: 2, awayGoals: 1, origin: 'live' });
      out.push({ id: `a${i}`, leagueId: 'eng-eft', date: d, homeTeamId: i % 2 ? 'y' : 'A', awayTeamId: i % 2 ? 'A' : 'y', homeGoals: 1, awayGoals: 1, origin: 'live' });
    }
    for (let i = 0; i < 12; i++) out.push({ id: `l${i}`, leagueId: 'eng-l2', date: `2026-08-${String(10 + i).padStart(2, '0')}T14:00:00Z`, homeTeamId: 'p', awayTeamId: 'q', homeGoals: 2, awayGoals: 1, origin: 'live' });
    return out;
  };
  const run = (homeYouth: boolean, n: number) => {
    const match: Match = { id: 'm', leagueId: 'eng-eft', homeTeamId: 'H', awayTeamId: 'A', kickoff: '2026-11-24T20:00:00Z', status: 'scheduled', importance: 'high', importanceReasons: ['Kupamérkőzés'], origin: 'live' };
    return analyzeMatch({ match, league: lg, homeTeam: mk('H', homeYouth), awayTeam: mk('A', false), results: results(n), odds: null, research: research(match), now: '2026-11-09T12:00:00Z', teamLeagues: { home: homeYouth ? lg : L2, away: L2 } });
  };

  it('ugyanazzal az adattal: felnőtt csapatnál van tipp, U21-esnél kevés saját eredménnyel nincs (csak a youth jelölés különbözik)', () => {
    const adult = run(false, 6);
    expect(adult.xg).not.toBeNull();
    expect(adult.tips.length).toBeGreaterThan(0);
    const youth = run(true, 6);
    expect(youth.xg).not.toBeNull(); // a modell futna – a tippet a szabály tiltja
    expect(youth.tips).toEqual([]);
    expect(youth.insufficientData).toBe(true);
    expect(youth.insufficientReasons.some((r) => r.startsWith('H: utánpótlás- (U21-es) csapat'))).toBe(true);
  });

  it(`elég saját eredménnyel (≥ ${YOUTH_MIN_MATCHES}) az U21-es csapatnál is készül tipp`, () => {
    const youth = run(true, YOUTH_MIN_MATCHES);
    expect(youth.insufficientReasons.some((r) => r.includes('utánpótlás'))).toBe(false);
    expect(youth.tips.length).toBeGreaterThan(0);
  });
});

describe('A meglévő kupák változatlanok', () => {
  it('EFL Cup / DFB-Pokal / Copa del Rey: formátum, forduló- és szakaszjelölés nélkül (nincs új mező az eredményeikben)', async () => {
    for (const id of ['eng-efl', 'ger-dfb', 'esp-cdr']) expect(competitionFormat(ESPN_LEAGUES.find((l) => l.id === id)!), id).toBe('domestic_cup');
    SCHEDULES[`eng.league_cup/teams/${T.luton}/schedule`] = [fin('9101', '2026-08-12T18:45Z', T.luton, T.barnet, 1, 1, { status: 'STATUS_FINAL_PEN', short: 'FT-Pens', so: [5, 4], stage: 'Round of 32' })];
    const results = await withProvider(async (p) => {
      await p.getTeams();
      // a Luton EFL Cup-menetrendje (a csapat a kupa csapatlistájából ismert lenne; itt közvetlenül a sorozatból)
      return (p as unknown as { teamSchedule: (t: string, l: string) => Promise<MatchResult[]> }).teamSchedule(`espn-${T.luton}`, 'eng-efl');
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ regulation: false, decidedBy: 'pen', shootout: { home: 5, away: 4 } });
    expect(results[0].stage).toBeUndefined();
    expect(results[0].groupStage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /api/standings és a Statisztikák oldal
// ---------------------------------------------------------------------------

describe('/api/standings – EFL Trophy csoporttabellák', () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });
  const tm = (id: string, leagueId: string, youth = false): Team => ({ id, name: id, shortName: id, country: 'Anglia', leagueId, ...(youth ? { youth: true as const } : {}) });
  const GROUPS: CompetitionGroup[] = [{ name: 'Északi A csoport', rows: [
    { teamId: 'shw', rank: 1, played: 2, won: 2, drawn: 0, lost: 0, gf: 4, ga: 1, gd: 3, points: 6 },
    { teamId: 'sun21', rank: 4, played: 2, won: 0, drawn: 1, lost: 1, gf: 3, ga: 5, gd: -2, points: 1 },
  ] }];
  async function call(leagueId: string, pro = true, groups: CompetitionGroup[] | null = GROUPS) {
    const calls: string[] = [];
    const data = {
      origin: 'live',
      getLeagues: async () => [EFT, L1],
      getLeagueResults: async () => [] as MatchResult[],
      getSeasonStart: async () => undefined,
      getTeams: async () => [tm('shw', 'eng-l1'), tm('sun21', 'eng-eft', true)],
      getGroupStandings: async (id: string) => { calls.push(id); return groups; },
    };
    const app = express();
    app.use((_req, res, next) => { res.locals.plan = { enforced: true, user: { id: 'u' }, pro, admin: false }; next(); });
    app.use('/api', apiRouter({ data } as unknown as Container, {} as AnalysisServiceT));
    server = await new Promise<Server>((r) => { const s = app.listen(0, () => r(s)); });
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/standings/${leagueId}`);
    return { body: await r.json(), calls };
  }

  it('PRO: a csoporttabellák a csapatokkal (U21-jelöléssel); közös bajnoki tabella nincs', async () => {
    const { body, calls } = await call('eng-eft');
    expect(body.format).toBe('domestic_cup_groups');
    expect(body.standings).toEqual([]);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].rows.map((r: { teamId: string; team: Team }) => [r.teamId, r.team.youth ?? false])).toEqual([['shw', false], ['sun21', true]]);
    expect(calls).toEqual(['eng-eft']);
  });

  it('FREE: a csoporttabella is PRO (le sem kérjük); bajnokságnál nincs csoport; elérhetetlen forrás → null', async () => {
    const free = await call('eng-eft', false);
    expect(free.body.groups).toBeNull();
    expect(free.calls).toEqual([]);
    const league = await call('eng-l1');
    expect(league.body.format).toBe('league');
    expect(league.body.groups).toBeNull();
    expect(league.calls).toEqual([]);
    expect((await call('eng-eft', true, null)).body.groups).toBeNull();
  });
});

describe('Statisztikák oldal – EFL Trophy', () => {
  it('csoporttabellák: csoportonként, a továbbjutó helyek jelölve, U21-címke; nincs közös rangsor', () => {
    const groups = [{ name: 'Északi A csoport', rows: [
      { teamId: 'shw', rank: 1, played: 2, won: 2, drawn: 0, lost: 0, gf: 4, ga: 1, gd: 3, points: 6, team: { id: 'shw', name: 'Sheffield Wednesday', shortName: 'SHW', country: 'Anglia', leagueId: 'eng-l1' } },
      { teamId: 'acc', rank: 2, played: 2, won: 0, drawn: 2, lost: 0, gf: 4, ga: 4, gd: 0, points: 4, team: { id: 'acc', name: 'Accrington Stanley', shortName: 'ACC', country: 'Anglia', leagueId: 'eng-l2' } },
      { teamId: 'sun', rank: 4, played: 2, won: 0, drawn: 1, lost: 1, gf: 3, ga: 5, gd: -2, points: 1, team: { id: 'sun', name: 'Sunderland U21', shortName: 'Sunderland', country: 'Anglia', leagueId: 'eng-eft', youth: true as const } },
    ] }];
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(GroupTables, { groups })));
    expect(html).toContain('Északi A csoport');
    expect(html).toContain('első két helyezett jut tovább');
    expect(html.match(/data-qualifying="true"/g)).toHaveLength(2);
    expect(html).toMatch(/Sunderland U21<\/a><span class="badge badge-muted ml-1\.5">U21<\/span>/);
    expect(html).toContain('+3');
  });

  it('eredménylista: szakasz-címke, kieséses meccsnél a továbbjutó, csoportköri 11-esnél nincs továbbjutó', () => {
    const t = (id: string, name: string): Team => ({ id, name, shortName: name, country: 'Anglia', leagueId: 'eng-l2' });
    const rows: CompetitionResultRow[] = [
      { id: 'g', leagueId: 'eng-eft', date: '2026-10-03T14:00:00Z', homeTeamId: 'col', awayTeamId: 'lut', homeGoals: 1, awayGoals: 1, origin: 'live', regulation: false, decidedBy: 'pen', shootout: { home: 3, away: 4 }, stage: 'Csoportkör', groupStage: true, homeTeam: t('col', 'Colchester United'), awayTeam: t('lut', 'Luton Town') },
      { id: 'k', leagueId: 'eng-eft', date: '2026-12-09T19:45:00Z', homeTeamId: 'col', awayTeamId: 'bar', homeGoals: 0, awayGoals: 0, origin: 'live', regulation: false, decidedBy: 'pen', shootout: { home: 2, away: 4 }, stage: 'Legjobb 32', groupStage: false, homeTeam: t('col', 'Colchester United'), awayTeam: t('bar', 'Barnet') },
    ];
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CompetitionResults, { name: EFT.name, format: 'domestic_cup_groups', results: rows, total: 2 })));
    expect(html).toContain('Csoportkör + kieséses kupa');
    expect(html).toContain('>Csoportkör<');
    expect(html).toContain('>Legjobb 32<');
    expect(html.match(/Továbbjutott:/g)).toHaveLength(1);
    expect(html).toMatch(/Továbbjutott: (<!-- -->)?Barnet/);
    expect(html).toContain('tizenegyesekkel 3–4');
  });
});
