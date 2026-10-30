/**
 * Copa del Rey (`domesticCup`) – a valódi `EspnProvider` hamisított ESPN-válaszokkal, hálózat nélkül.
 *
 * A válaszok alakja, a csapatok, az azonosítók és az árak a valódi ESPN-adatból (esp.copa_del_rey,
 * liga-azonosító 3951, „Spanish Copa del Rey”, 2026-os idény), 2026. 10. 29.:
 *  - Getafe (2922, LaLiga) – UB Lebrijana (133844): DraftKings +5000 / +1400 / -2500,
 *  - Eldense (7320, Segunda División) – Atlético Baleares (14263): DraftKings +220 / +250 / +120, 2,5 gól,
 *  - Real Oviedo (92, Segunda División) – Numancia (100): Bet 365 odds-objektum ár NÉLKÜL (élő meccs);
 * korábbi eredmények: Maracena (131412) – Tavernes de la Valldigna (133846) 0–0, 11-esek 2–4 (FT-Pens);
 * Sporting Hortaleza (133831) – Atlético Unión Güímar (133833) 3–3 h.u. (AET).
 * Az eseményazonosítók (4019300xx) a teszthez választottak.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ESPN_LEAGUES, EspnProvider, SLUG } from '../src/server/data/espnProvider';
import { XS_KINDS } from '../src/server/model/xsCompetitions';
import { competitionFormat, hasLeagueTable } from '../src/shared/competitionFormat';
import { buildSlips } from '../src/shared/engine/slips';
import { CUP_ENGINE_VERSION } from '../src/shared/engine/version';
import { baseModelInfo } from '../src/shared/engine/xsAnalysis';
import { engineOf } from '../src/server/tipArchive/service';
import { AnalysisService } from '../src/server/services/analysisService';
import type { Container } from '../src/server/container';
import type { Match, MatchAnalysis, SlipLeg } from '../src/shared/types';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/';
const T = {
  getafe: 2922, osasuna: 97, eldense: 7320, oviedo: 92,
  lebrijana: 133844, baleares: 14263, numancia: 100, tavernes: 133846, maracena: 131412, guimar: 133833, hortaleza: 133831,
} as const;
const NAME: Record<number, string> = {
  [T.getafe]: 'Getafe', [T.osasuna]: 'Osasuna', [T.eldense]: 'Eldense', [T.oviedo]: 'Real Oviedo', [T.lebrijana]: 'UB Lebrijana',
  [T.baleares]: 'Atlético Baleares', [T.numancia]: 'Numancia', [T.tavernes]: 'Tavernes de la Valldigna', [T.maracena]: 'Maracena',
  [T.guimar]: 'Atlético Unión Güímar', [T.hortaleza]: 'Sporting Hortaleza', 9201: 'Liga 9201', 9202: 'Liga 9202', 9203: 'Liga 9203',
};
const TEAMS: Record<string, number[]> = {
  'esp.1': [T.getafe, T.osasuna],
  'esp.2': [T.eldense, T.oviedo],
  'esp.copa_del_rey': [T.getafe, T.osasuna, T.eldense, T.oviedo, T.lebrijana, T.baleares, T.numancia, T.tavernes, T.maracena, T.guimar, T.hortaleza],
};
const team = (id: number) => ({ id: String(id), displayName: NAME[id], shortDisplayName: NAME[id], abbreviation: NAME[id].slice(0, 3).toUpperCase() });
const ml = (h: string, d: string, a: string) => ({ home: { close: { odds: h } }, draw: { close: { odds: d } }, away: { close: { odds: a } } });
const scheduled = (id: string, date: string, home: number, away: number, odds?: unknown, status = 'STATUS_SCHEDULED') => ({
  id, date,
  competitions: [{
    status: { type: { name: status, state: status === 'STATUS_SCHEDULED' ? 'pre' : 'in', completed: false } },
    competitors: [{ homeAway: 'home', team: team(home) }, { homeAway: 'away', team: team(away) }],
    ...(odds ? { odds: [odds] } : {}),
  }],
});
const DAY = [
  scheduled('401930001', '2026-10-29T20:00Z', T.lebrijana, T.getafe, { provider: { name: 'DraftKings' }, overUnder: 3.5, moneyline: ml('+5000', '+1400', '-2500') }),
  scheduled('401930002', '2026-10-29T18:00Z', T.baleares, T.eldense, {
    provider: { name: 'DraftKings' }, overUnder: 2.5, moneyline: ml('+220', '+250', '+120'),
    total: { over: { close: { line: 'o2.5', odds: '-120' } }, under: { close: { line: 'u2.5', odds: '-105' } } },
  }),
  // a valódi válaszban így szerepel: van odds-objektum (Bet 365), de ár nincs benne
  scheduled('401930003', '2026-10-29T17:00Z', T.numancia, T.oviedo, { provider: { name: 'Bet 365' }, moneyline: { home: {}, draw: {}, away: {} } }, 'STATUS_FIRST_HALF'),
];
/** csak összefoglalóból elérhető: két ismeretlen bajnokságú csapat */
const EXTRA_EVENTS = [scheduled('401930004', '2026-10-30T18:00Z', T.tavernes, T.maracena)];
const SCHEDULES: Record<string, unknown[]> = {};

