/**
 * Modell-tanulási admin irányítópult (V1) – megjelenítés és hozzáférés.
 *
 * A projektben nincs DOM-tesztkörnyezet: a komponensek statikus HTML-re
 * renderelve (react-dom/server), backend által ténylegesen előállított
 * riportokkal (a valódi `diagnose()` függvény) tesztelve. A backend-hozzáférést
 * a valódi `requireAdmin` + `modelLearningRouter` láncon teszteljük.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { AccessError, Breakdown, Calibration, CandidateSection, Events, Quality, TopCards } from '../src/client/pages/AdminModelLearning';
import { NO_DATA, fmtNum, parseCandidate, promotionRequirements, smallSample } from '../src/client/lib/learningDashboard';
import { api } from '../src/client/lib/api';
import { diagnose } from '../src/server/modelLearning/diagnostics';
import { prng, type Observation } from '../src/server/modelLearning/calibration';
import { SqliteModelLearningStore } from '../src/server/modelLearning/store';
import { SqliteTipArchiveStore } from '../src/server/tipArchive/store';
import { ModelLearningService } from '../src/server/modelLearning/service';
import { modelLearningRouter } from '../src/server/routes/modelLearning';
import { requireAdmin } from '../src/server/billing/entitlement';
import { LEARNING_THRESHOLDS, SERVING_NOTE, type DiagnosticsReport, type LearningStatus } from '../src/shared/modelLearning';
import { ENGINE_VERSION } from '../src/shared/engine/version';

const html = (el: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const NOW = new Date('2026-10-14T12:00:00.000Z');

/** Backend által előállított riport (valódi diagnose) determinisztikus megfigyelésekből. */
function report(matches: number, days = 60): DiagnosticsReport {
  const rnd = prng(42);
  const obs: Observation[] = [];
  const t0 = Date.parse('2026-06-01T15:00:00.000Z');
  for (let i = 0; i < matches; i++) {
    const kickoff = t0 + Math.floor((i * days) / Math.max(1, matches)) * 86400_000 + i * 60_000;
    for (const [market, type] of [['O2.5', 'gólszám'], ['1X', 'dupla esély']]) {
      const p = 0.1 + rnd() * 0.8;
      obs.push({ id: `${i}-${market}`, matchId: `m${i}`, market, marketType: type, leagueId: i % 2 ? 'L2' : 'L1', kickoff, generatedAt: kickoff - 5 * 3600_000, prob: p, y: rnd() < p ? 1 : 0 });
    }
  }
  return diagnose(obs, {}, { baseEngineVersion: ENGINE_VERSION, now: NOW, t: LEARNING_THRESHOLDS });
}

function status(over: Partial<LearningStatus> = {}): LearningStatus {
  return {
    baselineEngineVersion: ENGINE_VERSION, servedModel: ENGINE_VERSION, servingNote: SERVING_NOTE, promotionEnabled: false,
    activeModelId: null, previousModelId: null, stateVersion: 0,
    lastRun: { startedAt: null, finishedAt: null, status: null, error: null, summary: null },
    nextScheduledEvaluation: null, schedulingNote: 'x', locked: false, thresholds: LEARNING_THRESHOLDS, candidates: [], recentEvents: [],
    ...over,
  };
}

const holdout = (bm: number, cm: number) => ({
  baseline: { matches: bm, observations: bm * 3, logLoss: 0.61234, brier: 0.21111, ece: 0.04 },
  candidate: { matches: cm, observations: cm * 3, logLoss: 0.60123, brier: 0.20999, ece: 0.02 },
  logLossDelta: 0.01111, logLossDeltaCi: [0.0041, 0.0187], relativeLogLossImprovement: 0.0181, brierDelta: 0.00112,
});

