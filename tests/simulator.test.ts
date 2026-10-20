/**
 * AI-meccsszimulátor (mc-poisson-lognormal-1): motor, kalibráció, adathiány/elavultság, FREE/PRO kapu.
 * Hálózat nélkül: a végponttesztek a DEMO adatszolgáltatóval futnak.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { buildSimulation, percentages100, previewSimulation, sampleSdLog, seedFrom, simulate, DEFAULT_SIMULATIONS, type SimulationReport } from '../src/shared/engine/simulator';
import { poissonModel } from '../src/shared/engine/models';
import { freeMatchIds } from '../src/shared/engine/plan';
import { DemoMatchDataProvider } from '../src/server/data/demoProvider';
import { DemoResearchProvider } from '../src/server/research/demoResearch';
import { AnalysisService } from '../src/server/services/analysisService';
import { apiRouter } from '../src/server/routes/api';
import { localDateKey } from '../src/server/data/demoProvider';
import type { Container } from '../src/server/container';
import type { MatchAnalysis } from '../src/shared/types';
import { SimulatorView } from '../src/client/components/SimulatorCard';

function container(demo: DemoMatchDataProvider): Container {
  return {
    data: demo, research: new DemoResearchProvider(demo), oddsApi: null,
    db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined },
  } as unknown as Container;
}

async function demoAnalysis(): Promise<MatchAnalysis> {
  const demo = new DemoMatchDataProvider();
  const svc = new AnalysisService(container(demo));
  for (const m of await demo.getMatches({ status: 'scheduled' })) {
    const a = await svc.analyze(m.id);
    if (a && !a.insufficientData && a.xg) return a;
  }
  throw new Error('nincs elemezhető DEMO-meccs');
}

describe('Szimulációs motor', () => {
  it('érvényes valószínűségek: 1X2 összege 1, a kerekített százalékok összege pontosan 100; determinisztikus', () => {
    const a = simulate({ seedKey: 'm1', homeLambda: 1.6, awayLambda: 1.1, sdHome: 0.2, sdAway: 0.2 });
    const b = simulate({ seedKey: 'm1', homeLambda: 1.6, awayLambda: 1.1, sdHome: 0.2, sdAway: 0.2 });
    expect(a).toEqual(b);
    expect(a.n).toBe(DEFAULT_SIMULATIONS);
    expect(a.homeWin + a.draw + a.awayWin).toBeCloseTo(1, 12);
    for (const p of [a.homeWin, a.draw, a.awayWin, a.btts.yes, ...a.overUnder.map((o) => o.over)]) { expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThanOrEqual(1); }
    for (const ps of [[1 / 3, 1 / 3, 1 / 3], [0.455, 0.275, 0.27], [0.005, 0.005, 0.99], [0.4449, 0.3551, 0.2]]) expect(percentages100(ps).reduce((x, y) => x + y, 0)).toBe(100);
    // a gólpiacok monotonok, a pontos eredmények csökkenő sorrendben
    for (let i = 1; i < a.overUnder.length; i++) expect(a.overUnder[i].over).toBeLessThanOrEqual(a.overUnder[i - 1].over);
    for (let i = 1; i < a.topScores.length; i++) expect(a.topScores[i].prob).toBeLessThanOrEqual(a.topScores[i - 1].prob);
    expect(seedFrom('m1')).not.toBe(seedFrom('m2'));
  });

  it('σ = 0 esetén a meglévő analitikus Poisson-modellt adja (Monte Carlo hibahatáron belül)', () => {
    const n = 100_000;
    for (const [lh, la] of [[1.5, 1.1], [2.4, 0.7], [0.9, 1.3]]) {
      const s = simulate({ seedKey: `p${lh}`, homeLambda: lh, awayLambda: la, sdHome: 0, sdAway: 0, n });
      const p = poissonModel(lh, la, 10);
      const tol = (x: number) => 4 * Math.sqrt((x * (1 - x)) / n);
      expect(Math.abs(s.homeWin - p.homeWin)).toBeLessThan(tol(p.homeWin));
      expect(Math.abs(s.draw - p.draw)).toBeLessThan(tol(p.draw));
      expect(Math.abs(s.awayWin - p.awayWin)).toBeLessThan(tol(p.awayWin));
      expect(Math.abs(s.overUnder[2].over - p.over['2.5'])).toBeLessThan(tol(p.over['2.5']));
      expect(Math.abs(s.btts.yes - p.bttsYes)).toBeLessThan(tol(p.bttsYes));
      expect(Math.abs(s.expectedGoals.home - lh)).toBeLessThan(4 * Math.sqrt(lh / n));
      expect(s.topScores[0].score).toBe(p.correctScores[0].score);
    }
  });

  it('a paraméter-bizonytalanság megőrzi a várható gólt, de szélesíti az eloszlást (keverék)', () => {
    const n = 100_000;
    const flat = simulate({ seedKey: 'v', homeLambda: 1.5, awayLambda: 1.2, sdHome: 0, sdAway: 0, n });
    const wide = simulate({ seedKey: 'v', homeLambda: 1.5, awayLambda: 1.2, sdHome: 0.4, sdAway: 0.4, n });
    expect(Math.abs(wide.expectedGoals.home - 1.5)).toBeLessThan(0.03);
    expect(Math.abs(wide.expectedGoals.away - 1.2)).toBeLessThan(0.03);
    // szélesebb összgól-eloszlás: több 0 gólos ÉS több 5+ gólos meccs
    expect(1 - wide.overUnder[0].over).toBeGreaterThan(1 - flat.overUnder[0].over);
    expect(wide.overUnder[4].over).toBeGreaterThan(flat.overUnder[4].over);
  });

  it('kalibráció (szintetikus): ismert λ-kból generált meccseken az előrejelzett valószínűségek a megfigyelt gyakoriságokkal egyeznek', () => {
    // valós λ-tartomány; a "valóság" független Poisson-húzás ugyanabból a λ-ból (nincs szivárgás: a jóslat a kimenetet nem látja)
    let r = 12345; const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
    const pois = (l: number) => { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
    const bins = Array.from({ length: 10 }, () => ({ pred: 0, obs: 0, n: 0 }));
    let brier = 0, base = 0; const N = 3000; const preds: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const lh = 0.6 + rnd() * 2.2, la = 0.4 + rnd() * 1.8;
      const s = simulate({ seedKey: `c${i}`, homeLambda: lh, awayLambda: la, sdHome: 0, sdAway: 0, n: 2000 });
      const y = pois(lh) > pois(la) ? 1 : 0;
      preds.push([s.homeWin, y]);
      const b = bins[Math.min(9, Math.floor(s.homeWin * 10))];
      b.pred += s.homeWin; b.obs += y; b.n++;
    }
    const rate = preds.reduce((a, [, y]) => a + y, 0) / N;
    for (const [p, y] of preds) { brier += (p - y) ** 2; base += (rate - y) ** 2; }
    expect(brier / N).toBeLessThan(base / N); // jobb a konstans alapgyakoriságnál
    for (const b of bins.filter((x) => x.n >= 150)) expect(Math.abs(b.pred / b.n - b.obs / b.n)).toBeLessThan(0.07);
  });
});

describe('Szimuláció elemzésből (DEMO-adat)', () => {
  it('teljes riport: 10 000 szimuláció, 1X2 (százalék = 100), várható gól, gólpiacok, pontos eredmények, magyarázat, frissesség', async () => {
    const a = await demoAnalysis();
    const s = buildSimulation(a);
    expect(s.status).toBe('ok');
    expect(s.full!.n).toBe(10_000);
    const { pct } = s.oneXTwo!;
    expect(pct.home + pct.draw + pct.away).toBe(100);
    expect(s.oneXTwo!.home + s.oneXTwo!.draw + s.oneXTwo!.away).toBeCloseTo(1, 2);
    expect(s.full!.inputs).toMatchObject({ homeLambda: a.xg!.homeExpected, awayLambda: a.xg!.awayExpected, sdSource: 'sample' });
    expect(s.full!.topScores.length).toBeGreaterThan(0);
    expect(s.full!.explanation.join(' ')).toContain(a.homeTeam.shortName);
    expect(s.freshness.newestResultDate! < a.match.kickoff).toBe(true);
    expect(['alacsony', 'közepes', 'magas']).toContain(s.uncertainty!.level);
    // a mintából becsült σ pozitív és véges
    const sd = sampleSdLog(a);
    expect(sd.sdHome).toBeGreaterThan(0); expect(sd.sdHome).toBeLessThan(1);
    // ugyanaz az elemzés → ugyanaz a szimuláció
    expect(buildSimulation(a)).toEqual(s);
  });

  it('PRO-modellnél a modell saját sdLog-ját használja', async () => {
    const a = await demoAnalysis();
    const s = buildSimulation({ ...a, model: { id: 'xs-strength-1', label: 'Több ligás modell', sdLog: 0.18 } });
    expect(s.full!.inputs).toMatchObject({ sdHome: 0.18, sdAway: 0.18, sdSource: 'pro-model' });
  });

  it('hiányos adat: nincs kitalált szám – status insufficient, az okokkal', async () => {
    const a = await demoAnalysis();
    for (const bad of [{ ...a, insufficientData: true, insufficientReasons: ['kevés meccs'] }, { ...a, xg: null }]) {
      const s = buildSimulation(bad);
      expect(s.status).toBe('insufficient');
      expect(s.oneXTwo).toBeNull();
      expect(s.full).toBeUndefined();
      expect(s.reasons.length).toBeGreaterThan(0);
    }
    expect(buildSimulation({ ...a, match: { ...a.match, status: 'finished' } }).status).toBe('insufficient');
  });

  it('elavult adat: jelzi és magas bizonytalanságot ad', async () => {
    const a = await demoAnalysis();
    const old = (f: MatchAnalysis['form']['homeLast10']) => ({ ...f, matches: f.matches.map((m) => ({ ...m, date: '2020-01-01' })) });
    const s = buildSimulation({ ...a, form: { ...a.form, homeLast10: old(a.form.homeLast10), awayLast10: old(a.form.awayLast10) } });
    expect(s.freshness.stale).toBe(true);
    expect(s.uncertainty!.level).toBe('magas');
    expect(s.uncertainty!.reasons.join(' ')).toMatch(/elavult/);
  });

  it('FREE előnézet: a teljes eredmény egyáltalán nem szerepel', async () => {
    const p = previewSimulation(buildSimulation(await demoAnalysis()));
    expect('full' in p).toBe(false);
    expect(JSON.stringify(p)).not.toMatch(/topScores|overUnder|expectedGoals|explanation/);
    expect(p.oneXTwo).not.toBeNull();
  });
});

describe('Szerveroldali kapu: GET /api/matches/:id/simulation', () => {
  let server: Server | null = null;
  afterEach(async () => { vi.restoreAllMocks(); if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

  async function app(plan: unknown) {
    const demo = new DemoMatchDataProvider();
    const svc = new AnalysisService(container(demo));
    const spy = vi.spyOn(svc, 'analyze');
    const a = express();
    a.use(express.json());
    a.use((_req, res, next) => { res.locals.plan = plan; next(); });
    a.use('/api', apiRouter(container(demo), svc));
    server = await new Promise<Server>((r) => { const s = a.listen(0, () => r(s)); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (path: string) => { const res = await fetch(url + path); return { status: res.status, body: await res.json() }; };
    // FREE-kvótán belüli és azon kívüli meccs ugyanarról a napról
    const all = await demo.getMatches({ status: 'scheduled' });
    let inQuota = '', outQuota = '';
    for (const m of all) {
      const ids = freeMatchIds(await demo.getMatches({ date: localDateKey(m.kickoff) }));
      if (!inQuota && ids.has(m.id)) inQuota = m.id;
      if (!outQuota && !ids.has(m.id)) outQuota = m.id;
    }
    return { get, spy, inQuota, outQuota };
  }

  const FREE = { enforced: true, user: { id: 'u1' }, pro: false, admin: false };
  const ANON = { enforced: true, user: null, pro: false, admin: false };
  const PRO = { enforced: true, user: { id: 'u1' }, pro: true, admin: false };

  it('FREE és kijelentkezett látogató: előnézet (1X2), a teljes eredmény NÉLKÜL; az alap motorral', async () => {
    for (const plan of [FREE, ANON]) {
      const { get, spy, inQuota } = await app(plan);
      const r = await get(`/api/matches/${inQuota}/simulation`);
      expect(r.status).toBe(200);
      const s = r.body as SimulationReport;
      expect(s.simulator).toBe('mc-poisson-lognormal-1');
      expect('full' in s).toBe(false);
      expect(JSON.stringify(s)).not.toMatch(/topScores|overUnder|expectedGoals|explanation/);
      if (s.status === 'ok') expect(s.oneXTwo!.pct.home + s.oneXTwo!.pct.draw + s.oneXTwo!.pct.away).toBe(100);
      expect(spy.mock.calls.every(([, o]) => o?.variant === 'base')).toBe(true);
      if (server) await new Promise<void>((res) => server!.close(() => res())); server = null;
    }
  });

  it('FREE a kvótán kívüli meccsre: 403 PRO_REQUIRED, szimuláció nélkül', async () => {
    const { get, outQuota } = await app(FREE);
    expect(outQuota).not.toBe('');
    const r = await get(`/api/matches/${outQuota}/simulation`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PRO_REQUIRED');
    expect(JSON.stringify(r.body)).not.toMatch(/oneXTwo|full/);
  });

  it('PRO: a teljes eredmény a PRO-változat elemzéséből; érvénytelen azonosító 400, ismeretlen 404', async () => {
    const { get, spy, outQuota } = await app(PRO);
    const r = await get(`/api/matches/${outQuota}/simulation`);
    expect(r.status).toBe(200);
    const s = r.body as SimulationReport;
    if (s.status === 'ok') {
      expect(s.full!.n).toBe(10_000);
      expect(s.full!.overUnder.length).toBe(5);
      expect(s.full!.topScores.length).toBeGreaterThan(0);
    } else {
      expect(s.reasons.length).toBeGreaterThan(0);
    }
    expect(spy.mock.calls.every(([, o]) => o?.variant === 'pro')).toBe(true);
    expect((await get('/api/matches/%3Bdrop/simulation')).status).toBe(400);
    expect((await get('/api/matches/nincs-ilyen/simulation')).status).toBe(404);
  });
});

describe('Felület: szimulátorkártya', () => {
  const render = (s: SimulationReport, pro: boolean) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SimulatorView, { s, homeName: 'Hazai', awayName: 'Vendég', pro })));

  it('FREE előnézet: 1X2 + bizonytalanság + PRO-zár; PRO: gólpiacok, pontos eredmények, magyarázat; hiányos adat: nincs szám', async () => {
    const full = buildSimulation(await demoAnalysis());
    const free = render(previewSimulation(full), false);
    expect(free).toContain('data-sim-1x2');
    expect(free).toContain('data-sim-uncertainty');
    expect(free).toContain('Teljes szimuláció – PRO');
    expect(free).not.toContain('data-sim-full');
    const pro = render(full, true);
    expect(pro).toContain('data-sim-full');
    expect(pro).toContain('10');
    expect(pro).toContain('Legvalószínűbb pontos eredmények');
    expect(pro).not.toContain('Teljes szimuláció – PRO');
    const none = render({ ...full, status: 'insufficient', reasons: ['kevés meccs'], oneXTwo: null, mostLikely: null, uncertainty: null, full: undefined }, true);
    expect(none).toContain('A szimuláció nem futtatható');
    expect(none).not.toContain('data-sim-1x2');
  });
});
