import { describe, expect, it } from 'vitest';
import { poissonModel, poissonPmf, xgModel, marketProbability } from '../src/shared/engine/models';
import { computeForm, computeGoalMarkets, computeH2H, computeLeagueAverages, computeStandings } from '../src/shared/engine/stats';
import { evaluateMarket, parsePredictionText, marketLabel } from '../src/shared/engine/markets';
import { computeConsensus, computeDataQuality, computeValue, impliedProbability, valueVerdict } from '../src/shared/engine/evaluation';
import { analyzeMatch } from '../src/shared/engine/analysis';
import type { MatchResult, ResearchResult, League, Team, Match } from '../src/shared/types';
import { buildDemoDataset } from '../src/server/data/demo/generate';

const r = (id: string, home: string, away: string, hg: number, ag: number, date: string, leagueId = 'L'): MatchResult =>
  ({ id, leagueId, date, homeTeamId: home, awayTeamId: away, homeGoals: hg, awayGoals: ag, origin: 'demo' });

const sample: MatchResult[] = [
  r('1', 'A', 'B', 2, 1, '2026-01-01'),
  r('2', 'B', 'A', 0, 0, '2026-01-08'),
  r('3', 'A', 'C', 3, 1, '2026-01-15'),
  r('4', 'C', 'B', 1, 2, '2026-01-22'),
  r('5', 'A', 'B', 1, 3, '2026-01-29'),
];

describe('Poisson', () => {
  it('pmf matches known values', () => {
    expect(poissonPmf(1, 0)).toBeCloseTo(Math.exp(-1), 6);
    expect(poissonPmf(2, 2)).toBeCloseTo(2 * Math.exp(-2), 6);
  });
  it('distribution sums to 1 and probabilities are consistent', () => {
    const p = poissonModel(1.6, 1.1);
    const total = p.matrix.flat().reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(p.homeWin + p.draw + p.awayWin).toBeCloseTo(1, 6);
    expect(p.over['2.5'] + p.under['2.5']).toBeCloseTo(1, 6);
    expect(p.bttsYes + p.bttsNo).toBeCloseTo(1, 6);
    expect(p.homeWin).toBeGreaterThan(p.awayWin);
    expect(p.correctScores[0].prob).toBeGreaterThanOrEqual(p.correctScores[1].prob);
    expect(p.asianHome1.win + p.asianHome1.push + p.asianHome1.lose).toBeCloseTo(1, 6);
    expect(marketProbability(p, 'CS_1-0')).toBeCloseTo(p.matrix[1][0], 10);
    expect(marketProbability(p, 'NOPE')).toBeNull();
  });
});

describe('Form statistics', () => {
  it('computes last N with correct W/D/L, goals and percentages', () => {
    const f = computeForm('A', sample, 10);
    expect(f.sampleSize).toBe(4);
    expect(f.formString).toBe('LWDW'); // legfrissebb elöl
    expect(f.wins).toBe(2); expect(f.draws).toBe(1); expect(f.losses).toBe(1);
    expect(f.goalsFor).toBe(6); expect(f.goalsAgainst).toBe(5);
    expect(f.over25).toBe(75); // 3, 4 és 4 gólos meccsek: 3/4
    expect(f.btts).toBe(75);
    expect(f.firstHalfGoalsAvg).toBeNull(); // nincs félidei adat
  });
  it('venue split works', () => {
    expect(computeForm('A', sample, 10, 'hazai').sampleSize).toBe(3);
    expect(computeForm('A', sample, 10, 'idegen').sampleSize).toBe(1);
  });
  it('empty sample returns zeros not NaN', () => {
    const f = computeForm('Z', sample, 10);
    expect(f.sampleSize).toBe(0);
    expect(f.avgGoalsFor).toBe(0);
    expect(f.over25).toBe(0);
    expect(Number.isNaN(f.btts)).toBe(false);
  });
  it('beforeDate excludes later matches (no look-ahead)', () => {
    const f = computeForm('A', sample, 10, 'összes', '2026-01-20');
    expect(f.sampleSize).toBe(3);
  });
});

