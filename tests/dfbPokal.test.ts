/**
 * DFB-Pokal (hazai kupa, `domesticCup`) – a valódi `EspnProvider` hamisított ESPN-válaszokkal, hálózat nélkül.
 *
 * Ellenőrzi: a kupa scoreboardjának lekérését és a 2026. 10. 27-i 8 mérkőzés feldolgozását, a „Kupamérkőzés”
 * címkét (nem „Nemzetközi kupamérkőzés”), a Bundesliga-csapatok elsődleges sorozatát, a csak kupából ismert
 * német csapatok országát, a kupa előző idényének kihagyását, a `/api/leagues` listát, valamint hogy a
 * meglévő sorozatok viselkedése és a több ligás modell tanítóköre változatlan.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ESPN_LEAGUES, EspnProvider, SLUG } from '../src/server/data/espnProvider';
import { XS_KINDS } from '../src/server/model/xsCompetitions';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/';

/** ESPN csapatazonosítók (hamis, de a valós neveket használjuk) */
const T = {
  frankfurt: 125, hamburg: 127, leipzig: 11420, augsburg: 3841, mainz: 2950, dortmund: 124, bremen: 137, gladbach: 268,
  union: 598, koln: 122, bochum: 121, karlsruhe: 6417, darmstadt: 3813, elversberg: 21366, essen: 8174, grossaspach: 21460,
} as const;
const NAME: Record<number, string> = {
  [T.frankfurt]: 'Eintracht Frankfurt', [T.hamburg]: 'Hamburg SV', [T.leipzig]: 'RB Leipzig', [T.augsburg]: 'FC Augsburg', [T.mainz]: 'Mainz',
  [T.dortmund]: 'Borussia Dortmund', [T.bremen]: 'Werder Bremen', [T.gladbach]: 'Borussia Mönchengladbach', [T.union]: '1. FC Union Berlin',
  [T.koln]: 'FC Cologne', [T.bochum]: 'VfL Bochum', [T.karlsruhe]: 'Karlsruher SC', [T.darmstadt]: 'SV Darmstadt 98', [T.elversberg]: 'SV Elversberg',
  [T.essen]: 'Rot-Weiss Essen', [T.grossaspach]: 'SG Sonnenhof Großaspach',
};
const TEAMS: Record<string, number[]> = {
  'ger.1': [T.frankfurt, T.hamburg, T.leipzig, T.augsburg, T.mainz, T.dortmund, T.bremen, T.gladbach, T.union, T.koln],
  'ger.2': [T.bochum, T.karlsruhe, T.darmstadt, T.elversberg],
  'ger.dfb_pokal': Object.values(T),
};
/** a 2026. 10. 27-i 8 DFB-Pokal-mérkőzés az ESPN szerint (vendég, hazai, kezdés UTC) */
const POKAL: [number, number, string][] = [
  [T.frankfurt, T.hamburg, '2026-10-27T17:00Z'], [T.leipzig, T.essen, '2026-10-27T17:00Z'],
  [T.augsburg, T.grossaspach, '2026-10-27T17:00Z'], [T.mainz, T.bochum, '2026-10-27T17:00Z'],
  [T.bremen, T.dortmund, '2026-10-27T19:45Z'], [T.karlsruhe, T.gladbach, '2026-10-27T19:45Z'],
  [T.union, T.koln, '2026-10-27T19:45Z'], [T.darmstadt, T.elversberg, '2026-10-27T19:45Z'],
];

const team = (id: number) => ({ id: String(id), displayName: NAME[id], shortDisplayName: NAME[id], abbreviation: NAME[id].slice(0, 3).toUpperCase() });
const event = ([away, home, date]: [number, number, string], i: number) => ({
  id: String(401900000 + i), date,
  competitions: [{
    status: { type: { name: 'STATUS_SCHEDULED', state: 'pre', completed: false } },
    competitors: [{ homeAway: 'home', team: team(home) }, { homeAway: 'away', team: team(away) }],
  }],
});

