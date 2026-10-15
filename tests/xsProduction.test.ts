/**
 * xs-strength-1 – éles üzem előtti ellenőrzések (a 0021 tartós tár nélkül / vele, vészkapcsoló,
 * admin-végpont, visszaesések megfigyelhetősége, a havi ESPN-válaszok memóriaigénye).
 *
 * A tartós tár itt a SqliteXsStore (a PostgresXsStore-ral azonos szerződés); ugyanezt a valódi
 * PostgreSQL 17-en a tests/xsTraining.pg.test.ts ellenőrzi. Külső hálózatot egy teszt sem ér el.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { XsModelService, type MonthlyResultsSource } from '../src/server/model/xsService';
import { SqliteXsStore, type XsTrainingStore } from '../src/server/model/xsStore';
import { XS_TRAINING_COMPETITIONS } from '../src/server/model/xsCompetitions';
import { createXsModel, xsAdminRouter, xsSwitchOn, XS_DISABLED_STATUS } from '../src/server/model/xsBootstrap';
import { EspnProvider } from '../src/server/data/espnProvider';
import { DemoMatchDataProvider } from '../src/server/data/demoProvider';
import { DemoResearchProvider } from '../src/server/research/demoResearch';
import { AnalysisService } from '../src/server/services/analysisService';
import { apiRouter } from '../src/server/routes/api';
import { CornerService } from '../src/server/corners/service';
import { SqliteAppStore } from '../src/server/db/appStore';
import { requireAdmin, requirePro } from '../src/server/billing/entitlement';
import type { ScoreboardResult } from '../src/server/data/scoreboardResults';
import type { Container } from '../src/server/container';
import type { Match, MatchAnalysis, PredictionRecord, SlipBuildResponse, TipListEntry } from '../src/shared/types';
import { rng } from '../src/shared/engine/experimental/crossLeagueEval';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const NOW = new Date('2026-10-15T12:00:00.000Z');

/**
 * Éles méretű forrás: MINDEN tanító-sorozat (XS_TRAINING_COMPETITIONS), havonta 4 meccs 8 csapat
 * között, determinisztikus (a hívássorrendtől független) eredményekkel. Számolja a hónap-lekéréseket (= ESPN-kérések élesben).
 */
function countingSource(opts: { failMonths?: Set<string>; perMonth?: number } = {}) {
  const calls: string[] = [];
  const source: MonthlyResultsSource = {
    async monthResults(c, m) {
      calls.push(`${c}|${m}`);
      if (opts.failMonths?.has(`${c}|${m}`)) return null;
      const ci = XS_TRAINING_COMPETITIONS.indexOf(c);
      const out: ScoreboardResult[] = [];
      for (let k = 0; k < (opts.perMonth ?? 4); k++) {
        const h = 1 + ((k * 3 + +m.slice(4)) % 8), a = 1 + ((k * 5 + +m.slice(4) + 1) % 8);
        if (h === a) continue;
        const date = new Date(Date.UTC(+m.slice(0, 4), +m.slice(4) - 1, 3 + k * 2, 15)).toISOString();
        out.push({ id: `espn-c${ci}-${m}${k}`, competitionId: c, date, homeTeamId: `espn-${ci * 100 + h}`, awayTeamId: `espn-${ci * 100 + a}`, homeGoals: (ci + +m + k) % 4, awayGoals: (ci * 3 + +m.slice(4) + k) % 3, regulation: true });
      }
      return out;
    },
  };
  return { source, calls };
}
const svcOpts = (now: Date, log: (m: string) => void = () => {}) => ({ now: () => now, minTrainingMatches: 1000, log });

