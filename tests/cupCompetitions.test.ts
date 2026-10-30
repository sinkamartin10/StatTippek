/**
 * Kupasorozatok statisztikai és elemzési kezelése:
 *  - sorozatformátum (melyik sorozat kap bajnoki tabellát),
 *  - /api/standings: kupánál tabella helyett mérkőzések és eredmények (valódi apiRouter, hamis adatforrás),
 *  - a Statisztikák oldal kupás nézete (statikus renderelés),
 *  - kupameccs liga-alapértéke a csapatok bajnokságából (egyező / különböző / hiányzó bajnoki adat),
 *  - a hosszabbítás és a tizenegyespárbaj nem torzítja a rendes játékidős átlagot,
 *  - a bajnoki elemzés és tabella változatlan.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ESPN_LEAGUES } from '../src/server/data/espnProvider';
import { apiRouter } from '../src/server/routes/api';
import type { Container } from '../src/server/container';
import type { AnalysisService } from '../src/server/services/analysisService';
import { competitionFormat, hasLeagueTable, type CompetitionResultRow } from '../src/shared/competitionFormat';
import { MIN_BASELINE_MATCHES, chooseBaseline, combineAverages } from '../src/shared/engine/baseline';
import { computeLeagueAverages, computeStandings } from '../src/shared/engine/stats';
import { analyzeMatch } from '../src/shared/engine/analysis';
import { CompetitionResults, decidedText } from '../src/client/pages/Stats';
import type { League, Match, MatchResult, ResearchResult, Team } from '../src/shared/types';

const L = (id: string, o: Partial<League> = {}): League => ESPN_LEAGUES.find((l) => l.id === id) ?? { id, name: id, country: 'X', countryCode: 'X', tier: 1, international: false, ...o };
const BL = L('ger-bl'); const B2 = L('ger-b2'); const DFB = L('ger-dfb'); const UCL = L('uefa-ucl'); const PL = L('eng-pl');

let seq = 0;
const res = (leagueId: string, home: string, away: string, hg: number, ag: number, date: string, o: Partial<MatchResult> = {}): MatchResult =>
  ({ id: `r${++seq}`, leagueId, date, homeTeamId: home, awayTeamId: away, homeGoals: hg, awayGoals: ag, origin: 'live', ...o });

/** Determinisztikus „idény”: minden csapat mindenki ellen otthon; a gólok a megadott minta szerint ismétlődnek. */
function season(leagueId: string, teams: string[], scores: [number, number][], start = Date.parse('2026-08-01T15:00:00Z')): MatchResult[] {
  const out: MatchResult[] = [];
  let k = 0;
  for (const h of teams) for (const a of teams) {
    if (h === a) continue;
    const [hg, ag] = scores[k % scores.length];
    out.push(res(leagueId, h, a, hg, ag, new Date(start + k * 86_400_000).toISOString()));
    k++;
  }
  return out;
}
const BL_TEAMS = ['dortmund', 'bremen', 'bayern', 'leipzig'];
const B2_TEAMS = ['karlsruhe', 'darmstadt', 'bochum', 'hertha'];
const PL_TEAMS = ['arsenal', 'chelsea', 'spurs', 'city'];
const blSeason = season('ger-bl', BL_TEAMS, [[3, 1], [2, 2], [1, 0], [2, 1]]); // 12 meccs
const b2Season = season('ger-b2', B2_TEAMS, [[1, 1], [0, 0], [1, 2], [2, 0]]); // 12 meccs
const plSeason = season('eng-pl', PL_TEAMS, [[2, 0], [1, 1], [0, 1], [3, 2]]); // 12 meccs
/** kupa: lefutott profi–amatőr meccsek + hosszabbítás + tizenegyespárbaj */
const cup: MatchResult[] = [
  res('ger-dfb', 'amateur1', 'dortmund', 0, 11, '2026-08-21T17:00:00Z'),
  res('ger-dfb', 'amateur2', 'bremen', 0, 9, '2026-08-22T17:00:00Z'),
  res('ger-dfb', 'halle', 'schalke', 2, 5, '2026-08-23T17:00:00Z', { regulation: false, decidedBy: 'aet' }),
  res('ger-dfb', 'grossaspach', 'bielefeld', 2, 2, '2026-08-24T17:00:00Z', { regulation: false, decidedBy: 'pen', shootout: { home: 3, away: 0 } }),
];
const team = (id: string, leagueId: string): Team => ({ id, name: id[0].toUpperCase() + id.slice(1), shortName: id.slice(0, 3).toUpperCase(), country: 'Németország', leagueId });
const research = (matchId: string): ResearchResult => ({ matchId, origin: 'live', performedAt: '', provider: 'x', news: [], availability: { home: { teamId: 'h', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] }, away: { teamId: 'a', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] } }, externalPredictions: [], sources: [], warnings: [] });
const match = (leagueId: string, home: string, away: string): Match => ({ id: `m-${home}-${away}`, leagueId, homeTeamId: home, awayTeamId: away, kickoff: '2026-10-27T19:45:00Z', status: 'scheduled', importance: 'normal', importanceReasons: [], origin: 'live' });

