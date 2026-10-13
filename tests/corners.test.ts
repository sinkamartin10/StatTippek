/**
 * corners-nb-1 – szögletadat-parser, leíró statisztika, modell, visszateszt,
 * PRO-jogosultság és regresszióvédelem (a gólmodell érintetlen).
 *
 * Hálózat, Supabase, .env NINCS: az ESPN-válaszokat fixture-ök és egy
 * kicserélt `fetch` adja; a DEMO-integráció a valódi AnalysisService-t futtatja.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import {
  candidateMonths, espnDayKey, espnMonthKey, parseScoreboardCorners, readCornerValue, shiftMonth,
} from '../src/server/data/espnCorners';
import { EspnProvider } from '../src/server/data/espnProvider';
import type { HttpCache } from '../src/server/db/database';
import { CornerIndex, cornerCutoff, leagueCornerAverages, lineRates, teamCornerBlock, teamCornerStats, type FinishedRef } from '../src/shared/engine/corners/stats';
import {
  baselineExpectation, convolve, cornerExpectation, cornerLineProbabilities, cornerPrediction, countPmf, DEFAULT_CORNER_PARAMS, dispersion, probOver, shrink,
} from '../src/shared/engine/corners/model';
import { bootstrapDiff, evaluateTargets, releaseGate, rng, selectParams, summarize } from '../src/shared/engine/corners/backtest';
import { cornerMarketCode, cornerMarketLabel, evaluateCornerMarket, isCornerMarket, parseCornerMarket } from '../src/shared/engine/corners/markets';
import { CORNER_RELEASE, cornerTipsEnabled } from '../src/shared/engine/corners/release';
import { evaluateMarket, marketType } from '../src/shared/engine/markets';
import { redactAnalysisForFree } from '../src/shared/engine/plan';
import { CornerService } from '../src/server/corners/service';
import { AnalysisService } from '../src/server/services/analysisService';
import { DemoMatchDataProvider } from '../src/server/data/demoProvider';
import { DemoResearchProvider } from '../src/server/research/demoResearch';
import { apiRouter } from '../src/server/routes/api';
import type { Container } from '../src/server/container';
import type { CornerFetch, CornerRef, MatchDataProvider } from '../src/server/data/provider';
import type { CornerAnalysis, CornerResult, MatchAnalysis } from '../src/shared/types';
import { cornerStatusTitle, lineRateLabel, sampleLabel } from '../src/client/lib/corners';

// ---------------------------------------------------------------------------
// Fixture-ök (valós ESPN-szerkezet szerint)
// ---------------------------------------------------------------------------

type Stat = { name: string; displayValue?: unknown; value?: unknown };
const comp = (homeAway: 'home' | 'away', id: string, corners: unknown, extra: Stat[] = []) => ({
  homeAway, team: { id, displayName: `T${id}` },
  statistics: corners === undefined ? extra : [{ name: 'wonCorners', displayValue: corners }, ...extra],
});
function ev(id: string, date: string, h: unknown, a: unknown, status: { completed: boolean; name: string } = { completed: true, name: 'STATUS_FULL_TIME' }, hid = '1', aid = '2') {
  return { id, date, competitions: [{ status: { type: status }, competitors: [comp('home', hid, h), comp('away', aid, a)] }] };
}

// ---------------------------------------------------------------------------
// 1) Parser
// ---------------------------------------------------------------------------

describe('ESPN szöglet-parser', () => {
  it('érvényes befejezett meccs: mindkét csapat szögletszáma, ESPN-azonosítókkal', () => {
    const p = parseScoreboardCorners({ events: [ev('100', '2025-03-08T15:00Z', '4', '7')] }, 'eng.1', 'eng-pl');
    expect(p.results).toEqual([{ matchId: 'espn-eng.1-100', leagueId: 'eng-pl', date: '2025-03-08T15:00:00.000Z', homeTeamId: 'espn-1', awayTeamId: 'espn-2', homeCorners: 4, awayCorners: 7 }]);
    expect(p.skipped).toEqual([]);
  });

  it('a valódi 0 érvényes; a hiányzó, null, üres, kötőjeles érték SOHA nem nulla', () => {
    expect(readCornerValue(comp('home', '1', '0'))).toBe(0);
    expect(readCornerValue({ statistics: [{ name: 'wonCorners', value: 3 }] })).toBe(3);
    for (const v of [null, '', '  ', '-', '--']) expect(readCornerValue(comp('home', '1', v))).toBe('missing');
    expect(readCornerValue({ statistics: [] })).toBe('missing');
    expect(readCornerValue({})).toBe('missing');
    expect(readCornerValue({ statistics: [{ name: 'wonCorners' }] })).toBe('missing');
  });

  it('negatív, tört és szöveges érték érvénytelen', () => {
    for (const v of ['-1', '1.5', 'abc', '3a']) expect(readCornerValue(comp('home', '1', v))).toBe('invalid');
    expect(readCornerValue({ statistics: [{ name: 'wonCorners', value: -2 }] })).toBe('invalid');
    expect(readCornerValue({ statistics: [{ name: 'wonCorners', value: 2.5 }] })).toBe('invalid');
    const p = parseScoreboardCorners({ events: [ev('1', '2025-03-08T15:00Z', '-1', '4')] }, 'eng.1', 'eng-pl');
    expect(p.results).toEqual([]);
    expect(p.skipped).toEqual([{ matchId: 'espn-eng.1-1', reason: 'invalid_value' }]);
  });

  it('ha csak az egyik csapat értéke van meg, a meccs kimarad (nem lesz 0)', () => {
    const p = parseScoreboardCorners({ events: [ev('1', '2025-03-08T15:00Z', '5', undefined), ev('2', '2025-03-08T15:00Z', null, '3')] }, 'eng.1', 'eng-pl');
    expect(p.results).toEqual([]);
    expect(p.skipped.map((s) => s.reason)).toEqual(['missing_value', 'missing_value']);
  });

  it('élő, félidei és nem befejezett meccs adata soha nem kerül be (a scoreboard élőben is ad szögletet)', () => {
    const p = parseScoreboardCorners({ events: [
      ev('1', '2025-03-08T15:00Z', '4', '2', { completed: false, name: 'STATUS_HALFTIME' }),
      ev('2', '2025-03-08T15:00Z', '6', '3', { completed: false, name: 'STATUS_IN_PROGRESS' }),
      ev('3', '2025-03-08T15:00Z', undefined, undefined, { completed: false, name: 'STATUS_SCHEDULED' }),
    ] }, 'eng.1', 'eng-pl');
    expect(p.results).toEqual([]);
    expect(p.skipped.every((s) => s.reason === 'not_completed')).toBe(true);
  });

  it('hosszabbítás / tizenegyesek: kimarad (a szögletpiac a rendes játékidőre szól)', () => {
    const p = parseScoreboardCorners({ events: [
      ev('1', '2025-03-11T20:00Z', '6', '5', { completed: true, name: 'STATUS_FINAL_PEN' }),
      ev('2', '2025-03-11T20:00Z', '6', '5', { completed: true, name: 'STATUS_FINAL_AET' }),
    ] }, 'uefa.champions', 'uefa-ucl');
    expect(p.results).toEqual([]);
    expect(p.skipped.map((s) => s.reason)).toEqual(['extra_time', 'extra_time']);
  });

  it('üres statisztika-blokk (csupa 0, pl. 0%–0% birtoklás): a „0” helyőrző → hiányzó, nem 0 szöglet', () => {
    const z = (corners: string, shots: string, poss: string): Stat[] => [{ name: 'wonCorners', displayValue: corners }, { name: 'totalShots', displayValue: shots }, { name: 'possessionPct', displayValue: poss }];
    const e = (id: string, h: Stat[], a: Stat[]) => ({ id, date: '2025-03-08T15:00Z', competitions: [{ status: { type: { completed: true, name: 'STATUS_FULL_TIME' } }, competitors: [{ homeAway: 'home', team: { id: '1' }, statistics: h }, { homeAway: 'away', team: { id: '2' }, statistics: a }] }] });
    const p = parseScoreboardCorners({ events: [
      e('1', z('0', '0', '0'), z('0', '0', '0')),     // valós ESPN-minta (Championship): helyőrző
      e('2', z('0', '9', '41'), z('6', '14', '59')),  // valódi 0 szöglet az egyik oldalon
      e('3', z('0', '7', '50'), z('0', '5', '50')),   // valódi 0–0 szöglet (van lövés/birtoklás)
    ] }, 'eng.2', 'eng-ch');
    expect(p.skipped).toEqual([{ matchId: 'espn-eng.2-1', reason: 'empty_stats' }]);
    expect(p.results.map((r) => [r.matchId, r.homeCorners, r.awayCorners])).toEqual([['espn-eng.2-2', 0, 6], ['espn-eng.2-3', 0, 0]]);
  });

  it('duplikált event ID: csak az első marad', () => {
    const p = parseScoreboardCorners({ events: [ev('1', '2025-03-08T15:00Z', '4', '2'), ev('1', '2025-03-08T15:00Z', '9', '9')] }, 'eng.1', 'eng-pl');
    expect(p.results.map((r) => r.homeCorners)).toEqual([4]);
    expect(p.skipped).toEqual([{ matchId: 'espn-eng.1-1', reason: 'duplicate' }]);
  });

  it('hiányos vagy érvénytelen válasz nem dob hibát', () => {
    for (const j of [null, {}, { events: null }, { events: [{}] }, { events: [{ id: '1' }] }]) {
      expect(() => parseScoreboardCorners(j, 'eng.1', 'eng-pl')).not.toThrow();
    }
  });

  it('dátumhatár: az ESPN napja/hónapja amerikai keleti idő szerinti', () => {
    // valós példa: a 2025-03-09T03:30Z kezdésű MLS-meccs a 20250308-as napon szerepel
    expect(espnDayKey('2025-03-09T03:30:00Z')).toBe('20250308');
    expect(espnDayKey('2025-03-09T20:00:00Z')).toBe('20250309');
    expect(espnMonthKey('2025-04-01T01:00:00Z')).toBe('202503');
    expect(candidateMonths('2025-04-01T01:00:00Z')).toEqual(['202503', '202504']);
    expect(candidateMonths('2025-04-15T18:00:00Z')).toEqual(['202504']);
    expect(shiftMonth('202501', -1)).toBe('202412');
    expect(shiftMonth('202412', 1)).toBe('202501');
  });
});

// ---------------------------------------------------------------------------
// 2) Provider: hónap-lekérés, éjfél körüli meccs, hálózati és cache-hiba
// ---------------------------------------------------------------------------

describe('EspnProvider szögletlekérés (kicserélt fetch)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function stubFetch(byMonth: Record<string, unknown>, fail = new Set<string>()) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      const m = url.match(/scoreboard\?dates=(\d{6})$/);
      const key = m?.[1] ?? '';
      if (fail.has(key)) throw new Error('hálózati hiba');
      return new Response(JSON.stringify(byMonth[key] ?? { events: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return calls;
  }

  it('havi lekérés event ID szerint; az éjfél utáni (UTC) meccs a keleti idő szerinti előző hónapban van', async () => {
    const calls = stubFetch({
      '202503': { events: [ev('7', '2025-04-01T01:00Z', '3', '5'), ev('8', '2025-03-15T15:00Z', '2', '2')] },
    });
    const p = new EspnProvider();
    const r = await p.getCornerResults([
      { matchId: 'espn-eng.1-7', leagueId: 'eng-pl', kickoff: '2025-04-01T01:00:00Z' },
      { matchId: 'espn-eng.1-8', leagueId: 'eng-pl', kickoff: '2025-03-15T15:00:00Z' },
    ]);
    expect(r.results.map((x) => x.matchId).sort()).toEqual(['espn-eng.1-7', 'espn-eng.1-8']);
    expect(r.missing).toEqual([]);
    expect(calls.every((u) => u.includes('/eng.1/scoreboard?dates='))).toBe(true);
  });

  it('ha az elsődleges hónapban nincs, a szomszédos hónapban keresi; nem talált → not_found (nem nulla)', async () => {
    stubFetch({ '202504': { events: [ev('7', '2025-04-01T01:00Z', '3', '5')] } });
    const r = await new EspnProvider().getCornerResults([
      { matchId: 'espn-eng.1-7', leagueId: 'eng-pl', kickoff: '2025-04-01T01:00:00Z' },
      { matchId: 'espn-eng.1-9', leagueId: 'eng-pl', kickoff: '2025-04-01T01:00:00Z' },
    ]);
    expect(r.results.map((x) => x.matchId)).toEqual(['espn-eng.1-7']);
    expect(r.missing).toEqual([{ matchId: 'espn-eng.1-9', reason: 'not_found' }]);
  });

  it('hálózati hiba: nincs kivétel, nincs adat, request_failed a hiány oka', async () => {
    stubFetch({}, new Set(['202503']));
    const r = await new EspnProvider().getCornerResults([{ matchId: 'espn-eng.1-8', leagueId: 'eng-pl', kickoff: '2025-03-15T15:00:00Z' }]);
    expect(r.results).toEqual([]);
    expect(r.missing).toEqual([{ matchId: 'espn-eng.1-8', reason: 'request_failed' }]);
    expect(r.failedRequests).toBeGreaterThan(0);
  });

  it('cache-hiba: nincs kivétel, a lekérés sikertelennek számít', async () => {
    stubFetch({ '202503': { events: [ev('8', '2025-03-15T15:00Z', '2', '2')] } });
    const broken: HttpCache = { get: () => { throw new Error('SQLITE_BUSY'); }, set: () => undefined };
    const r = await new EspnProvider(broken).getCornerResults([{ matchId: 'espn-eng.1-8', leagueId: 'eng-pl', kickoff: '2025-03-15T15:00:00Z' }]);
    expect(r.results).toEqual([]);
    expect(r.missing[0].reason).toBe('request_failed');
  });

  it('nem támogatott liga (pl. nem ESPN-azonosító, NB I) → unsupported_league, lekérés nélkül', async () => {
    const calls = stubFetch({});
    const r = await new EspnProvider().getCornerResults([
      { matchId: 'af-hun1-123', leagueId: 'hun-nb1', kickoff: '2025-03-15T15:00:00Z' },
      { matchId: 'espn-eng.1-1', leagueId: 'nincs-ilyen', kickoff: '2025-03-15T15:00:00Z' },
    ]);
    expect(r.missing.map((m) => m.reason)).toEqual(['unsupported_league', 'unsupported_league']);
    expect(calls).toEqual([]);
  });

  it('liga-előzmény: csak a megadott időpont előtti meccsek, hónapokon visszafelé, duplikátum nélkül', async () => {
    stubFetch({
      '202503': { events: [ev('1', '2025-03-01T15:00Z', '5', '4'), ev('2', '2025-03-20T15:00Z', '9', '9')] },
      '202502': { events: [ev('3', '2025-02-10T15:00Z', '6', '3'), ev('1', '2025-03-01T15:00Z', '5', '4')] },
    });
    const r = await new EspnProvider().getLeagueCornerHistory('eng-pl', '2025-03-10T00:00:00.000Z', 100, 2);
    expect(r.results.map((x) => x.matchId).sort()).toEqual(['espn-eng.1-1', 'espn-eng.1-3']);
  });
});

// ---------------------------------------------------------------------------
// 3) Leíró statisztika
// ---------------------------------------------------------------------------

const cr = (id: string, date: string, h: string, a: string, hc: number, ac: number, leagueId = 'L'): CornerResult => ({ matchId: id, leagueId, date, homeTeamId: h, awayTeamId: a, homeCorners: hc, awayCorners: ac });

describe('leíró szögletstatisztikák', () => {
  const data = [
    cr('m1', '2025-01-01T15:00:00Z', 'A', 'B', 6, 2),
    cr('m2', '2025-01-08T15:00:00Z', 'C', 'A', 5, 3),
    cr('m3', '2025-01-15T15:00:00Z', 'A', 'D', 8, 4),
    // m4: A meccse, de nincs szögletadat
    cr('m5', '2025-01-29T15:00:00Z', 'E', 'A', 1, 7),
    cr('m6', '2025-02-05T15:00:00Z', 'A', 'B', 99, 99), // a cutoff UTÁN – nem látszhat
  ];
  const finished: FinishedRef[] = [
    ...data.map((d) => ({ matchId: d.matchId, date: d.date, homeTeamId: d.homeTeamId, awayTeamId: d.awayTeamId })),
    { matchId: 'm4', date: '2025-01-22T15:00:00Z', homeTeamId: 'A', awayTeamId: 'F' },
  ];
  const map = new Map(data.map((d) => [d.matchId, d]));
  const cutoff = cornerCutoff('2025-02-05T15:00:00Z');

  it('átlagok: kiharcolt/kapott/összes; a hiányzó meccs kimarad, de vizsgáltként számít', () => {
    const s = teamCornerStats('A', finished, map, cutoff, 10, 'összes');
    expect(s.considered).toBe(5); // m1,m2,m3,m4,m5
    expect(s.sampleSize).toBe(4); // m4 nélkül
    expect(s.forAvg).toBeCloseTo((6 + 3 + 8 + 7) / 4);
    expect(s.againstAvg).toBeCloseTo((2 + 5 + 4 + 1) / 4);
    expect(s.totalAvg).toBeCloseTo((8 + 8 + 12 + 8) / 4);
  });

  it('hazai és idegenbeli bontás', () => {
    const home = teamCornerStats('A', finished, map, cutoff, 10, 'hazai');
    expect([home.considered, home.sampleSize, home.forAvg]).toEqual([3, 2, 7]); // m1, m3 (+ m4 hiányzó)
    const away = teamCornerStats('A', finished, map, cutoff, 10, 'idegen');
    expect([away.sampleSize, away.forAvg, away.againstAvg]).toEqual([2, 5, 3]);
  });

  it('utolsó 5 és 10: a legfrissebb befejezett meccsek, időrendben helyesen (a jövőbeli nem látszik)', () => {
    const s5 = teamCornerStats('A', finished, map, cutoff, 2, 'összes');
    expect(s5.considered).toBe(2); // m5, m4
    expect(s5.sampleSize).toBe(1);
    expect(s5.forAvg).toBe(7);
    const block = teamCornerBlock('A', 'home', finished, map, cutoff);
    expect(block.last10.forAvg).not.toBe(99);
  });

  it('vonal-teljesülés: hányszor volt TÖBB a vonalnál, az érvényes mintából', () => {
    expect(lineRates([8, 8, 12, 8], [7.5, 8.5, 11.5])).toEqual([
      { line: 7.5, over: 4, sampleSize: 4 }, { line: 8.5, over: 1, sampleSize: 4 }, { line: 11.5, over: 1, sampleSize: 4 },
    ]);
    expect(lineRateLabel({ line: 9.5, over: 6, sampleSize: 10 })).toBe('Over 9,5: 6/10');
    expect(sampleLabel({ sampleSize: 9, considered: 10 })).toBe('9/10 meccs szögletadattal');
  });

  it('index: szigorúan a cutoff előtt, duplikátum és érvénytelen sor nélkül', () => {
    const idx = new CornerIndex([...data, cr('m1', '2025-01-01T15:00:00Z', 'A', 'B', 0, 0), cr('bad', '2025-01-02T15:00:00Z', 'A', 'B', -1, 2)]);
    expect(idx.all.length).toBe(5);
    expect(idx.get('m1')!.homeCorners).toBe(6);
    expect(idx.teamBefore('A', cutoff).map((r) => r.matchId)).toEqual(['m5', 'm3', 'm2', 'm1']);
    expect(idx.teamBefore('A', '2025-01-15T15:00:00.000Z').map((r) => r.matchId)).toEqual(['m2', 'm1']); // a pont-egyező kezdés nem látszik
    const lg = leagueCornerAverages(idx, 'L', cutoff);
    expect(lg.sampleSize).toBe(4);
    expect(lg.homeAvg).toBeCloseTo((6 + 5 + 8 + 1) / 4);
  });
});

// ---------------------------------------------------------------------------
// 4) Modell
// ---------------------------------------------------------------------------

/** Determinisztikus szintetikus liga – CSAK a kód helyességének tesztjéhez (nem validáció). */
function synthLeague(opts: { teams: number; rounds: number; strength?: (t: number) => number; seed?: number; leagueId?: string; start?: string }): CornerResult[] {
  const rand = rng(opts.seed ?? 7);
  const pois = (mu: number) => { let k = 0, p = Math.exp(-mu), s = p; const u = rand(); while (u > s && k < 60) { k++; p *= mu / k; s += p; } return k; };
  const out: CornerResult[] = [];
  const t0 = new Date(opts.start ?? '2024-08-01T15:00:00Z').getTime();
  let n = 0;
  for (let r = 0; r < opts.rounds; r++) {
    for (let i = 0; i < opts.teams; i += 2) {
      const h = (i + r) % opts.teams, a = (i + r + 1 + (r % (opts.teams - 1))) % opts.teams;
      if (h === a) continue;
      const sh = opts.strength?.(h) ?? 1, sa = opts.strength?.(a) ?? 1;
      out.push(cr(`s${n++}`, new Date(t0 + r * 7 * 86400_000 + i * 60_000).toISOString(), `T${h}`, `T${a}`, pois(5.3 * sh / sa), pois(4.4 * sa / sh), opts.leagueId ?? 'L'));
    }
  }
  return out;
}

