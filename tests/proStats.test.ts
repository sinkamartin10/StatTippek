/**
 * Nyilvános PRO-felhasználószám – HTTP-szintű és felületi tesztek.
 *
 * A VALÓDI routerekkel és a VALÓDI requireAdmin őrrel; a beállítás a VALÓDI
 * SqliteAppStore `app_settings` táblájában él (tartósság). A `res.locals.plan`
 * előállítása az egyetlen szimulált elem (élesben az attachPlan tölti ki).
 * A Supabase-darabszám szabályát a proStats.pg.test.ts ellenőrzi valódi PostgreSQL-en.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { SqliteAppStore } from '../src/server/db/appStore';
import { proStatsRouters, type ActiveProCounter } from '../src/server/billing/proStats';
import { requireAdmin } from '../src/server/billing/entitlement';
import { PRO_COUNTER_SETTING_KEY, formatProUsers } from '../src/shared/proStats';
import { ProUserCountView } from '../src/client/components/ProUserCount';
import { AdminProStatsView } from '../src/client/pages/AdminProStats';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN = { user: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: ADMIN_EMAIL };
const USER = { user: '11111111-1111-1111-1111-111111111111', email: 'anna@example.com' };
const DAY = 86_400_000;

type Profile = { status: string; end: string | null };
/** Ugyanaz a szabály, mint a profileIsPro: 'pro' és (nincs lejárat vagy a jövőben). */
const memoryCounter = (profiles: Profile[]): ActiveProCounter => async () =>
  profiles.filter((p) => p.status === 'pro' && (p.end == null || Date.parse(p.end) > Date.now())).length;

interface Harness { url: string; close: () => Promise<void>; settings: SqliteAppStore; profiles: Profile[]; clock: { t: number } }

function seedProfiles(): Profile[] {
  return [
    { status: 'pro', end: null },
    { status: 'pro', end: new Date(Date.now() + 10 * DAY).toISOString() },
    { status: 'pro', end: new Date(Date.now() + 1 * DAY).toISOString() },
    { status: 'pro', end: new Date(Date.now() - 1 * DAY).toISOString() }, // lejárt – nem számít
    { status: 'free', end: null },
    { status: 'past_due', end: new Date(Date.now() + 5 * DAY).toISOString() },
    { status: 'canceled', end: null },
  ];
}

async function startApp(settings = new SqliteAppStore(new DatabaseSync(':memory:')), profiles = seedProfiles(), counter?: ActiveProCounter | null): Promise<Harness> {
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  const clock = { t: Date.now() };
  const routers = proStatsRouters(settings, counter === undefined ? memoryCounter(profiles) : counter, () => clock.t);
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    const email = (req.header('x-test-email') ?? '').toLowerCase();
    res.locals.plan = { enforced: true, user: id ? { id, email } : null, pro: req.header('x-test-plan') === 'pro', admin: email === ADMIN_EMAIL };
    next();
  });
  app.use('/api/pro-stats', routers.pub);
  app.use('/api/admin/pro-stats', requireAdmin, routers.admin);
  const server: Server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())), settings, profiles, clock };
}