describe('Sorozatformátum', () => {
  it('csak a valódi bajnokságok kapnak tabellát; a kupák, válogatott sorozatok és barátságos meccsek nem', () => {
    const got = Object.fromEntries(ESPN_LEAGUES.map((l) => [l.id, competitionFormat(l)]));
    expect(got).toEqual({
      'eng-pl': 'league', 'esp-ll': 'league', 'ita-sa': 'league', 'ger-bl': 'league', 'fra-l1': 'league', 'usa-mls': 'league', 'aus-al': 'league',
      'eng-ch': 'league', 'esp-l2': 'league', 'ita-sb': 'league', 'ger-b2': 'league', 'fra-l2': 'league',
      'uefa-ucl': 'club_intl_cup', 'uefa-uel': 'club_intl_cup', 'uefa-uecl': 'club_intl_cup',
      'uefa-nl': 'national_team', 'fifa-wcq-uefa': 'national_team', 'fifa-friendly': 'friendly',
      'ger-dfb': 'domestic_cup', 'eng-efl': 'domestic_cup', 'esp-cdr': 'domestic_cup',
    });
    expect(ESPN_LEAGUES.filter(hasLeagueTable).every((l) => !l.international && !l.domesticCup)).toBe(true);
  });
});

describe('Rendes játékidős átlag', () => {
  it('a hosszabbítással és tizenegyespárbajjal eldőlt meccs nem számít az átlagba', () => {
    const avg = computeLeagueAverages('ger-dfb', cup);
    expect(avg.matches).toBe(2); // csak a két rendes játékidős meccs
    expect(avg.avgTotalGoals).toBe(10); // (11 + 9) / 2 – a 2–5 (h.u.) és a 2–2 (11-es) kimarad
    expect(avg.drawPct).toBe(0);
  });

  it('bajnokságban (ahol ilyen meccs nincs) az átlag változatlan', () => {
    const before = computeLeagueAverages('ger-bl', blSeason);
    const withCup = computeLeagueAverages('ger-bl', [...blSeason, ...cup]);
    expect(withCup).toEqual(before);
    expect(before.matches).toBe(12);
  });
});

