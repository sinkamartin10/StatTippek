/**
 * Edge Radar 2. fázis – belső szolgáltatási réteg (src/server/edge/edgeService.ts).
 * Nincs éles adatbázis, titok vagy külső hálózat: a függőségek beinjektálva, illetve a valódi
 * AnalysisService DEMO-adattal.
 */
import { describe, expect, it } from 'vitest';
import { EdgeService, mapMarket, sameOddsState, type EdgeDeps, type EdgeRow, type EdgeVariant } from '../src/server/edge/edgeService';
import { AnalysisService } from '../src/server/services/analysisService';
import { DemoMatchDataProvider } from '../src/server/data/demoProvider';
import { DemoResearchProvider } from '../src/server/research/demoResearch';
import { computeValue } from '../src/shared/engine/evaluation';
import type { Container } from '../src/server/container';
import type { Match, MatchAnalysis, MatchOdds } from '../src/shared/types';

const NOW = '2026-10-20T15:00:00.000Z';
const KICK = '2026-10-20T18:00:00.000Z';
const at = (minAgo: number) => new Date(Date.parse(NOW) - minAgo * 60_000).toISOString();

const match = (o: Partial<Match> = {}): Match => ({ id: 'espn-eng.1-1', leagueId: 'eng-pl', homeTeamId: 'espn-11', awayTeamId: 'espn-21', kickoff: KICK, status: 'scheduled', importance: 'normal', importanceReasons: [], origin: 'live', ...o });
const PK = { '1': 'close', X: 'close', '2': 'close', 'O2.5': 'close', 'U2.5': 'close' } as const;
const espnOdds = (o: Partial<MatchOdds> = {}): MatchOdds => ({
  matchId: 'espn-eng.1-1', source: 'live', bookmaker: 'DraftKings (ESPN)', retrievedAt: NOW, observedAt: at(10),
  markets: { '1': 2.1, X: 3.5, '2': 3.4, 'O2.5': 1.91, 'U2.5': 1.91 },
  observation: { via: 'espn-scoreboard', singleBook: true, matchStatus: 'scheduled', priceKind: { ...PK } }, ...o,
});
const MODEL: Record<string, number> = { '1': 0.5, X: 0.26, '2': 0.24, 'O2.5': 0.55, 'U2.5': 0.45 };
const analysis = (m: Match, odds: MatchOdds | null, o: Partial<MatchAnalysis> = {}): MatchAnalysis => ({
  match: m, odds, poisson: {} as MatchAnalysis['poisson'], model: { id: 'xg-poisson-1', label: 'x' },
  value: Object.entries(MODEL).map(([market, modelProb]) => ({ market, label: market, modelProb, odds: odds?.markets[market] ?? null, impliedProb: null, diffPoints: null, verdict: null })),
  ...o,
} as MatchAnalysis);

/** beinjektált függőségek; az elemzés és a feloldott odds külön állítható (cache-eltérés szimulálására) */
function deps(m: Match, odds: MatchOdds | null, a: MatchAnalysis | null = analysis(m, odds)) {
  const calls: { variant: EdgeVariant }[] = [];
  const d: EdgeDeps = {
    getMatches: async () => [m],
    analyze: async (_id, o) => { calls.push(o); return a; },
    resolveOdds: async () => odds,
  };
  return { d, calls };
}
const rows = async (m: Match, odds: MatchOdds | null, a?: MatchAnalysis | null, now = NOW) => new EdgeService(deps(m, odds, a === undefined ? analysis(m, odds) : a).d).buildEdgeRows('2026-10-20', 'base', now);
const by = (r: EdgeRow[], market: string) => r.find((x) => x.market === market)!;

describe('Sorépítés igazolt ESPN-oddsból', () => {
  it('minden piac sora: odds, iroda, forrás, megfigyelés, nyers és árrésmentes valószínűség, modell, edge', async () => {
    const r = await rows(match(), espnOdds());
    expect(r.map((x) => x.market)).toEqual(['1', 'X', '2', 'O2.5', 'U2.5']);
    const over = 1 / 2.1 + 1 / 3.5 + 1 / 3.4;
    const h = by(r, '1');
    expect(h).toMatchObject({ matchId: 'espn-eng.1-1', kickoff: KICK, leagueId: 'eng-pl', outcome: '1x2:home', odds: 2.1, bookmaker: 'DraftKings (ESPN)', source: 'espn-scoreboard', observedAt: at(10), ageMs: 600_000, modelProb: 0.5, modelId: 'xg-poisson-1', excluded: false, excludeReason: null, devigReason: null });
    expect(h.rawImplied).toBeCloseTo(1 / 2.1, 12);
    expect(h.devig).toBeCloseTo(1 / 2.1 / over, 12);
    expect(h.edgePp).toBe(Math.round((0.5 - 1 / 2.1 / over) * 10000) / 100);
    expect(by(r, 'U2.5')).toMatchObject({ outcome: 'ou2.5:under', excluded: false });
    expect(by(r, 'U2.5').devig).toBeCloseTo(0.5, 12);
    // a sorban NINCS EV-mező
    expect(Object.keys(h)).not.toContain('ev');
  });
});