function serve(log: string[]) {
  return vi.fn(async (url: string) => {
    const path = String(url).replace(BASE, '');
    log.push(path);
    let m = path.match(/^([^/]+)\/teams$/);
    if (m) return new Response(JSON.stringify({ sports: [{ leagues: [{ teams: (TEAMS[m[1]] ?? []).map((id) => ({ team: team(id) })) }] }] }));
    m = path.match(/^([^/]+)\/scoreboard\?dates=(\d{8})$/);
    if (m) {
      const events = m[1] === 'esp.copa_del_rey' && m[2] === '20261029' ? DAY : [];
      return new Response(JSON.stringify({ leagues: [{ id: '3951', slug: 'esp.copa_del_rey', name: 'Spanish Copa del Rey', season: { year: 2026, startDate: '2026-07-01T04:00Z' } }], events }));
    }
    m = path.match(/^esp\.copa_del_rey\/summary\?event=(\d+)$/);
    if (m) {
      const ev = [...DAY, ...EXTRA_EVENTS].find((e) => e.id === m![1]);
      return new Response(JSON.stringify(ev ? { header: { competitions: [{ ...ev.competitions[0], date: ev.date }] } } : {}));
    }
    if (/\/teams\/\d+\/schedule/.test(path)) return new Response(JSON.stringify({ events: SCHEDULES[path] ?? [] }));
    return new Response(JSON.stringify({ events: [] }));
  });
}
async function withProvider<R>(fn: (p: EspnProvider, log: string[]) => Promise<R>): Promise<R> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
  const log: string[] = [];
  vi.stubGlobal('fetch', serve(log));
  try { return await fn(new EspnProvider(), log); } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); for (const k of Object.keys(SCHEDULES)) delete SCHEDULES[k]; });

/** lejátszott meccs a csapat-menetrendben (ESPN-alak) */
const fin = (id: string, date: string, home: number, away: number, hg: number, ag: number, status = 'STATUS_FULL_TIME', short = 'FT', so?: [number, number]) => ({
  id, date,
  competitions: [{
    status: { type: { name: status, shortDetail: short, completed: true } },
    competitors: [
      { homeAway: 'home', team: team(home), score: { value: hg, displayValue: String(hg), ...(so ? { shootoutScore: so[0] } : {}) } },
      { homeAway: 'away', team: team(away), score: { value: ag, displayValue: String(ag), ...(so ? { shootoutScore: so[1] } : {}) } },
    ],
  }],
});

/**
 * Minden csapatlista (bajnokságé és kupáé is) pontosan egyszer kérődik le: a bajnoki listákat a közös
 * csapatbetöltés, a párhuzamos azonos kéréseket (pl. a kupa listáját a sorozat-eredmények is kérik)
 * a HTTP-réteg osztja meg.
 */
