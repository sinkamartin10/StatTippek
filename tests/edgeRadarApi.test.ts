/**
 * Edge Radar API (3. fázis) – végpontszintű tesztek. Valódi requirePro + planOf + router, a csomagot
 * – mint élesben az attachPlan – a `res.locals.plan` adja. Nincs éles rendszer, titok vagy hálózat.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { requirePro } from '../src/server/billing/entitlement';
import { edgeRadarRouter, parseIsoDate, toItem, type EdgeRadarRouterOptions } from '../src/server/routes/edgeRadar';
import { EdgeService, type EdgeDeps, type EdgeRow, type EdgeVariant } from '../src/server/edge/edgeService';
import { AnalysisService } from '../src/server/services/analysisService';
import { apiRouter } from '../src/server/routes/api';
import { CornerService } from '../src/server/corners/service';
import { DemoMatchDataProvider } from '../src/server/data/demoProvider';
import { DemoResearchProvider } from '../src/server/research/demoResearch';
import type { Container } from '../src/server/container';
import type { MatchOdds } from '../src/shared/types';

const NOW = new Date('2026-10-20T15:00:00.000Z');
const PRO = { enforced: true, user: { id: 'pro-1', email: 'pro@example.test' }, pro: true, admin: false };
const FREE = { enforced: true, user: { id: 'free-1', email: 'free@example.test' }, pro: false, admin: false };
const ANON = { enforced: true, user: null, pro: false, admin: false };

const row = (o: Partial<EdgeRow> = {}): EdgeRow => ({
  matchId: 'espn-eng.1-1', kickoff: '2026-10-20T18:00:00.000Z', leagueId: 'eng-pl', matchStatus: 'scheduled', market: '1', outcome: '1x2:home',
  odds: 2.1, bookmaker: 'DraftKings (ESPN)', source: 'espn-scoreboard', observedAt: '2026-10-20T14:50:00.000Z', ageMs: 600_000,
  rawImplied: 1 / 2.1, devig: 0.45, devigReason: null, modelProb: 0.5, edgePp: 5, modelId: 'xs-strength-1', excluded: false, excludeReason: null, ...o,
});

let server: Server | null = null;
afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

/** az index.ts sorrendje: (attachPlan →) requirePro → edgeRadarRouter */
async function app(plan: unknown, edge: Pick<EdgeService, 'buildEdgeResult'>, extra?: (a: express.Express) => void, now: Date = NOW, opts: EdgeRadarRouterOptions = { enabled: () => true }) {
  const a = express();
  a.use((_req, res, next) => { res.locals.plan = plan; next(); });
  // a bekapcsolt működés tesztjei: a kapcsoló itt BE van kapcsolva (a kapcsoló saját tesztjei külön)
  a.use('/api/edge-radar', requirePro, edgeRadarRouter(edge, () => now, opts));
  extra?.(a);
  server = await new Promise<Server>((r) => { const s = a.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path: string) => { const res = await fetch(url + path); const text = await res.text(); return { status: res.status, text, body: JSON.parse(text) }; };
}
/** rögzítő hamis szolgáltatás: milyen változattal hívták */
function fakeEdge(rows: EdgeRow[] = [row(), row({ market: 'X', outcome: '1x2:draw', edgePp: null, modelId: 'xs-strength-1', excluded: true, excludeReason: 'stale', devig: null, devigReason: null })]) {
  const calls: { date: string; variant: EdgeVariant; now: unknown }[] = [];
  return { calls, edge: { buildEdgeResult: async (date: string, variant: EdgeVariant, now: string | number | Date) => { calls.push({ date, variant, now }); return { rows, matchCount: 1, failedMatchIds: [] as string[] }; } } };
}

describe('Jogosultság (meglévő requirePro / planOf)', () => {
  it('1. PRO + érvényes dátum: 200, stabil szerkezet, a PRO modellváltozatból', async () => {
    const f = fakeEdge();
    const get = await app(PRO, f.edge);
    const r = await get('/api/edge-radar?date=2026-10-20');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['date', 'generatedAt', 'items', 'meta', 'version']);
    expect(r.body).toMatchObject({ version: 1, date: '2026-10-20', generatedAt: NOW.toISOString() });
    expect(r.body.meta).toMatchObject({ experimental: true, modelVariant: 'pro', matches: 1, rows: 2, usable: 1, excluded: 1, partial: false, failedMatchIds: [], devigMethod: 'proportional' });
    expect(r.body.meta.notice.join(' ')).toMatch(/nem garantál nyereséget/);
    expect(f.calls).toEqual([{ date: '2026-10-20', variant: 'pro', now: NOW }]);
  });

  it('2–3. FREE: 403 PRO_REQUIRED, adat nélkül – a kliens variant/isPro/plan paramétere sem nyit ki semmit', async () => {
    const f = fakeEdge();
    const get = await app(FREE, f.edge);
    for (const q of ['', '&variant=pro', '&isPro=true', '&plan=pro&pro=1', '&variant=pro&isPro=true&plan=pro']) {
      const r = await get(`/api/edge-radar?date=2026-10-20${q}`);
      expect(r.status, q).toBe(403);
      expect(r.body).toEqual({ error: 'Ez a funkció PRO előfizetéssel érhető el.', code: 'PRO_REQUIRED' });
    }
    expect(f.calls).toEqual([]); // a szolgáltatás meg sem hívódik
  });

  it('3. PRO-nál a kliens variant=base sem vált modellt (a változatot csak a szerver dönti el)', async () => {
    const f = fakeEdge();
    const get = await app(PRO, f.edge);
    await get('/api/edge-radar?date=2026-10-20&variant=base&isPro=false');
    expect(f.calls.map((c) => c.variant)).toEqual(['pro']);
  });

  it('4. nem hitelesített kérés: 401 AUTH_REQUIRED (a meglévő formátum)', async () => {
    const f = fakeEdge();
    const r = await (await app(ANON, f.edge))('/api/edge-radar?date=2026-10-20');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Bejelentkezés szükséges.', code: 'AUTH_REQUIRED' });
    expect(f.calls).toEqual([]);
  });
});