describe('Kézi és összefésült odds: nincs igazolt iroda, nincs de-vig, nincs edge', () => {
  it('kézi odds (eredet nélkül) és összefésült odds (eredet nélkül)', async () => {
    for (const odds of [espnOdds({ source: 'manual', bookmaker: 'kézi bevitel', observation: undefined, observedAt: undefined }), espnOdds({ bookmaker: 'legjobb odds (összefésült)', observation: undefined, observedAt: undefined, bookmakers: { '1': 'A', X: 'B', '2': 'A' } })]) {
      const r = await rows(match(), odds);
      for (const x of r) {
        expect(x.bookmaker).toBeNull();
        expect(x.source).toBe(`unverified:${odds.source}`);
        expect(x.devig).toBeNull();
        expect(x.edgePp).toBeNull();
        expect(x.excluded).toBe(true);
      }
    }
  });
});

describe('Megfigyelési idő és mérkőzésállapot', () => {
  it('hiányzó, hibás, jövőbeli és túl régi megfigyelés → kizárva, edge nélkül', async () => {
    const cases: [Partial<MatchOdds>, string][] = [
      [{ observedAt: undefined }, 'unknown_observation'],
      [{ observedAt: 'nem-dátum' }, 'unknown_observation'],
      [{ observedAt: '2026-10-20T15:05:00.000Z' }, 'observed_in_future'],
      [{ observedAt: at(61) }, 'stale'],
    ];
    for (const [o, reason] of cases) {
      const odds = espnOdds(o);
      const r = await rows(match(), odds);
      expect(r.every((x) => x.excluded && x.excludeReason === reason && x.edgePp === null), reason).toBe(true);
      if (reason === 'observed_in_future' || reason === 'unknown_observation') expect(r.every((x) => x.ageMs === null), reason).toBe(true);
    }
  });
  it('élő, befejezett, halasztott és már elkezdődött meccs → nem kerül használható pre-match sorba', async () => {
    for (const status of ['live', 'finished', 'postponed'] as const) {
      const r = await rows(match({ status }), espnOdds());
      expect(r.every((x) => x.excludeReason === 'not_prematch' && x.edgePp === null), status).toBe(true);
    }
    const started = await rows(match(), espnOdds(), undefined, '2026-10-20T18:00:00.000Z');
    expect(started.every((x) => x.excludeReason === 'kickoff_passed' && x.edgePp === null)).toBe(true);
    const inPlay = await rows(match(), espnOdds({ observation: { via: 'espn-scoreboard', singleBook: true, matchStatus: 'live', priceKind: { ...PK } } }));
    expect(inPlay.every((x) => x.excludeReason === 'observed_in_play')).toBe(true);
  });
});