/** Csapat-menetrendek (útvonal → események); alapból üres. A tesztek töltik fel. */
const SCHEDULES: Record<string, unknown[]> = {};
/** Lejátszott esemény a menetrendben (ESPN-alak: a score objektum, benne a tizenegyes-eredménnyel). */
const played = (id: string, date: string, home: number, away: number, hg: number, ag: number, status = 'STATUS_FULL_TIME', short = 'FT', so?: [number, number]) => ({
  id, date,
  competitions: [{
    status: { type: { name: status, shortDetail: short, completed: true } },
    competitors: [
      { homeAway: 'home', team: team(home), score: { value: hg, displayValue: String(hg), ...(so ? { shootoutScore: so[0] } : {}) } },
      { homeAway: 'away', team: team(away), score: { value: ag, displayValue: String(ag), ...(so ? { shootoutScore: so[1] } : {}) } },
    ],
  }],
});

/** Hamis ESPN-szerver; minden kért útvonalat naplóz. */
function serve(log: string[]) {
  return vi.fn(async (url: string) => {
    const path = String(url).replace(BASE, '');
    log.push(path);
    let m = path.match(/^([^/]+)\/teams$/);
    if (m) {
      const list = (TEAMS[m[1]] ?? []).map((id) => ({ team: team(id) }));
      return new Response(JSON.stringify({ sports: [{ leagues: [{ teams: list }] }] }));
    }
    m = path.match(/^([^/]+)\/scoreboard\?dates=(\d{8})$/);
    if (m) {
      const events = m[1] === 'ger.dfb_pokal' && m[2] === '20261027' ? POKAL.map(event) : [];
      return new Response(JSON.stringify({ leagues: [{ season: { startDate: '2026-07-01T00:00Z' } }], events }));
    }
    if (/\/teams\/\d+\/schedule/.test(path)) return new Response(JSON.stringify({ events: SCHEDULES[path] ?? [] }));
    return new Response(JSON.stringify({ events: [] }));
  });
}

async function withProvider<T>(fn: (p: EspnProvider, log: string[]) => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
  const log: string[] = [];
  vi.stubGlobal('fetch', serve(log));
  try { return await fn(new EspnProvider(), log); } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); for (const k of Object.keys(SCHEDULES)) delete SCHEDULES[k]; });

/** a változtatás előtti 17 sorozat (azonosító, nemzetközi-e) – ezek nem változhatnak */
const EXISTING: [string, boolean][] = [
  ['eng-pl', false], ['esp-ll', false], ['ita-sa', false], ['ger-bl', false], ['fra-l1', false], ['uefa-ucl', true], ['uefa-uel', true],
  ['uefa-uecl', true], ['usa-mls', false], ['eng-ch', false], ['esp-l2', false], ['ita-sb', false], ['ger-b2', false], ['fra-l2', false],
  ['uefa-nl', true], ['fifa-wcq-uefa', true], ['fifa-friendly', true],
];

describe('DFB-Pokal – sorozatlista', () => {
  it('a DFB-Pokal hazai kupaként szerepel a listában; a meglévő 17 sorozat változatlan', async () => {
    const leagues = await withProvider((p) => p.getLeagues());
    expect(leagues.find((l) => l.id === 'ger-dfb')).toEqual({ id: 'ger-dfb', name: 'DFB-Pokal', country: 'Németország', countryCode: 'GER', tier: 0, international: false, domesticCup: true });
    expect(SLUG['ger-dfb']).toBe('ger.dfb_pokal');
    expect(leagues.filter((l) => !l.domesticCup).map((l) => [l.id, l.international])).toEqual(EXISTING);
    // a hazai kupák: DFB-Pokal és (később felvett) EFL Cup, Copa del Rey – több nincs
    expect(leagues.filter((l) => l.domesticCup).map((l) => l.id)).toEqual(['ger-dfb', 'eng-efl', 'esp-cdr']);
  });

  it('a /api/leagues a szolgáltató listáját adja (így az új sorozatot is)', () => {
    const src = readFileSync(new URL('../src/server/routes/api.ts', import.meta.url), 'utf8');
    expect(src).toContain("r.get('/leagues', async (_req, res) => res.json(await c.data.getLeagues()));");
  });
});