describe('corners-nb-1 modell', () => {
  it('az eloszlás összege 1, az átlag a várt érték (Poisson és negatív binomiális)', () => {
    for (const r of [Infinity, 3, 12]) {
      const p = countPmf(5.2, r, 40);
      expect(p.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
      expect(p.reduce((s, x, k) => s + x * k, 0)).toBeCloseTo(5.2, 2);
      expect(p.every((x) => x >= 0)).toBe(true);
    }
    const nb = countPmf(5, 4, 40), po = countPmf(5, Infinity, 40);
    const v = (pmf: number[]) => pmf.reduce((s, x, k) => s + x * (k - 5) ** 2, 0);
    expect(v(nb)).toBeGreaterThan(v(po)); // túlszóródás
    const t = convolve(countPmf(5, Infinity, 40), countPmf(4, Infinity, 40), 80);
    expect(t.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
  });

  it('a vonal-valószínűségek 0 és 1 közöttiek és monoton csökkenők', () => {
    const probs = cornerLineProbabilities({ homeExpected: 5.6, awayExpected: 4.3, rHome: 8, rAway: 8 });
    for (const scope of ['total', 'home', 'away'] as const) {
      const xs = probs[scope].map((p) => p.over);
      expect(xs.every((x) => x >= 0 && x <= 1)).toBe(true);
      for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThan(xs[i - 1]);
    }
    expect(probOver([0.5, 0.5], 0.5)).toBeCloseTo(0.5);
  });

  it('zsugorítás: n=0 → liga-átlag, nagy minta → saját átlag; szórás ≤ átlag → Poisson', () => {
    expect(shrink(0, 0, 5, 5)).toBe(5);
    expect(shrink(80, 10, 5, 5)).toBeCloseTo((80 + 25) / 15);
    expect(shrink(8000, 1000, 5, 5)).toBeCloseTo(8, 1);
    expect(dispersion(5, 4)).toBe(Infinity);
    expect(dispersion(5, 5)).toBe(Infinity);
    expect(dispersion(5, 10)).toBeCloseTo(5);
  });

  it('elégtelen adat: nincs becslés, és pontosan megmondja, mi hiányzik', () => {
    const idx = new CornerIndex(synthLeague({ teams: 6, rounds: 2 }));
    const e = cornerExpectation(idx, 'T0', 'T1', 'L', '2030-01-01T00:00:00.000Z', DEFAULT_CORNER_PARAMS, { home: 'Hazai FC', away: 'Vendég SC', league: 'Teszt Liga' });
    expect(e.ok).toBe(false);
    expect(e.missing).toContain('league');
    expect(e.missing).toContain('home_team');
    expect(e.reasons.join(' ')).toMatch(/Teszt Liga: csak \d+ érvényes szögletmeccs/);
    expect(e.reasons.join(' ')).toMatch(/Hazai FC: csak \d+ érvényes korábbi szögletmeccs \(legalább 8 kell\)/);
    expect(baselineExpectation(idx, 'L', '2030-01-01T00:00:00.000Z')).toBeNull();
  });

  it('elegendő adatnál becsül; az erősebb hazai csapatnak több várható szöglete van', () => {
    const idx = new CornerIndex(synthLeague({ teams: 10, rounds: 30, strength: (t) => (t === 0 ? 1.6 : 1) }));
    const cutoff = '2030-01-01T00:00:00.000Z';
    const strong = cornerExpectation(idx, 'T0', 'T5', 'L', cutoff);
    const even = cornerExpectation(idx, 'T3', 'T5', 'L', cutoff);
    expect(strong.ok && even.ok).toBe(true);
    expect(strong.homeExpected).toBeGreaterThan(even.homeExpected);
    const pred = cornerPrediction(strong);
    expect(pred.modelVersion).toBe('corners-nb-1');
    expect(pred.markets.map((m) => m.market)).toContain('CRN_O9.5');
    expect(pred.markets.every((m) => Math.abs(m.over + m.under - 1) < 1e-12)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5) Visszateszt: szivárgás elleni védelem, baseline, kapu
// ---------------------------------------------------------------------------

describe('időrendi visszateszt', () => {
  it('ADATSZIVÁRGÁS ELLEN: a célmeccs utáni (jövőbeli) eredmények nem változtatják a becslést', () => {
    const data = synthLeague({ teams: 10, rounds: 20 });
    const targets = data.slice(-10);
    const a = evaluateTargets(new CornerIndex(data), targets, DEFAULT_CORNER_PARAMS);
    const future = Array.from({ length: 30 }, (_, i) => cr(`f${i}`, '2031-01-01T15:00:00Z', 'T0', 'T1', 40, 0));
    const b = evaluateTargets(new CornerIndex([...data, ...future]), targets, DEFAULT_CORNER_PARAMS);
    expect(b.records).toEqual(a.records);
    // a célmeccs saját eredménye sem számít az előzményébe
    const self = evaluateTargets(new CornerIndex(data.map((r) => (r === targets[0] ? { ...r, homeCorners: 40 } : r))), [targets[0]], DEFAULT_CORNER_PARAMS);
    const orig = evaluateTargets(new CornerIndex(data), [targets[0]], DEFAULT_CORNER_PARAMS);
    expect(self.records.map((r) => r.pModel)).toEqual(orig.records.map((r) => r.pModel));
  });

  it('valódi csapat-különbségeknél a modell jobb a liga-átlag baseline-nál; erős egyezésnél nincs hamis „javulás”', () => {
    const strong = synthLeague({ teams: 12, rounds: 60, strength: (t) => 0.7 + (t % 6) * 0.12, seed: 11 });
    const run = evaluateTargets(new CornerIndex(strong), strong.slice(-150), { ...DEFAULT_CORNER_PARAMS, distribution: 'poisson' });
    const s = summarize(run.records);
    expect(run.eligible).toBeGreaterThan(100);
    expect(s.logLossModel).toBeLessThan(s.logLossBase);
    const ci = bootstrapDiff(run.records, 'logLoss', 300);
    expect(ci.hi).toBeLessThan(0);
  });

  it('paraméterválasztás csak a hangolási célmeccseken, a kisebb log loss nyer', () => {
    const data = synthLeague({ teams: 10, rounds: 40, strength: (t) => 0.8 + (t % 5) * 0.1, seed: 3 });
    const grid = [{ ...DEFAULT_CORNER_PARAMS, k: 0 }, { ...DEFAULT_CORNER_PARAMS, k: 5 }, { ...DEFAULT_CORNER_PARAMS, k: 200 }];
    const t = selectParams(new CornerIndex(data), data.slice(-60), grid);
    const minLL = Math.min(...t.table.map((x) => x.logLoss));
    expect(t.table.find((x) => x.params === t.best)!.logLoss).toBe(minLL);
  });

  it('kiadási kapu: kis minta, nem meggyőző különbség vagy romló piaccsoport → nem validált', () => {
    const good = { mean: -0.01, lo: -0.015, hi: -0.005 };
    const ok = { eligibleMatches: 1000, logLoss: good, brier: good, byScope: { total: good, home: good, away: good } };
    expect(releaseGate(ok).passed).toBe(true);
    expect(releaseGate({ ...ok, eligibleMatches: 50 }).passed).toBe(false);
    expect(releaseGate({ ...ok, logLoss: { mean: -0.001, lo: -0.004, hi: 0.002 } }).passed).toBe(false);
    expect(releaseGate({ ...ok, brier: { mean: 0.0001, lo: -0.001, hi: 0.001 } }).passed).toBe(false);
    expect(releaseGate({ ...ok, byScope: { ...ok.byScope, away: { mean: 0.01, lo: 0.005, hi: 0.015 } } }).passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6) Piackódok: nincs ütközés a gólpiacokkal
// ---------------------------------------------------------------------------

describe('CRN_ piackódok', () => {
  it('a szögletkódok nem illeszkednek a gólpiaci mintákra, a gólpiaci elszámolás elutasítja őket', () => {
    for (const m of ['CRN_O9.5', 'CRN_U10.5', 'CRN_HOME_O4.5', 'CRN_AWAY_O3.5']) {
      expect(isCornerMarket(m)).toBe(true);
      expect(/^[OU]\d\.5$/.test(m)).toBe(false);
      expect(/^(HOME|AWAY)_O\d\.5$/.test(m)).toBe(false);
      expect(marketType(m)).toBe('egyéb');
      expect(() => evaluateMarket(m, 3, 1)).toThrow(/Ismeretlen piac/); // az archívum ezt „nem elszámolható”-nak veszi
    }
  });

  it('szögletelszámolás csak hiteles szögletszámból; gólpiaci kódot soha nem számol el', () => {
    expect(evaluateCornerMarket('CRN_O9.5', 6, 4)).toBe('win');
    expect(evaluateCornerMarket('CRN_O9.5', 5, 4)).toBe('loss');
    expect(evaluateCornerMarket('CRN_U9.5', 5, 4)).toBe('win');
    expect(evaluateCornerMarket('CRN_HOME_O4.5', 5, 0)).toBe('win');
    expect(evaluateCornerMarket('CRN_AWAY_O4.5', 5, 0)).toBe('loss');
    expect(evaluateCornerMarket('CRN_O9.5', null, 4)).toBeNull(); // nincs hiteles végeredmény → függőben
    expect(evaluateCornerMarket('CRN_O9.5', -1, 4)).toBeNull();
    expect(evaluateCornerMarket('O2.5', 6, 4)).toBeNull();
    expect(cornerMarketCode('home', 'O', 4.5)).toBe('CRN_HOME_O4.5');
    expect(parseCornerMarket('CRN_O12.5')).toEqual({ scope: 'total', side: 'O', line: 12.5 });
    expect(cornerMarketLabel('CRN_O9.5')).toBe('Összes szöglet: több mint 9,5');
  });

  it('szöglettipp csak validált modellnél ÉS kifejezett kapcsolóval engedélyezhető', () => {
    expect(CORNER_RELEASE.modelVersion).toBe('corners-nb-1');
    expect(cornerTipsEnabled({ ...CORNER_RELEASE, validated: false }, { CORNER_TIPS_ENABLED: '1' })).toBe(false);
    expect(cornerTipsEnabled({ ...CORNER_RELEASE, validated: true }, {})).toBe(false);
    expect(cornerTipsEnabled({ ...CORNER_RELEASE, validated: true, validatedScopes: [] }, { CORNER_TIPS_ENABLED: '1' })).toBe(false);
    expect(cornerTipsEnabled({ ...CORNER_RELEASE, validated: true }, { CORNER_TIPS_ENABLED: '1' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7) Integráció: gólmodell változatlan, PRO-jogosultság, hiba-tűrés
// ---------------------------------------------------------------------------

function container(data: MatchDataProvider, demo: DemoMatchDataProvider): Container {
  return {
    data, research: new DemoResearchProvider(demo), oddsApi: null,
    db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined },
  } as unknown as Container;
}

/** DEMO provider + determinisztikus TESZT-szögletadat (csak a bekötés tesztjéhez). */
function withCorners(demo: DemoMatchDataProvider, mode: 'ok' | 'throw' = 'ok'): MatchDataProvider {
  const fake = (id: string, leagueId: string, date: string, h: string, a: string): CornerResult => {
    let x = 0; for (const ch of id) x = (x * 31 + ch.charCodeAt(0)) % 997;
    return cr(id, date, h, a, 3 + (x % 6), 2 + (x % 5), leagueId);
  };
  const p = Object.create(demo) as MatchDataProvider;
  p.getCornerResults = async (refs: CornerRef[]): Promise<CornerFetch> => {
    if (mode === 'throw') throw new Error('ESPN nem elérhető');
    const all = await demo.getLeagueResults((await demo.getLeagues())[0].id);
    const res = await Promise.all(refs.map(async (r) => {
      const m = all.find((x) => x.id === r.matchId) ?? (await demo.getTeamResults('x')).find((x) => x.id === r.matchId);
      return m ? fake(m.id, m.leagueId, m.date, m.homeTeamId, m.awayTeamId) : null;
    }));
    return { results: res.filter((x): x is CornerResult => !!x), missing: [], failedRequests: 0 };
  };
  p.getLeagueCornerHistory = async (leagueId: string, before: string): Promise<CornerFetch> => {
    if (mode === 'throw') throw new Error('ESPN nem elérhető');
    const all = await demo.getLeagueResults(leagueId);
    return { results: all.filter((m) => m.date < before).map((m) => fake(m.id, m.leagueId, m.date, m.homeTeamId, m.awayTeamId)), missing: [], failedRequests: 0 };
  };
  return p;
}

/** Az elemzés az időbélyegek nélkül (a DEMO kutatómotor minden híváskor új időpontokat ad) – minden más bájtra összevetve. */
const TIME_KEYS = new Set(['generatedAt', 'publishedAt', 'retrievedAt', 'performedAt', 'fetchedAt']);
const strip = (a: MatchAnalysis | null) => (a ? JSON.parse(JSON.stringify(a, (k, v) => (TIME_KEYS.has(k) ? 'x' : v))) : a);

describe('regresszióvédelem és PRO-jogosultság', () => {
  it('a gólmodell kimenete és a tippek AZONOSAK szögletadattal és anélkül; a szögletelemzés nem módosítja őket', async () => {
    const demo = new DemoMatchDataProvider();
    const match = (await demo.getMatches({ status: 'scheduled' }))[0];
    const plain = new AnalysisService(container(demo, demo));
    const corneredProvider = withCorners(demo);
    const withC = new AnalysisService(container(corneredProvider, demo));
    const a1 = await plain.analyze(match.id);
    const a2 = await withC.analyze(match.id);
    const cs = new CornerService(corneredProvider);
    const c = await cs.analyze(match.id);
    expect(c).not.toBeNull();
    const a3 = await withC.analyze(match.id);
    expect(strip(a2)).toEqual(strip(a1));
    expect(strip(a3)).toEqual(strip(a1));
    expect(a1!.tips).toEqual(a2!.tips);
    expect(a1!.poisson).toEqual(a2!.poisson);
    expect('corners' in a1!).toBe(false); // az elemzőmotor nem tölti ki
  });

  it('nem validált modell: van leíró statisztika, de modell-valószínűség és szöglettipp NINCS', async () => {
    const demo = new DemoMatchDataProvider();
    const match = (await demo.getMatches({ status: 'scheduled' }))[0];
    const c = await new CornerService(withCorners(demo), { release: { ...CORNER_RELEASE, validated: false } }).analyze(match.id);
    expect(c!.validation.validated).toBe(false);
    expect(c!.prediction).toBeNull();
    expect(c!.home!.last10.sampleSize).toBeGreaterThan(0);
    expect(c!.oddsAvailable).toBe(false);
  });

  it('validált kiadásnál elegendő adattal ad modell-valószínűséget (monoton vonalakkal)', async () => {
    const demo = new DemoMatchDataProvider();
    const match = (await demo.getMatches({ status: 'scheduled' }))[0];
    const c = await new CornerService(withCorners(demo), { release: { ...CORNER_RELEASE, validated: true, validatedScopes: ['total', 'home', 'away'], params: { ...DEFAULT_CORNER_PARAMS, minLeagueMatches: 10, minTeamMatches: 3, minVenueMatches: 1 } } }).analyze(match.id);
    expect(c!.status).toBe('ok');
    const total = c!.prediction!.markets.filter((m) => m.scope === 'total').map((m) => m.over);
    expect(total.length).toBe(6);
    for (let i = 1; i < total.length; i++) expect(total[i]).toBeLessThan(total[i - 1]);
  });

  it('csak a validált piaccsoportok valószínűsége kerül ki (a kiadott állapot: hazai/vendég, összes NEM)', async () => {
    expect(CORNER_RELEASE.validatedScopes).toEqual(['home', 'away']);
    const demo = new DemoMatchDataProvider();
    const match = (await demo.getMatches({ status: 'scheduled' }))[0];
    const c = await new CornerService(withCorners(demo), { release: { ...CORNER_RELEASE, params: { ...CORNER_RELEASE.params, minLeagueMatches: 10, minTeamMatches: 3, minVenueMatches: 1 } } }).analyze(match.id);
    expect(c!.prediction!.markets.length).toBeGreaterThan(0);
    expect(c!.prediction!.markets.every((m) => m.scope !== 'total')).toBe(true);
    expect(c!.validation.scopes).toEqual(['home', 'away']);
    expect(c!.prediction!.totalExpected).toBeNull(); // a nem validált összes-szöglet becslés várható értékként sem kerül ki
  });

  it('KISZOLGÁLÁS = VALIDÁLÁS: az éles szolgáltatás ugyanazt a várható értéket adja, mint a visszateszt kódútja a teljes előzményen', async () => {
    const teams = 20, data: CornerResult[] = [];
    let n = 0; const t0 = Date.UTC(2024, 7, 1);
    for (let r = 0; r < 60; r++) for (let i = 0; i < teams; i += 2) {
      const h = (i + r) % teams, a = (i + r * 3 + 1) % teams; if (h === a) continue;
      data.push(cr(`m${n++}`, new Date(t0 + r * 4 * 86400_000 + i * 60_000).toISOString(), `T${h}`, `T${a}`, 2 + ((h * 7 + r) % 7), 1 + ((a * 5 + r) % 6)));
    }
    const match = { id: 'target', leagueId: 'L', homeTeamId: 'T0', awayTeamId: 'T1', kickoff: '2025-08-01T15:00:00.000Z', status: 'scheduled', origin: 'live', importance: 'normal', importanceReasons: [] };
    const results = data.map((d) => ({ id: d.matchId, leagueId: 'L', date: d.date, homeTeamId: d.homeTeamId, awayTeamId: d.awayTeamId, homeGoals: 1, awayGoals: 1, origin: 'live' }));
    const leagueCalls: number[] = [];
    const provider = {
      name: 'stub', origin: 'live',
      getMatch: async () => match, getLeagues: async () => [{ id: 'L', name: 'L' }], getTeam: async (id: string) => ({ id, name: id }),
      getResultsForAnalysis: async () => results,
      getCornerResults: async (refs: CornerRef[]): Promise<CornerFetch> => ({ results: data.filter((d) => refs.some((r) => r.matchId === d.matchId)), missing: [], failedRequests: 0 }),
      getLeagueCornerHistory: async (_l: string, before: string, min: number): Promise<CornerFetch> => {
        leagueCalls.push(min);
        return { results: data.filter((d) => d.date < before).sort((a, b) => b.date.localeCompare(a.date)).slice(0, min), missing: [], failedRequests: 0 };
      },
    } as unknown as MatchDataProvider;
    const svc = await new CornerService(provider, { now: () => new Date('2025-07-31T12:00:00.000Z') }).analyze('target');
    const full = cornerExpectation(new CornerIndex(data), 'T0', 'T1', 'L', cornerCutoff(match.kickoff), CORNER_RELEASE.params);
    expect(full.ok).toBe(true);
    expect(leagueCalls).toEqual([CORNER_RELEASE.params.leagueWindow]);
    expect(svc!.prediction!.homeExpected).toBeCloseTo(full.homeExpected, 12);
    expect(svc!.prediction!.awayExpected).toBeCloseTo(full.awayExpected, 12);
  });

  it('szögletforrás hibája / hiánya: „nem elérhető” / „nem támogatott”, a gólelemzés közben működik', async () => {
    const demo = new DemoMatchDataProvider();
    const match = (await demo.getMatches({ status: 'scheduled' }))[0];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = withCorners(demo, 'throw');
    const c = await new CornerService(broken).analyze(match.id);
    expect(c!.status).toBe('unavailable');
    expect(cornerStatusTitle(c!)).toBe('A szögletadat most nem érhető el');
    const a = await new AnalysisService(container(broken, demo)).analyze(match.id);
    expect(a && a.tips.length).toBeGreaterThan(0);
    const none = await new CornerService(demo).analyze(match.id); // a DEMO provider nem ad szögletet
    expect(none!.status).toBe('unsupported');
    vi.restoreAllMocks();
  });

  it('FREE redakció: a corners mező a FREE válaszban egyáltalán nem szerepel', () => {
    const a = { form: { homeLast5: { matches: [] }, homeLast10: { matches: [] }, awayLast5: { matches: [] }, awayLast10: { matches: [] }, homeAtHome: { matches: [] }, awayAtAway: { matches: [] }, interpretation: [] }, h2h: { matches: [] }, xg: null, poisson: null, tips: [], corners: { status: 'ok' } as unknown as CornerAnalysis } as unknown as MatchAnalysis;
    const red = redactAnalysisForFree(a);
    expect('corners' in red).toBe(false);
    expect(JSON.stringify(red)).not.toContain('corners');
  });

  describe('szerveroldali PRO-kapu a /api/matches/:id/corners végponton', () => {
    let server: Server | null = null;
    afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

    async function app(plan: unknown) {
      const demo = new DemoMatchDataProvider();
      const data = withCorners(demo);
      const svc = new AnalysisService(container(data, demo));
      const a = express();
      a.use(express.json());
      a.use((_req, res, next) => { res.locals.plan = plan; next(); });
      a.use('/api', apiRouter(container(data, demo), svc, new CornerService(data)));
      server = await new Promise<Server>((r) => { const s = a.listen(0, () => r(s)); });
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const match = (await demo.getMatches({ status: 'scheduled' }))[0];
      return async (path = `/api/matches/${match.id}/corners`) => {
        const res = await fetch(url + path);
        return { status: res.status, body: await res.json() };
      };
    }

    it('FREE (bejelentkezve): 403 PRO_REQUIRED, szögletadat nélkül', async () => {
      const get = await app({ enforced: true, user: { id: 'u1' }, pro: false, admin: false });
      const r = await get();
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('PRO_REQUIRED');
      expect(JSON.stringify(r.body)).not.toMatch(/forAvg|prediction|home/);
    });

    it('kijelentkezve: 401 AUTH_REQUIRED', async () => {
      const get = await app({ enforced: true, user: null, pro: false, admin: false });
      expect((await get()).status).toBe(401);
    });

    it('PRO: megkapja a szögletelemzést; érvénytelen azonosító 400', async () => {
      const get = await app({ enforced: true, user: { id: 'u1' }, pro: true, admin: false });
      const r = await get();
      expect(r.status).toBe(200);
      expect(r.body.modelVersion).toBe('corners-nb-1');
      expect(r.body.home.last10.sampleSize).toBeGreaterThan(0);
      expect((await get('/api/matches/%3Bdrop/corners')).status).toBe(400);
    });

    it('FREE elemzés-válasz (kvótán belül) sem tartalmaz szögletadatot', async () => {
      const demo = new DemoMatchDataProvider();
      const day = await demo.getMatches({ status: 'scheduled' });
      const get = await app({ enforced: true, user: { id: 'u1' }, pro: false, admin: false });
      for (const m of day.slice(0, 5)) {
        const r = await get(`/api/matches/${m.id}/analysis`);
        if (r.status === 200) expect(r.body).not.toHaveProperty('corners');
      }
    });
  });
});