describe('irányítópult – megjelenítés', () => {
  it('3) API- vagy jogosultsági hiba: érthető hibaállapot, érzékeny adat nélkül', () => {
    const out = html(createElement(AccessError, { message: 'Ehhez adminisztrátori jogosultság szükséges.' }));
    expect(out).toContain('adminisztrátori fiók szükséges');
    expect(out).not.toMatch(/log loss|Brier|xg-poisson/i);
    const other = html(createElement(AccessError, { message: 'Hálózati hiba' }));
    expect(other).toContain('Hálózati hiba');
    expect(other).not.toContain('adminisztrátori fiók szükséges');
  });

  it('4) üres adathalmaz: nincs kitalált grafikon vagy szám', () => {
    const r = diagnose([], {}, { baseEngineVersion: ENGINE_VERSION, now: NOW, t: LEARNING_THRESHOLDS });
    const q = html(createElement(Quality, { d: r }));
    expect(q).toContain('Nincs kiértékelhető adat');
    expect(q).toContain('Nincs páros összevetés');
    expect(q).not.toMatch(/0,0000/);
    const c = html(createElement(Calibration, { d: r }));
    expect(c).toContain('Nincs kalibrációs adat');
    expect(c).not.toContain('<svg');
    const top = html(createElement(TopCards, { s: status(), d: r, diagLoading: false }));
    expect(top).toContain('Nincs jelölt');
    expect(top).toContain('Nem érhető el'); // utolsó eredményfeldolgozás – nem mérhető, nem 0
    expect(html(createElement(Events, { s: status() }))).toContain('Nincs rögzített esemény');
  });

  it('5) hiányzó mezők: a felület stabil, „Nincs adat” jelenik meg (nem 0)', () => {
    const s = status({ candidates: [{ id: 'cal-aaaaaaaaaaaa', status: 'rejected', statusReason: null, createdAt: '2026-10-01T00:00:00Z', metrics: null, gateResult: null as never }] });
    const out = html(createElement(CandidateSection, { s }));
    expect(out).toContain('Nincs összevethető holdout');
    expect(out).toContain(NO_DATA);
    expect(out).not.toMatch(/>0 \/ 0 \/ 0</);
    const v = parseCandidate(s.candidates[0]);
    expect(v.sizes).toEqual({ trainMatches: null, validationMatches: null, holdoutMatches: null, holdoutObservations: null });
    expect(v.gatePassed).toBeNull();
    // ismeretlen eseménytípus / hiányzó részletek sem dönti el
    expect(() => html(createElement(Events, { s: status({ recentEvents: [{ at: 'x', kind: 'valami_uj', modelId: null, details: null }] }) }))).not.toThrow();
  });

  it('6) a metrikák pontosan a backend által visszaadott értékek', () => {
    const r = report(400, 90);
    const q = html(createElement(Quality, { d: r }));
    expect(q).toContain(fmtNum(r.model!.logLoss));
    expect(q).toContain(fmtNum(r.model!.brier));
    expect(q).toContain(fmtNum(r.naiveBaseline!.baseline.logLoss));
    expect(q).toContain(fmtNum(r.naiveBaseline!.modelLogLossAdvantage, 5));
    const c = html(createElement(Calibration, { d: r }));
    for (const b of r.reliability.filter((x) => x.observations)) expect(c).toContain(`>${b.observations}`);
  });

  it('7) azonos mintájú éles/jelölt összevetés megjelenik; eltérő mintán NEM hasonlít össze', () => {
    const same = status({ candidates: [{ id: 'cal-bbbbbbbbbbbb', status: 'rejected', statusReason: 'x', createdAt: '2026-10-01T00:00:00Z', gateResult: { passed: false, reasons: ['ok1'] }, metrics: { holdout: holdout(160, 160), sizes: { trainMatches: 500, validationMatches: 160, holdoutMatches: 160, holdoutObservations: 480 }, markets: [] } }] });
    const a = html(createElement(CandidateSection, { s: same }));
    expect(a).toContain('Holdout – azonos mintán (160 meccs)');
    expect(a).toContain('0,6123 / 0,6012');
    expect(a).toContain('0,00410 … 0,01870');
    const diff = status({ candidates: [{ ...same.candidates[0], metrics: { holdout: holdout(160, 150) } }] });
    const b = html(createElement(CandidateSection, { s: diff }));
    expect(b).toContain('Nincs összevethető holdout');
    expect(b).not.toContain('0,6123 / 0,6012');
  });

  it('8) kis minta: figyelmeztetés a bontásban és a kalibrációban; nincs „legjobb” piac', () => {
    const r = report(30, 3);
    expect(r.sufficiency.enoughForConclusions).toBe(false);
    const b = html(createElement(Breakdown, { d: r, s: status() }));
    expect(b).toContain('kis minta');
    expect(b).toMatch(/rangsor nélkül/);
    expect(b).not.toMatch(/legjobb/i);
    expect(html(createElement(Calibration, { d: r }))).toContain('kis minta');
    expect(smallSample(10, 30, LEARNING_THRESHOLDS)).toBe(true);
    expect(smallSample(null, 500, LEARNING_THRESHOLDS)).toBe(true);
    expect(smallSample(80, 300, LEARNING_THRESHOLDS)).toBe(false);
  });

  it('nincs modellállapotot módosító gomb; az élesítési feltételek a backend küszöbeiből jönnek', () => {
    const s = status({ candidates: [{ id: 'cal-cccccccccccc', status: 'eligible', statusReason: 'x', createdAt: '2026-10-01T00:00:00Z', gateResult: { passed: true, reasons: [] }, metrics: { holdout: holdout(160, 160) } }] });
    const out = html(createElement(CandidateSection, { s })) + html(createElement(TopCards, { s, d: report(200), diagLoading: false }));
    expect(out).not.toMatch(/<button[^>]*>[^<]*(Aktiv|Promote|Rollback|Visszaállít)/i);
    expect(out).toContain('Tiltva');
    const req = promotionRequirements(status()).join(' ');
    expect(req).toContain(String(LEARNING_THRESHOLDS.minTrainMatches));
    expect(req).toContain('TILTOTT');
  });
});