describe('Elemzés–odds egyezés', () => {
  it('hiányzó modell-valószínűség: hiányzó value-sor, vagy nincs Poisson-eredmény', async () => {
    const m = match(), odds = espnOdds();
    const a = analysis(m, odds); a.value = a.value.filter((v) => v.market !== 'O2.5');
    const r = await rows(m, odds, a);
    expect(by(r, 'O2.5')).toMatchObject({ excluded: true, excludeReason: 'model_prob_missing', modelProb: null, edgePp: null });
    expect(by(r, '1').excluded).toBe(false);
    const noPoisson = await rows(m, odds, analysis(m, odds, { poisson: null }));
    expect(noPoisson.every((x) => x.excludeReason === 'model_prob_missing')).toBe(true);
    const none = await rows(m, odds, null);
    expect(none.every((x) => x.excludeReason === 'analysis_unavailable' && x.modelProb === null)).toBe(true);
  });

  it('meccsazonosító-eltérés (az elemzés vagy az odds másik meccshez tartozik)', async () => {
    const m = match(), odds = espnOdds();
    expect((await rows(m, odds, analysis(match({ id: 'espn-eng.1-2' }), odds))).every((x) => x.excludeReason === 'match_mismatch')).toBe(true);
    const other = espnOdds({ matchId: 'espn-eng.1-2' });
    expect((await rows(m, other, analysis(m, other))).every((x) => x.excludeReason === 'match_mismatch')).toBe(true);
  });

  it('piac- és kimenetel-leképezés explicit: nem leképezett piac nem kap edge-et; a value-sor odds-a is egyezzen', async () => {
    expect(mapMarket('1')).toEqual({ group: '1x2', outcome: 'home' });
    expect(mapMarket('U3.5')).toEqual({ group: 'ou', outcome: 'under', line: 3.5 });
    for (const m of ['1X', 'BTTS_Y', 'DNB_1', 'AH_HOME_-1', 'O2', 'CS_1-0']) expect(mapMarket(m), m).toBeNull();
    const m = match();
    const odds = espnOdds({ markets: { ...espnOdds().markets, BTTS_Y: 1.8 } });
    const a = analysis(m, odds); a.value.push({ market: 'BTTS_Y', label: 'BTTS', modelProb: 0.6, odds: 1.8, impliedProb: null, diffPoints: null, verdict: null });
    const r = await rows(m, odds, a);
    expect(by(r, 'BTTS_Y')).toMatchObject({ outcome: null, devigReason: 'market_not_mapped', excludeReason: 'market_not_mapped', edgePp: null });
    // a value-sor más odds-ra készült, mint a piac aktuális ára
    const b = analysis(m, espnOdds()); b.value = b.value.map((v) => (v.market === 'X' ? { ...v, odds: 3.6 } : v));
    expect(by(await rows(m, espnOdds(), b), 'X')).toMatchObject({ excludeReason: 'analysis_odds_mismatch', edgePp: null, modelProb: null });
  });

  it('az elemzés odds-állapota eltér az aktuálistól (más ár, más megfigyelés, más iroda) → analysis_odds_mismatch', async () => {
    const m = match(), cur = espnOdds();
    for (const old of [espnOdds({ markets: { ...cur.markets, '1': 2.2 } }), espnOdds({ observedAt: at(20) }), espnOdds({ bookmaker: 'Bet 365 (ESPN)' }), null]) {
      const r = await rows(m, cur, analysis(m, old));
      expect(r.every((x) => x.excludeReason === 'analysis_odds_mismatch' && x.edgePp === null && x.modelProb === null)).toBe(true);
    }
    expect(sameOddsState(cur, espnOdds())).toBe(true);
  });
});

describe('Valódi AnalysisService: cache-elt elemzés nem bizonyítható odds-egyezéssel', () => {
  it('ha csak a megfigyelés frissül (ugyanazok az árak), a cache-elt elemzés régi odds-állapotú → kizárva; új elemzésnél egyezik', async () => {
    const demo = new DemoMatchDataProvider();
    const m = (await demo.getMatches({ status: 'scheduled' }))[0];
    const now = new Date(Date.parse(m.kickoff) - 3 * 3600_000).toISOString();
    let current: MatchOdds = { ...espnOdds({ matchId: m.id, observedAt: new Date(Date.parse(now) - 5 * 60_000).toISOString() }) };
    const data = Object.create(demo) as DemoMatchDataProvider;
    data.getOdds = async () => current;
    const c = { data, research: new DemoResearchProvider(demo), oddsApi: null, db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined } } as unknown as Container;
    const svc = new AnalysisService(c);
    const edge = new EdgeService({ getMatches: async () => [m], analyze: (id, o) => svc.analyze(id, o), resolveOdds: (x) => svc.resolveOdds(x) });
    const first = await edge.buildEdgeRows('x', 'base', now);
    expect(first.length).toBe(5);
    expect(first.filter((r) => r.market === '1' || r.market === 'X' || r.market === '2').every((r) => !r.excluded)).toBe(true);
    // 2 perccel később ugyanaz az ár, új megfigyelés – az AnalysisService 5 perces cache-e (árak szerinti kulccsal) a régit adja
    current = { ...current, observedAt: new Date(Date.parse(now) - 3 * 60_000).toISOString() };
    const second = await edge.buildEdgeRows('x', 'base', now);
    expect(second.every((r) => r.excludeReason === 'analysis_odds_mismatch' && r.edgePp === null)).toBe(true);
  });
});