describe('Kupameccs liga-alapértéke', () => {
  const all = [...blSeason, ...b2Season, ...plSeason, ...cup];

  it('DFB-Pokal, két Bundesliga-csapat: a Bundesliga rendes játékidős átlaga – nem a kupa saját eredményei', () => {
    const b = chooseBaseline({ league: DFB, teamLeagues: { home: BL, away: BL }, results: all });
    expect(b).toMatchObject({ source: 'teams_league', leagueIds: ['ger-bl'], label: 'Bundesliga' });
    expect(b.averages).toEqual(computeLeagueAverages('ger-bl', all));
    expect(b.averages.avgTotalGoals).not.toBe(computeLeagueAverages('ger-dfb', all).avgTotalGoals);
  });

  it('különböző bajnokságok (Bundesliga + 2. Bundesliga): a két bajnoki átlag egyenlő súlyú átlaga', () => {
    const b = chooseBaseline({ league: DFB, teamLeagues: { home: B2, away: BL }, results: all });
    const bl = computeLeagueAverages('ger-bl', all); const b2 = computeLeagueAverages('ger-b2', all);
    expect(b).toMatchObject({ source: 'teams_leagues_mixed', leagueIds: ['ger-b2', 'ger-bl'], label: '2. Bundesliga + Bundesliga' });
    expect(b.averages.avgHomeGoals).toBe(Math.round(((bl.avgHomeGoals + b2.avgHomeGoals) / 2) * 100) / 100);
    expect(b.averages.avgAwayGoals).toBe(Math.round(((bl.avgAwayGoals + b2.avgAwayGoals) / 2) * 100) / 100);
    expect(b.averages.homeWinPct).toBe(Math.round(((bl.homeWinPct + b2.homeWinPct) / 2) * 10) / 10);
    expect(b.averages.matches).toBe(bl.matches + b2.matches);
    expect(combineAverages(b2, bl)).toEqual(b.averages); // hazai csapat bajnoksága elöl
  });

  it('nemzetközi kupa, két ország (Bundesliga + Premier League): ugyanígy a két saját bajnokság egyenlő súllyal', () => {
    const b = chooseBaseline({ league: UCL, teamLeagues: { home: BL, away: PL }, results: all });
    expect(b).toMatchObject({ source: 'teams_leagues_mixed', leagueIds: ['ger-bl', 'eng-pl'] });
  });

  it('csak az egyik csapatnak van bajnoki adata (alsóbb osztályú, csak kupából ismert ellenfél): az ő bajnoksága', () => {
    const b = chooseBaseline({ league: DFB, teamLeagues: { home: DFB, away: BL }, results: all });
    expect(b).toMatchObject({ source: 'teams_league', leagueIds: ['ger-bl'] });
  });

  it('hiányzó / kevés bajnoki adat: a meglévő biztonságos fallback – a sorozat saját, rendes játékidős eredményei', () => {
    const few = [...blSeason.slice(0, MIN_BASELINE_MATCHES - 1), ...cup];
    const b = chooseBaseline({ league: DFB, teamLeagues: { home: BL, away: BL }, results: few });
    expect(b).toMatchObject({ source: 'competition', leagueIds: ['ger-dfb'] });
    expect(b.averages).toEqual(computeLeagueAverages('ger-dfb', few));
    expect(b.averages.matches).toBe(2); // a h.u. és a 11-es meccs a fallbackben sem számít
    // ismeretlen csapat-sorozat (nincs teamLeagues): szintén fallback
    expect(chooseBaseline({ league: DFB, results: all }).source).toBe('competition');
  });

  it('bajnoki meccsnél semmi nem változik: a bajnokság saját átlaga, akkor is, ha a csapatok sorozata más', () => {
    const b = chooseBaseline({ league: BL, teamLeagues: { home: B2, away: PL }, results: all });
    expect(b).toMatchObject({ source: 'league', leagueIds: ['ger-bl'] });
    expect(b.averages).toEqual(computeLeagueAverages('ger-bl', all));
  });
});

describe('Elemzés', () => {
  const all = [...blSeason, ...b2Season, ...cup];
  const dortmund = team('dortmund', 'ger-bl'); const bremen = team('bremen', 'ger-bl');

  it('DFB-Pokal-elemzés: Bundesliga-alapérték, nincs „Tabella” helyezés, a forrás megnevezve', () => {
    const a = analyzeMatch({ match: match('ger-dfb', 'dortmund', 'bremen'), league: DFB, homeTeam: dortmund, awayTeam: bremen, results: all, odds: null, research: research('m'), now: '2026-10-26T12:00:00Z', teamLeagues: { home: BL, away: BL } });
    expect(a.leagueAverages).toEqual(computeLeagueAverages('ger-bl', all));
    expect(a.standings).toEqual({ home: null, away: null, total: 0 });
    expect(a.oneXtwoFactors.join(' ')).not.toMatch(/Tabella:/);
    expect(a.oneXtwoFactors.join(' ')).toMatch(/Kupamérkőzés: a liga-alapérték a\(z\) Bundesliga/);
  });

  it('bajnoki elemzés változatlan: a teamLeagues nem számít, a tabella-helyezés megmarad', () => {
    const inp = { match: match('ger-bl', 'dortmund', 'bremen'), league: BL, homeTeam: dortmund, awayTeam: bremen, results: all, odds: null, research: research('m'), now: '2026-10-26T12:00:00Z' };
    const plain = analyzeMatch(inp);
    const withTl = analyzeMatch({ ...inp, teamLeagues: { home: B2, away: B2 } });
    expect(withTl).toEqual(plain);
    expect(plain.leagueAverages).toEqual(computeLeagueAverages('ger-bl', all));
    expect(plain.standings.total).toBe(BL_TEAMS.length);
    expect(plain.oneXtwoFactors.join(' ')).toMatch(/Tabella:/);
    expect(plain.oneXtwoFactors.join(' ')).not.toMatch(/Kupamérkőzés/);
  });
});

// ---------------------------------------------------------------------------
// /api/standings – valódi apiRouter, hamis adatforrás
// ---------------------------------------------------------------------------