describe('Újraindítás: hány havi ESPN-kérés? (éles méret: minden sorozat × 37 hónap)', () => {
  const total = XS_TRAINING_COMPETITIONS.length * 37;

  it('tartós tárral: hideg indulás = minden hónap egyszer; újraindulás = csak a nyitott (folyó) hónapok', async () => {
    expect(total).toBe(1258); // a korábbi mérés ~1258 havi kérése
    const db = new DatabaseSync(':memory:');
    const cold = countingSource();
    const a = new XsModelService(cold.source, new SqliteXsStore(db), svcOpts(NOW));
    await a.refresh();
    expect(cold.calls.length).toBe(1258);
    expect(a.status()).toMatchObject({ ready: true, durableStore: true, storeError: null, months: { fetched: 1258, stored: 0, failed: 0 } });

    // „újraindulás”: új folyamat, ugyanaz a tár
    const warm = countingSource();
    const b = new XsModelService(warm.source, new SqliteXsStore(db), svcOpts(new Date(NOW.getTime() + 10 * 60_000)));
    await b.refresh();
    expect(warm.calls.length).toBe(XS_TRAINING_COMPETITIONS.length); // csak a 2026-10 (nyitott) hónapok
    expect(warm.calls.every((k) => k.endsWith('|202610'))).toBe(true);
    expect(b.status().months).toMatchObject({ stored: 1224, fetched: 34 });
    expect(b.status().datasetSha256).toBe(a.status().datasetSha256); // ugyanaz a tanítóadat
  });

  it('6 órás újrabecslés ugyanabban a folyamatban: a lezárt hónapokat tár NÉLKÜL sem kéri le újra', async () => {
    const src = countingSource();
    const s = new XsModelService(src.source, null, svcOpts(NOW));
    await s.refresh();
    expect(src.calls.length).toBe(1258);
    src.calls.length = 0;
    const later = new XsModelService(src.source, null, svcOpts(NOW)); // tár nélküli újraindulás: a kockázat
    await later.refresh();
    expect(src.calls.length).toBe(1258);
    src.calls.length = 0;
    // ugyanaz a folyamat, 6 órával később
    (s as unknown as { opts: { now: () => Date } }).opts.now = () => new Date(NOW.getTime() + 6 * HOUR);
    await s.refresh();
    expect(src.calls.length).toBe(34);
    expect(s.status().months).toMatchObject({ cached: 1224, fetched: 34, stored: 0 });
    expect(s.status()).toMatchObject({ durableStore: false, storeError: 'nincs tartós tár konfigurálva' });
  });

  it('adatbázis-hiba: a frissítés memóriából becsül, a következő kör ÚJRA próbálja a tárat (nem kapcsol ki végleg)', async () => {
    const db = new DatabaseSync(':memory:');
    const real = new SqliteXsStore(db);
    let down = true;
    const flaky: XsTrainingStore = {
      months: () => (down ? Promise.reject(new Error('connect ECONNREFUSED')) : real.months()),
      saveMonth: (...a) => (down ? Promise.reject(new Error('connect ECONNREFUSED')) : real.saveMonth(...a)),
      loadMatches: (f) => (down ? Promise.reject(new Error('connect ECONNREFUSED')) : real.loadMatches(f)),
      recordFit: (f) => (down ? Promise.reject(new Error('connect ECONNREFUSED')) : real.recordFit(f)),
    };
    const logs: string[] = [];
    const src = countingSource();
    const s = new XsModelService(src.source, flaky, svcOpts(NOW, (m) => logs.push(m)));
    await s.refresh();
    expect(s.status()).toMatchObject({ ready: true, durableStore: false, storeError: expect.stringMatching(/months: connect ECONNREFUSED/) });
    expect(logs.some((l) => /tartós tár nem érhető el \(months\)/.test(l))).toBe(true);
    down = false;
    (s as unknown as { opts: { now: () => Date } }).opts.now = () => new Date(NOW.getTime() + 6 * HOUR);
    await s.refresh();
    expect(s.status()).toMatchObject({ ready: true, durableStore: true, storeError: null });
    expect((db.prepare('SELECT COUNT(*) AS n FROM xs_model_fits').get() as { n: number }).n).toBe(1); // a helyreállás utáni becslés naplózva
  });

  it('egy hónap írási hibája (pl. megszorítás-sértés) nem kapcsolja ki a tárat; a többi hónap eltárolódik', async () => {
    const db = new DatabaseSync(':memory:');
    const real = new SqliteXsStore(db);
    const store: XsTrainingStore = { ...real, months: () => real.months(), loadMatches: (f) => real.loadMatches(f), recordFit: (f) => real.recordFit(f),
      saveMonth: (c, m, closed, rows) => (c === XS_TRAINING_COMPETITIONS[0] && m === '202501' ? Promise.reject(new Error('violates check constraint')) : real.saveMonth(c, m, closed, rows)) };
    const s = new XsModelService(countingSource().source, store, svcOpts(NOW));
    await s.refresh();
    expect(s.status().durableStore).toBe(true);
    expect((await real.months()).size).toBe(1257);
  });
});

