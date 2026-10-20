/**
 * PRO kézi fizetés (banki átutalás / Revolut) – HTTP-szintű és felületi tesztek.
 *
 * A VALÓDI routerekkel és a VALÓDI requireAuthenticated / requireAdmin őrökkel;
 * a `res.locals.plan` előállítása az egyetlen szimulált elem (élesben az
 * attachPlan tölti ki a hitelesített Supabase tokenből) – a competition.test.ts
 * mintájára. A tároló a MemoryManualPaymentStore; a 0020 SQL-függvényt a
 * manualPayments.pg.test.ts ellenőrzi valódi PostgreSQL-en.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import { MemoryManualPaymentStore, adminProPaymentsRouter, proPaymentsRouter, type ProfileState } from '../src/server/billing/manualPayments';
import { requireAdmin } from '../src/server/billing/entitlement';
import { currentProPrice } from '../src/server/billing/stripeRoutes';
import { APP_PRO_PRICE, PAYEE, accountNumberDigits, formatAmount, type ProPaymentInfo, type ProPrice } from '../src/shared/manualPayment';
import { copyText } from '../src/client/lib/clipboard';
import { CopyField, ManualPaymentSection, PaymentRequestList } from '../src/client/components/ManualPayment';
import { AdminPaymentCard } from '../src/client/pages/AdminProPayments';
import { PRO_PRICE } from '../src/client/pages/Pro';
import { api } from '../src/client/lib/api';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN = { user: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: ADMIN_EMAIL };
const A = { user: '11111111-1111-1111-1111-111111111111', email: 'anna@example.com' };
const B = { user: '22222222-2222-2222-2222-222222222222', email: 'bela@example.com' };
const DAY = 86_400_000;

type Who = { user?: string; email?: string; pro?: boolean };
interface Harness { url: string; close: () => Promise<void>; store: MemoryManualPaymentStore; profiles: Map<string, ProfileState> }

async function startApp(price: ProPrice = APP_PRO_PRICE): Promise<Harness> {
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  const profiles = new Map<string, ProfileState>([
    [A.user, { status: 'free', subscriptionEnd: null, stripeSubscriptionId: null }],
    [B.user, { status: 'free', subscriptionEnd: null, stripeSubscriptionId: null }],
  ]);
  const store = new MemoryManualPaymentStore(profiles);
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    const email = (req.header('x-test-email') ?? '').toLowerCase();
    // élesben az attachPlan: a PRO a profilból, az admin az ADMIN_EMAILS-ből – sosem a kliensből
    res.locals.plan = { enforced: true, user: id ? { id, email } : null, pro: profiles.get(id ?? '')?.status === 'pro', admin: email === ADMIN_EMAIL };
    next();
  });
  app.use('/api/pro-payments', proPaymentsRouter(store, async () => price));
  app.use('/api/admin/pro-payments', requireAdmin, adminProPaymentsRouter(store));
  const server: Server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())), store, profiles };
}

async function call(h: Harness, method: string, path: string, who: Who = {}, body?: unknown) {
  const res = await fetch(`${h.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who.user ? { 'x-test-user': who.user } : {}), ...(who.email ? { 'x-test-email': who.email } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

let h: Harness;
beforeEach(async () => {
  // a jóváhagyási napló és a statikus renderelés SSR-figyelmeztetései ne terheljék a kimenetet
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h = await startApp();
});
afterEach(async () => { vi.restoreAllMocks(); await h.close(); });

const request = (who: Who, body: unknown = { method: 'bank_transfer' }) => call(h, 'POST', '/api/pro-payments', who, body);
/** Jóváhagyás úgy, ahogy az admin felület küldi: a megerősített (a kérelemben szereplő) összeg, pénznem és mód. */
const approveAs = (who: Who, id: string) => {
  const r = h.store.requests.get(id);
  return call(h, 'POST', `/api/admin/pro-payments/${id}/approve`, who, r ? { amount: r.amount, currency: r.currency, method: r.method } : { amount: 1, currency: 'HUF', method: 'bank_transfer' });
};

