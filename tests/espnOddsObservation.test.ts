/**
 * ESPN-odds megfigyelési ideje és az eltűnt vonal kezelése (Edge Radar 1. fázis) + regresszió.
 * Hálózat nélkül: a fetch és a cache helyettesítve, a válaszok az ESPN scoreboard szerkezetét követik.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EspnProvider } from '../src/server/data/espnProvider';
import type { HttpCache } from '../src/server/db/database';
import { checkFreshness, devig1x2, devigTwoWay, quoteFrom } from '../src/shared/engine/edge';
import { AnalysisService } from '../src/server/services/analysisService';
import type { Container } from '../src/server/container';
import type { League, Match, Team } from '../src/shared/types';
import { computeValue } from '../src/shared/engine/evaluation';
import { poissonModel } from '../src/shared/engine/models';
import type { MatchOdds } from '../src/shared/types';

type Json = Record<string, unknown>;
const DATE = '2026-10-20';
const ev = (id: string, opts: { odds?: boolean; state?: 'pre' | 'in' | 'post'; provider?: string | null } = {}): Json => ({
  id, date: `${DATE}T12:00:00Z`,
  status: { type: { state: opts.state ?? 'pre', completed: opts.state === 'post', name: opts.state === 'in' ? 'STATUS_FIRST_HALF' : opts.state === 'post' ? 'STATUS_FULL_TIME' : 'STATUS_SCHEDULED' } },
  competitions: [{
    competitors: [
      { homeAway: 'home', team: { id: `1${id}`, displayName: `Hazai ${id}` }, score: opts.state && opts.state !== 'pre' ? '1' : undefined },
      { homeAway: 'away', team: { id: `2${id}`, displayName: `Vendég ${id}` }, score: opts.state && opts.state !== 'pre' ? '0' : undefined },
    ],
    odds: opts.odds === false ? undefined : [{
      ...(opts.provider === null ? {} : { provider: { name: opts.provider ?? 'DraftKings' } }),
      moneyline: { home: { open: { odds: '-105' }, close: { odds: '+110' } }, draw: { close: { odds: '+250' } }, away: { close: { odds: '+240' } } },
      total: { over: { close: { odds: '-110', line: 'o2.5' } }, under: { close: { odds: '-110', line: 'u2.5' } } }, // a valós ESPN-válasz szerkezete (az under is közli a vonalát)
    }],
  }],
});
const board = (events: Json[]) => ({ leagues: [{ season: { startDate: '2026-08-01T00:00Z' } }], events });

/** a fetch válaszai hívásonként (Json = 200, szám = HTTP-hiba, 'throw' = hálózati hiba) */
function stubFetch(...responses: (Json | number | 'throw')[]) {
  const fn = vi.fn(async () => {
    const r = responses.length > 1 ? responses.shift()! : responses[0];
    if (r === 'throw') throw new Error('ECONNRESET');
    if (typeof r === 'number') return new Response('{}', { status: r });
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const refetch = (p: EspnProvider) => (p as unknown as { mem: Map<string, unknown> }).mem.clear(); // a 5 perces memória-cache lejárata
const matchId = (id: string) => `espn-eng.1-${id}`;
const load = (p: EspnProvider) => p.getMatches({ date: DATE, leagueId: 'eng-pl' });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Odds megfigyelési ideje (observedAt)', () => {
  it('hálózati lekérés: a válasz megérkezésének ideje; egyirodás megfigyelés, tervezett állapotban; a retrievedAt jelentése változatlan', async () => {
    stubFetch(board([ev('1')]));
    const p = new EspnProvider();
    const t0 = Date.now();
    await load(p);
    const o = (await p.getOdds(matchId('1')))!;
    expect(Date.parse(o.observedAt!)).toBeGreaterThanOrEqual(t0);
    expect(Date.parse(o.observedAt!)).toBeLessThanOrEqual(Date.now());
    expect(o.observation).toEqual({ via: 'espn-scoreboard', singleBook: true, matchStatus: 'scheduled', priceKind: { '1': 'close', X: 'close', '2': 'close', 'O2.5': 'close', 'U2.5': 'close' } });
    expect(o.markets).toEqual({ '1': 2.1, X: 3.5, '2': 3.4, 'O2.5': 1.91, 'U2.5': 1.91 });
    expect(o.retrievedAt).toBeDefined();
  });

  it('cache-találat: a cache-bejegyzés EREDETI lekérési ideje, nem a feldolgozásé; nincs hálózati hívás', async () => {
    const fetchFn = stubFetch(500);
    const fetchedAt = Date.now() - 4 * 60_000;
    const cache: HttpCache = { get: () => { throw new Error('a getEntry-t kell használni'); }, set: () => undefined, getEntry: () => ({ body: JSON.stringify(board([ev('1')])), fetchedAt }) };
    const p = new EspnProvider(cache);
    await load(p);
    const o = (await p.getOdds(matchId('1')))!;
    expect(o.observedAt).toBe(new Date(fetchedAt).toISOString());
    expect(Date.parse(o.retrievedAt)).toBeGreaterThan(fetchedAt + 3 * 60_000); // a feldolgozás ideje ≠ megfigyelés
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('régi (getEntry nélküli) cache: az odds megmarad, de megfigyelési idő NINCS (nem igazolható) → az Edge frissesség-ellenőrzés kizárja', async () => {
    stubFetch(500);
    const cache: HttpCache = { get: () => JSON.stringify(board([ev('1')])), set: () => undefined };
    const p = new EspnProvider(cache);
    const [m] = await load(p);
    const o = (await p.getOdds(matchId('1')))!;
    expect(o.markets['1']).toBe(2.1);
    expect(o.observedAt).toBeUndefined();
    expect(checkFreshness({ observedAt: o.observedAt, observedStatus: o.observation?.matchStatus, matchStatus: m.status, kickoff: m.kickoff, now: new Date(Date.parse(m.kickoff) - 3600_000) }))
      .toEqual({ ok: false, reason: 'unknown_observation' });
  });

  it('provider nélküli ESPN-odds: nem igazolhatóan egyirodás (singleBook = false)', async () => {
    stubFetch(board([ev('1', { provider: null })]));
    const p = new EspnProvider();
    await load(p);
    expect((await p.getOdds(matchId('1')))!.observation?.singleBook).toBe(false);
  });
});

describe('Eltűnt vonal, sikertelen és részleges frissítés', () => {
  it('a friss, sikeres válaszban az eseménynél nincs odds → a régi odds törlődik', async () => {
    stubFetch(board([ev('1'), ev('2')]), board([ev('1', { odds: false }), ev('2')]));
    const p = new EspnProvider();
    await load(p);
    expect(await p.getOdds(matchId('1'))).not.toBeNull();
    refetch(p);
    await load(p);
    expect(await p.getOdds(matchId('1'))).toBeNull();
    expect(await p.getOdds(matchId('2'))).not.toBeNull(); // a másik esemény érintetlen
  });

  it('sikertelen frissítés (HTTP-hiba, hálózati hiba) → semmi nem törlődik, a megfigyelési idő a régi marad', async () => {
    for (const failure of [503, 'throw'] as const) {
      stubFetch(board([ev('1')]), failure);
      const p = new EspnProvider();
      await load(p);
      const before = (await p.getOdds(matchId('1')))!;
      refetch(p);
      await load(p);
      const after = await p.getOdds(matchId('1'));
      expect(after, String(failure)).toEqual(before);
      vi.unstubAllGlobals();
    }
  });

  it('részleges válasz: az esemény hiányzik a listából, vagy a válasz szerkezete hibás → az odds megmarad', async () => {
    for (const partial of [board([ev('2')]), { leagues: [] }, { events: 'nem lista' }]) {
      stubFetch(board([ev('1')]), partial as Json);
      const p = new EspnProvider();
      await load(p);
      refetch(p);
      await load(p);
      expect(await p.getOdds(matchId('1')), JSON.stringify(partial)).not.toBeNull();
      vi.unstubAllGlobals();
    }
  });

  it('a summary-válasz (nem mérvadó az oddsra) nem törli a meglévő oddsot', async () => {
    stubFetch(board([ev('1')]));
    const p = new EspnProvider();
    await load(p);
    (p as unknown as { matches: Map<string, unknown> }).matches.delete(matchId('1'));
    refetch(p);
    stubFetch({ header: { competitions: [{ ...(ev('1').competitions as Json[])[0], odds: undefined, date: `${DATE}T12:00:00Z`, status: ev('1').status }] } });
    expect(await p.getMatch(matchId('1'))).not.toBeNull();
    expect(await p.getOdds(matchId('1'))).not.toBeNull();
  });

  it('élő és befejezett meccs: az odds állapota rögzül (live/finished) → nem kerülhet pre-match Edge-adatba', async () => {
    for (const state of ['in', 'post'] as const) {
      stubFetch(board([ev('1', { state })]));
      const p = new EspnProvider();
      const [m] = await load(p);
      const o = (await p.getOdds(matchId('1')))!;
      expect(o.observation?.matchStatus).toBe(state === 'in' ? 'live' : 'finished');
      const r = checkFreshness({ observedAt: o.observedAt, observedStatus: o.observation?.matchStatus, matchStatus: m.status, kickoff: m.kickoff, now: new Date(Date.parse(m.kickoff) - 60_000) });
      expect(r).toEqual({ ok: false, reason: 'not_prematch' });
      vi.unstubAllGlobals();
    }
  });
});

describe('Vonal-eredet: a de-vig csak egyazon megfigyelés aktuális vonalán fut', () => {
  const custom = (ml: Json, total: Json): Json => {
    const e = ev('1'); (e.competitions as Json[])[0].odds = [{ provider: { name: 'DraftKings' }, moneyline: ml, total }]; return e;
  };
  const ml3 = { home: { close: { odds: '+110' } }, draw: { close: { odds: '+250' } }, away: { close: { odds: '+240' } } };
  const tot = { over: { close: { odds: '-110', line: 'o2.5' } }, under: { close: { odds: '-110', line: 'u2.5' } } };
  const sets = async (e: Json) => {
    stubFetch(board([e]));
    const p = new EspnProvider();
    await load(p);
    const o = (await p.getOdds(matchId('1')))!;
    const q = (m: string) => quoteFrom(o, m);
    return { o, x12: devig1x2({ home: q('1'), draw: q('X'), away: q('2') }), ou: devigTwoWay({ over: q('O2.5') && { ...q('O2.5')!, line: 2.5 }, under: q('U2.5') && { ...q('U2.5')!, line: 2.5 } }) };
  };

  it('minden ár close, azonos totals-vonal → 1X2 és O/U is árrésmentesíthető; a piacok értéke változatlan', async () => {
    const r = await sets(custom(ml3, tot));
    expect(r.x12.ok).toBe(true);
    expect(r.ou.ok).toBe(true);
    expect(r.o.markets).toEqual({ '1': 2.1, X: 3.5, '2': 3.4, 'O2.5': 1.91, 'U2.5': 1.91 });
  });

  it('egy kimenetel csak nyitó (open) árral → az odds megmarad (a meglévő működés változatlan), de a de-vig unavailable', async () => {
    const r = await sets(custom({ ...ml3, draw: { open: { odds: '+260' } } }, tot));
    expect(r.o.markets.X).toBe(3.6);
    expect(r.o.observation?.priceKind?.X).toBe('open');
    expect(r.x12).toEqual({ ok: false, reason: 'unknown_bookmaker' });
  });

  it('az under vonala hiányzik vagy eltér az overétől → az U-piac igazolatlan, az O/U de-vig unavailable', async () => {
    for (const under of [{ close: { odds: '-110' } }, { close: { odds: '-110', line: 'u3.5' } }]) {
      const r = await sets(custom(ml3, { over: tot.over, under }));
      expect(r.o.observation?.priceKind?.['U2.5']).toBe('unverified');
      expect(r.ou.ok).toBe(false);
      expect(r.x12.ok).toBe(true);
      vi.unstubAllGlobals();
    }
  });
});

describe('Kézi és összefésült odds nem kap igazolt, egyirodás státuszt (valódi resolveOdds-útvonal)', () => {
  const match: Match = { id: 'espn-eng.1-1', leagueId: 'eng-pl', homeTeamId: 'espn-11', awayTeamId: 'espn-21', kickoff: '2026-10-20T12:00:00.000Z', status: 'scheduled', importance: 'normal', importanceReasons: [], origin: 'live' };
  const espnOdds: MatchOdds = { matchId: match.id, source: 'live', bookmaker: 'DraftKings (ESPN)', retrievedAt: '2026-10-20T09:00:00.000Z', observedAt: '2026-10-20T08:59:00.000Z',
    markets: { '1': 2.1, X: 3.5, '2': 3.4 }, observation: { via: 'espn-scoreboard', singleBook: true, matchStatus: 'scheduled', priceKind: { '1': 'close', X: 'close', '2': 'close' } } };
  const apiOdds: MatchOdds = { matchId: match.id, source: 'live', bookmaker: 'legjobb odds 1 irodából (The Odds API)', retrievedAt: '2026-10-20T09:00:00.000Z', observedAt: '2026-10-20T08:58:00.000Z',
    markets: { '1': 2.2, X: 3.4, '2': 3.3 }, bookmakers: { '1': 'Pinnacle', X: 'Pinnacle', '2': 'Pinnacle' }, observation: { via: 'the-odds-api', singleBook: true } };
  const team = (id: string): Team => ({ id, name: id, shortName: id, country: 'Anglia', leagueId: 'eng-pl' });
  const svc = (manual: MatchOdds | null, oddsApi: boolean) => new AnalysisService({
    data: { getOdds: async () => espnOdds, getLeagues: async (): Promise<League[]> => [{ id: 'eng-pl', name: 'Premier League', country: 'Anglia' } as League], getTeam: async (id: string) => team(id) },
    oddsApi: oddsApi ? { getOdds: async () => apiOdds } : null,
    db: { getManualOdds: async () => manual },
  } as unknown as Container);
  const verified = (o: MatchOdds | null) => devig1x2({ home: quoteFrom(o, '1'), draw: quoteFrom(o, 'X'), away: quoteFrom(o, '2') }).ok;

  it('csak ESPN: az eredeti, igazolt objektum; összefésülve (ESPN + The Odds API): eredet nélküli → nem árrésmentesíthető', async () => {
    expect(verified(await svc(null, false).resolveOdds(match))).toBe(true);
    const merged = (await svc(null, true).resolveOdds(match))!;
    expect(merged.observation).toBeUndefined();
    expect(merged.observedAt).toBeUndefined();
    expect(verified(merged)).toBe(false);
  });

  it('kézi odds: soha nem igazolt (még akkor sem, ha a tárolt adat eredet-mezőt hordozna)', async () => {
    const manual: MatchOdds = { matchId: match.id, source: 'manual', bookmaker: 'kézi bevitel', retrievedAt: '2026-10-20T09:00:00.000Z', markets: { '1': 2.0, X: 3.6, '2': 3.5 } };
    expect(verified(await svc(manual, false).resolveOdds(match))).toBe(false);
  });
});

describe('Regresszió: az új mezők nem változtatnak a meglévő számításon', () => {
  it('computeValue ugyanazt adja a megfigyelési mezőkkel és nélkülük (nyers 1/odds, változatlan különbség)', () => {
    const poisson = poissonModel(1.45, 1.1);
    const plain: MatchOdds = { matchId: 'm', source: 'live', bookmaker: 'DraftKings (ESPN)', retrievedAt: '2026-10-20T10:00:00.000Z', markets: { '1': 2.1, X: 3.5, '2': 3.4, 'O2.5': 1.91, 'U2.5': 1.91 } };
    const observed: MatchOdds = { ...plain, observedAt: '2026-10-20T09:58:00.000Z', observation: { via: 'espn-scoreboard', singleBook: true, matchStatus: 'scheduled' } };
    const a = computeValue(poisson, plain), b = computeValue(poisson, observed);
    expect(b).toEqual(a);
    expect(a.find((r) => r.market === '1')!.impliedProb).toBe(1 / 2.1);
  });
});