describe('Üres / hiányos tanítóadat, elavult becslés', () => {
  const match = (leagueId: string, kickoff: string) => ({ id: 'm1', leagueId, homeTeamId: 'espn-1', awayTeamId: 'espn-2', kickoff } as unknown as Match);
  let base: MatchAnalysis;
  beforeAll(async () => {
    // valódi alap-elemzés (xg-poisson-1) egy DEMO-meccsre – a visszaesés ezt adja vissza
    const demo = new DemoMatchDataProvider();
    const c = { data: demo, research: new DemoResearchProvider(demo), oddsApi: null,
      db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined } } as unknown as Container;
    const m = (await demo.getMatches({ status: 'scheduled' }))[0];
    base = (await new AnalysisService(c).analyze(m.id))!;
  });

  it('üres forrás: nincs becslés, megnevezett hiba; a PRO az alap motort kapja (not_ready)', async () => {
    const s = new XsModelService({ monthResults: async () => [] }, null, svcOpts(NOW));
    await s.refresh();
    expect(s.status()).toMatchObject({ ready: false, lastError: expect.stringMatching(/Kevés tanítóadat/) });
    expect(s.serve(match(XS_TRAINING_COMPETITIONS[0], new Date(NOW.getTime() + DAY).toISOString()), base).model).toMatchObject({ id: 'xg-poisson-1', fallbackCode: 'not_ready' });
  });

  it('hiányos letöltés (sok sikertelen hónap): a meglévő adatból becsül, a hiány jelölve; ha túl kevés marad, a korábbi becslés marad', async () => {
    const fail = new Set(XS_TRAINING_COMPETITIONS.slice(0, 10).flatMap((c) => Array.from({ length: 12 }, (_, i) => `${c}|2025${String(i + 1).padStart(2, '0')}`)));
    const s = new XsModelService(countingSource({ failMonths: fail }).source, null, svcOpts(NOW));
    await s.refresh();
    expect(s.status()).toMatchObject({ ready: true, months: { failed: 120 }, lastError: expect.stringMatching(/120 hónap nem volt letölthető/) });
  });

  it('a becslés kora korlátos: 30 óránál régebbi becslés nem szolgál ki (stale_fit), a FREE-t nem érinti', async () => {
    let now = NOW;
    const s = new XsModelService(countingSource({ perMonth: 24 }).source, null, { ...svcOpts(NOW), now: () => now });
    await s.refresh();
    const ko = new Date(NOW.getTime() + 40 * HOUR).toISOString();
    expect(s.serve(match(XS_TRAINING_COMPETITIONS[0], ko), base).model!.id).toBe('xs-strength-1');
    now = new Date(NOW.getTime() + 31 * HOUR);
    expect(s.serve(match(XS_TRAINING_COMPETITIONS[0], ko), base).model).toMatchObject({ id: 'xg-poisson-1', fallbackCode: 'stale_fit' });
  });

  it('visszaesések megfigyelhetők: okonként számolva az admin-állapotban, okonként egyszer naplózva', async () => {
    const logs: string[] = [];
    const s = new XsModelService(countingSource({ perMonth: 24 }).source, null, svcOpts(NOW, (m) => logs.push(m)));
    s.serve(match(XS_TRAINING_COMPETITIONS[0], NOW.toISOString()), base); // még nincs becslés
    await s.refresh();
    const before = new Date(NOW.getTime() - 5 * HOUR).toISOString(), after = new Date(NOW.getTime() + DAY).toISOString();
    for (let i = 0; i < 3; i++) s.serve(match(XS_TRAINING_COMPETITIONS[0], before), base); // szivárgás-őr
    s.serve(match('hun-nb1-nincs-ilyen', after), base);
    s.serve(match(XS_TRAINING_COMPETITIONS[0], after), base);
    const st = s.status();
    expect(st.serving).toEqual({ xs: 1, fallbacks: { not_ready: 1, leakage: 3, competition: 1 } });
    expect(logs.filter((l) => /visszaesés az alap motorra \(leakage\)/.test(l))).toHaveLength(1);
  });
});