describe('Dátum', () => {
  it('5. hibás formátum és nem létező nap: 400 INVALID_DATE, a szolgáltatás nem fut', async () => {
    const f = fakeEdge();
    const get = await app(PRO, f.edge);
    for (const d of ['2026-1-01', '20261020', 'abc', '2026-02-30', '2026-13-01', '2025-02-29', '2026-10-20T00:00', '%20', '2026-10-20&date=2026-10-21']) {
      const r = await get(`/api/edge-radar?date=${d}`);
      expect(r.status, d).toBe(400);
      expect(r.body.code, d).toBe('INVALID_DATE');
    }
    // az Express 5 egyszerű query-értelmezője a `date[]` kulcsot nem `date`-ként adja → hiányzó dátum
    expect((await get('/api/edge-radar?date[]=2026-10-20')).body.code).toBe('DATE_REQUIRED');
    expect(f.calls).toEqual([]);
    expect(parseIsoDate('2024-02-29')).toBe('2024-02-29');
  });

  it('6. hiányzó dátum: 400 DATE_REQUIRED (nincs szerver-időzónától függő alapértelmezés)', async () => {
    const r = await (await app(PRO, fakeEdge().edge))('/api/edge-radar');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DATE_REQUIRED');
  });
});

describe('Hibakezelés és adatvédelem', () => {
  it('7. belső hiba: 500, általános üzenet – nincs stack trace, nincs belső üzenet', async () => {
    const boom = { buildEdgeResult: async () => { const e = new Error('SECRET belső részlet /srv/app/src/x.ts:42'); throw e; } };
    const r = await (await app(PRO, boom))('/api/edge-radar?date=2026-10-20');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Az Edge Radar most nem számolható.', code: 'EDGE_UNAVAILABLE' });
    expect(r.text).not.toMatch(/SECRET|stack|\.ts:\d+|at /);
  });

  it('7. ha minden meccs számítása hibás → 500 (nem üres, sikeres eredmény); részleges hiba → 200, partial jelöléssel', async () => {
    const allFail = { buildEdgeResult: async () => ({ rows: [], matchCount: 2, failedMatchIds: ['a', 'b'] }) };
    expect((await (await app(PRO, allFail))('/api/edge-radar?date=2026-10-20')).status).toBe(500);
    await new Promise<void>((r) => server!.close(() => r())); server = null;
    const someFail = { buildEdgeResult: async () => ({ rows: [row()], matchCount: 2, failedMatchIds: ['espn-eng.1-9'] }) };
    const r = await (await app(PRO, someFail))('/api/edge-radar?date=2026-10-20');
    expect(r.status).toBe(200);
    expect(r.body.meta).toMatchObject({ partial: true, failedMatchIds: ['espn-eng.1-9'] });
  });

  it('8–9. nincs EV-mező, nincs modell-valószínűség, felhasználói vagy belső adat – csak a whitelist mezői', async () => {
    const r = await (await app(PRO, fakeEdge().edge))('/api/edge-radar?date=2026-10-20');
    const keys = ['matchId', 'leagueId', 'kickoff', 'market', 'outcome', 'odds', 'bookmaker', 'source', 'observedAt', 'ageMs', 'rawImplied', 'devig', 'devigReason', 'modelId', 'edgePp', 'excluded', 'excludeReason'].sort();
    for (const it of r.body.items) expect(Object.keys(it).sort()).toEqual(keys);
    expect(r.text).not.toMatch(/"ev"|expected|profit|modelProb|matchStatus|pro-1|example\.test|email|user/i);
  });

  it('10. a kizárt sor és a kizárási oka megmarad; kizárt sorban nincs edge és modellazonosító', async () => {
    const r = await (await app(PRO, fakeEdge().edge))('/api/edge-radar?date=2026-10-20');
    const x = r.body.items.find((i: { market: string }) => i.market === 'X');
    expect(x).toMatchObject({ excluded: true, excludeReason: 'stale', edgePp: null, modelId: null });
    expect(r.body.items.find((i: { market: string }) => i.market === '1')).toMatchObject({ excluded: false, edgePp: 5, modelId: 'xs-strength-1' });
    // a toItem akkor sem ad edge-et, ha egy sor ellentmondásos lenne (excluded, mégis van szám)
    expect(toItem(row({ excluded: true, excludeReason: 'stale', edgePp: 3 }))).toMatchObject({ excluded: true, edgePp: null, modelId: null });
  });
});