describe('DFB-Pokal – 2026. 10. 27-i mérkőzések', () => {
  it('a napi lista lekéri a kupa scoreboardját, és mind a 8 mérkőzést feldolgozza', async () => {
    const { matches, log } = await withProvider(async (p, log) => ({ matches: await p.getMatches({ date: '2026-10-27' }), log }));
    expect(log).toContain('ger.dfb_pokal/scoreboard?dates=20261027');
    const cup = matches.filter((m) => m.leagueId === 'ger-dfb');
    expect(cup).toHaveLength(8);
    expect(cup.map((m) => m.id)).toEqual(POKAL.map((_, i) => `espn-ger.dfb_pokal-${401900000 + i}`));
    expect(cup.map((m) => [m.homeTeamId, m.awayTeamId, m.kickoff])).toEqual(POKAL.map(([away, home, date]) => [`espn-${home}`, `espn-${away}`, new Date(date).toISOString()]));
    expect(cup.every((m) => m.status === 'scheduled' && m.origin === 'live')).toBe(true);
  });

  it('címke: „Kupamérkőzés” (kiemelt), NEM „Nemzetközi kupamérkőzés”', async () => {
    const matches = await withProvider((p) => p.getMatches({ date: '2026-10-27', leagueId: 'ger-dfb' }));
    expect(matches).toHaveLength(8);
    for (const m of matches) {
      expect(m.importanceReasons).toContain('Kupamérkőzés');
      expect(m.importanceReasons).not.toContain('Nemzetközi kupamérkőzés');
      expect(['high', 'top']).toContain(m.importance);
    }
  });

  it('a sorozatszűrő csak a kupa scoreboardját kéri (más sorozatot nem)', async () => {
    const log = await withProvider(async (p, log) => { await p.getMatches({ date: '2026-10-27', leagueId: 'ger-dfb' }); return log; });
    expect(log.filter((l) => l.includes('/scoreboard'))).toEqual(['ger.dfb_pokal/scoreboard?dates=20261027']);
  });
});

describe('DFB-Pokal – csapatok', () => {
  it('a Bundesliga-csapatok elsődleges sorozata a Bundesliga; a csak kupából ismert német csapat országa Németország', async () => {
    const teams = await withProvider((p) => p.getTeams());
    const byId = new Map(teams.map((t) => [t.id, t]));
    expect(byId.get(`espn-${T.dortmund}`)).toMatchObject({ leagueId: 'ger-bl', country: 'Németország' });
    expect(byId.get(`espn-${T.bochum}`)).toMatchObject({ leagueId: 'ger-b2', country: 'Németország' });
    for (const id of [T.essen, T.grossaspach]) {
      expect(byId.get(`espn-${id}`)).toMatchObject({ leagueId: 'ger-dfb', country: 'Németország' });
    }
  });

  it('ha egy Bundesliga-csapatot ELŐBB a kupameccsből ismer meg, a bajnokság utána is elsődlegessé válik', async () => {
    const t = await withProvider(async (p) => {
      await p.getMatches({ date: '2026-10-27', leagueId: 'ger-dfb' }); // a csapat először a kupából regisztrálódik
      await p.getTeams(); // a hazai bajnokságok betöltése
      return p.getTeam(`espn-${T.dortmund}`);
    });
    expect(t).toMatchObject({ leagueId: 'ger-bl', country: 'Németország' });
  });
});