describe('A havi ESPN-válaszok nem maradnak a memóriában (heap-kockázat)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('monthResults: a nyers választ nem tartja meg sem memóriában, sem a cache-ben', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const writes: string[] = [];
    const p = new EspnProvider({ get: () => null, set: (url: string) => { writes.push(url); } } as never);
    expect(await p.monthResults('eng-pl', '202401')).toEqual([]);
    expect(await p.monthResults('eng-pl', '202401')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((p as unknown as { mem: Map<string, unknown> }).mem.size).toBe(0);
    expect(writes).toEqual([]);
  });
});

describe('Vészkapcsoló: XS_MODEL_ENABLED=false', () => {
  it('a kapcsoló értelmezése', () => {
    for (const v of ['false', 'FALSE', ' false ', '0', 'off', 'no']) expect(xsSwitchOn(v), v).toBe(false);
    for (const v of [undefined, '', 'true', '1', 'yes']) expect(xsSwitchOn(v), String(v)).toBe(true);
  });

  it('kikapcsolva nem jön létre szolgáltatás, és a tárhoz sem nyúl; élő ESPN nélkül sem', () => {
    const storeFactory = vi.fn(() => null);
    expect(createXsModel({ XS_MODEL_ENABLED: 'false' }, countingSource().source, storeFactory)).toBeNull();
    expect(createXsModel({}, null, storeFactory)).toBeNull();
    expect(storeFactory).not.toHaveBeenCalled();
    expect(createXsModel({}, countingSource().source, storeFactory)).toBeInstanceOf(XsModelService);
    expect(storeFactory).toHaveBeenCalledTimes(1);
  });
});

