/**
 * Edge Radar – kiadás előtti korlátok: EDGE_RADAR_ENABLED kapcsoló (biztonságos alapértelmezés: KI)
 * és dátumkorlát (a mai BUDAPESTI nap + 7 naptári nap – közös a szerver és a böngésző között).
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { requirePro } from '../src/server/billing/entitlement';
import { addDays, edgeDateRange, edgeRadarEnabled, edgeRadarRouter, type EdgeRadarRouterOptions } from '../src/server/routes/edgeRadar';
import { localDateKey } from '../src/server/data/demoProvider';
import { dayKey } from '../src/shared/missions';
import { addCalendarDays, edgeDateRange as sharedRange } from '../src/shared/edgeDates';
import { EdgeRadarBody, loadEdgeRadar } from '../src/client/pages/EdgeRadar';
import { DEFAULT_FILTERS } from '../src/client/lib/edgeRadar';
import { ApiError } from '../src/client/lib/api';
import type { EdgeVariant } from '../src/server/edge/edgeService';

const PRO = { enforced: true, user: { id: 'pro-1' }, pro: true, admin: false };
const FREE = { enforced: true, user: { id: 'free-1' }, pro: false, admin: false };
const ANON = { enforced: true, user: null, pro: false, admin: false };
const NOW = new Date('2026-10-20T10:00:00.000Z');
const fixedToday = (d: string) => () => d;

let server: Server | null = null;
const savedEnv = process.env.EDGE_RADAR_ENABLED;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  if (savedEnv === undefined) delete process.env.EDGE_RADAR_ENABLED; else process.env.EDGE_RADAR_ENABLED = savedEnv;
});

function fake() {
  const calls: { date: string; variant: EdgeVariant }[] = [];
  return { calls, edge: { buildEdgeResult: async (date: string, variant: EdgeVariant) => { calls.push({ date, variant }); return { rows: [], matchCount: 0, failedMatchIds: [] as string[] }; } } };
}
async function app(plan: unknown, edge: ReturnType<typeof fake>['edge'], opts?: EdgeRadarRouterOptions, now = NOW) {
  const a = express();
  a.use((_req, res, next) => { res.locals.plan = plan; next(); });
  a.use('/api/edge-radar', requirePro, edgeRadarRouter(edge, () => now, opts));
  server = await new Promise<Server>((r) => { const s = a.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path: string) => { const res = await fetch(url + path); return { status: res.status, body: await res.json() }; };
}

describe('EDGE_RADAR_ENABLED kapcsoló', () => {
  it('értelmezés: csak true/1/on/yes kapcsol BE; hiányzó, üres, false, 0, ismeretlen → KI', () => {
    for (const v of ['true', ' TRUE ', '1', 'on', 'Yes']) expect(edgeRadarEnabled({ EDGE_RADAR_ENABLED: v }), v).toBe(true);
    for (const v of [undefined, '', 'false', '0', 'off', 'no', 'enabled', 'ture']) expect(edgeRadarEnabled({ EDGE_RADAR_ENABLED: v }), String(v)).toBe(false);
  });

  it('a változó HIÁNYZIK (alapértelmezés): 503 EDGE_RADAR_DISABLED, a szolgáltatás nem fut, adat nincs', async () => {
    delete process.env.EDGE_RADAR_ENABLED;
    const f = fake();
    const r = await (await app(PRO, f.edge, { todayOf: fixedToday('2026-10-20') }))('/api/edge-radar?date=2026-10-20');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'Az Edge Radar jelenleg nincs bekapcsolva.', code: 'EDGE_RADAR_DISABLED' });
    expect(f.calls).toEqual([]);
  });

  it('kifejezetten letiltva (false): 503; bekapcsolva (true): 200 – a kapcsolót kérésenként a szerver olvassa', async () => {
    const f = fake();
    const get = await app(PRO, f.edge, { todayOf: fixedToday('2026-10-20') });
    process.env.EDGE_RADAR_ENABLED = 'false';
    expect((await get('/api/edge-radar?date=2026-10-20')).status).toBe(503);
    process.env.EDGE_RADAR_ENABLED = 'true';
    const on = await get('/api/edge-radar?date=2026-10-20');
    expect(on.status).toBe(200);
    expect(f.calls).toEqual([{ date: '2026-10-20', variant: 'pro' }]);
    process.env.EDGE_RADAR_ENABLED = '0';
    expect((await get('/api/edge-radar?date=2026-10-20')).body.code).toBe('EDGE_RADAR_DISABLED');
  });

  it('a kapcsoló nem gyengíti a jogosultságot: kikapcsolva is FREE → 403, nem bejelentkezett → 401', async () => {
    delete process.env.EDGE_RADAR_ENABLED;
    expect((await (await app(FREE, fake().edge))('/api/edge-radar?date=2026-10-20')).status).toBe(403);
    await new Promise<void>((r) => server!.close(() => r())); server = null;
    expect((await (await app(ANON, fake().edge))('/api/edge-radar?date=2026-10-20')).status).toBe(401);
  });

  it('felület: a kikapcsolt állapot nem hiba, hanem külön jelzett állapot; más 503 hibaként megy tovább', async () => {
    expect(await loadEdgeRadar('2026-10-20', async () => { throw new ApiError('Az Edge Radar jelenleg nincs bekapcsolva.', 503, 'EDGE_RADAR_DISABLED'); })).toEqual({ kind: 'disabled' });
    await expect(loadEdgeRadar('2026-10-20', async () => { throw new ApiError('x', 503, 'UNAVAILABLE'); })).rejects.toThrow();
    const out = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(EdgeRadarBody, {
      date: '2026-10-20', onDate: () => {}, state: { loading: false, error: null, result: { kind: 'disabled' } }, matches: null, filters: DEFAULT_FILTERS, onFilters: () => {},
    })));
    expect(out).toContain('data-edge-state="disabled"');
    expect(out).not.toContain('data-edge-table');
  });
});

describe('Dátumkorlát: a mai nap + 7 naptári nap', () => {
  const opts: EdgeRadarRouterOptions = { enabled: () => true, todayOf: fixedToday('2026-10-20') };

  it('ma és a 7. nap elfogadva; a 8. nap és a múlt 400 DATE_OUT_OF_RANGE (a tartománnyal); a szolgáltatás nem fut', async () => {
    const f = fake();
    const get = await app(PRO, f.edge, opts);
    expect((await get('/api/edge-radar?date=2026-10-20')).status).toBe(200);
    expect((await get('/api/edge-radar?date=2026-10-27')).status).toBe(200);
    for (const d of ['2026-10-28', '2026-10-19', '2025-10-20', '2026-12-31']) {
      const r = await get(`/api/edge-radar?date=${d}`);
      expect(r.status, d).toBe(400);
      expect(r.body, d).toMatchObject({ code: 'DATE_OUT_OF_RANGE', min: '2026-10-20', max: '2026-10-27' });
    }
    expect(f.calls.map((c) => c.date)).toEqual(['2026-10-20', '2026-10-27']);
  });

  it('a hiányzó és a formailag érvénytelen dátum kezelése változatlan (DATE_REQUIRED / INVALID_DATE elsőbbséggel)', async () => {
    const get = await app(PRO, fake().edge, opts);
    expect((await get('/api/edge-radar')).body.code).toBe('DATE_REQUIRED');
    expect((await get('/api/edge-radar?date=2026-02-30')).body.code).toBe('INVALID_DATE');
    expect((await get('/api/edge-radar?date=20261020')).body.code).toBe('INVALID_DATE');
  });

  it('hónap- és évváltás, nyári időszámítás vége (10.25.): a naptári napszámítás időzónafüggetlen', () => {
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(addDays('2028-02-25', 7)).toBe('2028-03-03'); // szökőév
    expect(edgeDateRange(NOW, fixedToday('2026-12-28'))).toEqual({ min: '2026-12-28', max: '2027-01-04' });
  });

  it('napváltás: a „mai nap” a budapesti napkulcs (dayKey); késő esti UTC-időpontban a budapesti és az UTC-nap eltér', async () => {
    const late = new Date('2026-10-20T22:30:00.000Z'); // Budapesten már 10.21. 00:30
    const budapest = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest' }).format(d);
    const utc = (d: Date) => d.toISOString().slice(0, 10);
    expect(edgeDateRange(late, budapest)).toEqual({ min: '2026-10-21', max: '2026-10-28' });
    expect(edgeDateRange(late, utc)).toEqual({ min: '2026-10-20', max: '2026-10-27' });
    // alapértelmezés: a meglévő budapesti dayKey (NEM a szerver helyi ideje)
    expect(edgeDateRange(late)).toEqual({ min: '2026-10-21', max: '2026-10-28' });
    expect(edgeDateRange(late).min).toBe(dayKey(late));
    // a router alapértelmezése is ez: ma (10.21.) és +7 (10.28.) elfogadva, tegnap (10.20.) és +8 (10.29.) elutasítva
    const get = await app(PRO, fake().edge, { enabled: () => true }, late);
    expect((await get('/api/edge-radar?date=2026-10-21')).status).toBe(200);
    expect((await get('/api/edge-radar?date=2026-10-28')).status).toBe(200);
    expect((await get('/api/edge-radar?date=2026-10-20')).body).toMatchObject({ code: 'DATE_OUT_OF_RANGE', min: '2026-10-21', max: '2026-10-28' });
    expect((await get('/api/edge-radar?date=2026-10-29')).body.code).toBe('DATE_OUT_OF_RANGE');
  });

  it('felület: a dátumválasztó UGYANAZT a budapesti tartományt kínálja, mint a szerver (közös modul)', () => {
    const r = sharedRange(new Date());
    expect(r.min).toBe(dayKey(new Date()));
    const out = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(EdgeRadarBody, {
      date: r.min, onDate: () => {}, state: { loading: true, error: null, result: null }, matches: null, filters: DEFAULT_FILTERS, onFilters: () => {},
    })));
    expect(out).toContain(`min="${r.min}"`);
    expect(out).toContain(`max="${r.max}"`);
    // a szerver ugyanazt a függvényt használja
    expect(edgeDateRange(new Date())).toEqual(r);
  });

  it('DST-határok budapesti éjfél körül: a nap a budapesti naptár szerint vált, a +7 naptári nap pontos', () => {
    // őszi váltás (2026-10-25 03:00 CEST → 02:00 CET): 10.24. 22:30 UTC = Budapesten 10.25. 00:30
    expect(sharedRange(new Date('2026-10-24T22:30:00.000Z'))).toEqual({ min: '2026-10-25', max: '2026-11-01' });
    expect(sharedRange(new Date('2026-10-24T21:59:00.000Z'))).toEqual({ min: '2026-10-24', max: '2026-10-31' }); // még 23:59 CEST
    // a váltás utáni első éjfél (CET, UTC+1): 10.25. 23:00 UTC = 10.26. 00:00
    expect(sharedRange(new Date('2026-10-25T23:00:00.000Z')).min).toBe('2026-10-26');
    expect(sharedRange(new Date('2026-10-25T22:59:00.000Z')).min).toBe('2026-10-25');
    // tavaszi váltás (2026-03-29 02:00 CET → 03:00 CEST): 03.28. 23:30 UTC = Budapesten 03.29. 00:30
    expect(sharedRange(new Date('2026-03-28T23:30:00.000Z'))).toEqual({ min: '2026-03-29', max: '2026-04-05' });
    expect(sharedRange(new Date('2026-03-29T22:00:00.000Z')).min).toBe('2026-03-30'); // CEST éjfél
    // naptári napok (nem 24 órás eltolás): hónap-, év-, szökőév-határ
    expect(addCalendarDays('2026-02-26', 7)).toBe('2026-03-05');
    expect(addCalendarDays('2028-02-26', 7)).toBe('2028-03-04');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('a szerver folyamatának időzónájától független (TZ futás közben átállítva)', () => {
    const saved = process.env.TZ;
    const late = new Date('2026-10-20T22:30:00.000Z');
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(localDateKey(late.toISOString())).toBe('2026-10-20'); // a helyi idő itt más napot ad…
      expect(edgeDateRange(late)).toEqual({ min: '2026-10-21', max: '2026-10-28' }); // …az Edge-tartomány nem
      process.env.TZ = 'UTC';
      expect(edgeDateRange(late)).toEqual({ min: '2026-10-21', max: '2026-10-28' });
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });
});