const listsOnce = (log: string[]) => {
  const lists = log.filter((p) => /^[^/]+\/teams$/.test(p));
  for (const l of ESPN_LEAGUES) expect(lists.filter((p) => p === `${SLUG[l.id]}/teams`), l.id).toHaveLength(1);
  expect(new Set(lists).size).toBe(lists.length);
};

const CDR = ESPN_LEAGUES.find((l) => l.id === 'esp-cdr')!;
const LL = ESPN_LEAGUES.find((l) => l.id === 'esp-ll')!;

describe('Copa del Rey – sorozat', () => {
  it('hazai kupaként szerepel a valódi ESPN-sluggal; nincs tabella (eredménylista), nincs a bajnoki tanítókörben', () => {
    expect(CDR).toEqual({ id: 'esp-cdr', name: 'Copa del Rey', country: 'Spanyolország', countryCode: 'ESP', tier: 0, international: false, domesticCup: true });
    expect(SLUG['esp-cdr']).toBe('esp.copa_del_rey');
    expect(competitionFormat(CDR)).toBe('domestic_cup');
    expect(hasLeagueTable(CDR)).toBe(false);
    expect(XS_KINDS['esp-cdr']).toBeUndefined();
  });
});

describe('Copa del Rey – adatbetöltés, mérkőzések, odds', () => {
  it('a napi lista csak a kupa scoreboardját kéri, és a meccseket „Kupamérkőzés” címkével adja', async () => {
    const { matches, log } = await withProvider(async (p, log) => ({ matches: await p.getMatches({ date: '2026-10-29', leagueId: 'esp-cdr' }), log }));
    expect(log.filter((l) => l.includes('/scoreboard'))).toEqual(['esp.copa_del_rey/scoreboard?dates=20261029']);
    expect(matches.map((m) => m.id).sort()).toEqual(['espn-esp.copa_del_rey-401930001', 'espn-esp.copa_del_rey-401930002', 'espn-esp.copa_del_rey-401930003']);
    const getafe = matches.find((m) => m.id.endsWith('401930001'))!;
    expect(getafe).toMatchObject({ leagueId: 'esp-cdr', homeTeamId: `espn-${T.lebrijana}`, awayTeamId: `espn-${T.getafe}`, status: 'scheduled', origin: 'live' });
    for (const m of matches) {
      expect(m.importanceReasons).toContain('Kupamérkőzés');
      expect(m.importanceReasons).not.toContain('Nemzetközi kupamérkőzés');
    }
  });

  it('valódi oddsok tizedesre váltva; az ár nélküli odds-objektumból nincs kitalált érték', async () => {
    const [getafe, eldense, oviedo] = await withProvider(async (p) => {
      await p.getMatches({ date: '2026-10-29', leagueId: 'esp-cdr' });
      return Promise.all(['401930001', '401930002', '401930003'].map((id) => p.getOdds(`espn-esp.copa_del_rey-${id}`)));
    });
    expect(getafe).toMatchObject({ bookmaker: 'DraftKings (ESPN)', markets: { '1': 51, X: 15, '2': 1.04 } });
    expect(eldense).toMatchObject({ bookmaker: 'DraftKings (ESPN)', markets: { '1': 3.2, X: 3.5, '2': 2.2 } });
    expect(eldense!.markets['O2.5']).toBeCloseTo(1.83, 2);
    expect(eldense!.markets['U2.5']).toBeCloseTo(1.95, 2);
    expect(oviedo).toBeNull();
  });

  it('csapatok: LaLiga és Segunda División felismerve; a csak kupából ismert csapat sorozata a kupa, Spanyolország', async () => {
    const teams = await withProvider((p) => p.getTeams());
    const byId = new Map(teams.map((t) => [t.id, t]));
    for (const id of [T.getafe, T.osasuna]) expect(byId.get(`espn-${id}`)).toMatchObject({ leagueId: 'esp-ll', country: 'Spanyolország' });
    for (const id of [T.eldense, T.oviedo]) expect(byId.get(`espn-${id}`)).toMatchObject({ leagueId: 'esp-l2', country: 'Spanyolország' });
    for (const id of [T.lebrijana, T.numancia, T.tavernes]) expect(byId.get(`espn-${id}`)).toMatchObject({ leagueId: 'esp-cdr', country: 'Spanyolország' });
  });

  it('tizenegyespárbaj és hosszabbítás: nem rendes játékidős eredményként jelölve; a kupa előző idénye nem töltődik', async () => {
    SCHEDULES[`esp.copa_del_rey/teams/${T.tavernes}/schedule`] = [
      fin('401920101', '2026-10-04T16:00Z', T.tavernes, T.maracena, 0, 0, 'STATUS_FINAL_PEN', 'FT-Pens', [4, 2]),
      fin('401920102', '2026-10-11T11:00Z', T.guimar, T.tavernes, 3, 3, 'STATUS_FINAL_AET', 'AET'),
    ];
    const { results, log } = await withProvider(async (p, log) => {
      await p.getMatches({ date: '2026-10-29', leagueId: 'esp-cdr' });
      return { results: await p.getTeamResults(`espn-${T.tavernes}`), log };
    });
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId['espn-esp.copa_del_rey-401920101']).toMatchObject({ homeGoals: 0, awayGoals: 0, regulation: false, decidedBy: 'pen', shootout: { home: 4, away: 2 } });
    expect(byId['espn-esp.copa_del_rey-401920102']).toMatchObject({ homeGoals: 3, awayGoals: 3, regulation: false, decidedBy: 'aet' });
    expect(log.filter((l) => l.includes(`/teams/${T.tavernes}/schedule`))).toEqual([`esp.copa_del_rey/teams/${T.tavernes}/schedule`]);
  });
});