describe('Kézi PRO-igénylés – felhasználó', () => {
  it('a fizetési adatok és az érvényes ár a szervertől jönnek; a közlemény a token e-mail-címe', async () => {
    const anon = await call(h, 'GET', '/api/pro-payments');
    expect(anon.status).toBe(200);
    expect(anon.body).toMatchObject({ price: APP_PRO_PRICE, requests: [], reference: null });
    expect(anon.body.payee).toEqual({
      bank: { beneficiary: 'Sinka Martin', accountNumber: '11773384-03115543' },
      revolut: { username: '@martin2pal', accountNumber: '30200014 19913410 31395146', profileUrl: 'https://revolut.me/martin2pal' },
    });
    expect((await call(h, 'GET', '/api/pro-payments', A)).body.reference).toBe('anna@example.com');
  });

  it('ha a kérelmek nem olvashatók (pl. hiányzó 0020), a fizetési adatok akkor is megjelennek', async () => {
    h.store.listForUser = async () => { throw new Error('relation "pro_payment_requests" does not exist'); };
    const r = await call(h, 'GET', '/api/pro-payments', A);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ price: APP_PRO_PRICE, requests: [], reference: 'anna@example.com' });
  });

  it('bejelentkezés nélkül a befizetés jelzése 401, kérelem nem jön létre', async () => {
    const r = await request({}, { method: 'bank_transfer', userId: A.user });
    expect(r.status).toBe(401);
    expect(h.store.requests.size).toBe(0);
  });

  it('függő kérelem jön létre a szerver adataival – a kliens userId/összeg/státusz/PRO mezőit figyelmen kívül hagyja, és a PRO NEM aktiválódik', async () => {
    const r = await request(A, { method: 'revolut', userId: B.user, amount: 1, currency: 'EUR', status: 'approved', pro: true, email: 'hamis@example.com' });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    expect(r.body.request).toMatchObject({ method: 'revolut', amount: 2990, currency: 'HUF', interval: 'month', reference: 'anna@example.com', status: 'pending', activatedUntil: null });
    expect(r.body.request.userId).toBeUndefined(); // a felhasználói nézet nem ad ki admin-mezőket
    const stored = [...h.store.requests.values()][0];
    expect(stored).toMatchObject({ userId: A.user, email: 'anna@example.com' });
    expect(h.profiles.get(A.user)).toEqual({ status: 'free', subscriptionEnd: null, stripeSubscriptionId: null });
    expect(h.profiles.get(B.user)!.status).toBe('free');
    const mine = await call(h, 'GET', '/api/pro-payments', A);
    expect(mine.body.requests.map((x: any) => x.status)).toEqual(['pending']);
    expect((await call(h, 'GET', '/api/pro-payments', B)).body.requests).toEqual([]);
  });

  it('dupla kattintás / ismételt küldés: egyetlen függő kérelem marad', async () => {
    const [a, b, c] = await Promise.all([request(A), request(A), request(A, { method: 'revolut' })]);
    expect([a.status, b.status, c.status].sort()).toEqual([200, 200, 201]);
    expect([...h.store.requests.values()].filter((x) => x.userId === A.user)).toHaveLength(1);
  });

  it('érvénytelen mód → 400; e-mail nélküli fiók → 400; élő Stripe-előfizetés → 409', async () => {
    expect((await request(A, { method: 'card' })).body.code).toBe('INVALID_METHOD');
    expect((await request(A, {})).status).toBe(400);
    expect((await request({ user: A.user })).body.code).toBe('EMAIL_REQUIRED');
    h.profiles.set(B.user, { status: 'pro', subscriptionEnd: new Date(Date.now() + 10 * DAY).toISOString(), stripeSubscriptionId: 'sub_123' });
    expect((await request(B)).body.code).toBe('ACTIVE_STRIPE_SUBSCRIPTION');
    expect(h.store.requests.size).toBe(0);
  });
});