describe('/api/standings', () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

  async function call(leagueId: string, pro = true) {
    const results: Record<string, MatchResult[]> = { 'ger-bl': blSeason, 'ger-dfb': cup, 'uefa-ucl': [res('uefa-ucl', 'dortmund', 'arsenal', 1, 1, '2026-10-01T19:00:00Z'), res('uefa-ucl', 'arsenal', 'bayern', 3, 0, '2026-10-21T19:00:00Z')] };
    const data = {
      origin: 'live',
      getLeagues: async () => [BL, DFB, UCL],
      getLeagueResults: async (id: string) => results[id] ?? [],
      getSeasonStart: async () => undefined,
      getTeams: async () => ['dortmund', 'bremen', 'bayern', 'leipzig', 'halle', 'schalke', 'grossaspach', 'bielefeld', 'amateur1', 'amateur2', 'arsenal'].map((id) => team(id, 'ger-bl')),
    };
    const app = express();
    app.use((_req, res, next) => { res.locals.plan = { enforced: true, user: { id: 'u' }, pro, admin: false }; next(); });
    app.use('/api', apiRouter({ data } as unknown as Container, {} as AnalysisService));
    server = await new Promise<Server>((r) => { const s = app.listen(0, () => r(s)); });
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/standings/${leagueId}`);
    return { status: r.status, body: await r.json() };
  }

  it('DFB-Pokal: nincs tabella; helyette a mérkőzések és eredmények (legfrissebb elöl), a formátummal', async () => {
    const { status, body } = await call('ger-dfb');
    expect(status).toBe(200);
    expect(body.format).toBe('domestic_cup');
    expect(body.standings).toEqual([]);
    expect(body.resultsTotal).toBe(4);
    expect(body.results.map((r: CompetitionResultRow) => r.id)).toEqual([...cup].sort((a, b) => b.date.localeCompare(a.date)).map((r) => r.id));
    expect(body.results[0]).toMatchObject({ decidedBy: 'pen', shootout: { home: 3, away: 0 }, homeTeam: { id: 'grossaspach' } });
    expect(JSON.stringify(body.results)).not.toMatch(/"points"|"position"/); // nincs mesterséges pontozás / rangsor
    expect(body.averages.matches).toBe(2); // rendes játékidős átlag
  });

  it('nemzetközi kupa (BL): sincs félrevezető bajnoki tabella', async () => {
    const { body } = await call('uefa-ucl');
    expect(body.format).toBe('club_intl_cup');
    expect(body.standings).toEqual([]);
    expect(body.results).toHaveLength(2);
  });

  it('Bundesliga: a tabella változatlanul működik (pontok, helyezések), kupás eredménylista nélkül', async () => {
    const { body } = await call('ger-bl');
    expect(body.format).toBe('league');
    expect(body.results).toEqual([]);
    expect(body.resultsTotal).toBe(0);
    const expected = computeStandings('ger-bl', blSeason);
    expect(body.standings.map((s: { teamId: string; points: number; position: number }) => [s.teamId, s.points, s.position])).toEqual(expected.map((s) => [s.teamId, s.points, s.position]));
  });

  it('FREE: a kupa eredménylistája is PRO (mint a tabella) – csak az átlagok és a darabszám látszik', async () => {
    const { body } = await call('ger-dfb', false);
    expect(body.results).toEqual([]);
    expect(body.standings).toEqual([]);
    expect(body.resultsTotal).toBe(4);
    expect(body.averages.matches).toBe(2);
  });
});

describe('Statisztikák oldal – kupás nézet', () => {
  const rows: CompetitionResultRow[] = cup.map((r) => ({ ...r, homeTeam: team(r.homeTeamId, 'x'), awayTeam: team(r.awayTeamId, 'x') }));
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CompetitionResults, { name: 'DFB-Pokal', format: 'domestic_cup', results: rows, total: 4 })));

  it('kupasorozatként jelöl, a mérkőzéseket és eredményeket mutatja, tabella nélkül', () => {
    expect(html).toContain('DFB-Pokal – mérkőzések és eredmények');
    expect(html).toContain('Kieséses hazai kupa');
    expect(html).toContain('nincs tabella');
    expect(html).toContain('0–11');
    expect(html).not.toContain('<th>P</th>');
    expect(html).not.toMatch(/tabella<\/h3>/);
  });

  it('a hosszabbítás és a tizenegyespárbaj szövegesen jelölve', () => {
    expect(html).toContain('hosszabbítás után');
    expect(html).toContain('tizenegyesekkel 3–0');
    expect(decidedText({ decidedBy: undefined, shootout: undefined })).toBeNull();
    expect(decidedText({ decidedBy: 'pen', shootout: undefined })).toBe('tizenegyesekkel');
  });
});