describe('Copa del Rey – motorverzió és szelvény', () => {
  it('külön kupás motorverzió → a kupás tippek és kalibráció nem keveredik a bajnokival', () => {
    expect(baseModelInfo(CDR).id).toBe(CUP_ENGINE_VERSION);
    expect(baseModelInfo(LL).id).not.toBe(CUP_ENGINE_VERSION);
    expect(engineOf({ model: baseModelInfo(CDR) } as MatchAnalysis)).toBe(CUP_ENGINE_VERSION);
  });

  it('odds nélküli kupaláb nem kerül szelvényre (a Duplázó ugyanezt a szelvényépítőt használja)', () => {
    const leg = (matchId: string, odds: number): SlipLeg => ({
      matchId, matchLabel: matchId, leagueName: CDR.name, kickoff: '2026-10-29T20:00:00Z', market: '2', label: 'Vendéggyőzelem', modelProb: 0.85,
      odds, bookmaker: odds > 1 ? 'DraftKings (ESPN)' : null, impliedProb: odds > 1 ? 1 / odds : 0, diffPoints: 0, category: 'biztonságos' as SlipLeg['category'], supportingIndicators: 4, dataQuality: 'magas',
    });
    const slips = buildSlips([leg('getafe', 1.04), leg('eldense', 2.2), leg('oviedo', Number.NaN), leg('zero', 0)], { legs: 2, minTotalOdds: 1, minLegProb: 0.5 });
    expect(slips.length).toBeGreaterThan(0);
    for (const s of slips) expect(s.legs.map((l) => l.matchId).sort()).toEqual(['eldense', 'getafe']);
  });
});

// ---------------------------------------------------------------------------
// Hidegindítás: az ELSŐ kérés közvetlenül egy kupameccs elemzése (üres gyorsítótár)
// ---------------------------------------------------------------------------

