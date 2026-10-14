/**
 * Diagnosztikai előzmények (0018) – rögzítés, idempotencia, jogosultság,
 * lekérdezés és megjelenítés.
 *
 * Valódi `SqliteTipArchiveStore` + `SqliteModelLearningStore` memóriában
 * (a 0014/0015/0018 megfelelői), valódi `ModelLearningService`, valódi
 * `requireAdmin` + `modelLearningRouter`. Hálózat, Supabase, .env NINCS.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { SqliteTipArchiveStore, type ArchiveDraft } from '../src/server/tipArchive/store';
import { SqliteModelLearningStore, type ModelLearningStore } from '../src/server/modelLearning/store';
import { ModelLearningService } from '../src/server/modelLearning/service';
import { prng } from '../src/server/modelLearning/calibration';
import { modelLearningRouter } from '../src/server/routes/modelLearning';
import { requireAdmin } from '../src/server/billing/entitlement';
import { HistorySection, TopCards } from '../src/client/pages/AdminModelLearning';
import { NO_DATA, fmtNum, historyPoints, historyRows, newIdempotencyKey, singleFlight } from '../src/client/lib/learningDashboard';
import { ENGINE_VERSION } from '../src/shared/engine/version';
import { LEARNING_THRESHOLDS, SERVING_NOTE, type DiagnosticRun, type LearningStatus } from '../src/shared/modelLearning';

type DB = InstanceType<typeof DatabaseSync>;
const H = 3_600_000;

function seed(archive: SqliteTipArchiveStore, matches: number, startMs = Date.parse('2026-06-01T15:00:00.000Z'), spacing = 18 * H, prefix = 'm') {
  const rnd = prng(matches + startMs);
  for (let i = 0; i < matches; i++) {
    const matchId = `${prefix}${String(i).padStart(5, '0')}`;
    const kickoff = startMs + i * spacing;
    const drafts: ArchiveDraft[] = [['O2.5', 'gólszám'], ['1X', 'dupla esély']].map(([market, type], k) => {
      const p = 0.1 + rnd() * 0.8;
      return {
        matchId, market, versionNo: 1, contentHash: `${prefix}${i}-${k}`.padStart(64, '0'), engineVersion: ENGINE_VERSION,
        generatedAt: new Date(kickoff - 5 * H).toISOString(), origin: 'live', matchLabel: 'A – B', leagueId: 'L1', leagueName: 'Liga',
        kickoff: new Date(kickoff).toISOString(), marketLabel: market, marketType: type, category: 'mérsékelt', modelProb: p, odds: null, impliedProb: null,
        dataQuality: 'magas', sampleSize: 10, supportingIndicators: 2, preKickoff: true, availability: 'pro_on_request', servedProb: p, servedModel: ENGINE_VERSION,
      };
    });
    archive.insertVersions(drafts);
    archive.settle({ matchId, homeGoals: 1, awayGoals: 0, resultKickoff: new Date(kickoff).toISOString(), settledAt: new Date(kickoff + 3 * H).toISOString(),
      outcomes: drafts.map((d) => ({ market: d.market, status: (rnd() < d.modelProb ? 'won' : 'lost') as 'won' | 'lost' })) });
  }
}

function ctx() {
  const db = new DatabaseSync(':memory:');
  const archive = new SqliteTipArchiveStore(db);
  const store = new SqliteModelLearningStore(db);
  const clock = { t: Date.parse('2026-10-14T12:00:00.000Z') };
  const svc = (s: ModelLearningStore = store) => new ModelLearningService(s, { now: () => new Date(clock.t), allowPromotion: false });
  return { db, archive, store, clock, svc };
}
const count = (db: DB) => Number((db.prepare('SELECT count(*) AS n FROM model_learning_diagnostic_runs').get() as { n: number }).n);
const snapshotOf = (db: DB) => JSON.stringify(['model_tip_archive', 'model_calibration_versions', 'model_learning_events', 'model_learning_state']
  .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));

/** Egy store, amelynek egyes metódusai hibát dobnak (a többi a valódi). */
function failing(store: SqliteModelLearningStore, method: 'loadArchive' | 'insertDiagnosticRun'): ModelLearningStore {
  return new Proxy(store, {
    get(t, p, r) {
      if (p === method) return async () => { throw new Error(`szimulált hiba: ${method}`); };
      const v = Reflect.get(t, p, r); return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as ModelLearningStore;
}

describe('diagnosztikai futás rögzítése (szolgáltatás)', () => {
  it('1) sikeres futás pontosan EGY rekordot hoz létre a riport tényleges értékeivel', async () => {
    const c = ctx();
    seed(c.archive, 200);
    const out = await c.svc().snapshotDiagnostics('admin1', 'kulcs-0001-aaaa');
    expect(out.replayed).toBe(false);
    expect(count(c.db)).toBe(1);
    const r = out.report!;
    expect(out.run).toMatchObject({
      status: 'succeeded', baseEngineVersion: ENGINE_VERSION, method: 'diagnostics-v1',
      observations: r.sizes.observations, matches: r.sizes.matches, logLoss: r.model!.logLoss, brier: r.model!.brier, ece: r.model!.ece,
      enoughForConclusions: r.sufficiency.enoughForConclusions, period: r.period,
    });
    expect(out.run.naive?.modelLogLossAdvantageCi).toEqual(r.naiveBaseline!.modelLogLossAdvantageCi);
    expect(out.run.dataFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // az API-forma nem ad ki indítót / idempotencia-kulcsot
    expect(JSON.stringify(out.run)).not.toMatch(/admin1|kulcs-0001/);
  });

  it('2) sikertelen számítás nem hoz létre rekordot', async () => {
    const c = ctx();
    seed(c.archive, 50);
    await expect(c.svc(failing(c.store, 'loadArchive')).snapshotDiagnostics('a', 'kulcs-0002-aaaa')).rejects.toThrow(/szimulált hiba/);
    expect(count(c.db)).toBe(0);
  });

  it('9) ugyanaz a kulcs kétszer (újrapróbálás) → egy rekord, a második „replayed”; párhuzamosan is egy', async () => {
    const c = ctx();
    seed(c.archive, 60);
    const a = await c.svc().snapshotDiagnostics('a', 'kulcs-0009-aaaa');
    const b = await c.svc().snapshotDiagnostics('a', 'kulcs-0009-aaaa');
    expect(b).toMatchObject({ replayed: true, report: null });
    expect(b.run.id).toBe(a.run.id);
    const [x, y] = await Promise.all([c.svc().snapshotDiagnostics('a', 'kulcs-0010-bbbb'), c.svc().snapshotDiagnostics('a', 'kulcs-0010-bbbb')]);
    expect(x.run.id).toBe(y.run.id);
    expect(count(c.db)).toBe(2);
  });

  it('append-only: a rögzített futás nem módosítható és nem törölhető', async () => {
    const c = ctx();
    seed(c.archive, 30);
    await c.svc().snapshotDiagnostics('a', 'kulcs-0011-aaaa');
    expect(() => c.db.prepare('UPDATE model_learning_diagnostic_runs SET log_loss = 0').run()).toThrow(/nem módosítható/);
    expect(() => c.db.prepare('DELETE FROM model_learning_diagnostic_runs').run()).toThrow(/nem törölhetők/);
  });

  it('13–14) a rögzítés nem illeszt jelöltet, nem ír archívumot/eseményt/állapotot; az aktiválás tiltott marad', async () => {
    const c = ctx();
    seed(c.archive, 120);
    const before = snapshotOf(c.db);
    await c.svc().snapshotDiagnostics('a', 'kulcs-0013-aaaa');
    expect(snapshotOf(c.db)).toBe(before);
    const st = await c.svc().status();
    expect(st).toMatchObject({ servedModel: ENGINE_VERSION, promotionEnabled: false, activeModelId: null, candidates: [] });
  });
});

describe('admin-végpontok: /snapshots és /history', () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise((r) => server!.close(() => r(null))); server = null; });

  async function app(c: ReturnType<typeof ctx>, store: ModelLearningStore = c.store) {
    const a = express();
    a.use('/api', (req, res, next) => {
      const id = req.header('x-test-user') ?? null;
      res.locals.plan = { enforced: true, user: id ? { id, email: `${id}@teszt.hu` } : null, pro: true, admin: req.header('x-test-admin') === '1' && !!id };
      next();
    });
    a.use('/api/admin/model-learning', requireAdmin, modelLearningRouter(c.svc(store)));
    server = await new Promise((r) => { const s = a.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/admin/model-learning`;
    const admin = { 'x-test-user': 'admin1', 'x-test-admin': '1' };
    return { base, admin, call: (method: string, path: string, h: Record<string, string> = {}) => fetch(base + path, { method, headers: h }) };
  }

  it('5–6) névtelen 401, nem admin (akár PRO) 403 – mindkét új végponton, rekord nélkül', async () => {
    const c = ctx();
    seed(c.archive, 20);
    const { call } = await app(c);
    for (const [m, p] of [['POST', '/snapshots'], ['GET', '/history']]) {
      expect((await call(m, p, { 'idempotency-key': 'kulcs-0005-aaaa' })).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, { 'x-test-user': 'u1', 'idempotency-key': 'kulcs-0005-aaaa' })).status, `${m} ${p}`).toBe(403);
    }
    expect(count(c.db)).toBe(0);
  });

  it('kötelező, érvényes Idempotency-Key; 201 új futásnál, 200 + replayed ismétlésnél', async () => {
    const c = ctx();
    seed(c.archive, 40);
    const { call, admin } = await app(c);
    expect((await call('POST', '/snapshots', admin)).status).toBe(400);
    expect((await call('POST', '/snapshots', { ...admin, 'idempotency-key': 'rövid' })).status).toBe(400);
    expect((await call('POST', '/snapshots', { ...admin, 'idempotency-key': 'rossz kulcs!!' })).status).toBe(400);
    const first = await call('POST', '/snapshots', { ...admin, 'idempotency-key': 'kulcs-0020-aaaa' });
    expect(first.status).toBe(201);
    const again = await call('POST', '/snapshots', { ...admin, 'idempotency-key': 'kulcs-0020-aaaa' });
    expect(again.status).toBe(200);
    expect((await again.json()).replayed).toBe(true);
    expect(count(c.db)).toBe(1);
  });

  it('3) mentési hiba: 500 „nem rögzült”, rekord nincs', async () => {
    const c = ctx();
    seed(c.archive, 20);
    const { call, admin } = await app(c, failing(c.store, 'insertDiagnosticRun'));
    const r = await call('POST', '/snapshots', { ...admin, 'idempotency-key': 'kulcs-0003-aaaa' });
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ code: 'SNAPSHOT_FAILED', error: 'A diagnosztikai futás nem rögzült.' });
    expect(count(c.db)).toBe(0);
  });

  it('4) oldalbetöltés (status, diagnostics, history GET) nem hoz létre rekordot', async () => {
    const c = ctx();
    seed(c.archive, 30);
    const { call, admin } = await app(c);
    for (const p of ['/status', '/diagnostics', '/history', '/history?limit=5']) expect((await call('GET', p, admin)).status, p).toBe(200);
    expect(count(c.db)).toBe(0);
  });

  it('7–8) limit validált és korlátozott; a válasz időrendben, a legújabbal kezdve', async () => {
    const c = ctx();
    seed(c.archive, 25);
    const { call, admin } = await app(c);
    for (let i = 0; i < 4; i++) {
      c.clock.t += 3600_000;
      expect((await call('POST', '/snapshots', { ...admin, 'idempotency-key': `kulcs-hist-${i}-aaaa` })).status).toBe(201);
    }
    for (const bad of ['0', '-1', 'abc', '2.5', '']) expect((await call('GET', `/history?limit=${bad}`, admin)).status, bad).toBe(400);
    const big = await (await call('GET', '/history?limit=100000', admin)).json();
    expect(big.limit).toBe(100);
    const two = await (await call('GET', '/history?limit=2', admin)).json();
    expect(two.runs).toHaveLength(2);
    const all = (await (await call('GET', '/history', admin)).json()).runs as DiagnosticRun[];
    expect(all).toHaveLength(4);
    const times = all.map((r) => r.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(two.runs.map((r: DiagnosticRun) => r.id)).toEqual(all.slice(0, 2).map((r) => r.id));
  });
});

// ---------------------------------------------------------------------------
// Megjelenítés
// ---------------------------------------------------------------------------

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, null, el));

function run(over: Partial<DiagnosticRun> = {}): DiagnosticRun {
  return {
    id: 'r1', createdAt: '2026-10-14T10:00:00.000Z', status: 'succeeded', baseEngineVersion: ENGINE_VERSION, method: 'diagnostics-v1',
    dataFingerprint: 'a'.repeat(64), observations: 1219, matches: 109,
    period: { firstKickoff: '2026-10-10T11:00:00.000Z', lastKickoff: '2026-10-13T19:00:00.000Z', distinctKickoffDays: 4 },
    logLoss: 0.56167, brier: 0.19025, ece: 0.03208,
    naive: { coveredMatches: 31, coveredObservations: 317, modelLogLoss: 0.5491, baselineLogLoss: 0.5251, modelBrier: 0.18, baselineBrier: 0.17,
      modelLogLossAdvantage: -0.024, modelLogLossAdvantageCi: [-0.07233, 0.02548], modelBrierAdvantage: -0.0095 },
    enoughForConclusions: false, notes: ['Kevés mérkőzés: 109 (következtetéshez legalább 150).'],
    ...over,
  };
}

describe('kliensoldali duplikáció elleni védelem', () => {
  it('9) gyors, többszörös kattintás: futás közben a további hívások NEM indulnak (szinkron kapu); utána újra indítható', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = singleFlight(() => { calls++; return new Promise<string>((r) => { release = () => r('kész'); }); });
    const first = gate();
    expect(await Promise.all([gate(), gate()])).toEqual([null, null]); // azonnal, a React-állapot frissülése nélkül is
    expect(calls).toBe(1);
    release();
    expect(await first).toBe('kész');
    const second = gate();
    release();
    expect(await second).toBe('kész');
    expect(calls).toBe(2);
    // hibánál is felszabadul
    const failingGate = singleFlight(async () => { throw new Error('x'); });
    await expect(failingGate()).rejects.toThrow('x');
    await expect(failingGate()).rejects.toThrow('x');
  });

  it('kattintásonként egyedi, a szerver formátumának megfelelő idempotencia-kulcs', () => {
    const a = newIdempotencyKey(), b = newIdempotencyKey();
    expect(a).not.toBe(b);
    for (const k of [a, b]) expect(k).toMatch(/^[A-Za-z0-9-]{8,100}$/);
  });
});

describe('előzmények megjelenítése', () => {
  it('10) üres és hibás válasz: egyértelmű állapot, grafikon és szám nélkül', () => {
    const empty = html(createElement(HistorySection, { runs: [], error: null, loading: false }));
    expect(empty).toContain('Még nincs rögzített diagnosztikai futás');
    expect(empty).not.toContain('<svg');
    const err = html(createElement(HistorySection, { runs: null, error: 'Hiba (500)', loading: false }));
    expect(err).toContain('Az előzmények nem tölthetők be: Hiba (500)');
    expect(err).not.toContain('<table');
  });

  it('11) a tábla és a grafikon a tényleges rögzített értékeket használja; a hiányzó érték „Nincs adat”', () => {
    const runs = [run({ id: 'r2', createdAt: '2026-10-15T10:00:00.000Z', logLoss: 0.55001, naive: null }), run()];
    const out = html(createElement(HistorySection, { runs, error: null, loading: false }));
    expect(out).toContain(fmtNum(0.55001));
    expect(out).toContain(fmtNum(0.56167));
    expect(out).toContain(NO_DATA); // r2-nek nincs baseline-összevetése
    const pts = historyPoints(runs, 'logLoss');
    expect([...pts.enough, ...pts.insufficient].map((p) => p.value)).toEqual([0.56167, 0.55001]); // legrégebbi elöl
    expect(historyPoints([run({ naive: null })], 'advantage').insufficient).toEqual([]); // hiányzó előny nem 0
    const adv = historyPoints([run()], 'advantage').insufficient[0];
    expect(adv.err![0]).toBeCloseTo(-0.024 - -0.07233, 12);
  });

  it('12) eltérő minták nem jelennek meg közvetlenül összevethetőként: nincs összekötő vonal, a minta jelölve; kis minta külön', () => {
    const runs = [run({ id: 'b', createdAt: '2026-10-16T10:00:00.000Z', dataFingerprint: 'b'.repeat(64) }), run({ id: 'a2', createdAt: '2026-10-15T10:00:00.000Z' }), run()];
    const rows = historyRows(runs);
    expect(rows.map((r) => r.sameSampleAsPrevious)).toEqual([false, true, false]);
    const out = html(createElement(HistorySection, { runs, error: null, loading: false }));
    expect(out).toContain('szándékosan nincsenek összekötve');
    expect(out).toContain('azonos az előzővel');
    expect(out).toContain('kis minta');
    expect(out).not.toContain('recharts-line'); // csak pontok, vonal nincs
    const p = historyPoints([run({ enoughForConclusions: true }), run({ id: 'x', enoughForConclusions: false })], 'brier');
    expect(p.enough).toHaveLength(1);
    expect(p.insufficient).toHaveLength(1);
  });

  it('a felső kártya az utolsó RÖGZÍTETT futást mutatja; az oldalbetöltéskori számítás nem „rögzített”', () => {
    const s: LearningStatus = {
      baselineEngineVersion: ENGINE_VERSION, servedModel: ENGINE_VERSION, servingNote: SERVING_NOTE, promotionEnabled: false,
      activeModelId: null, previousModelId: null, stateVersion: 0, lastRun: { startedAt: null, finishedAt: null, status: null, error: null, summary: null },
      nextScheduledEvaluation: null, schedulingNote: 'x', locked: false, thresholds: LEARNING_THRESHOLDS, candidates: [], recentEvents: [],
    };
    expect(html(createElement(TopCards, { s, d: null, diagLoading: false, lastRecorded: null }))).toContain('Még nincs rögzített futás');
    expect(html(createElement(TopCards, { s, d: null, diagLoading: false, lastRecorded: '2026-10-14T10:00:00.000Z' }))).toContain('Utolsó rögzített diagnosztika');
  });
});
