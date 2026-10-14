/**
 * Az alap motor hibaelemzése (diagnostics-v1) – csak olvasó riport.
 *
 * Valódi `SqliteTipArchiveStore` + `SqliteModelLearningStore` memóriában; a
 * szintetikus (determinisztikus) adat a valódi archívum beszúrási és
 * elszámolási útján kerül be. Hálózat, Supabase, .env NINCS. A szintetikus
 * adat csak a kód helyességét teszteli – a production modell minőségéről
 * semmit nem bizonyít.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { SqliteTipArchiveStore, type ArchiveDraft } from '../src/server/tipArchive/store';
import { SqliteModelLearningStore } from '../src/server/modelLearning/store';
import { ModelLearningService } from '../src/server/modelLearning/service';
import { logit, prng, sigmoid, type Observation } from '../src/server/modelLearning/calibration';
import { NAIVE_MIN_HISTORY, naiveBaselineProbs, reliabilityTable, wilson } from '../src/server/modelLearning/diagnostics';
import { modelLearningRouter } from '../src/server/routes/modelLearning';
import { requireAdmin } from '../src/server/billing/entitlement';
import { ENGINE_VERSION } from '../src/shared/engine/version';
import { LEARNING_THRESHOLDS } from '../src/shared/modelLearning';

type DB = InstanceType<typeof DatabaseSync>;
const H = 3_600_000;
const START = Date.parse('2026-01-01T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const calibrated = (p: number) => p;
const overconfident = (p: number) => sigmoid(0.5 * logit(p));

/** Determinisztikus archívum a valódi beszúrási + elszámolási úton. */
function seed(archive: SqliteTipArchiveStore, o: { matches: number; seed: number; truth: (p: number) => number; spacingMs?: number; start?: number; prob?: (rnd: () => number) => number; settle?: (i: number) => boolean }) {
  const rnd = prng(o.seed);
  for (let i = 0; i < o.matches; i++) {
    const matchId = `m${String(i).padStart(5, '0')}`;
    const kickoff = (o.start ?? START) + i * (o.spacingMs ?? 6 * H);
    const drafts: ArchiveDraft[] = [['O2.5', 'gólszám'], ['1X', 'dupla esély'], ['HOME_O0.5', 'csapat gólszám']].map(([market, type], k) => {
      const p = o.prob ? o.prob(rnd) : 0.08 + rnd() * 0.84;
      return {
        matchId, market, versionNo: 1, contentHash: `${i}-${k}`.padStart(64, '0'), engineVersion: ENGINE_VERSION,
        generatedAt: iso(kickoff - 5 * H), origin: 'live', matchLabel: `H${i} – V${i}`, leagueId: i % 2 ? 'L2' : 'L1', leagueName: 'Liga',
        kickoff: iso(kickoff), marketLabel: market, marketType: type, category: 'mérsékelt', modelProb: p, odds: null, impliedProb: null,
        dataQuality: 'magas', sampleSize: 10, supportingIndicators: 2, preKickoff: true, availability: 'pro_on_request', servedProb: p, servedModel: ENGINE_VERSION,
      };
    });
    archive.insertVersions(drafts);
    if (o.settle && !o.settle(i)) continue; // függőben marad (pl. elhalasztott / még nem lezárt meccs)
    archive.settle({
      matchId, homeGoals: 1, awayGoals: 0, resultKickoff: iso(kickoff), settledAt: iso(kickoff + 3 * H),
      outcomes: drafts.map((d) => ({ market: d.market, status: (rnd() < o.truth(d.modelProb) ? 'won' : 'lost') as 'won' | 'lost' })),
    });
  }
}

function ctx() {
  const db = new DatabaseSync(':memory:');
  const archive = new SqliteTipArchiveStore(db);
  const store = new SqliteModelLearningStore(db);
  const svc = new ModelLearningService(store, { now: () => new Date('2026-10-14T12:00:00.000Z'), allowPromotion: false });
  return { db, archive, store, svc };
}
const snapshot = (db: DB) => JSON.stringify(['model_tip_archive', 'model_calibration_versions', 'model_learning_events', 'model_learning_state']
  .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));

const obs = (id: string, kickoff: number, generatedAt: number, y: 0 | 1, market = 'O2.5', prob = 0.5): Observation =>
  ({ id, matchId: id, market, marketType: 'gólszám', leagueId: 'L', kickoff, generatedAt, prob, y });