describe('H2H, standings, league averages, goal markets', () => {
  it('h2h', () => {
    const h = computeH2H('A', 'B', sample);
    expect(h.sampleSize).toBe(3);
    expect(h.homeTeamWins).toBe(1); expect(h.draws).toBe(1); expect(h.awayTeamWins).toBe(1);
  });
  it('standings order and points', () => {
    const s = computeStandings('L', sample);
    expect(s[0].teamId).toBe('B'); // 7 pont, +2 gólkülönbség
    expect(s.find((x) => x.teamId === 'A')!.points).toBe(7);
    expect(s.find((x) => x.teamId === 'C')!.position).toBe(3);
  });
  it('league averages', () => {
    const l = computeLeagueAverages('L', sample);
    expect(l.matches).toBe(5);
    expect(l.avgHomeGoals).toBeCloseTo(7 / 5, 5);
  });
  it('goal markets combine home/away', () => {
    const gm = computeGoalMarkets(computeForm('A', sample, 10), computeForm('B', sample, 10));
    const o25 = gm.find((g) => g.market === 'O2.5')!;
    expect(o25.homePct).toBe(75);
    expect(o25.combinedPct).not.toBeNull();
    const empty = computeGoalMarkets(computeForm('Z', sample, 10), computeForm('Z', sample, 10));
    expect(empty[0].combinedPct).toBeNull();
  });
});

describe('xG model', () => {
  it('returns null on insufficient data', () => {
    expect(xgModel(computeForm('A', sample, 10, 'hazai'), computeForm('B', sample, 10, 'idegen'), computeLeagueAverages('L', sample))).toBeNull();
  });
  it('produces sensible lambdas on demo data', () => {
    const ds = buildDemoDataset(new Date('2026-09-18T12:00:00'));
    const results = ds.results.filter((x) => x.leagueId === 'eng-pl');
    const xg = xgModel(computeForm('man-city', results, 10, 'hazai'), computeForm('southampton', results, 10, 'idegen'), computeLeagueAverages('eng-pl', results));
    expect(xg).not.toBeNull();
    expect(xg!.homeExpected).toBeGreaterThan(xg!.awayExpected);
    expect(xg!.homeExpected).toBeLessThanOrEqual(4.5);
  });
});

describe('Markets', () => {
  it('evaluates outcomes', () => {
    expect(evaluateMarket('1', 2, 1)).toBe('win');
    expect(evaluateMarket('X', 1, 1)).toBe('win');
    expect(evaluateMarket('O2.5', 2, 1)).toBe('win');
    expect(evaluateMarket('U2.5', 2, 1)).toBe('loss');
    expect(evaluateMarket('BTTS_Y', 0, 3)).toBe('loss');
    expect(evaluateMarket('DNB_1', 1, 1)).toBe('void');
    expect(evaluateMarket('AH_HOME_-1', 2, 1)).toBe('void');
    expect(evaluateMarket('AH_HOME_-1', 3, 1)).toBe('win');
    expect(evaluateMarket('CS_2-1', 2, 1)).toBe('win');
    expect(evaluateMarket('HOME_O1.5', 2, 0)).toBe('win');
    expect(() => evaluateMarket('???', 1, 1)).toThrow();
  });
  it('parses prediction text conservatively', () => {
    expect(parsePredictionText('Our tip: Over 2.5 goals')).toBe('O2.5');
    expect(parsePredictionText('Both teams to score: No')).toBe('BTTS_N');
    expect(parsePredictionText('Arsenal home win')).toBe('1');
    expect(parsePredictionText('lorem ipsum')).toBeNull();
    expect(marketLabel('CS_2-1')).toBe('Pontos eredmény 2–1');
  });
});

describe('Value / quality / consensus', () => {
  it('implied probability and verdicts', () => {
    expect(impliedProbability(1.9)).toBeCloseTo(0.5263, 3);
    expect(valueVerdict(8.37)).toBe('Pozitív modellkülönbség');
    expect(valueVerdict(-5)).toBe('Negatív modellkülönbség');
    expect(valueVerdict(1)).toBe('Semleges');
    const p = poissonModel(1.7, 1.1);
    const rows = computeValue(p, { matchId: 'm', source: 'manual', retrievedAt: '', markets: { 'O2.5': 1.9 } });
    const o = rows.find((x) => x.market === 'O2.5')!;
    expect(o.impliedProb).toBeCloseTo(0.5263, 3);
    expect(o.diffPoints).not.toBeNull();
    expect(rows.find((x) => x.market === '1')!.odds).toBeNull();
    expect(computeValue(null, null)).toEqual([]);
  });
  it('consensus detects agreement and disagreement', () => {
    const mk = (id: string, market: string | null) => ({ id, sourceName: 'S' + id, url: null, originalText: '', market, confidence: null, sourceId: id, origin: 'demo' as const, autoExtracted: false });
    const c = computeConsensus([mk('1', 'O2.5'), mk('2', 'O2.5'), mk('3', 'U2.5'), mk('4', null)]);
    expect(c.byMarket[0].market).toBe('O2.5');
    expect(c.agreementNote).toContain('egyetértés');
    expect(c.disagreementNote).toContain('eltérő');
    expect(computeConsensus([]).agreementNote).toBeNull();
  });
  it('data quality is low with no data', () => {
    const research: ResearchResult = { matchId: 'm', origin: 'live', performedAt: '', provider: 'x', news: [], availability: { home: { teamId: 'A', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] }, away: { teamId: 'B', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] } }, externalPredictions: [], sources: [], warnings: [] };
    const q = computeDataQuality({ homeLast10: computeForm('Z', [], 10), awayLast10: computeForm('Z', [], 10), homeAtHome: computeForm('Z', [], 10), awayAtAway: computeForm('Z', [], 10), leagueMatches: 0, research, odds: null, newestResultDate: null, now: '2026-01-01' });
    expect(q.level).toBe('kevés');
    expect(q.score).toBe(0);
  });
});

