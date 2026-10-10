/**
 * Modell-kalibráció (tanulási réteg) – statisztika, adatérvényesség,
 * időrendi felosztás, kapuk, életciklus, zárak, aktiválás/visszaállítás,
 * visszaesés és admin-jogosultság.
 *
 * Valódi `SqliteTipArchiveStore` + `SqliteModelLearningStore` (a 0014/0015
 * megfelelői) memóriában; a tanító adat az archívum valódi
 * beszúrási/elszámolási útján kerül be, determinisztikus szintetikus
 * eredményekkel. Hálózat, Supabase, .env NINCS.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { SqliteTipArchiveStore, type ArchiveDraft } from '../src/server/tipArchive/store';
import { SqliteModelLearningStore, type ArchiveTrainingRow, type ModelLearningStore } from '../src/server/modelLearning/store';
import { ModelLearningService, validateParams } from '../src/server/modelLearning/service';
import {
  applyCalibration, bootstrapMeanCi, chronologicalSplit, fitCandidate, fitPlatt, logit, prng, sigmoid, type Observation,
} from '../src/server/modelLearning/calibration';
import { modelLearningRouter } from '../src/server/routes/modelLearning';
import { requireAdmin } from '../src/server/billing/entitlement';
import { ENGINE_VERSION } from '../src/shared/engine/version';
import { CALIBRATION_METHOD, LEARNING_THRESHOLDS, type CalibrationParams } from '../src/shared/modelLearning';

type DB = InstanceType<typeof DatabaseSync>;
const H = 3_600_000;
const START = Date.parse('2026-01-01T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Adat-generátor: a valódi archívum-úton (beszúrás + elszámolás)
// ---------------------------------------------------------------------------

interface MarketSpec { market: string; type: string; truth: (p: number) => number }

/** Az alap motor túlmagabiztos: a valódi esély σ(0,5·logit(p)). */
const overconfident = (p: number) => sigmoid(0.5 * logit(p));
const calibrated = (p: number) => p;
const underconfident = (p: number) => sigmoid(2.0 * logit(p));

function seedArchive(archive: SqliteTipArchiveStore, opts: {
  matches: number; seed: number; markets: (i: number, rnd: () => number) => MarketSpec[]; spacingMs?: number; start?: number; idPrefix?: string;
  /** a kiszolgáló modell és érték soronként (alapból: az alap motor, nyers érték) */
  served?: (p: number, type: string, i: number) => { model: string; prob: number };
  /** a generálás ideje (alapból a kezdés előtt 5 órával) */
  generatedAt?: (kickoff: number, i: number) => number;
}) {
  const rnd = prng(opts.seed);
  const spacing = opts.spacingMs ?? 6 * H;
  const start = opts.start ?? START;
  for (let i = 0; i < opts.matches; i++) {
    const matchId = `${opts.idPrefix ?? 'm'}${String(i).padStart(5, '0')}`;
    const kickoff = start + i * spacing;
    const specs = opts.markets(i, rnd);
    const drafts: ArchiveDraft[] = specs.map((s, k) => {
      const p = 0.08 + rnd() * 0.84;
      return {
        matchId, market: s.market, versionNo: 1, contentHash: `${i}-${k}`.padStart(64, '0'), engineVersion: ENGINE_VERSION,
        generatedAt: iso(opts.generatedAt ? opts.generatedAt(kickoff, i) : kickoff - 5 * H), origin: 'live', matchLabel: `Hazai ${i} – Vendég ${i}`, leagueId: i % 2 ? 'L2' : 'L1',
        leagueName: 'Liga', kickoff: iso(kickoff), marketLabel: s.market, marketType: s.type, category: 'mérsékelt',
        modelProb: p, odds: null, impliedProb: null, dataQuality: 'magas', sampleSize: 10, supportingIndicators: 2,
        preKickoff: true, availability: 'pro_on_request',
        ...(opts.served ? (({ model, prob }) => ({ servedModel: model, servedProb: prob }))(opts.served(p, s.type, i)) : { servedProb: p, servedModel: ENGINE_VERSION }),
      };
    });
    archive.insertVersions(drafts);
    const outcomes = drafts.map((d, k) => ({ market: d.market, status: (rnd() < specs[k].truth(d.modelProb) ? 'won' : 'lost') as 'won' | 'lost' }));
    archive.settle({ matchId, homeGoals: 1, awayGoals: 0, resultKickoff: iso(kickoff), settledAt: iso(kickoff + 3 * H), outcomes });
  }
}

const threeMarkets = (truth: (p: number) => number) => (): MarketSpec[] => [
  { market: 'O2.5', type: 'gólszám', truth },
  { market: '1X', type: 'dupla esély', truth },
  { market: 'HOME_O0.5', type: 'csapat gólszám', truth },
];

interface Ctx { db: DB; archive: SqliteTipArchiveStore; store: SqliteModelLearningStore; clock: { t: number }; svc: (o?: Partial<{ allowPromotion: boolean; store: ModelLearningStore }>) => ModelLearningService }

function ctx(): Ctx {
  const db = new DatabaseSync(':memory:');
  const archive = new SqliteTipArchiveStore(db);
  const store = new SqliteModelLearningStore(db);
  const clock = { t: Date.parse('2026-10-10T12:00:00.000Z') };
  return {
    db, archive, store, clock,
    svc: (o = {}) => new ModelLearningService(o.store ?? store, { now: () => new Date(clock.t), allowPromotion: o.allowPromotion ?? false }),
  };
}

const archiveSnapshot = (db: DB) => JSON.stringify(db.prepare('SELECT * FROM model_tip_archive ORDER BY id').all());
const versions = (db: DB) => db.prepare('SELECT id, status FROM model_calibration_versions ORDER BY id').all() as { id: string; status: string }[];
const events = (db: DB) => db.prepare('SELECT kind, model_id FROM model_learning_events ORDER BY at, rowid').all() as { kind: string; model_id: string | null }[];

/** Közvetlenül beszúrt, érvényes jelölt (az életciklus-tesztekhez). */
/** A jelölthöz sikeres mintán kívüli kiértékelést rögzít (az aktiválás feltétele). */
async function passShadow(store: SqliteModelLearningStore, id: string) {
  await store.appendEvent({ kind: 'shadow_evaluation', modelId: id, actor: 'teszt', details: { candidateId: id, outcome: 'passed' } });
}