type Who = { user?: string; email?: string; pro?: boolean };
async function call(h: Harness, method: string, path: string, who: Who = {}, body?: unknown) {
  const res = await fetch(`${h.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who.user ? { 'x-test-user': who.user } : {}), ...(who.email ? { 'x-test-email': who.email } : {}), ...(who.pro ? { 'x-test-plan': 'pro' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

let h: Harness;
beforeEach(async () => { vi.spyOn(console, 'error').mockImplementation(() => {}); h = await startApp(); });
afterEach(async () => { vi.restoreAllMocks(); await h.close(); });

describe('Nyilvános PRO-szám – API', () => {
  it('alapértelmezés: megjelenik, és a TÉNYLEGES aktív PRO-k száma (lejárt, past_due, free, canceled nem számít); bejelentkezés nélkül olvasható', async () => {
    const r = await call(h, 'GET', '/api/pro-stats');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ show: true, count: 3 });
  });

  it('admin végpontok: bejelentkezés nélkül 401, nem admin (akár PRO) 403 – a beállítás nem változik', async () => {
    for (const who of [{}, USER, { ...USER, pro: true }]) {
      expect((await call(h, 'GET', '/api/admin/pro-stats', who)).status).toBe('user' in who ? 403 : 401);
      expect((await call(h, 'PUT', '/api/admin/pro-stats', who, { showPublic: false })).status).toBe('user' in who ? 403 : 401);
    }
    expect(await h.settings.getSetting(PRO_COUNTER_SETTING_KEY)).toBeNull();
    expect((await call(h, 'GET', '/api/pro-stats')).body).toEqual({ show: true, count: 3 });
  });

  it('admin: látja a tényleges számot, a megjelenítést és az utolsó módosítást; elrejtés/megjelenítés mentődik és visszaolvasható', async () => {
    const before = await call(h, 'GET', '/api/admin/pro-stats', ADMIN);
    expect(before.body).toMatchObject({ activeProCount: 3, showPublic: true, updatedAt: null, updatedBy: null });
    expect(before.body.definition).toMatch(/subscription_status/);

    const hide = await call(h, 'PUT', '/api/admin/pro-stats', ADMIN, { showPublic: false });
    expect(hide.status).toBe(200);
    expect(hide.body).toMatchObject({ activeProCount: 3, showPublic: false, updatedBy: ADMIN.user });
    expect(typeof hide.body.updatedAt).toBe('string');
    expect((await call(h, 'GET', '/api/pro-stats')).body).toEqual({ show: false, count: null }); // a gyorsítótár azonnal ürül

    await call(h, 'PUT', '/api/admin/pro-stats', ADMIN, { showPublic: true });
    expect((await call(h, 'GET', '/api/pro-stats')).body).toEqual({ show: true, count: 3 });
  });

  it('kézi szám nem állítható: számot, szöveget, hiányzó mezőt elutasít; a küldött count/activeProCount figyelmen kívül marad', async () => {
    for (const body of [{ showPublic: 50 }, { showPublic: 'true' }, { showPublic: null }, {}, { count: 1000 }, { activeProCount: -1 }]) {
      const r = await call(h, 'PUT', '/api/admin/pro-stats', ADMIN, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(await h.settings.getSetting(PRO_COUNTER_SETTING_KEY)).toBeNull();
    await call(h, 'PUT', '/api/admin/pro-stats', ADMIN, { showPublic: true, count: 1000, activeProCount: 999 });
    expect((await call(h, 'GET', '/api/pro-stats')).body).toEqual({ show: true, count: 3 });
    expect(JSON.parse((await h.settings.getSetting(PRO_COUNTER_SETTING_KEY))!)).not.toHaveProperty('count');
  });

  it('tartós: új szerverpéldány / újraindulás ugyanazon az adatbázison ugyanazt a beállítást látja', async () => {
    await call(h, 'PUT', '/api/admin/pro-stats', ADMIN, { showPublic: false });
    const second = await startApp(h.settings, h.profiles);
    try {
      expect((await call(second, 'GET', '/api/pro-stats')).body).toEqual({ show: false, count: null });
      expect((await call(second, 'GET', '/api/admin/pro-stats', ADMIN)).body).toMatchObject({ showPublic: false, updatedBy: ADMIN.user });
    } finally { await second.close(); }
  });

  it('párhuzamos admin-műveletek: idempotens célállapot – a tárolt érték mindig érvényes, és megegyezik az utolsó írással', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => call(h, 'PUT', '/api/admin/pro-stats', ADMIN, { showPublic: i % 2 === 0 })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const stored = JSON.parse((await h.settings.getSetting(PRO_COUNTER_SETTING_KEY))!);
    expect(typeof stored.showPublic).toBe('boolean');
    const pub = (await call(h, 'GET', '/api/pro-stats')).body;
    expect(pub).toEqual(stored.showPublic ? { show: true, count: 3 } : { show: false, count: null });
  });

  it('a beállítás nem változtat PRO-jogosultságot: a profilok érintetlenek, a szám csak olvasás', async () => {
    const snapshot = JSON.stringify(h.profiles);
    await call(h, 'PUT', '/api/admin/pro-stats', ADMIN, { showPublic: false });
    await call(h, 'PUT', '/api/admin/pro-stats', ADMIN, { showPublic: true });
    expect(JSON.stringify(h.profiles)).toBe(snapshot);
    // a szám a valóságot követi: új aktív PRO → nő (a nyilvános gyorsítótár lejárta után)
    h.profiles.push({ status: 'pro', end: null });
    expect((await call(h, 'GET', '/api/admin/pro-stats', ADMIN)).body.activeProCount).toBe(4);
    h.clock.t += 61_000;
    expect((await call(h, 'GET', '/api/pro-stats')).body.count).toBe(4);
  });

  it('hiba vagy adatbázis nélküli mód: nincs kitalált szám', async () => {
    const broken = await startApp(new SqliteAppStore(new DatabaseSync(':memory:')), [], async () => { throw new Error('db down'); });
    const none = await startApp(new SqliteAppStore(new DatabaseSync(':memory:')), [], null);
    try {
      expect((await call(broken, 'GET', '/api/pro-stats')).status).toBe(503);
      expect((await call(none, 'GET', '/api/pro-stats')).body).toEqual({ show: false, count: null });
      expect((await call(none, 'GET', '/api/admin/pro-stats', ADMIN)).body.activeProCount).toBeNull();
    } finally { await broken.close(); await none.close(); }
  });

  it('sérült tárolt beállítás → biztonságos alapértelmezés', async () => {
    await h.settings.setSetting(PRO_COUNTER_SETTING_KEY, '{nem json');
    expect((await call(h, 'GET', '/api/admin/pro-stats', ADMIN)).body).toMatchObject({ showPublic: true, updatedAt: null });
  });
});

describe('Nyilvános PRO-szám – felület', () => {
  it('„X PRO-felhasználó” formázás és megjelenés; kikapcsolva, 0-nál, hibánál/betöltéskor semmi', () => {
    expect(formatProUsers(13)).toBe('13 PRO-felhasználó');
    expect(formatProUsers(1250)).toBe('1 250 PRO-felhasználó');
    expect(renderToStaticMarkup(createElement(ProUserCountView, { data: { show: true, count: 13 } }))).toContain('13 PRO-felhasználó');
    for (const data of [null, { show: false, count: null }, { show: true, count: 0 }, { show: true, count: null }]) {
      expect(renderToStaticMarkup(createElement(ProUserCountView, { data }))).toBe('');
    }
  });

  it('a nyitóoldal és a főoldal UGYANAZT a komponenst és forrást használja (nincs beégetett szám)', () => {
    const landing = readFileSync(new URL('../src/client/pages/Landing.tsx', import.meta.url), 'utf8');
    const dashboard = readFileSync(new URL('../src/client/pages/Dashboard.tsx', import.meta.url), 'utf8');
    const component = readFileSync(new URL('../src/client/components/ProUserCount.tsx', import.meta.url), 'utf8');
    for (const src of [landing, dashboard]) {
      expect(src).toContain("import { ProUserCount } from '../components/ProUserCount';");
      expect(src.match(/<ProUserCount\b/g)).toHaveLength(1);
      expect(src).not.toMatch(/\d+\s*PRO-felhasználó/);
    }
    expect(component).toContain('api.proStats()');
    expect(component).not.toMatch(/count:\s*\d|\?\?\s*\d/);
  });

  it('admin nézet: tényleges szám, megjelenítési állapot, utolsó módosítás; a megfelelő gomb tiltott', () => {
    const base = { activeProCount: 13, showPublic: true, updatedAt: null, updatedBy: null, definition: 'x' };
    const html = renderToStaticMarkup(createElement(AdminProStatsView, { d: base, busy: false, onShow: () => {}, onHide: () => {} }));
    expect(html).toContain('Ténylegesen aktív PRO');
    expect(html).toContain('13 PRO-felhasználó');
    expect(html).toContain('alapértelmezés');
    expect(html).toContain('kézzel nem írható át');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-pressed="true"[^>]*>.*Megjelenítés/);
    const hidden = renderToStaticMarkup(createElement(AdminProStatsView, { d: { ...base, showPublic: false, updatedAt: new Date().toISOString() }, busy: false, onShow: () => {}, onHide: () => {} }));
    expect(hidden).toContain('Rejtve');
  });
});