describe('irányítópult – API-hívások és hozzáférés', () => {
  let server: Server | null = null;
  afterEach(async () => { vi.unstubAllGlobals(); if (server) await new Promise((r) => server!.close(() => r(null))); server = null; });

  it('9) a frissítés csak a két csak olvasó GET-et hívja; kiértékelést, aktiválást, visszaállítást a kliens nem ismer', async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: (init?.method ?? 'GET').toUpperCase() });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await api.adminLearningStatus();
    await api.adminLearningDiagnostics();
    expect(calls).toEqual([
      { url: '/api/admin/model-learning/status', method: 'GET' },
      { url: '/api/admin/model-learning/diagnostics', method: 'GET' },
    ]);
    const keys = Object.keys(api).filter((k) => /learning/i.test(k));
    expect(keys.sort()).toEqual(['adminLearningDiagnostics', 'adminLearningStatus']);
  });

  it('1–2) admin hozzáfér; névtelen 401, nem admin (akár PRO) 403 – a diagnosztika nem ír és nem illeszt', async () => {
    const db = new DatabaseSync(':memory:');
    new SqliteTipArchiveStore(db);
    const store = new SqliteModelLearningStore(db);
    const svc = new ModelLearningService(store, { now: () => NOW, allowPromotion: false });
    const a = express();
    a.use('/api', (req, res, next) => {
      const id = req.header('x-test-user') ?? null;
      res.locals.plan = { enforced: true, user: id ? { id, email: `${id}@teszt.hu` } : null, pro: true, admin: req.header('x-test-admin') === '1' && !!id };
      next();
    });
    a.use('/api/admin/model-learning', requireAdmin, modelLearningRouter(svc));
    server = await new Promise((r) => { const s = a.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/admin/model-learning`;
    for (const p of ['/status', '/diagnostics']) {
      expect((await fetch(base + p)).status, p).toBe(401);
      expect((await fetch(base + p, { headers: { 'x-test-user': 'u1' } })).status, p).toBe(403);
      expect((await fetch(base + p, { headers: { 'x-test-user': 'a1', 'x-test-admin': '1' } })).status, p).toBe(200);
    }
    const st = await (await fetch(base + '/status', { headers: { 'x-test-user': 'a1', 'x-test-admin': '1' } })).json();
    expect(st).toMatchObject({ servedModel: ENGINE_VERSION, promotionEnabled: false, activeModelId: null, candidates: [], recentEvents: [] });
    expect((await store.listEvents(10)).length).toBe(0);
    expect((await store.listVersions(10)).length).toBe(0);
  });
});