describe('Valódi szolgáltatással (DEMO-adat, hálózat nélkül)', () => {
  /** igazolt, friss ESPN-szerű odds a DEMO-meccsekre */
  function setup(now: Date = NOW) {
    const demo = new DemoMatchDataProvider();
    const data = Object.create(demo) as DemoMatchDataProvider;
    data.getOdds = async (id: string): Promise<MatchOdds> => ({
      matchId: id, source: 'live', bookmaker: 'DraftKings (ESPN)', retrievedAt: now.toISOString(), observedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
      markets: { '1': 2.1, X: 3.5, '2': 3.4 }, observation: { via: 'espn-scoreboard', singleBook: true, matchStatus: 'scheduled', priceKind: { '1': 'close', X: 'close', '2': 'close' } },
    });
    const c = { data, research: new DemoResearchProvider(demo), oddsApi: null, db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined } } as unknown as Container;
    const svc = new AnalysisService(c);
    const variants: EdgeVariant[] = [];
    const deps: EdgeDeps = { getMatches: (q) => demo.getMatches(q), analyze: (id, o) => { variants.push(o.variant); return svc.analyze(id, o); }, resolveOdds: (m) => svc.resolveOdds(m) };
    return { demo, c, svc, edge: new EdgeService(deps), variants };
  }

  it('11. a PRO-válasz a PRO-változat elemzéséből készül (a szolgáltatás csak „pro” változattal fut)', async () => {
    const m0 = (await new DemoMatchDataProvider().getMatches({ status: 'scheduled' }))[0];
    const now = new Date(Date.parse(m0.kickoff) - 2 * 3600_000); // a meccs kezdése előtt: friss, pre-match odds
    const { demo, edge, variants } = setup(now);
    const m = (await demo.getMatches({ status: 'scheduled' }))[0];
    const date = new Date(m.kickoff).toLocaleDateString('sv-SE');
    const r = await (await app(PRO, edge, undefined, now))(`/api/edge-radar?date=${date}`);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(new Set(variants)).toEqual(new Set(['pro']));
    for (const it of r.body.items) expect(it.excluded ? it.modelId === null : typeof it.modelId === 'string').toBe(true);
  });

  it('12. a meglévő végpontok (tippek, elemzés) és a computeValue változatlanok az Edge-végpont mellett', async () => {
    const { demo, c, svc, edge } = setup();
    const m = (await demo.getMatches({ status: 'scheduled' }))[0];
    const date = new Date(m.kickoff).toLocaleDateString('sv-SE');
    const before = JSON.stringify((await svc.analyze(m.id))!.value);
    const get = await app(FREE, edge, (a) => a.use('/api', apiRouter(c, svc, new CornerService(demo))));
    const tips = await get(`/api/tips?date=${date}`);
    expect(tips.status).toBe(200);
    expect(tips.body.length).toBeLessThanOrEqual(3); // FREE-redakció változatlan
    expect((await get(`/api/edge-radar?date=${date}`)).status).toBe(403);
    expect(JSON.stringify((await svc.analyze(m.id))!.value)).toBe(before);
  });
});