describe('DFB-Pokal – előzmények', () => {
  it('a kupa előző idényét nem tölti le; a bajnokság előző idényét igen (változatlanul)', async () => {
    const log = await withProvider(async (p, log) => {
      await p.getMatches({ date: '2026-10-27', leagueId: 'ger-dfb' }); // a kupa-sorozat a csapathoz rendelődik
      await p.getTeamResults(`espn-${T.dortmund}`);
      return log;
    });
    const sched = log.filter((l) => l.includes(`/teams/${T.dortmund}/schedule`));
    expect(sched).toContain(`ger.dfb_pokal/teams/${T.dortmund}/schedule`);
    expect(sched.some((l) => l.startsWith('ger.dfb_pokal/') && l.includes('?season='))).toBe(false);
    expect(sched).toContain(`ger.1/teams/${T.dortmund}/schedule`);
    expect(sched).toContain(`ger.1/teams/${T.dortmund}/schedule?season=2025`);
  });

  it('szokásos sorrendben (előbb a csapatlisták, mint a /api/matches-ben) ugyanez: bajnoki előzmény előző idénnyel, kupa előző idény nélkül', async () => {
    const log = await withProvider(async (p, log) => {
      await p.getMatches({ date: '2026-10-27', leagueId: 'ger-dfb' });
      await p.getTeams();
      await p.getTeamResults(`espn-${T.dortmund}`);
      return log;
    });
    const sched = log.filter((l) => l.includes(`/teams/${T.dortmund}/schedule`));
    expect(sched).toEqual(expect.arrayContaining([`ger.1/teams/${T.dortmund}/schedule`, `ger.1/teams/${T.dortmund}/schedule?season=2025`, `ger.dfb_pokal/teams/${T.dortmund}/schedule`]));
    expect(sched.some((l) => l.startsWith('ger.dfb_pokal/') && l.includes('?season='))).toBe(false);
  });

  it('csak kupából ismert alsóbb osztályú csapat: csak a kupa aktuális idénye (nincs kitalált bajnoki előzmény)', async () => {
    const log = await withProvider(async (p, log) => {
      await p.getMatches({ date: '2026-10-27', leagueId: 'ger-dfb' });
      await p.getTeamResults(`espn-${T.grossaspach}`);
      return log;
    });
    expect(log.filter((l) => l.includes(`/teams/${T.grossaspach}/schedule`))).toEqual([`ger.dfb_pokal/teams/${T.grossaspach}/schedule`]);
  });

  it('a kupa sorozat-eredményeinél sincs előző idény', async () => {
    const log = await withProvider(async (p, log) => { await p.getLeagueResults('ger-dfb'); return log; });
    const sched = log.filter((l) => l.startsWith('ger.dfb_pokal/teams/') && l.includes('/schedule'));
    expect(sched.length).toBe(TEAMS['ger.dfb_pokal'].length);
    expect(sched.some((l) => l.includes('?season='))).toBe(false);
  });
});

describe('Meglévő viselkedés változatlan', () => {
  it('a nemzetközi kupák címkéje és a több ligás modell tanítóköre változatlan; a DFB-Pokal nincs a modellben', () => {
    const expected: Record<string, string> = Object.fromEntries(EXISTING.map(([id, intl]) => [id,
      ['uefa-nl', 'fifa-wcq-uefa', 'fifa-friendly'].includes(id) ? 'national' : intl ? 'club_intl' : 'domestic']));
    for (const [id, kind] of Object.entries(expected)) expect(XS_KINDS[id], id).toBe(kind);
    expect(XS_KINDS['ger-dfb']).toBeUndefined();
    // az ESPN-lista minden nem-hazai-kupa eleme a modellben van (semmi nem esett ki)
    for (const l of ESPN_LEAGUES.filter((x) => !x.domesticCup)) expect(XS_KINDS[l.id], l.id).toBeDefined();
  });
});

