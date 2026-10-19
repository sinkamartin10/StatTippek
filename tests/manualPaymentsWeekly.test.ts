/**
 * Heti PRO (1 490 Ft / 7 nap) + havi (ajánlott, alapértelmezett) – a kézi fizetési folyamatban.
 * VALÓDI routerek és őrök (requireAuthenticated / requireAdmin); a csomag (`res.locals.plan`)
 * szimulált, mint a manualPayments.test.ts-ben. A 0022 SQL-t a manualPaymentsWeekly.pg.test.ts
 * ellenőrzi valódi PostgreSQL-en.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { MemoryManualPaymentStore, adminProPaymentsRouter, proPaymentsRouter, proPlans, proWeeklyEnabled, type ManualPaymentStore, type ProPaymentsRouterOptions, type ProfileState } from '../src/server/billing/manualPayments';
import { requireAdmin } from '../src/server/billing/entitlement';
import { APP_PRO_PRICE, APP_WEEKLY_PRO_PRICE, PAYEE, formatAmount, plansOf, type ProPaymentInfo, type ProPrice } from '../src/shared/manualPayment';
import { ManualPaymentSection, PlanPicker, dailyCostLabel } from '../src/client/components/ManualPayment';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN = { user: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: ADMIN_EMAIL };
const A = { user: '11111111-1111-1111-1111-111111111111', email: 'anna@example.com' };
const DAY = 86_400_000;
type Who = { user?: string; email?: string };

let h: { url: string; close: () => Promise<void>; store: MemoryManualPaymentStore; profiles: Map<string, ProfileState> };
// a heti csomag ebben a fájlban alapból ENGEDÉLYEZETT (a kapcsoló tesztjei a `router` opcióval állítják)
async function startApp(opts: { price?: ProPrice; store?: (profiles: Map<string, ProfileState>) => ManualPaymentStore; router?: ProPaymentsRouterOptions } = {}) {
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  const profiles = new Map<string, ProfileState>([
    [A.user, { status: 'free', subscriptionEnd: null, stripeSubscriptionId: null }],
    [ADMIN.user, { status: 'free', subscriptionEnd: null, stripeSubscriptionId: null }],
  ]);
  const mem = new MemoryManualPaymentStore(profiles);
  const store = opts.store ? opts.store(profiles) : mem;
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    const email = (req.header('x-test-email') ?? '').toLowerCase();
    res.locals.plan = { enforced: true, user: id ? { id, email } : null, pro: profiles.get(id ?? '')?.status === 'pro', admin: email === ADMIN_EMAIL };
    next();
  });
  app.use('/api/pro-payments', proPaymentsRouter(store, async () => opts.price ?? APP_PRO_PRICE, opts.router ?? { weeklyEnabled: () => true }));
  app.use('/api/admin/pro-payments', requireAdmin, adminProPaymentsRouter(store));
  const server: Server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())), store: mem, profiles };
}
async function call(method: string, path: string, who: Who = {}, body?: unknown) {
  const res = await fetch(`${h.url}${path}`, { method, headers: { 'content-type': 'application/json', ...(who.user ? { 'x-test-user': who.user } : {}), ...(who.email ? { 'x-test-email': who.email } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
const order = (who: Who, body: unknown) => call('POST', '/api/pro-payments', who, body);
const approve = (who: Who, id: string, v?: unknown) => {
  const r = h.store.requests.get(id);
  return call('POST', `/api/admin/pro-payments/${id}/approve`, who, v ?? (r ? { amount: r.amount, currency: r.currency, method: r.method } : undefined));
};

beforeEach(async () => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); h = await startApp(); });
afterEach(async () => { vi.restoreAllMocks(); await h.close(); });

describe('Csomagok a szervertől', () => {
  it('havi (ajánlott, az érvényes szerverár: 2 990 Ft/hó) és heti (1 490 Ft / 7 nap); a havi az első és ajánlott', async () => {
    const info = (await call('GET', '/api/pro-payments')).body as ProPaymentInfo;
    expect(info.plans).toEqual([
      { id: 'month', price: APP_PRO_PRICE, recommended: true },
      { id: 'week', price: APP_WEEKLY_PRO_PRICE, recommended: false },
    ]);
    expect(info.price).toEqual(APP_PRO_PRICE); // visszafelé kompatibilis mező
    expect(APP_WEEKLY_PRO_PRICE).toMatchObject({ amount: 1490, currency: 'HUF', interval: 'week' });
    expect(APP_PRO_PRICE).toMatchObject({ amount: 2990, currency: 'HUF', interval: 'month' });
    expect(info.payee).toEqual(PAYEE);
  });
  it('a havi ár a meglévő árforrásból jön (pl. Stripe-ár), a heti fix szerverkonfiguráció', async () => {
    const stripe: ProPrice = { amount: 3490, currency: 'HUF', interval: 'month', label: '3 490 Ft/hó', source: 'stripe' };
    const plans = await proPlans(async () => stripe, true);
    expect(plans.map((p) => [p.id, p.price.amount])).toEqual([['month', 3490], ['week', 1490]]);
  });
});

describe('Rendelés (függő kérelem)', () => {
  it('heti: pontosan 1 490 Ft, „week” időtartam – a manipulált kliensár / időtartam / státusz figyelmen kívül marad', async () => {
    const r = await order(A, { method: 'revolut', plan: 'week', amount: 1, currency: 'EUR', interval: 'year', durationDays: 365, status: 'approved', pro: true, userId: ADMIN.user });
    expect(r.status).toBe(201);
    expect(r.body.request).toMatchObject({ method: 'revolut', amount: 1490, currency: 'HUF', interval: 'week', status: 'pending', activatedUntil: null });
    expect(h.store.requests.get(r.body.request.id)!.userId).toBe(A.user);
    expect(h.profiles.get(A.user)!.status).toBe('free'); // a rendelés NEM aktivál
  });
  it('havi: a jóváhagyott szerverár (2 990 Ft, „month”); banki átutalással is ugyanaz a kézi folyamat', async () => {
    const r = await order(A, { method: 'bank_transfer', plan: 'month', amount: 10 });
    expect(r.body.request).toMatchObject({ method: 'bank_transfer', amount: 2990, currency: 'HUF', interval: 'month', status: 'pending' });
    expect(h.profiles.get(A.user)!.status).toBe('free');
  });
  it('régi kliens (csomag nélkül) → havi; érvénytelen csomag → 400 INVALID_PLAN, kérelem nélkül', async () => {
    expect((await order(A, { method: 'bank_transfer' })).body.request.interval).toBe('month');
    await h.close(); h = await startApp();
    for (const plan of ['year', 'day', '', 7, null]) {
      const r = await order(A, { method: 'bank_transfer', plan });
      expect(r.status, String(plan)).toBe(400);
      expect(r.body.code).toBe('INVALID_PLAN');
    }
    expect(h.store.requests.size).toBe(0);
  });
  it('a kiválasztott heti csomag megmarad: függő HAVI kérelem mellett a heti rendelés 409 PENDING_OTHER_PLAN – nem csúszik át csendben', async () => {
    await order(A, { method: 'bank_transfer', plan: 'month' });
    const r = await order(A, { method: 'bank_transfer', plan: 'week' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'PENDING_OTHER_PLAN', request: { interval: 'month' } });
    // azonos csomag ismétlése: a meglévő függő kérelem (nincs második)
    const same = await order(A, { method: 'bank_transfer', plan: 'month' });
    expect(same.status).toBe(200);
    expect(same.body.created).toBe(false);
    expect(h.store.requests.size).toBe(1);
  });
  it('bejelentkezés nélkül 401, kérelem nincs', async () => {
    const r = await order({}, { method: 'bank_transfer', plan: 'week' });
    expect(r.status).toBe(401);
    expect(h.store.requests.size).toBe(0);
  });
  it('a 0022 migráció nélkül a heti rendelés egyértelmű 503 PLAN_UNAVAILABLE (a havi működik)', async () => {
    await h.close();
    h = await startApp({ store: (profiles) => {
      const s = new MemoryManualPaymentStore(profiles);
      const orig = s.createPending.bind(s);
      s.createPending = async (r) => { if (r.price.interval === 'week') throw new Error('[pro-payments] createPending: new row for relation "pro_payment_requests" violates check constraint "pro_payment_requests_billing_interval_check"'); return orig(r); };
      return s;
    } });
    const w = await order(A, { method: 'bank_transfer', plan: 'week' });
    expect(w.status).toBe(503);
    expect(w.body.code).toBe('PLAN_UNAVAILABLE');
    expect((await order(A, { method: 'bank_transfer', plan: 'month' })).status).toBe(201);
  });
});

describe('Admin-jóváhagyás és időtartam', () => {
  it('FREE / nem admin és névtelen felhasználó nem hagyhat jóvá', async () => {
    const id = (await order(A, { method: 'bank_transfer', plan: 'week' })).body.request.id;
    expect((await approve(A, id)).status).toBe(403);
    expect((await approve({}, id)).status).toBe(401);
    expect(h.store.requests.get(id)!.status).toBe('pending');
  });
  it('heti jóváhagyás: pontosan 7 nap PRO; havi: naptári 1 hónap (a meglévő szabály)', async () => {
    const t0 = Date.now();
    const id = (await order(A, { method: 'revolut', plan: 'week' })).body.request.id;
    const ok = await approve(ADMIN, id);
    expect(ok.status).toBe(200);
    const end = Date.parse(h.profiles.get(A.user)!.subscriptionEnd!);
    expect(end - t0).toBeGreaterThanOrEqual(7 * DAY - 1000);
    expect(end - t0).toBeLessThan(7 * DAY + 60_000);
    expect(h.profiles.get(A.user)!.status).toBe('pro');
    expect(ok.body.request).toMatchObject({ status: 'approved', decidedBy: ADMIN.user, activatedUntil: h.profiles.get(A.user)!.subscriptionEnd });
    // havi egy másik (lejárt PRO) fióknál: mától naptári 1 hónap
    h.profiles.set(ADMIN.user, { status: 'free', subscriptionEnd: null, stripeSubscriptionId: null });
    const B = { user: '33333333-3333-3333-3333-333333333333', email: 'b@example.com' };
    h.profiles.set(B.user, { status: 'free', subscriptionEnd: null, stripeSubscriptionId: null });
    const mid = (await order(B, { method: 'bank_transfer', plan: 'month' })).body.request.id;
    await approve(ADMIN, mid);
    const exp = new Date(); exp.setUTCMonth(exp.getUTCMonth() + 1);
    expect(Math.abs(Date.parse(h.profiles.get(B.user)!.subscriptionEnd!) - exp.getTime())).toBeLessThan(60_000);
  });
  it('meghosszabbítás: érvényes PRO a lejárattól +7 nap; korlátlan PRO nem rövidül', async () => {
    const end = new Date(Date.now() + 10 * DAY).toISOString();
    h.profiles.set(A.user, { status: 'pro', subscriptionEnd: end, stripeSubscriptionId: null });
    const id = (await order(A, { method: 'bank_transfer', plan: 'week' })).body.request.id;
    await approve(ADMIN, id);
    expect(Date.parse(h.profiles.get(A.user)!.subscriptionEnd!)).toBe(Date.parse(end) + 7 * DAY);
    h.profiles.set(A.user, { status: 'pro', subscriptionEnd: null, stripeSubscriptionId: null });
    const id2 = (await order(A, { method: 'bank_transfer', plan: 'week' })).body.request.id;
    const r = await approve(ADMIN, id2);
    expect(r.body.request.activatedUntil).toBeNull();
    expect(h.profiles.get(A.user)!.subscriptionEnd).toBeNull();
  });
  it('dupla jóváhagyás: a második 409 ALREADY_PROCESSED, a lejárat csak egyszer hosszabbodik; párhuzamosan is egy sikerül', async () => {
    const id = (await order(A, { method: 'bank_transfer', plan: 'week' })).body.request.id;
    const rs = await Promise.all([1, 2, 3].map(() => approve(ADMIN, id)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    const end = h.profiles.get(A.user)!.subscriptionEnd;
    const again = await approve(ADMIN, id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_PROCESSED');
    expect(h.profiles.get(A.user)!.subscriptionEnd).toBe(end);
  });
  it('az ellenőrzött összeg/mód kötelező és egyezzen; eltérésnél 409, a PRO nem aktiválódik', async () => {
    const id = (await order(A, { method: 'bank_transfer', plan: 'week' })).body.request.id;
    expect((await call('POST', `/api/admin/pro-payments/${id}/approve`, ADMIN, {})).body.code).toBe('VERIFICATION_REQUIRED');
    for (const v of [{ amount: 2990, currency: 'HUF', method: 'bank_transfer' }, { amount: 1490, currency: 'EUR', method: 'bank_transfer' }, { amount: 1490, currency: 'HUF', method: 'revolut' }]) {
      const r = await approve(ADMIN, id, v);
      expect(r.status, JSON.stringify(v)).toBe(409);
      expect(r.body.code).toBe('VERIFICATION_MISMATCH');
    }
    expect(h.profiles.get(A.user)!.status).toBe('free');
    expect(h.store.requests.get(id)!.status).toBe('pending');
    expect((await approve(ADMIN, id, { amount: 1490, currency: 'huf', method: 'bank_transfer' })).status).toBe(200);
  });
  it('az (egyetlen) admin a SAJÁT, ellenőrzött heti befizetését jóváhagyhatja: pontosan 7 nap PRO', async () => {
    const t0 = Date.now();
    const id = (await order(ADMIN, { method: 'revolut', plan: 'week' })).body.request.id;
    expect(h.profiles.get(ADMIN.user)!.status).toBe('free'); // a rendelés önmagában nem aktivál
    const r = await approve(ADMIN, id);
    expect(r.status).toBe(200);
    expect(r.body.request).toMatchObject({ status: 'approved', decidedBy: ADMIN.user, userId: ADMIN.user });
    const end = Date.parse(h.profiles.get(ADMIN.user)!.subscriptionEnd!);
    expect(end - t0).toBeGreaterThanOrEqual(7 * DAY - 1000);
    expect(end - t0).toBeLessThan(7 * DAY + 60_000);
  });
  it('saját havi befizetés: naptári 1 hónap', async () => {
    const id = (await order(ADMIN, { method: 'bank_transfer', plan: 'month' })).body.request.id;
    expect((await approve(ADMIN, id)).status).toBe(200);
    const exp = new Date(); exp.setUTCMonth(exp.getUTCMonth() + 1);
    expect(Math.abs(Date.parse(h.profiles.get(ADMIN.user)!.subscriptionEnd!) - exp.getTime())).toBeLessThan(60_000);
  });
  it('saját kérelemnél is kötelező az ellenőrzött összeg/mód: hiány 400, eltérés 409 – a PRO nem aktiválódik', async () => {
    const id = (await order(ADMIN, { method: 'bank_transfer', plan: 'week' })).body.request.id;
    expect((await call('POST', `/api/admin/pro-payments/${id}/approve`, ADMIN, {})).body.code).toBe('VERIFICATION_REQUIRED');
    for (const v of [{ amount: 2990, currency: 'HUF', method: 'bank_transfer' }, { amount: 1490, currency: 'HUF', method: 'revolut' }, { amount: 1, currency: 'HUF', method: 'bank_transfer' }]) {
      expect((await approve(ADMIN, id, v)).body.code, JSON.stringify(v)).toBe('VERIFICATION_MISMATCH');
    }
    expect(h.profiles.get(ADMIN.user)!.status).toBe('free');
    expect(h.store.requests.get(id)!.status).toBe('pending');
  });
  it('saját kérelem: dupla és párhuzamos jóváhagyásnál pontosan egy sikerül, a lejárat egyszer hosszabbodik', async () => {
    const id = (await order(ADMIN, { method: 'bank_transfer', plan: 'week' })).body.request.id;
    const rs = await Promise.all([1, 2, 3].map(() => approve(ADMIN, id)));
    expect(rs.filter((x) => x.status === 200)).toHaveLength(1);
    expect(rs.filter((x) => x.status === 409 && x.body.code === 'ALREADY_PROCESSED')).toHaveLength(2);
    const end = h.profiles.get(ADMIN.user)!.subscriptionEnd;
    expect((await approve(ADMIN, id)).body.code).toBe('ALREADY_PROCESSED');
    expect(h.profiles.get(ADMIN.user)!.subscriptionEnd).toBe(end);
  });
  it('NEM admin a saját kérelmét sem hagyhatja jóvá (403), akkor sem, ha a törzsben adminjogot / felhasználót állít', async () => {
    const id = (await order(A, { method: 'bank_transfer', plan: 'week' })).body.request.id;
    const r = await call('POST', `/api/admin/pro-payments/${id}/approve`, A, { amount: 1490, currency: 'HUF', method: 'bank_transfer', isAdmin: true, admin: true, userId: ADMIN.user, status: 'approved' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('ADMIN_REQUIRED');
    expect(h.profiles.get(A.user)!.status).toBe('free');
    expect(h.store.requests.get(id)!.status).toBe('pending');
  });
  it('érvénytelen azonosító 400, nem létező 404, elutasított kérelem 409 – egyik sem aktivál', async () => {
    expect((await approve(ADMIN, 'nem-uuid', { amount: 1490, currency: 'HUF', method: 'bank_transfer' })).status).toBe(400);
    expect((await approve(ADMIN, '99999999-9999-9999-9999-999999999999', { amount: 1490, currency: 'HUF', method: 'bank_transfer' })).status).toBe(404);
    const id = (await order(A, { method: 'bank_transfer', plan: 'week' })).body.request.id;
    await call('POST', `/api/admin/pro-payments/${id}/reject`, ADMIN, { note: 'nem érkezett meg' });
    const r = await approve(ADMIN, id);
    expect(r.status).toBe(409);
    expect(h.profiles.get(A.user)!.status).toBe('free');
  });
});

describe('Heti csomag kapcsolója (PRO_WEEKLY_ENABLED)', () => {
  let weekly = false;
  beforeEach(async () => { weekly = false; await h.close(); h = await startApp({ router: { weeklyEnabled: () => weekly } }); });

  it('a kapcsoló értelmezése: alapból (hiányzó / üres / ismeretlen érték) TILTVA; csak true/1/on/yes engedélyez', () => {
    for (const v of [undefined, '', 'false', '0', 'off', 'no', 'week', 'enabled', 'truee']) expect(proWeeklyEnabled({ PRO_WEEKLY_ENABLED: v }), String(v)).toBe(false);
    for (const v of ['true', 'TRUE', ' 1 ', 'on', 'Yes']) expect(proWeeklyEnabled({ PRO_WEEKLY_ENABLED: v }), v).toBe(true);
  });
  it('alapértelmezett router (nincs opció): a környezeti változót olvassa – hiányában tiltva, true-ra engedélyezve', async () => {
    const saved = process.env.PRO_WEEKLY_ENABLED;
    try {
      delete process.env.PRO_WEEKLY_ENABLED;
      await h.close(); h = await startApp({ router: {} });
      expect(((await call('GET', '/api/pro-payments')).body as ProPaymentInfo).plans!.map((p) => p.id)).toEqual(['month']);
      expect((await order(A, { method: 'revolut', plan: 'week' })).status).toBe(503);
      process.env.PRO_WEEKLY_ENABLED = 'true'; // kérésenként olvasódik ki
      expect(((await call('GET', '/api/pro-payments')).body as ProPaymentInfo).plans!.map((p) => p.id)).toEqual(['month', 'week']);
      expect((await order(A, { method: 'revolut', plan: 'week' })).status).toBe(201);
    } finally {
      if (saved === undefined) delete process.env.PRO_WEEKLY_ENABLED; else process.env.PRO_WEEKLY_ENABLED = saved;
    }
  });
  it('1. tiltva a heti rendelés 503 PLAN_UNAVAILABLE – nem jön létre kérelem, és havi sem lesz belőle', async () => {
    const spy = vi.spyOn(h.store, 'createPending');
    for (const method of ['bank_transfer', 'revolut']) {
      const r = await order(A, { method, plan: 'week' });
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('PLAN_UNAVAILABLE');
      expect(r.body.request).toBeUndefined();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(h.store.requests.size).toBe(0);
    expect(h.profiles.get(A.user)!.status).toBe('free');
  });
  it('2. tiltva a GET plans csak a havit tartalmazza (ajánlott); a price mező változatlanul a havi', async () => {
    const info = (await call('GET', '/api/pro-payments', A)).body as ProPaymentInfo;
    expect(info.plans).toEqual([{ id: 'month', price: APP_PRO_PRICE, recommended: true }]);
    expect(info.price).toEqual(APP_PRO_PRICE);
    expect(JSON.stringify(info)).not.toContain('"week"');
    expect(await proPlans(async () => APP_PRO_PRICE, false)).toEqual([{ id: 'month', price: APP_PRO_PRICE, recommended: true }]);
  });
  it('3. engedélyezve a heti csomag rendelhető: 1 490 Ft, „week”, függő kérelem; a GET mindkét csomagot adja', async () => {
    weekly = true;
    expect(((await call('GET', '/api/pro-payments')).body as ProPaymentInfo).plans).toEqual([
      { id: 'month', price: APP_PRO_PRICE, recommended: true },
      { id: 'week', price: APP_WEEKLY_PRO_PRICE, recommended: false },
    ]);
    const r = await order(A, { method: 'revolut', plan: 'week', amount: 1 });
    expect(r.status).toBe(201);
    expect(r.body.request).toMatchObject({ amount: 1490, currency: 'HUF', interval: 'week', status: 'pending' });
  });
  it('4. tiltva is: csomag nélküli (régi) kliens → havi, 2 990 Ft; a kifejezett havi is változatlan', async () => {
    const r = await order(A, { method: 'bank_transfer' });
    expect(r.status).toBe(201);
    expect(r.body.request).toMatchObject({ amount: 2990, currency: 'HUF', interval: 'month', status: 'pending' });
    const again = await order(A, { method: 'bank_transfer', plan: 'month' });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(h.store.requests.size).toBe(1);
  });
  it('5. érvénytelen csomag mindkét állásban 400 INVALID_PLAN (nem 503), kérelem nélkül', async () => {
    for (const on of [false, true]) {
      weekly = on;
      for (const plan of ['year', 'day', 'WEEK', '', 7, null, ['week'], { id: 'week' }]) {
        const r = await order(A, { method: 'bank_transfer', plan });
        expect(r.status, `${on} ${JSON.stringify(plan)}`).toBe(400);
        expect(r.body.code).toBe('INVALID_PLAN');
      }
    }
    expect(h.store.requests.size).toBe(0);
  });
  it('6. meglévő heti kérelem a tiltás után is kezelhető: a lista mutatja, a jóváhagyás pontosan 168 órát ad, az elutasítás működik', async () => {
    weekly = true;
    const B = { user: '44444444-4444-4444-4444-444444444444', email: 'b@example.com' };
    h.profiles.set(B.user, { status: 'free', subscriptionEnd: null, stripeSubscriptionId: null });
    const wa = (await order(A, { method: 'revolut', plan: 'week' })).body.request.id;
    const wb = (await order(B, { method: 'bank_transfer', plan: 'week' })).body.request.id;
    weekly = false; // a kapcsoló lekapcsolva – a meglévő heti kérelmek maradnak
    expect((await order(A, { method: 'revolut', plan: 'week' })).status).toBe(503);
    const list = await call('GET', '/api/admin/pro-payments?status=pending', ADMIN);
    expect(list.status).toBe(200);
    expect((list.body as { id: string; interval: string }[]).map((x) => [x.id, x.interval]).sort()).toEqual([[wa, 'week'], [wb, 'week']].sort());
    const ok = await approve(ADMIN, wa);
    expect(ok.status).toBe(200);
    expect(ok.body.request).toMatchObject({ status: 'approved', interval: 'week' });
    expect(Date.parse(ok.body.request.activatedUntil) - Date.parse(ok.body.request.decidedAt)).toBe(168 * 3_600_000);
    expect(h.profiles.get(A.user)).toMatchObject({ status: 'pro', subscriptionEnd: ok.body.request.activatedUntil });
    const no = await call('POST', `/api/admin/pro-payments/${wb}/reject`, ADMIN, { note: 'nem érkezett meg' });
    expect(no.status).toBe(200);
    expect(no.body.request).toMatchObject({ status: 'rejected', interval: 'week', decisionNote: 'nem érkezett meg' });
    expect(h.profiles.get(B.user)!.status).toBe('free');
    // a saját (admin) meglévő heti kérelme is jóváhagyható tiltás mellett
    weekly = true;
    const own = (await order(ADMIN, { method: 'bank_transfer', plan: 'week' })).body.request.id;
    weekly = false;
    const mine = await approve(ADMIN, own);
    expect(mine.status).toBe(200);
    expect(Date.parse(mine.body.request.activatedUntil) - Date.parse(mine.body.request.decidedAt)).toBe(168 * 3_600_000);
  });
  it('7. a kliens nem kapcsolhatja be: törzs-, query- és fejlécmező hatástalan; a szerver ára és a validáció érvényes marad', async () => {
    const res = await fetch(`${h.url}/api/pro-payments?PRO_WEEKLY_ENABLED=true&weeklyEnabled=1&weekly=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': A.user, 'x-test-email': A.email, 'x-pro-weekly-enabled': 'true', 'pro-weekly-enabled': 'true' },
      body: JSON.stringify({ method: 'revolut', plan: 'week', weeklyEnabled: true, PRO_WEEKLY_ENABLED: 'true', enabled: true, plans: [{ id: 'week', price: { amount: 1, currency: 'HUF', interval: 'week' } }], interval: 'week', amount: 1 }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('PLAN_UNAVAILABLE');
    const info = await fetch(`${h.url}/api/pro-payments?PRO_WEEKLY_ENABLED=true`, { headers: { 'x-pro-weekly-enabled': 'true' } }).then((r) => r.json()) as ProPaymentInfo;
    expect(info.plans!.map((p) => p.id)).toEqual(['month']);
    // a havi rendelésbe a kliens által küldött „heti” időtartam / ár nem szivárog át
    const m = await order(A, { method: 'revolut', interval: 'week', amount: 1490, weeklyEnabled: true });
    expect(m.body.request).toMatchObject({ interval: 'month', amount: 2990 });
    expect(h.store.requests.size).toBe(1);
    // engedélyezve sem kerülhető meg a validáció (érvénytelen mód / csomag), és az ár a szerveré
    weekly = true;
    expect((await order(A, { method: 'cash', plan: 'week' })).body.code).toBe('INVALID_METHOD');
    expect((await order(A, { method: 'revolut', plan: 'weekly' })).body.code).toBe('INVALID_PLAN');
  });
});

describe('Felület: csomagválasztó', () => {
  const info: ProPaymentInfo = { price: APP_PRO_PRICE, plans: [{ id: 'month', price: APP_PRO_PRICE, recommended: true }, { id: 'week', price: APP_WEEKLY_PRO_PRICE, recommended: false }], payee: PAYEE, requests: [], reference: 'anna@example.com' };
  const render = (i: ProPaymentInfo = info) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ManualPaymentSection, { info: i, loggedIn: true, onRequested: () => {} })));

  it('alapból a HAVI van kiválasztva, „Ajánlott” jelöléssel; a heti látható és választható, ár és időtartam a rendelés előtt', () => {
    const out = render();
    expect(out).toMatch(/role="radio" aria-checked="true" data-plan="month"/);
    expect(out).toMatch(/role="radio" aria-checked="false" data-plan="week"/);
    expect(out).not.toMatch(/data-plan="week"[^>]*disabled/);
    expect(out).toContain('data-plan-recommended');
    expect((out.match(/data-plan-recommended/g) ?? []).length).toBe(1);
    for (const s of ['Havi PRO', 'Heti PRO', formatAmount(2990, 'HUF'), formatAmount(1490, 'HUF'), '1 hónap', '7 nap', 'nem újul meg automatikusan']) expect(out, s).toContain(s);
    expect(out).toContain('data-selected-plan="month"');
    expect(out).toContain('data-send-plan="month"');
    expect(out).toContain(`Befizetés elküldve ellenőrzésre (${formatAmount(2990, 'HUF')} · 1 hónap)`);
  });

  it('a heti kiválasztása a fizetendő összeget és a küldött csomagot is a hetire állítja (a PlanPicker vezérelt)', () => {
    const out = renderToStaticMarkup(createElement(PlanPicker, { plans: info.plans!, selected: 'week', onSelect: () => {} }));
    expect(out).toMatch(/aria-checked="true" data-plan="week"/);
    expect(out).toMatch(/aria-checked="false" data-plan="month"/);
    // a küldés a kiválasztott csomag azonosítóját viszi (api.requestProPayment(method, planId) – lásd a kliens-tesztet)
  });

  it('napi összehasonlító költség a szerver árából: heti ár/7, havi ár/31–ár/28, éves nincs; mindig a „teljes ár” megjegyzéssel', () => {
    expect(dailyCostLabel(APP_WEEKLY_PRO_PRICE)).toBe(`Kb. ${formatAmount(213, 'HUF')}/nap`); // 1490 / 7 = 212,86
    expect(dailyCostLabel(APP_PRO_PRICE)).toBe(`Kb. 96–${formatAmount(107, 'HUF')}/nap, a hónap hosszától függően`); // 2990/31 = 96,45; 2990/28 = 106,79
    expect(dailyCostLabel({ ...APP_PRO_PRICE, amount: 3490 })).toBe(`Kb. 113–${formatAmount(125, 'HUF')}/nap, a hónap hosszától függően`); // a szerver árát követi
    expect(dailyCostLabel({ amount: 29900, currency: 'HUF', interval: 'year', label: '29 900 Ft/év', source: 'stripe' })).toBeNull();
    const out = render();
    expect((out.match(/data-plan-daily/g) ?? []).length).toBe(2);
    expect((out.match(/Összehasonlításként; a fizetendő összeg a teljes ár\./g) ?? []).length).toBe(2);
    // a fizetendő összeg továbbra is a teljes ár
    expect(out).toContain(`Befizetés elküldve ellenőrzésre (${formatAmount(2990, 'HUF')} · 1 hónap)`);
    const yearly = renderToStaticMarkup(createElement(PlanPicker, { plans: [{ id: 'month', price: { amount: 29900, currency: 'HUF', interval: 'year', label: '29 900 Ft/év', source: 'stripe' }, recommended: true }], selected: 'month', onSelect: () => {} }));
    expect(yearly).not.toContain('data-plan-daily');
    expect(yearly).not.toContain('/nap');
  });

  it('a havi kártya kiemelése a kijelöléstől független; az „Ajánlott” jelvény felül; a kijelölés külön jelzett', () => {
    for (const selected of ['month', 'week'] as const) {
      const out = renderToStaticMarkup(createElement(PlanPicker, { plans: info.plans!, selected, onSelect: () => {} }));
      const card = (id: string) => out.match(new RegExp(`<button[^>]*data-plan="${id}"[\\s\\S]*?</button>`))![0];
      expect(card('month'), selected).toContain('data-plan-highlighted');
      expect(card('month'), selected).toMatch(/ring-success/);
      expect(card('week'), selected).not.toContain('data-plan-highlighted');
      // a jelvény a kártya felső szélén, a cím előtt
      expect(card('month')).toMatch(/^<button[^>]*>\s*<span class="badge absolute -top-3[^"]*" data-plan-recommended(="[^"]*")?>Ajánlott<\/span>/);
      // a kijelölés jelzése csak a kiválasztott kártyán
      expect(card(selected)).toContain('data-plan-selected');
      expect(card(selected === 'month' ? 'week' : 'month')).not.toContain('data-plan-selected');
      expect((out.match(/data-plan-selected/g) ?? []).length).toBe(1);
    }
  });

  it('régi szerverválasz (plans nélkül): csak a havi csomag – heti csomagot a felület nem talál ki', () => {
    const old = { ...info, plans: undefined };
    expect(plansOf(old)).toEqual([{ id: 'month', price: APP_PRO_PRICE, recommended: true }]);
    const out = render(old);
    expect(out).not.toContain('data-plan="week"');
    expect(out).toContain('data-plan="month"');
  });

  it('függő heti kérelemnél a felület a heti csomagot mutatja, nincs új küldés gomb', () => {
    const pending = { id: 'x', method: 'revolut' as const, amount: 1490, currency: 'HUF', interval: 'week' as const, reference: 'a', status: 'pending' as const, createdAt: new Date().toISOString(), decidedAt: null, activatedUntil: null, decisionNote: null };
    const out = render({ ...info, requests: [pending] });
    expect(out).toContain(`${formatAmount(1490, 'HUF')} · 7 nap`);
    expect(out).not.toContain('data-send-plan');
  });

  it('nincs megtévesztő elem: nincs „automatikus megújulás”, a kézi ellenőrzés ténye látható', () => {
    const out = render();
    expect(out).toContain('A fizetés manuális ellenőrzést igényel.');
    expect(out).not.toMatch(/automatikusan megújul|garantált/i);
  });
});