describe('alap motor hibaelemzése (diagnostics-v1)', () => {
  it('CSAK OLVAS: nem ír az adatbázisba, nem hoz létre jelöltet, az eredeti model_prob és motorverzió változatlan', async () => {
    const c = ctx();
    seed(c.archive, { matches: 200, seed: 1, truth: calibrated });
    const before = snapshot(c.db);
    const r = await c.svc.diagnostics();
    expect(snapshot(c.db)).toBe(before);
    expect(r.baseEngineVersion).toBe(ENGINE_VERSION);
    expect(r.method).toBe('diagnostics-v1');
    expect((await c.svc.status()).promotionEnabled).toBe(false);
    expect((await c.store.getState()).activeModelId).toBeNull();
  });

  it('csak végleges, lezárt eredmény számít; a függő (pl. elhalasztott) tipp kimarad, nem vereség', async () => {
    const c = ctx();
    seed(c.archive, { matches: 60, seed: 2, truth: calibrated, settle: (i) => i % 3 !== 0 });
    const r = await c.svc.diagnostics();
    expect(r.excluded.unresolved).toBe(20 * 3);
    expect(r.sizes.matches).toBe(40);
    expect(r.sizes.observations).toBe(120);
  });

  it('jól kalibrált motor: a tényleges gyakoriság a sávok előrejelzésének Wilson-intervallumán belül; ECE kicsi', async () => {
    const c = ctx();
    seed(c.archive, { matches: 2000, seed: 3, truth: calibrated });
    const r = await c.svc.diagnostics();
    const filled = r.reliability.filter((b) => b.observations >= 200);
    expect(filled.length).toBeGreaterThanOrEqual(6);
    const inside = filled.filter((b) => b.meanPredicted! >= b.observedCi![0] && b.meanPredicted! <= b.observedCi![1]).length;
    expect(inside).toBeGreaterThanOrEqual(filled.length - 1); // 95%-os intervallum: legfeljebb egy kilógó sáv várható
    expect(r.model!.ece).toBeLessThan(0.03);
    expect(r.sufficiency.enoughForConclusions).toBe(true);
  });

  it('túlmagabiztos motor: a magas sávokban a tényleges gyakoriság mérhetően az előrejelzés alatt (a hiba látszik, nem csak a találati arány)', async () => {
    const c = ctx();
    seed(c.archive, { matches: 2000, seed: 4, truth: overconfident });
    const r = await c.svc.diagnostics();
    const high = r.reliability.filter((b) => b.from >= 0.7 && b.observations >= 200);
    expect(high.length).toBeGreaterThan(0);
    for (const b of high) expect(b.observedCi![1]).toBeLessThan(b.meanPredicted!);
    expect(r.model!.ece).toBeGreaterThan(0.05);
  });

  it('kis mintán nem hirdet következtetést: elegendőségi figyelmeztetés indoklással', async () => {
    const c = ctx();
    seed(c.archive, { matches: 30, seed: 5, truth: calibrated });
    const r = await c.svc.diagnostics();
    expect(r.sufficiency.enoughForConclusions).toBe(false);
    expect(r.sufficiency.notes.join(' ')).toMatch(/Kevés mérkőzés: 30/);
    expect(r.limitations.join(' ')).toMatch(/jövőbeli teljesítményt nem bizonyít/);
  });

  it('időben koncentrált minta (egy-két nap): külön figyelmeztetés, akkor is, ha a darabszám nagy', async () => {
    const c = ctx();
    seed(c.archive, { matches: 400, seed: 6, truth: calibrated, spacingMs: 4 * 60_000 }); // ~27 óra alatt
    const r = await c.svc.diagnostics();
    expect(r.period!.distinctKickoffDays).toBeLessThan(14);
    expect(r.sufficiency.enoughForConclusions).toBe(false);
    expect(r.sufficiency.notes.join(' ')).toMatch(/Időben koncentrált minta/);
  });

  it('naiv baseline SZIVÁRGÁSMENTES: csak a tipp generálásakor (embargóval) már ismert eredményeket használja', () => {
    const E = LEARNING_THRESHOLDS.embargoMs;
    const t0 = Date.parse('2026-03-01T12:00:00.000Z');
    const history = Array.from({ length: NAIVE_MIN_HISTORY }, (_, i) => obs(`h${i}`, t0 + i * H, t0 + i * H - 5 * H, i % 4 === 0 ? 1 : 0));
    const target = obs('target', t0 + 100 * H, t0 + 100 * H - 5 * H, 1);
    // jövőbeli meccsek: a target generálása után (embargón belül vagy később) kezdődnek
    const future = Array.from({ length: 40 }, (_, i) => obs(`f${i}`, target.generatedAt - E + 1 + i * H, target.generatedAt + i * H, 1));
    const a = naiveBaselineProbs([...history, target, ...future], E).get('target');
    const b = naiveBaselineProbs([...history, target, ...future.map((f) => ({ ...f, y: 0 as const }))], E).get('target');
    expect(a).toBeCloseTo((5 + 1) / (20 + 2), 12); // csak a 20 korábbi, ismert kimenetelű meccs (5 bejött)
    expect(b).toBe(a); // a jövőbeli kimenetelek átírása nem változtat
    // a target saját eredménye sem számít
    expect(naiveBaselineProbs([...history, { ...target, y: 0 }], E).get('target')).toBe(a);
    // kevés korábbi adat → nincs baseline-érték (nem találunk ki)
    expect(naiveBaselineProbs([target], E).get('target')).toBeNull();
  });

  it('páros összevetés ugyanazon a mintán; informatív modell mérhetően jobb a naiv baseline-nál, informatív jel nélkül nem', async () => {
    const good = ctx();
    seed(good.archive, { matches: 1500, seed: 7, truth: calibrated });
    const g = (await good.svc.diagnostics()).naiveBaseline!;
    expect(g.model.matches).toBe(g.baseline.matches);
    expect(g.model.observations).toBe(g.baseline.observations);
    expect(g.coveredObservations + g.uncoveredObservations).toBe(1500 * 3);
    expect(g.modelLogLossAdvantage).toBeGreaterThan(0);
    expect(g.modelLogLossAdvantageCi[0]).toBeGreaterThan(0);

    // a modell valószínűsége zaj, a valódi esély mindig 0,5 → a modellnek nincs előnye
    const noise = ctx();
    seed(noise.archive, { matches: 1500, seed: 8, truth: () => 0.5 });
    const n = (await noise.svc.diagnostics()).naiveBaseline!;
    expect(n.modelLogLossAdvantage).toBeLessThan(0);
    expect(n.modelLogLossAdvantageCi[1]).toBeLessThan(0);
  });

  it('segédfüggvények: Wilson-intervallum és üres sávok', () => {
    expect(wilson(0, 0)).toBeNull();
    const [lo, hi] = wilson(50, 100)!;
    expect(lo).toBeCloseTo(0.4038, 3);
    expect(hi).toBeCloseTo(0.5962, 3);
    const t = reliabilityTable([obs('a', 1, 0, 1, 'O2.5', 0.95)]);
    expect(t).toHaveLength(10);
    expect(t[9]).toMatchObject({ observations: 1, observedRate: 1 });
    expect(t[0]).toMatchObject({ observations: 0, meanPredicted: null, observedCi: null });
  });
});

describe('diagnostics admin-végpont', () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise((r) => server!.close(() => r(null))); server = null; });

  it('névtelen → 401, nem admin → 403; admin → 200 és a riport nem változtat állapoton', async () => {
    const c = ctx();
    seed(c.archive, { matches: 40, seed: 9, truth: calibrated });
    const a = express();
    a.use('/api', (req, res, next) => {
      const id = req.header('x-test-user') ?? null;
      res.locals.plan = { enforced: true, user: id ? { id, email: `${id}@teszt.hu` } : null, pro: true, admin: req.header('x-test-admin') === '1' && !!id };
      next();
    });
    a.use('/api/admin/model-learning', requireAdmin, modelLearningRouter(c.svc));
    server = await new Promise((r) => { const s = a.listen(0, () => r(s)); });
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/admin/model-learning/diagnostics`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { 'x-test-user': 'u1' } })).status).toBe(403); // PRO, de nem admin
    const before = snapshot(c.db);
    const res = await fetch(url, { headers: { 'x-test-user': 'admin1', 'x-test-admin': '1' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ method: 'diagnostics-v1', baseEngineVersion: ENGINE_VERSION, sizes: { matches: 40 } });
    expect(snapshot(c.db)).toBe(before);
  });
});