describe('Hosszabbítás és tizenegyespárbaj a csapat-menetrendben', () => {
  it('a h.u. és a 11-es eredmény jelölve (nem rendes játékidő), a tizenegyes-eredménnyel; a rendes eredmény objektuma változatlan', async () => {
    SCHEDULES[`ger.dfb_pokal/teams/${T.grossaspach}/schedule`] = [
      played('9001', '2026-08-24T17:00Z', T.grossaspach, T.bochum, 2, 2, 'STATUS_FINAL_PEN', 'FT-Pens', [3, 0]),
      played('9002', '2026-08-30T17:00Z', T.essen, T.grossaspach, 2, 5, 'STATUS_FINAL_AET', 'AET'),
      played('9003', '2026-09-10T17:00Z', T.grossaspach, T.essen, 1, 0),
    ];
    const results = await withProvider(async (p) => {
      await p.getMatches({ date: '2026-10-27', leagueId: 'ger-dfb' });
      return p.getTeamResults(`espn-${T.grossaspach}`);
    });
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId['espn-ger.dfb_pokal-9001']).toMatchObject({ homeGoals: 2, awayGoals: 2, regulation: false, decidedBy: 'pen', shootout: { home: 3, away: 0 } });
    expect(byId['espn-ger.dfb_pokal-9002']).toMatchObject({ homeGoals: 2, awayGoals: 5, regulation: false, decidedBy: 'aet' });
    expect(byId['espn-ger.dfb_pokal-9002'].shootout).toBeUndefined();
    const regular = byId['espn-ger.dfb_pokal-9003'];
    expect(Object.keys(regular).sort()).toEqual(['awayGoals', 'awayTeamId', 'date', 'homeGoals', 'homeTeamId', 'id', 'leagueId', 'origin']);
  });
});

describe('Kupameccs elemzési adatai', () => {
  const bundesliga = TEAMS['ger.1'];

  it('kupameccsnél a csapatok bajnokságának TELJES eredménylistája is lekérődik (a liga-alapértékhez)', async () => {
    const log = await withProvider(async (p, log) => {
      const [m] = (await p.getMatches({ date: '2026-10-27', leagueId: 'ger-dfb' })).filter((x) => x.homeTeamId === `espn-${T.dortmund}`);
      await p.getResultsForAnalysis(m);
      return log;
    });
    for (const id of bundesliga) expect(log, String(id)).toContain(`ger.1/teams/${id}/schedule`);
    // mindkét csapat Bundesliga: a 2. Bundesliga TELJES listája nem kell (más 2. ligás csapat menetrendje nem kérődik)
    expect(log).not.toContain(`ger.2/teams/${T.karlsruhe}/schedule`);
  });

  it('különböző bajnokságú párosnál (2. Bundesliga – Bundesliga) mindkét bajnokság lekérődik', async () => {
    const log = await withProvider(async (p, log) => {
      await p.getTeams();
      const [m] = (await p.getMatches({ date: '2026-10-27', leagueId: 'ger-dfb' })).filter((x) => x.homeTeamId === `espn-${T.bochum}`);
      await p.getResultsForAnalysis(m);
      return log;
    });
    expect(log).toContain(`ger.1/teams/${T.dortmund}/schedule`);
    expect(log).toContain(`ger.2/teams/${T.karlsruhe}/schedule`);
  });

  it('bajnoki meccsnél nincs új lekérés: pontosan a korábbi összetétel (saját bajnokság + a két csapat)', async () => {
    const m = { id: 'x', leagueId: 'ger-bl', homeTeamId: `espn-${T.dortmund}`, awayTeamId: `espn-${T.bremen}`, kickoff: '2026-10-31T14:30:00Z', status: 'scheduled' as const, importance: 'normal' as const, importanceReasons: [], origin: 'live' as const };
    const now = await withProvider(async (p, log) => { await p.getTeams(); log.length = 0; await p.getResultsForAnalysis(m); return [...new Set(log)].sort(); });
    const old = await withProvider(async (p, log) => {
      await p.getTeams(); log.length = 0;
      await Promise.all([p.getLeagueResults('ger-bl'), p.getTeamResults(m.homeTeamId), p.getTeamResults(m.awayTeamId)]);
      return [...new Set(log)].sort();
    });
    expect(now).toEqual(old);
  });
});