describe('Kézi PRO-igénylés – admin', () => {
  const pendingOf = async (who: Who) => (await request(who)).body.request.id as string;

  it('nem admin (akár PRO) és névtelen felhasználó admin műveletet nem végezhet', async () => {
    const id = await pendingOf(A);
    h.profiles.set(B.user, { status: 'pro', subscriptionEnd: null, stripeSubscriptionId: null });
    for (const [method, path] of [['GET', '/api/admin/pro-payments'], ['POST', `/api/admin/pro-payments/${id}/approve`], ['POST', `/api/admin/pro-payments/${id}/reject`]]) {
      expect((await call(h, method, path)).status, path).toBe(401);
      expect((await call(h, method, path, A)).status, path).toBe(403);
      expect((await call(h, method, path, B)).status, path).toBe(403);
    }
    expect(h.store.requests.get(id)!.status).toBe('pending');
    expect(h.profiles.get(A.user)!.status).toBe('free');
  });

  it('admin lista: fiók, e-mail, mód, csomag, összeg, időpont, állapot és a jelenlegi profil', async () => {
    await pendingOf(A);
    const r = await call(h, 'GET', '/api/admin/pro-payments', ADMIN);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ userId: A.user, email: 'anna@example.com', method: 'bank_transfer', amount: 2990, currency: 'HUF', interval: 'month', status: 'pending', profile: { status: 'free', stripeManaged: false } });
    expect(typeof r.body[0].createdAt).toBe('string');
    expect((await call(h, 'GET', '/api/admin/pro-payments?status=approved', ADMIN)).body).toEqual([]);
    expect((await call(h, 'GET', '/api/admin/pro-payments?status=bármi', ADMIN)).status).toBe(400);
  });

  it('elfogadás: a PRO aktiválódik 1 hónapra; ugyanazt a kérelmet másodszor nem lehet feldolgozni', async () => {
    const id = await pendingOf(A);
    const before = Date.now();
    const ok = await approveAs(ADMIN, id);
    expect(ok.status).toBe(200);
    expect(ok.body.request).toMatchObject({ status: 'approved', decidedBy: ADMIN.user });
    const p = h.profiles.get(A.user)!;
    expect(p.status).toBe('pro');
    const end = Date.parse(p.subscriptionEnd!);
    expect(end - before).toBeGreaterThan(27 * DAY);
    expect(end - before).toBeLessThan(32 * DAY);
    expect(p.stripeSubscriptionId).toBeNull(); // Stripe-mezőhöz nem nyúl

    const again = await approveAs(ADMIN, id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_PROCESSED');
    expect(h.profiles.get(A.user)!.subscriptionEnd).toBe(p.subscriptionEnd); // nem hosszabbodott kétszer
    expect((await call(h, 'POST', `/api/admin/pro-payments/${id}/reject`, ADMIN)).body.code).toBe('ALREADY_PROCESSED');
    expect((await call(h, 'GET', '/api/pro-payments', A)).body.requests[0]).toMatchObject({ status: 'approved', activatedUntil: p.subscriptionEnd });
  });

  it('párhuzamos jóváhagyás: pontosan egy sikerül', async () => {
    const id = await pendingOf(A);
    const rs = await Promise.all([1, 2, 3].map(() => approveAs(ADMIN, id)));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
  });

  it('elutasítás: a kérelem lezárul megjegyzéssel, a PRO nem aktiválódik, utána nem fogadható el; új kérelem küldhető', async () => {
    const id = await pendingOf(A);
    const r = await call(h, 'POST', `/api/admin/pro-payments/${id}/reject`, ADMIN, { note: 'Nem érkezett meg az utalás.' });
    expect(r.status).toBe(200);
    expect(r.body.request).toMatchObject({ status: 'rejected', decisionNote: 'Nem érkezett meg az utalás.' });
    expect(h.profiles.get(A.user)!.status).toBe('free');
    expect((await approveAs(ADMIN, id)).body.code).toBe('ALREADY_PROCESSED');
    expect(h.profiles.get(A.user)!.status).toBe('free');
    expect((await call(h, 'POST', `/api/admin/pro-payments/${id}/reject`, ADMIN, { note: 'x'.repeat(301) })).status).toBe(400);
    expect((await request(A)).status).toBe(201);
    expect((await approveAs(ADMIN, '99999999-9999-9999-9999-999999999999')).status).toBe(404);
  });

  it('meglévő jogosultságok megőrzése: érvényes PRO meghosszabbodik, korlátlan PRO nem rövidül, élő Stripe-előfizetés érintetlen', async () => {
    // érvényes kézi PRO (10 nap van hátra) → a lejárattól hosszabbodik
    const tenDays = new Date(Date.now() + 10 * DAY).toISOString();
    h.profiles.set(A.user, { status: 'pro', subscriptionEnd: tenDays, stripeSubscriptionId: null });
    const a = await pendingOf(A);
    await approveAs(ADMIN, a);
    expect(Date.parse(h.profiles.get(A.user)!.subscriptionEnd!) - Date.parse(tenDays)).toBeGreaterThan(27 * DAY);

    // korlátlan PRO (lejárat nélkül) → a jóváhagyás nem állít be lejáratot
    h.profiles.set(B.user, { status: 'pro', subscriptionEnd: null, stripeSubscriptionId: null });
    const b = await pendingOf(B);
    const rb = await approveAs(ADMIN, b);
    expect(rb.body.request.activatedUntil).toBeNull();
    expect(h.profiles.get(B.user)).toEqual({ status: 'pro', subscriptionEnd: null, stripeSubscriptionId: null });

    // élő Stripe-előfizetés: a kérelmet (pl. a Stripe-előfizetés előtt jelzett) a szerver nem aktiválja kézzel
    const c = await pendingOf({ user: '33333333-3333-3333-3333-333333333333', email: 'cili@example.com' });
    const stripeSub = { status: 'pro', subscriptionEnd: new Date(Date.now() + 20 * DAY).toISOString(), stripeSubscriptionId: 'sub_live' };
    h.profiles.set('33333333-3333-3333-3333-333333333333', { ...stripeSub });
    const rc = await approveAs(ADMIN, c);
    expect(rc.status).toBe(409);
    expect(rc.body.code).toBe('ACTIVE_STRIPE_SUBSCRIPTION');
    expect(h.profiles.get('33333333-3333-3333-3333-333333333333')).toEqual(stripeSub);
    expect(h.store.requests.get(c)!.status).toBe('pending');

    // lejárt PRO → mától számol
    h.profiles.set(A.user, { status: 'pro', subscriptionEnd: new Date(Date.now() - 5 * DAY).toISOString(), stripeSubscriptionId: null });
    const a2 = await pendingOf(A);
    await approveAs(ADMIN, a2);
    expect(Date.parse(h.profiles.get(A.user)!.subscriptionEnd!) - Date.now()).toBeGreaterThan(27 * DAY);
  });

  it('a kérelembe a szerver által érvényesnek tartott ár kerül (pl. éves Stripe-ár), nem a kliensé', async () => {
    await h.close();
    h = await startApp({ amount: 29900, currency: 'HUF', interval: 'year', label: '29 900 Ft/év', source: 'stripe' });
    const r = await request(A, { method: 'bank_transfer', amount: 100, interval: 'month' });
    expect(r.body.request).toMatchObject({ amount: 29900, interval: 'year' });
    const id = r.body.request.id;
    await approveAs(ADMIN, id);
    expect(Date.parse(h.profiles.get(A.user)!.subscriptionEnd!) - Date.now()).toBeGreaterThan(360 * DAY);
  });
});