async function insertCandidate(store: SqliteModelLearningStore, id: string, status: 'eligible' | 'rejected' = 'eligible', params: unknown = { global: { a: 0.01, b: 0.9 }, byMarketType: {}, lambda: 8 }, base = ENGINE_VERSION) {
  await store.insertVersion({
    id, baseEngineVersion: base, method: CALIBRATION_METHOD, params, dataFingerprint: 'f'.repeat(64), trainingWindow: {}, metrics: {},
    gateResult: { passed: status === 'eligible', reasons: [] }, status, statusReason: null,
  });
}

// ---------------------------------------------------------------------------
// 1) Statisztikai alapok
// ---------------------------------------------------------------------------

describe('kalibrációs statisztika', () => {
  it('erős büntetésnél az illesztés az identitásnál marad (kis adaton nem „tanul” bele a zajba)', () => {
    const rnd = prng(1);
    const pts = Array.from({ length: 50 }, () => { const p = 0.1 + rnd() * 0.8; return { x: logit(p), y: (rnd() < p ? 1 : 0) as 0 | 1, w: 1 }; });
    const f = fitPlatt(pts, { a: 0, b: 1 }, 1e6);
    expect(Math.abs(f.a)).toBeLessThan(1e-3);
    expect(Math.abs(f.b - 1)).toBeLessThan(1e-3);
  });

  it('nagy, túlmagabiztos mintán visszanyeri a valódi meredekséget (~0,5)', () => {
    const rnd = prng(2);
    const pts = Array.from({ length: 20000 }, () => { const p = 0.05 + rnd() * 0.9; return { x: logit(p), y: (rnd() < overconfident(p) ? 1 : 0) as 0 | 1, w: 1 }; });
    const f = fitPlatt(pts, { a: 0, b: 1 }, 0.5);
    expect(f.b).toBeGreaterThan(0.45);
    expect(f.b).toBeLessThan(0.55);
    expect(Math.abs(f.a)).toBeLessThan(0.05);
  });

  it('a bootstrap ugyanazzal a maggal reprodukálható, más maggal más', () => {
    const d = Array.from({ length: 200 }, (_, i) => Math.sin(i));
    expect(bootstrapMeanCi(d, 500, 0.95, 7)).toEqual(bootstrapMeanCi(d, 500, 0.95, 7));
    expect(bootstrapMeanCi(d, 500, 0.95, 7)).not.toEqual(bootstrapMeanCi(d, 500, 0.95, 8));
  });

  it('validateParams: szerkezet és tartomány', () => {
    expect(validateParams({ global: { a: 0, b: 1 }, byMarketType: {}, lambda: 2 })).toBe(true);
    expect(validateParams({ global: { a: 0, b: 9 }, byMarketType: {}, lambda: 2 })).toBe(false);
    expect(validateParams({ global: { a: Number.NaN, b: 1 }, byMarketType: {}, lambda: 2 })).toBe(false);
    expect(validateParams({ global: { a: 0, b: 1 }, byMarketType: { x: { a: 5, b: 1 } }, lambda: 2 })).toBe(false);
    expect(validateParams('{"global":{}}')).toBe(false);
    expect(validateParams(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2) Adatérvényesség: csak lezárt, kezdés előtti, egyedi megfigyelés
// ---------------------------------------------------------------------------

describe('tanító adat érvényessége', () => {
  const row = (over: Partial<ArchiveTrainingRow>): ArchiveTrainingRow => ({
    id: 'r', matchId: 'm', market: 'O2.5', marketType: 'gólszám', leagueId: 'L', generatedAt: '2026-01-01T07:00:00.000Z',
    kickoff: '2026-01-01T12:00:00.000Z', resultKickoff: '2026-01-01T12:00:00.000Z', modelProb: 0.6, settlementStatus: 'won',
    engineVersion: ENGINE_VERSION, origin: 'live', preKickoff: true, homeGoals: 2, awayGoals: 1,
    provenance: 'legacy_baseline', servedProb: null, servedModel: null, ...over,
  });

  it('kizárja a függő, érvénytelen, nem elszámolható, kezdés utáni, eredmény nélküli, duplikált és idegen sorokat', () => {
    const svc = ctx().svc();
    const { obs, excluded } = svc.buildObservations([
      row({ id: '1', matchId: 'a' }),
      row({ id: '2', matchId: 'b', settlementStatus: 'pending' }),
      row({ id: '3', matchId: 'c', settlementStatus: 'void' }),
      row({ id: '4', matchId: 'd', settlementStatus: 'unsupported' }),
      row({ id: '5', matchId: 'e', preKickoff: false }),
      row({ id: '6', matchId: 'f', generatedAt: '2026-01-01T12:30:00.000Z' }),
      row({ id: '7', matchId: 'g', resultKickoff: '2026-01-01T06:00:00.000Z' }), // a kezdés korábbra került → már kezdés utáni
      row({ id: '8', matchId: 'h', homeGoals: null }),
      row({ id: '9', matchId: 'a' }), // duplikált (meccs, piac)
      row({ id: '10', matchId: 'i', engineVersion: 'masik-motor' }),
      row({ id: '11', matchId: 'j', origin: 'demo' }),
      row({ id: '12', matchId: 'k', modelProb: 1 }),
      row({ id: '13', matchId: 'l', settlementStatus: 'lost' }),
    ]);
    expect(obs.map((o) => [o.id, o.y])).toEqual([['1', 1], ['13', 0]]);
    expect(excluded).toEqual({
      unresolved: 1, void: 1, unsupported: 1, not_pre_kickoff: 3, missing_result: 1, duplicate: 1,
      wrong_engine_or_origin: 2, invalid_probability: 1,
    });
  });

  it('az elhalasztott (soha el nem számolt) meccs nem kerül a tanító adatba', async () => {
    const c = ctx();
    seedArchive(c.archive, { matches: 3, seed: 3, markets: threeMarkets(calibrated) });
    c.archive.insertVersions([{
      matchId: 'postponed', market: 'O2.5', versionNo: 1, contentHash: 'p'.padStart(64, '0'), engineVersion: ENGINE_VERSION,
      generatedAt: iso(START - 5 * H), origin: 'live', matchLabel: 'x', leagueId: 'L1', leagueName: 'L', kickoff: iso(START),
      marketLabel: 'x', marketType: 'gólszám', category: 'mérsékelt', modelProb: 0.5, odds: null, impliedProb: null,
      dataQuality: 'magas', sampleSize: 1, supportingIndicators: 1, preKickoff: true, availability: 'pro_on_request',
      servedProb: 0.5, servedModel: ENGINE_VERSION,
    }]);
    const svc = c.svc();
    const { obs, excluded } = svc.buildObservations(await c.store.loadArchive(ENGINE_VERSION, 1000));
    expect(obs.some((o) => o.matchId === 'postponed')).toBe(false);
    expect(excluded.unresolved).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3) Időrendi felosztás és szivárgás
// ---------------------------------------------------------------------------

describe('időrendi felosztás és szivárgás-védelem', () => {
  const synth = (n: number): Observation[] => {
    const rnd = prng(4);
    return Array.from({ length: n }).flatMap((_, i) => ['O2.5', '1X'].map((market) => {
      const p = 0.1 + rnd() * 0.8;
      return { id: `${i}${market}`, matchId: `m${i}`, market, marketType: market === '1X' ? 'dupla esély' : 'gólszám', leagueId: 'L',
        kickoff: START + i * 6 * H, generatedAt: START + i * 6 * H - 5 * H, prob: p, y: (rnd() < p ? 1 : 0) as 0 | 1 };
    }));
  };

  it('tanító < validáció < holdout időrendben, embargóval, és egy meccs sosem kerül két szakaszba', () => {
    const s = chronologicalSplit(synth(500), LEARNING_THRESHOLDS);
    const maxT = Math.max(...s.train.map((o) => o.kickoff));
    const minV = Math.min(...s.validation.map((o) => o.kickoff));
    const maxV = Math.max(...s.validation.map((o) => o.kickoff));
    const minH = Math.min(...s.holdout.map((o) => o.kickoff));
    expect(minV).toBeGreaterThanOrEqual(maxT + LEARNING_THRESHOLDS.embargoMs);
    expect(minH).toBeGreaterThanOrEqual(maxV + LEARNING_THRESHOLDS.embargoMs);
    const sets = [s.train, s.validation, s.holdout].map((l) => new Set(l.map((o) => o.matchId)));
    for (const id of sets[2]) { expect(sets[0].has(id)).toBe(false); expect(sets[1].has(id)).toBe(false); }
    for (const id of sets[1]) expect(sets[0].has(id)).toBe(false);
    expect(s.embargoed).toBeGreaterThan(0);
  });

  it('a holdout semmilyen módon nem befolyásolja a jelöltet (a holdout-eredmények átírása nem változtat a paramétereken)', () => {
    const s = chronologicalSplit(synth(500), LEARNING_THRESHOLDS);
    const a = fitCandidate(s, LEARNING_THRESHOLDS);
    const flipped = { ...s, holdout: s.holdout.map((o) => ({ ...o, y: (1 - o.y) as 0 | 1, prob: 1 - o.prob })) };
    const b = fitCandidate(flipped, LEARNING_THRESHOLDS);
    expect(b.params).toEqual(a.params);
    expect(b.validationLogLoss).toEqual(a.validationLogLoss);
  });
});

// ---------------------------------------------------------------------------
// 4) Kiértékelés: elégtelen adat, gyenge javulás, igazolt javulás, piac-romlás
// ---------------------------------------------------------------------------

describe('kiértékelés és kapuk', () => {
  it('elégtelen adat: árnyék-mód, indoklás, nincs jelölt, az alap motor marad', async () => {
    const c = ctx();
    seedArchive(c.archive, { matches: 60, seed: 5, markets: threeMarkets(overconfident) });
    const r = await c.svc().evaluate('admin-1');
    expect(r.status).toBe('insufficient_data');
    if (r.status === 'locked') throw new Error('unreachable');
    expect(r.summary.reasons.join(' ')).toMatch(/árnyék-módban marad/);
    expect(r.summary.validMatches).toBe(60);
    expect(versions(c.db)).toEqual([]);
    expect(events(c.db).map((e) => e.kind)).toEqual(['insufficient_data']);
    const st = await c.svc().status();
    expect(st).toMatchObject({ activeModelId: null, servedModel: ENGINE_VERSION, promotionEnabled: false, locked: false });
    expect(st.lastRun.status).toBe('insufficient_data');
    expect(await c.svc().resolveActive()).toMatchObject({ kind: 'baseline' });
  });

  it('jól kalibrált alap motor: a javulás túl kicsi / nem igazolt → elutasítva', async () => {
    const c = ctx();
    seedArchive(c.archive, { matches: 800, seed: 6, markets: threeMarkets(calibrated) });
    const r = await c.svc().evaluate('admin-1');
    expect(r.status).toBe('rejected');
    if (r.status === 'locked') throw new Error('unreachable');
    expect(r.summary.reasons.join(' ')).toMatch(/relatív javulása|nem igazolt/);
    expect(versions(c.db)).toEqual([{ id: r.summary.candidateId, status: 'rejected' }]);
  });

  it('a minimális mintán a valódi, de kis mintán nem igazolható javulás is elutasítva (konzervatív kapu)', async () => {
    const c = ctx();
    seedArchive(c.archive, { matches: 800, seed: 7, markets: threeMarkets(overconfident) });
    const r = await c.svc().evaluate('admin-1');
    expect(r.status).toBe('rejected');
    if (r.status === 'locked') throw new Error('unreachable');
    expect(r.summary.reasons.join(' ')).toMatch(/nem igazolt/);
  });

  it('túlmagabiztos alap motor, elegendő adattal: igazolt javulás az érintetlen holdouton → „eligible”, de NEM aktív', async () => {
    const c = ctx();
    seedArchive(c.archive, { matches: 2000, seed: 7, markets: threeMarkets(overconfident) });
    const before = archiveSnapshot(c.db);
    const r = await c.svc().evaluate('admin-1');
    expect(r.status).toBe('eligible');
    if (r.status === 'locked') throw new Error('unreachable');
    const v = (await c.store.getVersion(r.summary.candidateId!))!;
    const m = v.metrics as { holdout: { relativeLogLossImprovement: number; logLossDeltaCi: [number, number]; brierDelta: number } };
    expect(m.holdout.relativeLogLossImprovement).toBeGreaterThanOrEqual(0.01);
    expect(m.holdout.logLossDeltaCi[0]).toBeGreaterThan(0);
    expect(m.holdout.brierDelta).toBeGreaterThanOrEqual(0);
    expect((v.params as CalibrationParams).global.b).toBeLessThan(0.8);
    // SOHA nem aktivál automatikusan; az archívum változatlan
    expect((await c.store.getState()).activeModelId).toBeNull();
    expect(archiveSnapshot(c.db)).toBe(before);
    expect(r.summary.sizes!.holdoutMatches).toBeGreaterThanOrEqual(150);
  });

  it('piactípus-regresszió: ha egy megfelelően mintázott piac romlik, a jelölt elutasítva', async () => {
    const c = ctx();
    seedArchive(c.archive, {
      matches: 800, seed: 8,
      markets: (_i, rnd) => [
        { market: 'O2.5', type: 'gólszám', truth: overconfident },
        { market: '1X', type: 'dupla esély', truth: overconfident },
        ...(rnd() < 0.4 ? [
          { market: 'BTTS_Y', type: 'BTTS', truth: underconfident },
          { market: 'BTTS_N', type: 'BTTS', truth: underconfident },
        ] : []),
      ],
    });
    const r = await c.svc().evaluate('admin-1');
    expect(r.status).toBe('rejected');
    if (r.status === 'locked') throw new Error('unreachable');
    expect(r.summary.reasons.join(' ')).toMatch(/„BTTS”/);
  });

  it('reprodukálható: ugyanarra az adatra ugyanaz a jelölt (azonosító, paraméter, metrika), nincs duplikált sor', async () => {
    const c = ctx();
    seedArchive(c.archive, { matches: 800, seed: 7, markets: threeMarkets(overconfident) });
    const a = await c.svc().evaluate('admin-1');
    c.clock.t += H;
    const b = await c.svc().evaluate('admin-2');
    if (a.status === 'locked' || b.status === 'locked') throw new Error('unreachable');
    expect(b.summary.candidateId).toBe(a.summary.candidateId);
    expect(versions(c.db)).toHaveLength(1);
    // egy másik, független adatbázisban ugyanaz az eredmény
    const c2 = ctx();
    seedArchive(c2.archive, { matches: 800, seed: 7, markets: threeMarkets(overconfident) });
    const a2 = await c2.svc().evaluate('admin-1');
    if (a2.status === 'locked') throw new Error('unreachable');
    expect(a2.summary.candidateId).toBe(a.summary.candidateId);
    expect((await c2.store.getVersion(a2.summary.candidateId!))!.metrics).toEqual((await c.store.getVersion(a.summary.candidateId!))!.metrics);
  });
});

// ---------------------------------------------------------------------------
// 5) Hibás / megszakadt / párhuzamos futás
// ---------------------------------------------------------------------------

describe('futás-zár, hibák, párhuzamosság', () => {
  it('hibás futás: „failed”, auditált, a zár felszabadul, a következő futás rendben indul', async () => {
    const c = ctx();
    const broken = new Proxy(c.store, {
      get(t, p, r) {
        if (p === 'loadArchive') return async () => { throw new Error('adatbázis-hiba'); };
        const v = Reflect.get(t, p, r); return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as ModelLearningStore;
    const r = await c.svc({ store: broken }).evaluate('admin-1');
    expect(r.status).toBe('failed');
    const st = await c.store.getState();
    expect(st).toMatchObject({ lockOwner: null, lastRunStatus: 'failed', lastRunError: 'adatbázis-hiba' });
    expect(events(c.db).map((e) => e.kind)).toEqual(['failure']);
    expect((await c.svc().evaluate('admin-1')).status).toBe('insufficient_data');
  });

  it('időkeret-túllépés: megszakítja a futást, nem ír jelöltet', async () => {
    const c = ctx();
    seedArchive(c.archive, { matches: 800, seed: 7, markets: threeMarkets(overconfident) });
    const slow = new Proxy(c.store, {
      get(t, p, r) {
        if (p === 'loadArchive') return async (...a: [string, number]) => { const rows = await t.loadArchive(...a); c.clock.t += 60_000; return rows; };
        const v = Reflect.get(t, p, r); return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as ModelLearningStore;
    const r = await c.svc({ store: slow }).evaluate('admin-1');
    expect(r.status).toBe('failed');
    if (r.status === 'locked') throw new Error('unreachable');
    expect(r.summary.reasons.join(' ')).toMatch(/időkeret/);
    expect(versions(c.db)).toEqual([]);
  });

  it('összeomlott futás (a zár bent ragadt): a lease lejártáig nem indul új, utána igen', async () => {
    const c = ctx();
    const now = c.clock.t;
    expect(await c.store.tryAcquireLock('halott-folyamat', iso(now), iso(now + LEARNING_THRESHOLDS.lockLeaseMs))).toBe(true);
    expect((await c.svc().evaluate('admin-1')).status).toBe('locked');
    expect((await c.svc().status()).locked).toBe(true);
    c.clock.t = now + LEARNING_THRESHOLDS.lockLeaseMs + 1000;
    expect((await c.svc().evaluate('admin-1')).status).toBe('insufficient_data');
  });

  it('két párhuzamos kiértékelésből csak egy fut', async () => {
    const c = ctx();
    seedArchive(c.archive, { matches: 60, seed: 9, markets: threeMarkets(calibrated) });
    const [a, b] = await Promise.all([c.svc().evaluate('a'), c.svc().evaluate('b')]);
    expect([a.status, b.status].sort()).toEqual(['insufficient_data', 'locked']);
  });
});

// ---------------------------------------------------------------------------
// 6) Aktiválás, visszaállítás, visszaesés
// ---------------------------------------------------------------------------

describe('életciklus: aktiválás, visszaállítás, alap motorra visszaesés', () => {
  it('élesben (alapértelmezés) az aktiválás tiltva – auditált elutasítás, az állapot nem változik', async () => {
    const c = ctx();
    await insertCandidate(c.store, 'cal-aaaaaaaaaaaa');
    // a szolgáltatás alapértéke (opciók nélkül) és az éles bekötés is tiltott aktiválást ad
    const bare = new ModelLearningService(c.store);
    expect(bare.promotionEnabled).toBe(false);
    const wiring = readFileSync(new URL('../src/server/index.ts', import.meta.url), 'utf8');
    expect(wiring).toMatch(/new ModelLearningService\(container\.learning, \{ allowPromotion: false \}\)/);
    const r = await bare.promote('cal-aaaaaaaaaaaa', 'admin-1');
    expect(r).toMatchObject({ ok: false, code: 'PROMOTION_DISABLED' });
    expect((await c.store.getState()).activeModelId).toBeNull();
    expect(events(c.db).map((e) => e.kind)).toEqual(['promotion_refused']);
  });

  it('csak „eligible”, kompatibilis, érvényes jelölt aktiválható', async () => {
    const c = ctx();
    const svc = c.svc({ allowPromotion: true });
    await insertCandidate(c.store, 'cal-bbbbbbbbbbbb', 'rejected');
    await insertCandidate(c.store, 'cal-cccccccccccc', 'eligible', { global: { a: 0, b: 1 }, byMarketType: {}, lambda: 1 }, 'regi-motor');
    await insertCandidate(c.store, 'cal-dddddddddddd', 'eligible', { global: { a: 0, b: 40 }, byMarketType: {}, lambda: 1 });
    expect((await svc.promote('cal-bbbbbbbbbbbb', 'x')).code).toBe('NOT_ELIGIBLE');
    expect((await svc.promote('cal-cccccccccccc', 'x')).code).toBe('INCOMPATIBLE');
    expect((await svc.promote('cal-dddddddddddd', 'x')).code).toBe('INVALID');
    expect((await svc.promote('cal-eeeeeeeeeeee', 'x')).code).toBe('NOT_FOUND');
    expect((await c.store.getState()).activeModelId).toBeNull();
  });

  it('atomikus aktiválás: két párhuzamos kísérletből pontosan egy nyer, a mutató konzisztens', async () => {
    const c = ctx();
    await insertCandidate(c.store, 'cal-111111111111');
    await insertCandidate(c.store, 'cal-222222222222');
    await passShadow(c.store, 'cal-111111111111');
    await passShadow(c.store, 'cal-222222222222');
    const [a, b] = await Promise.all([
      c.svc({ allowPromotion: true }).promote('cal-111111111111', 'admin-a'),
      c.svc({ allowPromotion: true }).promote('cal-222222222222', 'admin-b'),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a.code, b.code]).toContain('CONFLICT');
    const st = await c.store.getState();
    const winner = a.ok ? 'cal-111111111111' : 'cal-222222222222';
    expect(st).toMatchObject({ activeModelId: winner, stateVersion: 1 });
    expect(versions(c.db).filter((v) => v.status === 'active').map((v) => v.id)).toEqual([winner]);
  });

  it('aktiválás → csere → visszaállítás az előzőre → visszaállítás az alap motorra', async () => {
    const c = ctx();
    const svc = c.svc({ allowPromotion: true });
    await insertCandidate(c.store, 'cal-aaaaaaaaaaa1');
    await insertCandidate(c.store, 'cal-aaaaaaaaaaa2', 'eligible', { global: { a: 0.02, b: 0.8 }, byMarketType: {}, lambda: 8 });
    await passShadow(c.store, 'cal-aaaaaaaaaaa1');
    await passShadow(c.store, 'cal-aaaaaaaaaaa2');
    expect((await svc.promote('cal-aaaaaaaaaaa1', 'admin')).ok).toBe(true);
    expect(await svc.resolveActive()).toMatchObject({ kind: 'calibrated', modelId: 'cal-aaaaaaaaaaa1' });
    expect((await svc.promote('cal-aaaaaaaaaaa2', 'admin')).ok).toBe(true);
    expect(await c.store.getState()).toMatchObject({ activeModelId: 'cal-aaaaaaaaaaa2', previousModelId: 'cal-aaaaaaaaaaa1' });
    expect(versions(c.db)).toEqual([{ id: 'cal-aaaaaaaaaaa1', status: 'retired' }, { id: 'cal-aaaaaaaaaaa2', status: 'active' }]);

    expect(await svc.rollback('admin')).toMatchObject({ ok: true, activeModelId: 'cal-aaaaaaaaaaa1' });
    expect(versions(c.db)).toEqual([{ id: 'cal-aaaaaaaaaaa1', status: 'active' }, { id: 'cal-aaaaaaaaaaa2', status: 'rolled_back' }]);
    expect(await svc.resolveActive()).toMatchObject({ kind: 'calibrated', modelId: 'cal-aaaaaaaaaaa1' });

    expect(await svc.rollback('admin')).toMatchObject({ ok: true, activeModelId: null });
    expect(await svc.resolveActive()).toMatchObject({ kind: 'baseline', engineVersion: ENGINE_VERSION });
    expect((await svc.rollback('admin')).code).toBe('NOTHING_ACTIVE');
    expect(events(c.db).map((e) => e.kind).filter((k) => k !== 'shadow_evaluation')).toEqual(['promotion', 'promotion', 'rollback', 'rollback']);
  });

  it('a visszaállítás a tiltott aktiválás mellett is működik', async () => {
    const c = ctx();
    await insertCandidate(c.store, 'cal-ffffffffffff');
    await passShadow(c.store, 'cal-ffffffffffff');
    expect((await c.svc({ allowPromotion: true }).promote('cal-ffffffffffff', 'admin')).ok).toBe(true);
    expect(await c.svc().rollback('admin')).toMatchObject({ ok: true, activeModelId: null });
  });

  it('visszaesés az alap motorra: sérült, inkompatibilis vagy olvashatatlan konfiguráció', async () => {
    const c = ctx();
    // sérült paraméterek egy aktívként megjelölt verzióban (pl. kézi beavatkozás után)
    await insertCandidate(c.store, 'cal-0000000000aa', 'eligible', { global: { a: 'x', b: 1 } });
    await c.store.casActive(0, 'cal-0000000000aa', null, iso(c.clock.t));
    await c.store.setVersionStatus('cal-0000000000aa', 'active', null, ['eligible'], iso(c.clock.t));
    const r = await c.svc().resolveActive();
    expect(r).toMatchObject({ kind: 'baseline' });
    if (r.kind === 'baseline') expect(r.reason).toMatch(/sérült/);
    expect(events(c.db).map((e) => e.kind)).toContain('fallback');

    // inkompatibilis alap motor
    const c2 = ctx();
    await insertCandidate(c2.store, 'cal-0000000000bb', 'eligible', { global: { a: 0, b: 1 }, byMarketType: {}, lambda: 1 }, 'xg-poisson-0');
    await c2.store.casActive(0, 'cal-0000000000bb', null, iso(c2.clock.t));
    await c2.store.setVersionStatus('cal-0000000000bb', 'active', null, ['eligible'], iso(c2.clock.t));
    expect(await c2.svc().resolveActive()).toMatchObject({ kind: 'baseline' });

    // a mutató aktív, de a verzió állapota nem „active”
    const c3 = ctx();
    await insertCandidate(c3.store, 'cal-0000000000cc');
    await c3.store.casActive(0, 'cal-0000000000cc', null, iso(c3.clock.t));
    expect(await c3.svc().resolveActive()).toMatchObject({ kind: 'baseline' });

    // olvashatatlan állapot
    const failing = new Proxy(c3.store, {
      get(t, p, rcv) { if (p === 'getState') return async () => { throw new Error('nincs tábla'); }; const v = Reflect.get(t, p, rcv); return typeof v === 'function' ? v.bind(t) : v; },
    }) as ModelLearningStore;
    expect(await c3.svc({ store: failing }).resolveActive()).toMatchObject({ kind: 'baseline' });
  });

  it('applyCalibration: identitás-paraméter nem változtat; piactípus-paraméter elsőbbséget kap', () => {
    const id: CalibrationParams = { global: { a: 0, b: 1 }, byMarketType: {}, lambda: 1 };
    expect(applyCalibration(0.37, id, 'gólszám')).toBeCloseTo(0.37, 12);
    const p: CalibrationParams = { global: { a: 0, b: 1 }, byMarketType: { BTTS: { a: 0, b: 0.5 } }, lambda: 1 };
    expect(applyCalibration(0.8, p, 'BTTS')).toBeCloseTo(sigmoid(0.5 * logit(0.8)), 12);
    expect(applyCalibration(0.8, p, 'gólszám')).toBeCloseTo(0.8, 12);
  });
});

// ---------------------------------------------------------------------------
// 7) Megváltoztathatatlanság (SQLite-megfelelő) és a migráció
// ---------------------------------------------------------------------------

describe('megváltoztathatatlanság és migráció', () => {
  it('a jelölt tartalma nem írható át; az audit-napló és a sorok nem törölhetők', async () => {
    const c = ctx();
    await insertCandidate(c.store, 'cal-999999999999');
    await c.store.appendEvent({ kind: 'evaluation', modelId: null, actor: 'x', details: {} });
    expect(() => c.db.prepare(`UPDATE model_calibration_versions SET params = '{}'`).run()).toThrow(/nem módosítható/);
    expect(() => c.db.prepare(`UPDATE model_learning_events SET kind = 'failure'`).run()).toThrow(/nem módosítható/);
    for (const t of ['model_calibration_versions', 'model_learning_events', 'model_learning_state']) {
      expect(() => c.db.prepare(`DELETE FROM ${t}`).run(), t).toThrow(/nem törölhetők/);
    }
  });

  it('0015: csak új objektumok, legszűkebb jogkör, nincs kliens-hozzáférés, nincs security definer', () => {
    const sql = readFileSync(new URL('../supabase/migrations/0015_model_learning.sql', import.meta.url), 'utf8');
    const code = sql.split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');
    for (const t of ['model_calibration_versions', 'model_learning_state', 'model_learning_events']) {
      expect(code).toContain(`create table if not exists public.${t}`);
      expect(code).toContain(`revoke all on public.${t} from anon, authenticated;`);
      expect(code).toContain(`alter table public.${t} enable row level security;`);
    }
    expect(code).toMatch(/grant select, update on public\.model_learning_state to service_role/);
    expect(code).toMatch(/grant select, insert on public\.model_learning_events to service_role/);
    expect(code).toMatch(/before truncate on public\.%I for each statement/);
    expect(code).not.toMatch(/create policy/i);
    expect(code).not.toMatch(/security definer/i);
    expect(code).not.toMatch(/^\s*(drop|alter table (?!public\.(model_calibration_versions|model_learning_state|model_learning_events)))/im);
    // a 0014 archívumot nem érinti
    expect(code).not.toMatch(/model_tip_archive/);
  });
});

// ---------------------------------------------------------------------------
// 8) Admin-végpontok: jogosultság, nincs drága újraszámolás a státusznál
// ---------------------------------------------------------------------------

describe('admin-végpontok', () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise((r) => server!.close(() => r(null))); server = null; });

  async function app(c: Ctx, svc: ModelLearningService) {
    const a = express();
    a.use(express.json());
    a.use('/api', (req, res, next) => {
      const id = req.header('x-test-user') ?? null;
      res.locals.plan = { enforced: true, user: id ? { id, email: `${id}@teszt.hu` } : null, pro: false, admin: req.header('x-test-admin') === '1' && !!id };
      next();
    });
    a.use('/api/admin/model-learning', requireAdmin, modelLearningRouter(svc));
    a.use('/api', (_req, res) => res.status(404).json({ error: 'Ismeretlen API végpont.' }));
    server = await new Promise((r) => { const s = a.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    return (method: string, path: string, h: Record<string, string> = {}) => fetch(base + path, { method, headers: h });
  }

  it('névtelen → 401, nem admin → 403 minden végponton; a tiltott hívás nem indít futást', async () => {
    const c = ctx();
    const call = await app(c, c.svc());
    for (const [m, p] of [['GET', '/api/admin/model-learning/status'], ['POST', '/api/admin/model-learning/evaluate'],
      ['POST', '/api/admin/model-learning/promote/cal-aaaaaaaaaaaa'], ['POST', '/api/admin/model-learning/rollback']]) {
      expect((await call(m, p)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, { 'x-test-user': 'u1' })).status, `${m} ${p}`).toBe(403);
    }
    expect((await c.store.getState()).lastRunStatus).toBeNull();
    expect(events(c.db)).toEqual([]);
  });

  it('admin: státusz, kiértékelés, aktiválás (élesben tiltva) – nyilvános végpont nincs', async () => {
    const c = ctx();
    seedArchive(c.archive, { matches: 30, seed: 10, markets: threeMarkets(calibrated) });
    let loads = 0;
    const counting = new Proxy(c.store, {
      get(t, p, r) {
        if (p === 'loadArchive') return async (...a: [string, number]) => { loads++; return t.loadArchive(...a); };
        const v = Reflect.get(t, p, r); return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as ModelLearningStore;
    const call = await app(c, c.svc({ store: counting }));
    const admin = { 'x-test-user': 'admin1', 'x-test-admin': '1' };
    const s1 = await call('GET', '/api/admin/model-learning/status', admin);
    expect(s1.status).toBe(200);
    expect(loads).toBe(0); // a státusz nem számol újra
    const body = await s1.json();
    expect(body).toMatchObject({ servedModel: ENGINE_VERSION, promotionEnabled: false, activeModelId: null, nextScheduledEvaluation: null });
    expect(JSON.stringify(body)).not.toMatch(/service_role|SUPABASE|admin1@teszt\.hu/);

    const ev = await call('POST', '/api/admin/model-learning/evaluate', admin);
    expect(ev.status).toBe(200);
    expect((await ev.json()).status).toBe('insufficient_data');
    expect(loads).toBe(1);
    expect((await c.store.listEvents(5))[0]).toMatchObject({ kind: 'insufficient_data', actor: 'admin1' });

    expect((await call('POST', '/api/admin/model-learning/promote/nem-azonosito', admin)).status).toBe(400);
    await insertCandidate(c.store, 'cal-abcabcabcabc');
    const pr = await call('POST', '/api/admin/model-learning/promote/cal-abcabcabcabc', admin);
    expect(pr.status).toBe(409);
    expect((await pr.json()).code).toBe('PROMOTION_DISABLED');

    expect((await call('GET', '/api/model-learning/status')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 9) Valószínűség-eredet: tanító bemenet, szennyeződés, mintán kívüli árnyék-kiértékelés
// ---------------------------------------------------------------------------

describe('valószínűség-eredet és mintán kívüli árnyék-kiértékelés', () => {
  const CAL = `${ENGINE_VERSION}+cal-0123456789ab`;
  const prow = (over: Partial<ArchiveTrainingRow>): ArchiveTrainingRow => ({
    id: 'r', matchId: 'm', market: 'O2.5', marketType: 'gólszám', leagueId: 'L', generatedAt: '2026-01-01T07:00:00.000Z',
    kickoff: '2026-01-01T12:00:00.000Z', resultKickoff: '2026-01-01T12:00:00.000Z', modelProb: 0.6, settlementStatus: 'won',
    engineVersion: ENGINE_VERSION, origin: 'live', preKickoff: true, homeGoals: 2, awayGoals: 1,
    provenance: 'recorded', servedProb: 0.6, servedModel: ENGINE_VERSION, ...over,
  });

  it('eredet-integritás: ellentmondásos eredetű sor kizárva; a tanító valószínűség mindig a nyers érték', () => {
    const svc = ctx().svc();
    const { obs, excluded } = svc.buildObservations([
      prow({ id: '1', matchId: 'a' }),                                                   // alap motor, kiszolgált = nyers
      prow({ id: '2', matchId: 'b', servedProb: 0.4, servedModel: CAL }),                // kalibráció szolgált ki
      prow({ id: '3', matchId: 'c', provenance: 'legacy_baseline', servedProb: null, servedModel: null }),
      prow({ id: '4', matchId: 'd', servedProb: 0.55 }),                                 // „alap motor”, de eltérő érték
      prow({ id: '5', matchId: 'e', servedModel: 'masik-motor' }),
      prow({ id: '6', matchId: 'f', servedModel: `${ENGINE_VERSION}+cal-XYZ` }),
      prow({ id: '7', matchId: 'g', provenance: 'legacy_baseline' }),                     // régi sor kiszolgált értékkel
      prow({ id: '8', matchId: 'h', servedProb: null }),
      prow({ id: '9', matchId: 'i', provenance: 'ismeretlen' }),
    ]);
    expect(obs.map((o) => [o.id, o.prob])).toEqual([['1', 0.6], ['2', 0.6], ['3', 0.6]]);
    expect(obs[1]).toMatchObject({ servedProb: 0.4, servedModel: CAL });
    expect(excluded).toEqual({ provenance_mismatch: 1, invalid_provenance: 5 });
  });

  it('SZENNYEZŐDÉS ELLEN: a kiszolgált (akár kalibrált) érték sosem tanító bemenet – azonos nyers adat → azonos jelölt', async () => {
    const a = ctx();
    seedArchive(a.archive, { matches: 800, seed: 21, markets: threeMarkets(overconfident) });
    const b = ctx();
    seedArchive(b.archive, {
      matches: 800, seed: 21, markets: threeMarkets(overconfident),
      // minden második meccset egy (kitalált) kalibráció „szolgált ki”, nagyon eltérő értékkel
      served: (p, _t, i) => (i % 2 ? { model: CAL, prob: Math.min(0.99, p * 0.5 + 0.4) } : { model: ENGINE_VERSION, prob: p }),
    });
    const ra = await a.svc().evaluate('x');
    const rb = await b.svc().evaluate('x');
    if (ra.status === 'locked' || rb.status === 'locked') throw new Error('unreachable');
    expect(rb.summary.candidateId).toBe(ra.summary.candidateId);
    expect((await b.store.getVersion(rb.summary.candidateId!))!.params).toEqual((await a.store.getVersion(ra.summary.candidateId!))!.params);
    expect((await b.store.getVersion(rb.summary.candidateId!))!.metrics).toEqual((await a.store.getVersion(ra.summary.candidateId!))!.metrics);
  });

  it('árnyék-kiértékelés: csak mintán kívüli adat; a jelölt által kiszolgált sornál a rögzített érték (eltérés kizárva); aktiválás csak sikeres árnyék-kiértékelés után', async () => {
    const c = ctx();
    // 1) történeti adat → jelölt
    seedArchive(c.archive, { matches: 2000, seed: 7, markets: threeMarkets(overconfident) });
    const ev = await c.svc().evaluate('admin');
    expect(ev.status).toBe('eligible');
    if (ev.status === 'locked') throw new Error('unreachable');
    const id = ev.summary.candidateId!;
    const params = (await c.store.getVersion(id))!.params as CalibrationParams;
    const promoter = c.svc({ allowPromotion: true });

    // 2) még nincs mintán kívüli adat → elégtelen; aktiválás elutasítva
    const s1 = await c.svc().evaluateShadow(id, 'admin');
    expect(s1.status).toBe('insufficient_data');
    expect((await promoter.promote(id, 'admin')).code).toBe('SHADOW_NOT_PASSED');

    // 3) mintán kívüli (a jelölt adatablaka utáni) meccsek; egy részüket a jelölt „szolgálta ki”
    const after = START + 2000 * 6 * H + 3 * 24 * H;
    const served = `${ENGINE_VERSION}+${id}`;
    seedArchive(c.archive, {
      matches: 1500, seed: 22, start: after, idPrefix: 'p', markets: threeMarkets(overconfident),
      served: (p, type, i) => (i === 1 ? { model: served, prob: p }                                   // manipulált: ≠ f(p)
        : i % 3 === 0 ? { model: served, prob: applyCalibration(p, params, type) }                    // valóban kiszolgált
          : { model: ENGINE_VERSION, prob: p }),
    });
    // a jelölt létrejötte ELŐTT generált, de későbbi kezdésű sorok: nem lehetnek mintán kívüliek
    seedArchive(c.archive, { matches: 20, seed: 23, start: after, idPrefix: 'early', markets: threeMarkets(overconfident), generatedAt: () => START });

    const s2 = await c.svc().evaluateShadow(id, 'admin');
    expect(s2.status).toBe('passed');
    if (!('result' in s2)) throw new Error('unreachable');
    const r = s2.result;
    expect(r.excluded.provenance_mismatch).toBeGreaterThanOrEqual(1);
    expect(r.excluded.before_cutoff).toBeGreaterThanOrEqual(2000 * 3 + 20 * 3 - 10);
    expect(r.sizes.servedByCandidate).toBeGreaterThan(1000);
    expect(r.sizes.shadowComputed).toBeGreaterThan(2000);
    expect(r.sizes.matches).toBeLessThanOrEqual(1500);
    expect(Date.parse(r.cutoff.kickoffAfter)).toBeGreaterThan(START + 1999 * 6 * H);
    expect(r.comparison!.logLossDeltaCi[0]).toBeGreaterThan(0);
    // a jelölt tartalma változatlan; az esemény auditált
    expect((await c.store.getVersion(id))!.params).toEqual(params);
    expect((await c.store.latestEvent(id, 'shadow_evaluation'))!.details).toMatchObject({ outcome: 'passed' });

    // 4) élesben továbbra is tiltott; tesztben (engedélyezve) most már aktiválható
    expect((await c.svc().promote(id, 'admin')).code).toBe('PROMOTION_DISABLED');
    expect((await promoter.promote(id, 'admin')).ok).toBe(true);
    expect(await promoter.resolveActive()).toMatchObject({ kind: 'calibrated', modelId: id });
    // visszaállítás → alap motor
    expect((await promoter.rollback('admin')).activeModelId).toBeNull();
    expect(await promoter.resolveActive()).toMatchObject({ kind: 'baseline', engineVersion: ENGINE_VERSION });
  }, 60_000);

  it('árnyék-kiértékelés: ismeretlen / érvénytelen jelölt, és párhuzamos futásnál a zár', async () => {
    const c = ctx();
    expect((await c.svc().evaluateShadow('cal-000000000000', 'a')).status).toBe('not_found');
    await insertCandidate(c.store, 'cal-0000000000dd', 'eligible', { global: { a: 0, b: 50 }, byMarketType: {}, lambda: 1 });
    expect((await c.svc().evaluateShadow('cal-0000000000dd', 'a')).status).toBe('invalid');
    await insertCandidate(c.store, 'cal-0000000000ee');
    expect(await c.store.tryAcquireLock('mas', iso(c.clock.t), iso(c.clock.t + 60_000))).toBe(true);
    expect((await c.svc().evaluateShadow('cal-0000000000ee', 'a')).status).toBe('locked');
  });

  it('0016: csak bővítés – régi sor „legacy”, kitalált kiszolgált érték nélkül; az őr az új oszlopokat is védi', () => {
    const sql = readFileSync(new URL('../supabase/migrations/0016_tip_archive_provenance.sql', import.meta.url), 'utf8');
    const code = sql.split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');
    expect(code).toMatch(/add column if not exists provenance\s+text not null default 'legacy_baseline'/);
    expect(code).toMatch(/add column if not exists served_prob\s+double precision;/);
    expect(code).toMatch(/add column if not exists served_model text;/);
    expect(code).toMatch(/provenance = 'legacy_baseline' and served_prob is null and served_model is null/);
    expect(code).toMatch(/served_model <> engine_version or served_prob = model_prob/);
    expect(code).toMatch(/new\.provenance, new\.served_prob, new\.served_model\)/);
    expect(code).not.toMatch(/\bupdate\s+public\.model_tip_archive\b/i);    // meglévő értéket nem ír át
    expect(code).not.toMatch(/^\s*drop\b/im);
    expect(code).not.toMatch(/security definer/i);
    // a listázó nézetek DEFINÍCIÓJÁHOZ nem nyúl (csak a jogaikat szűkíti)
    expect(code).not.toMatch(/create (or replace )?view public\.model_tip_archive(_counted)?_listing/);
    expect(code).toMatch(/revoke insert, update, delete, truncate, references, trigger\s+on public\.model_tip_archive_counted, public\.model_tip_archive_listing, public\.model_tip_archive_counted_listing\s+from service_role/);
  });
});