describe('API kikapcsolt és bekapcsolt modellel – jogosultság, mentés, szelvény, admin', () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

  const PRO = { enforced: true, user: { id: 'pro-1' }, pro: true, admin: false };
  const FREE = { enforced: true, user: { id: 'free-1' }, pro: false, admin: false };
  const ANON = { enforced: true, user: null, pro: false, admin: false };
  const ADMIN = { enforced: true, user: { id: 'admin-1' }, pro: true, admin: true };

  /** az index.ts sorrendje: attachPlan → requirePro (slips, predictions) → admin → apiRouter */
  async function app(plan: unknown, xs: XsModelService | null) {
    const demo = new DemoMatchDataProvider();
    const store = new SqliteAppStore(new DatabaseSync(':memory:'));
    const db = {
      getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined,
      savePrediction: (p: never) => store.savePrediction(p), getPredictionByMarket: (u: string, m: string, k: string) => store.getPredictionByMarket(u, m, k),
      hasPrediction: async (u: string, m: string, k: string) => !!(await store.getPredictionByMarket(u, m, k)),
      saveSlip: (s: never) => store.saveSlip(s), listSlips: (u: string) => store.listSlips(u),
    };
    const c = { data: demo, research: new DemoResearchProvider(demo), oddsApi: null, db } as unknown as Container;
    const svc = new AnalysisService(c, null, xs);
    const a = express();
    a.use(express.json());
    a.use((_req, res, next) => { res.locals.plan = plan; next(); });
    a.use(['/api/slips', '/api/history'], requirePro);
    a.post('/api/matches/:id/predictions', requirePro);
    a.use('/api/admin/xs-model', requireAdmin, xsAdminRouter(xs));
    a.use('/api', apiRouter(c, svc, new CornerService(demo)));
    server = await new Promise<Server>((r) => { const s = a.listen(0, () => r(s)); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    };
    return { call, demo, svc };
  }
  /** kész xs-modell a DEMO-csapatok múltjával */
  async function readyXs(demo: DemoMatchDataProvider) {
    const teams = await demo.getTeams();
    const r = rng(42);
    const rows: ScoreboardResult[] = [];
    let n = 0;
    const leagues = ['eng-pl', 'esp-ll', 'ita-sa', 'ger-bl', 'fra-l1', 'usa-mls'];
    for (const l of leagues) {
      const lt = teams.filter((t) => t.leagueId === l);
      for (let s = 0; s < 2; s++) for (const h of lt) for (const a of lt) if (h !== a) {
        rows.push({ id: `espn-x-${n}`, competitionId: l, date: new Date(Date.now() - (40 + s * 200 + (n++ % 180)) * DAY).toISOString(), homeTeamId: h.id, awayTeamId: a.id, homeGoals: Math.floor(r() * 4), awayGoals: Math.floor(r() * 3), regulation: true });
      }
    }
    const xs = new XsModelService({ monthResults: async (c, m) => rows.filter((x) => x.competitionId === c && x.date.slice(0, 7).replace('-', '') === m) }, null,
      { historyMonths: 24, minTrainingMatches: 100, competitions: leagues, log: () => {} });
    await xs.refresh();
    return xs;
  }
  const scheduled = async (demo: DemoMatchDataProvider): Promise<Match> => (await demo.getMatches({ status: 'scheduled' })).find((m) => m.leagueId === 'eng-pl')!;

  it('KIKAPCSOLVA: PRO elemzés = xg-poisson-1 (visszaesés-zaj nélkül), tipplista, tippmentés és szelvény működik, nincs API-hiba', async () => {
    const { call, demo } = await app(PRO, null);
    const m = await scheduled(demo);
    const an = await call('GET', `/api/matches/${m.id}/analysis`);
    expect(an.status).toBe(200);
    expect((an.body as MatchAnalysis).model).toEqual({ id: 'xg-poisson-1', label: expect.any(String) });
    const date = new Date(m.kickoff).toLocaleDateString('sv-SE');
    const tips = await call('GET', `/api/tips?date=${date}`);
    expect(tips.status).toBe(200);
    expect((tips.body as TipListEntry[]).every((e) => e.model?.id === 'xg-poisson-1')).toBe(true);
    const tip = (an.body as MatchAnalysis).tips[0];
    const saved = await call('POST', `/api/matches/${m.id}/predictions`, { market: tip.market });
    expect(saved.status).toBe(200);
    expect((saved.body as PredictionRecord).modelProb).toBeCloseTo(tip.modelProb, 9); // a látott (alap) valószínűség
    const slips = await call('GET', `/api/slips?from=${date}&to=${date}&legs=2&minOdds=1.01&minLegProb=0`);
    expect(slips.status).toBe(200);
    const built = slips.body as SlipBuildResponse;
    expect(built.matchesAnalyzed).toBeGreaterThan(0);
    const slip = built.slips[0];
    expect(slip).toBeDefined();
    const post = await call('POST', '/api/slips', { strategy: slip.strategy, legs: slip.legs.map((l) => ({ matchId: l.matchId, market: l.market })) });
    expect(post.status).toBe(200);
  });

  it('KIKAPCSOLVA: a FREE viselkedése változatlan (xg, kitakarva, 403 a kereten kívül; a mentés/szelvény PRO-funkció marad)', async () => {
    const { call, demo } = await app(FREE, null);
    const day = await demo.getMatches({ status: 'scheduled' });
    const { freeMatchIds } = await import('../src/shared/engine/plan');
    const sameDay = (x: Match) => day.filter((y) => y.kickoff.slice(0, 10) === x.kickoff.slice(0, 10));
    const open = day.find((x) => freeMatchIds(sameDay(x)).has(x.id))!;
    const locked = day.find((x) => !freeMatchIds(sameDay(x)).has(x.id))!;
    const fr = await call('GET', `/api/matches/${open.id}/analysis`);
    expect(fr.status).toBe(200);
    expect((fr.body as MatchAnalysis).model?.id).toBe('xg-poisson-1');
    expect((fr.body as MatchAnalysis).tips.every((t) => t.reasonsFor.length === 0)).toBe(true);
    expect((await call('GET', `/api/matches/${locked.id}/analysis`)).status).toBe(403);
    expect((await call('POST', `/api/matches/${open.id}/predictions`, { market: '1' })).body.code).toBe('PRO_REQUIRED');
    expect((await call('GET', '/api/slips')).body.code).toBe('PRO_REQUIRED');
  });

  it('BEKAPCSOLVA: a PRO tippmentés a látott xs-valószínűséget rögzíti; a FREE nem kap PRO-hozzáférést a modellváltással', async () => {
    const demo0 = new DemoMatchDataProvider();
    const xs = await readyXs(demo0);
    const { call, demo } = await app(PRO, xs);
    const m = await scheduled(demo);
    const an = (await call('GET', `/api/matches/${m.id}/analysis`)).body as MatchAnalysis;
    expect(an.model?.id).toBe('xs-strength-1');
    const saved = await call('POST', `/api/matches/${m.id}/predictions`, { market: an.tips[0].market });
    expect((saved.body as PredictionRecord).modelProb).toBeCloseTo(an.tips[0].modelProb, 9);
    await new Promise<void>((r) => server!.close(() => r())); server = null;
    const free = await app(FREE, xs);
    expect((await free.call('GET', '/api/slips')).status).toBe(403);
    expect((await free.call('GET', '/api/admin/xs-model')).status).toBe(403);
  });

  it('GET /api/admin/xs-model: anon 401, FREE 403, PRO (nem admin) 403, admin 200 – titok és személyes adat nélkül', async () => {
    const demo = new DemoMatchDataProvider();
    const xs = await readyXs(demo);
    for (const [plan, code] of [[ANON, 401], [FREE, 403], [PRO, 403]] as const) {
      const { call } = await app(plan, xs);
      const r = await call('GET', '/api/admin/xs-model');
      expect(r.status, JSON.stringify(plan)).toBe(code);
      expect(JSON.stringify(r.body)).not.toMatch(/fitId|trainedMatches/);
      await new Promise<void>((res) => server!.close(() => res())); server = null;
    }
    const on = await app(ADMIN, xs);
    const st = await on.call('GET', '/api/admin/xs-model');
    expect(st.status).toBe(200);
    expect(Object.keys(st.body).sort()).toEqual(['cutoff', 'datasetSha256', 'durableStore', 'fitId', 'lastError', 'lastRefreshAt', 'modelId', 'months', 'ready', 'serving', 'storeError', 'trainedMatches']);
    expect(JSON.stringify(st.body)).not.toMatch(/@|service_role|eyJ|password|token|admin-1|pro-1/i);
    await new Promise<void>((res) => server!.close(() => res())); server = null;
    const off = await app(ADMIN, null);
    expect((await off.call('GET', '/api/admin/xs-model')).body).toEqual(XS_DISABLED_STATUS);
  });
});