describe('Változat, determinizmus, regresszió', () => {
  it('a FREE/PRO változatot a hívó adja, a szolgáltatás csak továbbítja (jogosultsági döntés nincs benne)', async () => {
    for (const variant of ['base', 'pro'] as const) {
      const { d, calls } = deps(match(), espnOdds());
      await new EdgeService(d).buildEdgeRows('2026-10-20', variant, NOW);
      expect(calls).toEqual([{ variant }]);
    }
    expect(Object.keys(deps(match(), null).d).sort()).toEqual(['analyze', 'getMatches', 'resolveOdds']); // nincs plan/auth függőség
  });

  it('rögzített now mellett determinisztikus, rendezett eredmény; oddsszal nem rendelkező meccs nem ad sort', async () => {
    const m2 = match({ id: 'espn-eng.1-2', kickoff: '2026-10-20T17:00:00.000Z' });
    const mk = (): EdgeDeps => ({
      getMatches: async () => [match(), m2],
      analyze: async (id) => (id === m2.id ? analysis(m2, espnOdds({ matchId: m2.id })) : analysis(match(), espnOdds())),
      resolveOdds: async (x) => (x.id === m2.id ? espnOdds({ matchId: m2.id }) : espnOdds()),
    });
    const a = await new EdgeService(mk()).buildEdgeRows('d', 'base', NOW);
    const b = await new EdgeService(mk(), { concurrency: 1 }).buildEdgeRows('d', 'base', NOW);
    expect(a).toEqual(b);
    expect(a.map((r) => `${r.matchId}:${r.market}`).slice(0, 3)).toEqual(['espn-eng.1-2:1', 'espn-eng.1-2:X', 'espn-eng.1-2:2']);
    expect(await rows(match(), null)).toEqual([]);
  });

  it('a meglévő tippek és a computeValue változatlanok az Edge-sorépítés után', async () => {
    const demo = new DemoMatchDataProvider();
    const m = (await demo.getMatches({ status: 'scheduled' }))[0];
    const c = { data: demo, research: new DemoResearchProvider(demo), oddsApi: null, db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined } } as unknown as Container;
    const svc = new AnalysisService(c);
    const before = (await svc.analyze(m.id))!;
    const snapshot = JSON.stringify({ tips: before.tips, value: before.value, poisson: before.poisson });
    await new EdgeService({ getMatches: async () => [m], analyze: (id, o) => svc.analyze(id, o), resolveOdds: (x) => svc.resolveOdds(x) }).buildEdgeRows('d', 'base', new Date(Date.parse(m.kickoff) - 3600_000));
    const after = (await svc.analyze(m.id))!;
    expect(JSON.stringify({ tips: after.tips, value: after.value, poisson: after.poisson })).toBe(snapshot);
    expect(computeValue(after.poisson, after.odds)).toEqual(after.value);
  });

  it('nincs fölösleges elemzés: odds nélküli, élő/befejezett/halasztott, elkezdődött, elavult vagy ismeretlen megfigyelésű meccsre nem fut analyze', async () => {
    const cases: [Match, MatchOdds | null, string][] = [
      [match(), null, NOW],
      [match({ status: 'live' }), espnOdds(), NOW],
      [match({ status: 'finished' }), espnOdds(), NOW],
      [match({ status: 'postponed' }), espnOdds(), NOW],
      [match(), espnOdds(), '2026-10-20T18:30:00.000Z'],
      [match(), espnOdds({ observedAt: at(90) }), NOW],
      [match(), espnOdds({ observedAt: undefined }), NOW],
    ];
    for (const [m, odds, now] of cases) {
      const { d, calls } = deps(m, odds);
      const r = await new EdgeService(d).buildEdgeRows('2026-10-20', 'pro', now);
      expect(calls, `${m.status} ${odds?.observedAt} ${now}`).toEqual([]);
      expect(r.every((x) => x.excluded && x.modelProb === null && x.modelId === null && x.edgePp === null)).toBe(true);
    }
    // friss, kezdés előtti oddsnál pontosan egyszer fut
    const { d, calls } = deps(match(), espnOdds());
    await new EdgeService(d).buildEdgeRows('2026-10-20', 'pro', NOW);
    expect(calls).toEqual([{ variant: 'pro' }]);
  });

  it('kizárt sor soha nem kap edge-et', async () => {
    const all = [
      ...(await rows(match({ status: 'live' }), espnOdds())),
      ...(await rows(match(), espnOdds({ observedAt: undefined }))),
      ...(await rows(match(), espnOdds(), null)),
    ];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((r) => r.excluded && r.edgePp === null)).toBe(true);
  });
});