describe('Full analysis', () => {
  const league: League = { id: 'L', name: 'Teszt liga', country: 'X', countryCode: 'X', tier: 1, international: false };
  const A: Team = { id: 'A', name: 'A csapat', shortName: 'A', country: 'X', leagueId: 'L' };
  const B: Team = { id: 'B', name: 'B csapat', shortName: 'B', country: 'X', leagueId: 'L' };
  const research: ResearchResult = { matchId: 'm', origin: 'live', performedAt: '', provider: 'x', news: [], availability: { home: { teamId: 'A', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] }, away: { teamId: 'B', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] } }, externalPredictions: [], sources: [], warnings: [] };
  const match: Match = { id: 'm', leagueId: 'L', homeTeamId: 'A', awayTeamId: 'B', kickoff: '2026-02-01T18:00:00Z', status: 'scheduled', importance: 'normal', importanceReasons: [], origin: 'live' };

  it('reports insufficient data instead of inventing numbers', () => {
    const a = analyzeMatch({ match, league, homeTeam: A, awayTeam: B, results: sample, odds: null, research, now: '2026-01-30T00:00:00Z' });
    expect(a.insufficientData).toBe(true);
    expect(a.xg).toBeNull();
    expect(a.poisson).toBeNull();
    expect(a.tips).toEqual([]);
    expect(a.insufficientReasons.length).toBeGreaterThan(0);
  });
  it('works end-to-end on demo data', () => {
    const ds = buildDemoDataset(new Date('2026-09-18T12:00:00'));
    const m = ds.matches.find((x) => x.status === 'scheduled' && x.leagueId === 'eng-pl')!;
    const home = ds.teams.find((t) => t.id === m.homeTeamId)!;
    const away = ds.teams.find((t) => t.id === m.awayTeamId)!;
    const a = analyzeMatch({ match: m, league: ds.leagues[0], homeTeam: home, awayTeam: away, results: ds.results, odds: ds.odds.get(m.id)!, research: { ...research, matchId: m.id, origin: 'demo' }, now: '2026-09-18T12:00:00Z' });
    expect(a.insufficientData).toBe(false);
    expect(a.poisson!.homeWin + a.poisson!.draw + a.poisson!.awayWin).toBeCloseTo(1, 6);
    expect(a.tips.length).toBeGreaterThan(5);
    expect(a.tips.some((t) => t.category === 'konzervatív')).toBe(true);
    expect(a.value.some((v) => v.odds != null)).toBe(true);
    expect(a.methodology.length).toBeGreaterThan(3);
  });
  it('demo dataset is deterministic', () => {
    const a = buildDemoDataset(new Date('2026-09-18T12:00:00'));
    const b = buildDemoDataset(new Date('2026-09-19T12:00:00'));
    expect(a.results.map((x) => `${x.id}:${x.homeGoals}-${x.awayGoals}`)).toEqual(b.results.map((x) => `${x.id}:${x.homeGoals}-${x.awayGoals}`));
    expect(a.results.every((x) => x.origin === 'demo')).toBe(true);
  });
});