describe('Copa del Rey – elemzés hidegindítás után (első kérés egy kupameccs)', () => {
  /** LaLiga: 12 meccs (1,5 gól/meccs); a kupa saját eredményei kiugróak (5–0, 4–4) */
  const schedules = (): void => {
    const opp = [9201, 9202, 9203];
    SCHEDULES[`esp.1/teams/${T.getafe}/schedule`] = opp.flatMap((o, i) => [
      fin(`80${i}1`, `2026-08-${10 + i}T19:00Z`, T.getafe, o, 2, 1), fin(`80${i}2`, `2026-09-${10 + i}T19:00Z`, o, T.getafe, 0, 0)]);
    SCHEDULES[`esp.1/teams/${T.osasuna}/schedule`] = opp.flatMap((o, i) => [
      fin(`81${i}1`, `2026-08-${20 + i}T19:00Z`, T.osasuna, o, 1, 1), fin(`81${i}2`, `2026-09-${20 + i}T19:00Z`, o, T.osasuna, 1, 0)]);
    SCHEDULES[`esp.copa_del_rey/teams/${T.lebrijana}/schedule`] = [fin('8201', '2026-10-04T16:00Z', T.lebrijana, T.numancia, 5, 0), fin('8202', '2026-10-11T16:00Z', T.baleares, T.lebrijana, 4, 4)];
    SCHEDULES[`esp.copa_del_rey/teams/${T.tavernes}/schedule`] = [fin('8203', '2026-10-04T16:00Z', T.tavernes, T.numancia, 5, 0)];
    SCHEDULES[`esp.copa_del_rey/teams/${T.maracena}/schedule`] = [fin('8204', '2026-10-05T16:00Z', T.baleares, T.maracena, 4, 4)];
  };
  const service = (p: EspnProvider) => new AnalysisService({
    data: p, oddsApi: null,
    research: { research: async ({ match }: { match: Match }) => ({ matchId: match.id, origin: 'live', performedAt: '', provider: 'x', news: [], availability: { home: { teamId: 'h', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] }, away: { teamId: 'a', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] } }, externalPredictions: [], sources: [], warnings: [] }) },
    db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined },
  } as unknown as Container);

  it('előbb a bajnoki adatok töltődnek be, és az elemzés a LaLiga statisztikáiból számol (az ismeretlen bajnokságú ellenfél mellett is)', async () => {
    schedules();
    const { a, log } = await withProvider(async (p, log) => ({ a: await service(p).analyze('espn-esp.copa_del_rey-401930001'), log }));
    expect(a).not.toBeNull();
    expect(log[0]).toBe('esp.copa_del_rey/summary?event=401930001');
    expect(a!.awayTeam).toMatchObject({ name: 'Getafe', leagueId: 'esp-ll' });
    expect(a!.homeTeam).toMatchObject({ name: 'UB Lebrijana', leagueId: 'esp-cdr' });
    expect(log).toContain('esp.1/teams');
    expect(log).toContain(`esp.1/teams/${T.getafe}/schedule`);
    // alapérték: a 12 LaLiga-meccs (18 gól), nem a kupa 5–0 / 4–4 eredményei
    expect(a!.leagueAverages.matches).toBe(12);
    expect(a!.leagueAverages.avgTotalGoals).toBeCloseTo(18 / 12, 5);
    expect(a!.standings).toEqual({ home: null, away: null, total: 0 });
    expect(a!.model?.id).toBe(CUP_ENGINE_VERSION);
    listsOnce(log); // minden csapatlista pontosan egyszer
  });

  it('fallback: ha egyik csapat bajnoksága sem ismert, a kupa saját rendes játékidős eredményeiből számol, kitalált tipp nélkül', async () => {
    schedules();
    const { a, log } = await withProvider(async (p, log) => ({ a: await service(p).analyze('espn-esp.copa_del_rey-401930004'), log }));
    expect(a).not.toBeNull();
    expect(a!.homeTeam.leagueId).toBe('esp-cdr');
    expect(a!.awayTeam.leagueId).toBe('esp-cdr');
    // a kupa összes csapatának kupameccsei (4 különböző meccs: 2× 5–0, 2× 4–4) – bajnoki adat nélkül
    expect(a!.leagueAverages.matches).toBe(4);
    expect(a!.leagueAverages.avgTotalGoals).toBeCloseTo(6.5, 5);
    expect(a!.oneXtwoFactors.join(' ')).not.toMatch(/LaLiga/);
    expect(a!.poisson).toBeNull();
    listsOnce(log);
  });
});