describe('Ár és Stripe', () => {
  it.skipIf(!!process.env.STRIPE_SECRET_KEY || !!process.env.STRIPE_PRICE_ID_PRO)('Stripe-konfiguráció nélkül az alkalmazás eddigi ára érvényes (2 990 Ft/hó) – a kliens tartalék felirata ugyanaz', async () => {
    expect(await currentProPrice()).toEqual(APP_PRO_PRICE);
    expect(PRO_PRICE).toBe('2 990 Ft/hó');
    expect(APP_PRO_PRICE).toMatchObject({ amount: 2990, currency: 'HUF', interval: 'month' });
  });
});

// ---------------------------------------------------------------------------
// Felület
// ---------------------------------------------------------------------------

const info = (over: Partial<ProPaymentInfo> = {}): ProPaymentInfo => ({ price: APP_PRO_PRICE, payee: PAYEE, requests: [], reference: 'anna@example.com', ...over });
const render = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, null, el));

describe('Kézi PRO-igénylés – felület', () => {
  it('megjeleníti a banki és a Revolut-adatokat, az összeget, az időtartamot és a kézi ellenőrzés tényét', () => {
    const html = render(createElement(ManualPaymentSection, { info: info(), loggedIn: true, onRequested: () => {} }));
    for (const t of ['Banki átutalás', 'Sinka Martin', '11773384-03115543', '30200014 19913410 31395146', 'Számlaszám (Revolut)', 'anna@example.com', 'Revolut', '@martin2pal', 'Fizetési kérelem állapota',
      'A fizetés manuális ellenőrzést igényel.', 'nem aktiválódik automatikusan', 'Befizetés elküldve ellenőrzésre', '1 hónap']) {
      expect(html, t).toContain(t);
    }
    expect(html).toMatch(/2.990 Ft/);
    expect(html).toContain('href="https://revolut.me/martin2pal"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toMatch(/revolut\.me\/martin2pal\/\d|amount=/); // nincs előtöltött összegű fizetési link
    expect(html.match(/másolása"/g)?.length).toBeGreaterThanOrEqual(5); // kedvezményezett, számlaszám, közlemény, összegek, Revolut
    // a számlaszámok a megfelelő fizetési mód alatt: a banki a Revolut-blokk előtt, a Revolut-számla a Revolut-blokkban
    const rev = html.indexOf('id="fizetes-revolut"');
    expect(html.indexOf('11773384-03115543')).toBeGreaterThan(html.indexOf('id="fizetes-bank"'));
    expect(html.indexOf('11773384-03115543')).toBeLessThan(rev);
    expect(html.indexOf('30200014 19913410 31395146')).toBeGreaterThan(rev);
    expect(html).toContain('aria-label="Számlaszám (Revolut) másolása"');
  });

  it('az összeg nincs beégetve: a szerver ára jelenik meg', () => {
    const html = render(createElement(ManualPaymentSection, { info: info({ price: { amount: 4990, currency: 'HUF', interval: 'month', label: '4 990 Ft/hó', source: 'stripe' } }), loggedIn: true, onRequested: () => {} }));
    expect(html).toMatch(/4.990 Ft/);
    expect(html).not.toMatch(/2.990 Ft/);
  });

  it('kijelentkezve bejelentkezést kér a jelzéshez; függő kérelemnél nincs új küldés gomb', () => {
    const out = render(createElement(ManualPaymentSection, { info: info({ reference: null }), loggedIn: false, onRequested: () => {} }));
    expect(out).toContain('jelentkezz be');
    expect(out).not.toContain('Befizetés elküldve ellenőrzésre</button>');
    const pending = { id: 'r1', method: 'revolut' as const, amount: 2990, currency: 'HUF', interval: 'month' as const, reference: 'anna@example.com', status: 'pending' as const, createdAt: new Date().toISOString(), decidedAt: null, activatedUntil: null, decisionNote: null };
    const withPending = render(createElement(ManualPaymentSection, { info: info({ requests: [pending] }), loggedIn: true, onRequested: () => {} }));
    expect(withPending).toContain('Van ellenőrzésre váró befizetésed');
    expect(withPending).not.toMatch(/<button[^>]*>.{0,80}Befizetés elküldve ellenőrzésre/);
    expect(render(createElement(PaymentRequestList, { requests: [{ ...pending, status: 'rejected', decisionNote: 'Nem érkezett meg.' }] }))).toContain('Elutasítva');
  });

  it('összegformázás: locale-független ezres tagolás (böngészőben és Node-ban azonos)', () => {
    expect(formatAmount(2990, 'HUF')).toBe('2 990 Ft');
    expect(formatAmount(29900, 'huf')).toBe('29 900 Ft');
    expect(formatAmount(1234567, 'HUF')).toBe('1 234 567 Ft');
    expect(formatAmount(990, 'HUF')).toBe('990 Ft');
  });

  it('másolás: a számlaszám számjegyekként, a Clipboard API-val; tartalék execCommand-dal', async () => {
    expect(accountNumberDigits()).toBe('1177338403115543'); // alapértelmezés: a banki számla
    expect(accountNumberDigits(PAYEE.revolut.accountNumber)).toBe('302000141991341031395146');
    const written: string[] = [];
    expect(await copyText('302000141991341031395146', { writeText: async (t) => { written.push(t); } })).toBe(true);
    expect(written).toEqual(['302000141991341031395146']);
    const exec = vi.fn(() => true);
    const ta = { value: '', style: {} as Record<string, string>, setAttribute: () => {}, select: () => {} };
    const doc = { createElement: () => ta, body: { appendChild: () => {}, removeChild: () => {} }, execCommand: exec } as unknown as Document;
    expect(await copyText('@martin2pal', { writeText: async () => { throw new Error('tiltva'); } }, doc)).toBe(true);
    expect(ta.value).toBe('@martin2pal');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(await copyText('x', undefined, undefined)).toBe(false);
    expect(renderToStaticMarkup(createElement(CopyField, { label: 'Számlaszám', value: '30200014 19913410 31395146' }))).toContain('aria-label="Számlaszám másolása"');
  });

  it('admin kártya: függő kérelemnél van döntés, lezártnál nincs; élő Stripe-nál figyelmeztet', () => {
    const base = { id: 'r1', userId: A.user, email: 'anna@example.com', method: 'bank_transfer' as const, amount: 2990, currency: 'HUF', interval: 'month' as const, reference: 'anna@example.com', createdAt: new Date().toISOString(), decidedAt: null, decidedBy: null, activatedUntil: null, decisionNote: null };
    const pending = renderToStaticMarkup(createElement(AdminPaymentCard, { r: { ...base, status: 'pending', profile: { status: 'pro', subscriptionEnd: null, stripeManaged: true } }, onDone: () => {} }));
    expect(pending).toContain('Elfogadás');
    expect(pending).toContain('Elutasítás');
    expect(pending).toContain('élő Stripe-előfizetése');
    expect(pending).toContain('anna@example.com');
    const done = renderToStaticMarkup(createElement(AdminPaymentCard, { r: { ...base, status: 'approved', decidedAt: new Date().toISOString(), decidedBy: ADMIN.user, profile: null }, onDone: () => {} }));
    expect(done).not.toContain('Elfogadás');
  });

  it('a kliens a jelzéskor csak a fizetési módot és a csomag azonosítóját küldi (összeget nem)', async () => {
    const seen: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify({ request: {}, created: true }), { status: 201 });
    }));
    try { await api.requestProPayment('revolut', 'week'); } finally { vi.unstubAllGlobals(); }
    expect(seen).toEqual([{ url: '/api/pro-payments', body: JSON.stringify({ method: 'revolut', plan: 'week' }) }]);
  });
});