describe('Élő adat segédfüggvények', () => {
  it('amerikai odds → tizedes', async () => {
    const { americanToDecimal } = await import('../src/server/data/espnProvider');
    expect(americanToDecimal('-140')).toBeCloseTo(1.71, 2);
    expect(americanToDecimal('+260')).toBe(3.6);
    expect(americanToDecimal('+100')).toBe(2);
    expect(americanToDecimal(undefined)).toBeNull();
    expect(americanToDecimal('abc')).toBeNull();
  });
  it('csapatnév-alapú tippfelismerés konzervatív', () => {
    expect(parsePredictionText('Brighton vs Arsenal predictions: Arsenal to win', 'Brighton & Hove Albion', 'Arsenal')).toBe('2');
    expect(parsePredictionText('Brighton to beat Arsenal', 'Brighton & Hove Albion', 'Arsenal')).toBe('1');
    expect(parsePredictionText('Brighton vs Arsenal preview', 'Brighton & Hove Albion', 'Arsenal')).toBeNull();
    // mindkét csapat "nyer" – bizonytalan, nem ad piacot
    expect(parsePredictionText('Brighton win or Arsenal win?', 'Brighton', 'Arsenal')).toBeNull();
  });
});

describe('Szelvényépítő', () => {
  const mk = (matchId: string, market: string, p: number, odds: number, quality: 'magas' | 'közepes' | 'kevés' = 'magas') => ({
    matchId, matchLabel: matchId, leagueName: 'L', kickoff: '2026-09-27T12:00:00.000Z', market, label: market, modelProb: p, odds,
    bookmaker: null, impliedProb: 1 / odds, diffPoints: Math.round((p - 1 / odds) * 10000) / 100, category: 'konzervatív' as const, supportingIndicators: 3, dataQuality: quality,
  });
  const legs = [
    mk('A', 'O1.5', 0.85, 1.25), mk('A', '1', 0.6, 1.9),
    mk('B', '1X', 0.8, 1.3), mk('B', 'U2.5', 0.55, 2.0),
    mk('C', 'O2.5', 0.7, 1.7), mk('C', 'BTTS_Y', 0.62, 1.8),
    mk('D', '1', 0.5, 2.2, 'kevés'),
  ];
  it('legnagyobb esély: a legvalószínűbb lábak, mérkőzésenként legfeljebb egy', async () => {
    const { buildSlips } = await import('../src/shared/engine/slips');
    const s = buildSlips(legs, { legs: 3, minTotalOdds: 1, minLegProb: 0.5, strategies: ['legnagyobb esély'], perStrategy: 1 });
    expect(s).toHaveLength(1);
    expect(s[0].legs.map((l) => l.matchId + ':' + l.market).sort()).toEqual(['A:O1.5', 'B:1X', 'C:O2.5']);
    expect(s[0].jointProb).toBeCloseTo(0.85 * 0.8 * 0.7, 6);
    expect(s[0].totalOdds).toBeCloseTo(1.25 * 1.3 * 1.7, 2);
    expect(new Set(s[0].legs.map((l) => l.matchId)).size).toBe(3);
  });
  it('összodds-korlát érvényesül', async () => {
    const { buildSlips } = await import('../src/shared/engine/slips');
    const s = buildSlips(legs, { legs: 2, minTotalOdds: 3.5, minLegProb: 0.5, strategies: ['legnagyobb esély'], perStrategy: 3 });
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) expect(x.totalOdds).toBeGreaterThanOrEqual(3.5);
  });
  it('modell-előny csak pozitív különbségű lábakat használ; kevés láb esetén üres', async () => {
    const { buildSlips } = await import('../src/shared/engine/slips');
    const s = buildSlips(legs, { legs: 2, minTotalOdds: 1, minLegProb: 0.5, strategies: ['modell-előny'], perStrategy: 2 });
    for (const x of s) for (const l of x.legs) expect(l.diffPoints).toBeGreaterThan(0);
    expect(buildSlips(legs.slice(0, 2), { legs: 3, minTotalOdds: 1, minLegProb: 0.5 })).toEqual([]);
  });
  it('figyelmeztetések: kevés adat és alacsony együttes esély', async () => {
    const { buildSlips } = await import('../src/shared/engine/slips');
    const s = buildSlips(legs, { legs: 4, minTotalOdds: 1, minLegProb: 0.5, strategies: ['legnagyobb esély'], perStrategy: 1 });
    expect(s[0].warnings.some((w) => w.includes('kevés adatra'))).toBe(true);
    expect(s[0].warnings[0]).toContain('függetlenség');
  });
  it('csapatnév-hasonlóság az odds-párosításhoz', async () => {
    const { nameSimilarity } = await import('../src/server/odds/theOddsApi');
    expect(nameSimilarity('Brighton and Hove Albion', 'Brighton & Hove Albion')).toBeGreaterThan(0.6);
    expect(nameSimilarity('Manchester United', 'Manchester City')).toBeLessThan(0.6);
    expect(nameSimilarity('Real Oviedo', 'Sporting Gijón')).toBe(0);
  });
});
