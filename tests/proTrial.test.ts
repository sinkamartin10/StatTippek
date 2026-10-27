/**
 * Ingyenes, 3 napos PRO próbaidőszak – HTTP-szintű, értesítési és felületi tesztek.
 *
 * A VALÓDI routerekkel és a VALÓDI requireAuthenticated / requireAdmin / requirePro őrökkel;
 * a `res.locals.plan` előállítása az egyetlen szimulált elem (élesben az attachPlan tölti ki
 * a hitelesített tokenből) – a PRO-t itt is a profilból számoljuk, a meglévő profileIsPro-val.
 * Az értesítések a VALÓDI NotificationService-en és SQLite-tárolón mennek. A 0024 SQL-függvényt
 * a proTrial.pg.test.ts ellenőrzi valódi PostgreSQL-en.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const plan = vi.hoisted(() => ({ pro: false, end: null as string | null }));
vi.mock('../src/client/auth/PlanContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client/auth/PlanContext')>()),
  usePlan: () => ({
    configured: true, loggedIn: true, loading: false, pro: plan.pro, error: null, reload: async () => {},
    profile: { id: 'u', email: 'anna@example.com', subscription_status: plan.pro ? 'pro' : 'free', stripe_customer_id: null, stripe_subscription_id: null, subscription_end: plan.end },
  }),
  // a modulon belüli usePlan-hívást a fenti csere nem éri el
  useFreeDay: () => ({ loading: false, total: 0, quota: Infinity, allowed: () => true, locked: () => false }),
}));
vi.mock('../src/client/auth/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client/auth/AuthContext')>()),
  useAuth: () => ({ configured: true, loading: false, user: { id: 'u', email: 'anna@example.com' }, session: null }),
}));

import { MemoryProTrialStore, adminProTrialsRouter, proTrialRouter, trialNotificationCandidates, trialStatus, type StoredTrial } from '../src/server/billing/proTrial';
import type { ProfileState } from '../src/server/billing/manualPayments';
import { requireAdmin, requirePro } from '../src/server/billing/entitlement';
import { profileIsPro } from '../src/server/billing/supabaseAdmin';
import { SqliteNotificationStore } from '../src/server/notifications/store';
import { NotificationService } from '../src/server/notifications/service';
import { TRIAL_TEXT, formatBudapestDateTime, trialActivatedText, type ProTrialStatus } from '../src/shared/proTrial';
import { ProTrialView } from '../src/client/components/ProTrial';
import { AdminTrialCard } from '../src/client/pages/AdminProPayments';
import Pro from '../src/client/pages/Pro';
import Dashboard from '../src/client/pages/Dashboard';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN = { user: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: ADMIN_EMAIL };
const A = { user: '11111111-1111-1111-1111-111111111111', email: 'anna@example.com' };
const B = { user: '22222222-2222-2222-2222-222222222222', email: 'bela@example.com' };
const DAY = 86_400_000;
const free = (): ProfileState => ({ status: 'free', subscriptionEnd: null, stripeSubscriptionId: null });

type Who = { user?: string; email?: string };
interface Harness {
  url: string; close: () => Promise<void>; store: MemoryProTrialStore; profiles: Map<string, ProfileState>;
  notifications: NotificationService; emitted: string[];
}

async function startApp(): Promise<Harness> {
  const profiles = new Map<string, ProfileState>([[A.user, free()], [B.user, free()], [ADMIN.user, free()]]);
  const store = new MemoryProTrialStore(profiles);
  const notifications = new NotificationService(new SqliteNotificationStore(new DatabaseSync(':memory:')), [trialNotificationCandidates(store)]);
  const emitted: string[] = [];
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    const email = (req.header('x-test-email') ?? '').toLowerCase();
    // élesben az attachPlan: a PRO a profilból (profileIsPro), az admin az ADMIN_EMAILS-ből – sosem a kliensből
    const p = profiles.get(id ?? '');
    const pro = profileIsPro(p ? { subscription_status: p.status, subscription_end: p.subscriptionEnd } as never : null);
    res.locals.plan = { enforced: true, user: id ? { id, email } : null, pro, admin: email === ADMIN_EMAIL };
    next();
  });
  app.use('/api/pro-trial', proTrialRouter(store));
  app.use('/api/admin/pro-trials', requireAdmin, adminProTrialsRouter(store, {
    notify: (n) => { emitted.push(n.sourceKey); return notifications.emit(n); },
    displayNames: async (ids) => new Map(ids.filter((id) => id === A.user).map((id) => [id, 'Anna'])),
  }));
  app.get('/api/pro-only', requirePro, (_req, res) => { res.json({ ok: true }); });
  const server: Server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())),
    store, profiles, notifications, emitted,
  };
}

async function call(h: Harness, method: string, path: string, who: Who = {}, body?: unknown) {
  const res = await fetch(`${h.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who.user ? { 'x-test-user': who.user } : {}), ...(who.email ? { 'x-test-email': who.email } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text();
  // az ismeretlen útvonal Express-féle HTML 404-et ad – az nem JSON
  return { status: res.status, body: t && res.headers.get('content-type')?.includes('json') ? JSON.parse(t) : null };
}

let h: Harness;
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h = await startApp();
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await h.close(); });

const requestTrial = (who: Who, body: unknown = {}) => call(h, 'POST', '/api/pro-trial', who, body);
const status = async (who: Who) => (await call(h, 'GET', '/api/pro-trial', who)).body as ProTrialStatus;
const approve = (id: string, who: Who = ADMIN) => call(h, 'POST', `/api/admin/pro-trials/${id}/approve`, who, {});
const reject = (id: string, who: Who = ADMIN) => call(h, 'POST', `/api/admin/pro-trials/${id}/reject`, who, {});
const trialNotes = async (userId: string) =>
  (await h.notifications.list(userId, { limit: 50 })).notifications.filter((n) => n.type === 'pro_trial_activated');

describe('PRO próbaidőszak – igénylés', () => {
  it('sikeres igénylés: függő igénylés jön létre, a PRO NEM aktiválódik', async () => {
    expect((await status(A)).state).toBe('available');
    const r = await requestTrial(A);
    expect(r.status).toBe(201);
    expect(r.body.status.state).toBe('pending');
    expect(h.store.requests.size).toBe(1);
    expect(h.profiles.get(A.user)).toEqual(free());
    expect((await status(A)).state).toBe('pending');
    expect((await call(h, 'GET', '/api/pro-only', A)).status).toBe(403);
  });

  it('második igénylés tiltva (409), és nem jön létre új sor', async () => {
    await requestTrial(A);
    const again = await requestTrial(A);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_REQUESTED');
    expect(again.body.status.state).toBe('pending');
    expect(h.store.requests.size).toBe(1);
  });

  it('párhuzamos igénylések: pontosan egy jön létre, a többi 409', async () => {
    const outs = await Promise.all(Array.from({ length: 8 }, () => requestTrial(A)));
    expect(outs.filter((o) => o.status === 201)).toHaveLength(1);
    expect(outs.filter((o) => o.status === 409)).toHaveLength(7);
    expect([...h.store.requests.values()].filter((x) => x.userId === A.user)).toHaveLength(1);
  });

  it('a tároló maga is csak egy igénylést enged fiókonként (a route-ellenőrzés nélkül is)', async () => {
    const outs = await Promise.all(Array.from({ length: 5 }, () => h.store.create(B.user, B.email)));
    expect(outs.filter((o) => o.created)).toHaveLength(1);
    expect(new Set(outs.map((o) => o.request.id)).size).toBe(1);
  });

  it('a felhasználó nem állíthat be állapotot: a törzs figyelmen kívül marad, és nincs felhasználói jóváhagyó végpont', async () => {
    const r = await requestTrial(A, { status: 'approved', userId: B.user, trialEnd: '2099-01-01T00:00:00Z' });
    expect(r.status).toBe(201);
    const [t] = [...h.store.requests.values()];
    expect(t).toMatchObject({ userId: A.user, status: 'pending', trialEnd: null });
    expect((await call(h, 'POST', `/api/pro-trial/${t.id}/approve`, A, {})).status).toBe(404);
    expect((await call(h, 'PUT', '/api/pro-trial', A, { status: 'approved' })).status).toBe(404);
    expect(h.profiles.get(A.user)).toEqual(free());
  });

  it('bejelentkezés nélkül nem igényelhető (401)', async () => {
    expect((await requestTrial({})).status).toBe(401);
    expect(h.store.requests.size).toBe(0);
  });
});

describe('PRO próbaidőszak – admin döntés', () => {
  it('nem admin nem aktiválhat, nem utasíthat el és nem listázhat (403); bejelentkezés nélkül 401', async () => {
    const { body } = await requestTrial(A);
    const id = [...h.store.requests.values()][0].id;
    expect(body.status.state).toBe('pending');
    expect((await approve(id, A)).status).toBe(403);
    expect((await approve(id, B)).status).toBe(403);
    expect((await approve(id, {})).status).toBe(401);
    expect((await reject(id, A)).status).toBe(403);
    expect((await call(h, 'GET', '/api/admin/pro-trials', A)).status).toBe(403);
    expect(h.profiles.get(A.user)).toEqual(free());
    expect(h.store.requests.get(id)!.status).toBe('pending');
  });

  it('admin aktiválás: PRO pontosan 3 napra, kezdet és vég mentve, a jogosultság azonnal él', async () => {
    await requestTrial(A);
    const id = [...h.store.requests.values()][0].id;
    const list = await call(h, 'GET', '/api/admin/pro-trials', ADMIN);
    expect(list.status).toBe(200);
    expect(list.body[0]).toMatchObject({ id, email: A.email, displayName: 'Anna', status: 'pending' });
    expect(list.body[0].createdAt).toEqual(expect.any(String));

    const r = await approve(id);
    expect(r.status).toBe(200);
    const t: StoredTrial = r.body.request;
    expect(t.status).toBe('approved');
    expect(new Date(t.trialEnd!).getTime() - new Date(t.trialStart!).getTime()).toBe(3 * DAY);
    expect(h.profiles.get(A.user)).toEqual({ status: 'pro', subscriptionEnd: t.trialEnd, stripeSubscriptionId: null });
    expect(await status(A)).toEqual({ state: 'active', requestedAt: expect.any(String), trialEnd: t.trialEnd });
    expect((await call(h, 'GET', '/api/pro-only', A)).status).toBe(200);
    // ugyanaz az igénylés nem dolgozható fel kétszer
    expect((await approve(id)).body.code).toBe('ALREADY_PROCESSED');
    expect((await reject(id)).body.code).toBe('ALREADY_PROCESSED');
    expect(h.profiles.get(A.user)!.subscriptionEnd).toBe(t.trialEnd);
  });

  it('párhuzamos admin-jóváhagyások: egy aktivál, a lejárat egyszer áll be, egy értesítés', async () => {
    await requestTrial(A);
    const id = [...h.store.requests.values()][0].id;
    const outs = await Promise.all([1, 2, 3, 4].map(() => approve(id)));
    expect(outs.filter((o) => o.status === 200)).toHaveLength(1);
    expect(outs.filter((o) => o.body?.code === 'ALREADY_PROCESSED')).toHaveLength(3);
    expect(await trialNotes(A.user)).toHaveLength(1);
  });

  it('3 nap után a fiók magától FREE (ütemező nélkül), és újra nem igényelhet', async () => {
    await requestTrial(A);
    const id = [...h.store.requests.values()][0].id;
    const t: StoredTrial = (await approve(id)).body.request;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(t.trialEnd!).getTime() - 60_000);
    expect((await call(h, 'GET', '/api/pro-only', A)).status).toBe(200);
    expect((await status(A)).state).toBe('active');
    vi.setSystemTime(new Date(t.trialEnd!).getTime() + 1_000);
    expect((await call(h, 'GET', '/api/pro-only', A)).status).toBe(403);
    expect((await status(A)).state).toBe('used');
    const again = await requestTrial(A);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_REQUESTED');
  });

  it('elutasítás után nincs új igénylés, és a döntés végleges', async () => {
    await requestTrial(A);
    const id = [...h.store.requests.values()][0].id;
    const r = await reject(id);
    expect(r.status).toBe(200);
    expect(r.body.request.status).toBe('rejected');
    expect((await status(A)).state).toBe('rejected');
    const again = await requestTrial(A);
    expect(again.status).toBe(409);
    expect(again.body.status.state).toBe('rejected');
    expect((await approve(id)).body.code).toBe('ALREADY_PROCESSED');
    expect(h.profiles.get(A.user)).toEqual(free());
    expect(h.store.requests.size).toBe(1);
    expect(await trialNotes(A.user)).toHaveLength(0);
  });
});

describe('PRO próbaidőszak – értesítés', () => {
  it('sikeres aktiválás után pontosan EGY értesítés, a pontos szöveggel és a lejárattal', async () => {
    await requestTrial(A);
    const id = [...h.store.requests.values()][0].id;
    const t: StoredTrial = (await approve(id)).body.request;
    await approve(id); // második (elutasított) jóváhagyás nem küld újat
    const notes = await trialNotes(A.user);
    // a listázás újraszármaztatója sem hoz létre másodikat ugyanarra az igénylésre
    expect(await trialNotes(A.user)).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(`${notes[0].title} ${notes[0].body}`).toBe(
      `Jó hír! Aktiváltuk számodra a TippStats PRO hozzáférést 3 napra. A próbaidőszak lejárata: ${formatBudapestDateTime(t.trialEnd!)}. Jó szórakozást a PRO funkciók használatához!`,
    );
    expect(h.emitted).toEqual([`pro_trial:${id}:activated`]);
    expect(await trialNotes(B.user)).toHaveLength(0);
  });

  it('ha az aktiváláskor az értesítés elmaradt, a következő listázás pótolja – egyszer', async () => {
    await requestTrial(A);
    const id = [...h.store.requests.values()][0].id;
    await h.store.approve(id, ADMIN.user); // közvetlenül a tárolón: nincs kibocsátás
    expect(await trialNotes(A.user)).toHaveLength(1);
    expect(await trialNotes(A.user)).toHaveLength(1);
  });

  it('a lejárat budapesti idő szerint, dátummal és időponttal jelenik meg', () => {
    expect(formatBudapestDateTime('2026-10-30T13:05:00.000Z')).toBe('2026. 10. 30. 14:05'); // CET (UTC+1)
    expect(formatBudapestDateTime('2026-07-01T09:30:00.000Z')).toBe('2026. 07. 01. 11:30'); // CEST (UTC+2)
    expect(trialActivatedText('2026-10-30T13:05:00.000Z').body).toContain('2026. 10. 30. 14:05');
  });
});

describe('PRO próbaidőszak – fizetős PRO változatlan', () => {
  it('aktív fizetős PRO nem igényelhet próbaidőszakot, állapota „Már PRO tag”', async () => {
    const paidEnd = new Date(Date.now() + 25 * DAY).toISOString();
    h.profiles.set(A.user, { status: 'pro', subscriptionEnd: paidEnd, stripeSubscriptionId: null });
    expect((await status(A)).state).toBe('pro_member');
    const r = await requestTrial(A);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ALREADY_PRO');
    expect(r.body.error).toBe(TRIAL_TEXT.proMember);
    expect(h.store.requests.size).toBe(0);
    expect(h.profiles.get(A.user)!.subscriptionEnd).toBe(paidEnd);
  });

  it('ha az igénylés után fizetett elő, a jóváhagyás nem írja felül és nem hosszabbítja a PRO-t', async () => {
    await requestTrial(A);
    const id = [...h.store.requests.values()][0].id;
    const paidEnd = new Date(Date.now() + 25 * DAY).toISOString();
    h.profiles.set(A.user, { status: 'pro', subscriptionEnd: paidEnd, stripeSubscriptionId: null });
    const r = await approve(id);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ALREADY_PRO');
    expect(h.profiles.get(A.user)!.subscriptionEnd).toBe(paidEnd);
    expect(h.store.requests.get(id)!.status).toBe('pending');
    expect((await status(A)).state).toBe('pro_member');
    expect(await trialNotes(A.user)).toHaveLength(0);
  });

  it('korlátlan PRO és élő Stripe-előfizetés: nincs próbaidőszak', async () => {
    h.profiles.set(A.user, { status: 'pro', subscriptionEnd: null, stripeSubscriptionId: null });
    expect((await requestTrial(A)).body.code).toBe('ALREADY_PRO');
    await requestTrial(B);
    const id = [...h.store.requests.values()][0].id;
    h.profiles.set(B.user, { status: 'past_due', subscriptionEnd: null, stripeSubscriptionId: 'sub_1' });
    expect((await approve(id)).body.code).toBe('ACTIVE_STRIPE_SUBSCRIPTION');
    expect(h.profiles.get(B.user)!.status).toBe('past_due');
  });

  it('próbaidőszak közben kifizetett PRO (későbbi lejárat) → „Már PRO tag”, nem próbaidőszak', () => {
    const now = Date.now();
    const t: StoredTrial = {
      id: 'x', userId: A.user, email: A.email, status: 'approved', createdAt: new Date(now - DAY).toISOString(), decidedAt: new Date(now - DAY).toISOString(),
      decidedBy: 'a', trialStart: new Date(now - DAY).toISOString(), trialEnd: new Date(now + 2 * DAY).toISOString(),
    };
    expect(trialStatus(t, { status: 'pro', subscriptionEnd: t.trialEnd, stripeSubscriptionId: null }, now).state).toBe('active');
    expect(trialStatus(t, { status: 'pro', subscriptionEnd: new Date(now + 32 * DAY).toISOString(), stripeSubscriptionId: null }, now).state).toBe('pro_member');
  });
});

describe('PRO próbaidőszak – felület', () => {
  const view = (status: ProTrialStatus | null, pro = false, loggedIn = true) =>
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProTrialView, { status, loggedIn, pro })));
  const st = (state: ProTrialStatus['state'], trialEnd: string | null = null): ProTrialStatus => ({ state, requestedAt: null, trialEnd });

  it('még nem igényelt: cím, leírás és igénylő gomb', () => {
    const html = view(st('available'));
    expect(html).toContain(TRIAL_TEXT.title);
    expect(html).toContain(TRIAL_TEXT.description);
    expect(html).toContain(TRIAL_TEXT.button);
    expect(html).toContain('<button');
  });

  it('függőben / elutasítva: a megfelelő szöveg, gomb nélkül', () => {
    for (const [state, text] of [['pending', TRIAL_TEXT.pending], ['rejected', TRIAL_TEXT.rejected]] as const) {
      const html = view(st(state));
      expect(html).toContain(text);
      expect(html).not.toContain(TRIAL_TEXT.button);
      expect(html).not.toContain('<button');
    }
  });

  it('aktív próbaidőszak: felirat és a pontos lejárat', () => {
    const end = '2026-10-30T13:05:00.000Z';
    const html = view(st('active', end), true);
    expect(html).toContain(TRIAL_TEXT.active);
    const d = new Date(end);
    expect(html).toContain(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
    expect(html).not.toContain(TRIAL_TEXT.button);
  });

  it('fizetős PRO: „Már PRO tag vagy, köszönjük!”, igénylő gomb nélkül', () => {
    for (const html of [view(st('pro_member'), true), view(st('available'), true)]) {
      expect(html).toContain(TRIAL_TEXT.proMember);
      expect(html).not.toContain(TRIAL_TEXT.button);
    }
    expect(view(st('used'))).toBe('');
    expect(view(st('unavailable'))).toBe('');
  });

  it('API-hiba esetén a FREE felhasználónál a kártya NEM tűnik el: ajánlat, gomb, figyelmeztetés és újrapróbálás', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProTrialView, { status: null, loggedIn: true, pro: false, loadError: 'Hiba (500)', onRetry: () => {} })));
    expect(html).toContain(TRIAL_TEXT.title);
    expect(html).toContain(TRIAL_TEXT.button);
    expect(html).toContain('nem sikerült betölteni');
    expect(html).toContain('Újrapróbálás');
  });

  it('betöltés közben a FREE felhasználó látja az ajánlatot (letiltott gombbal); PRO-nál nincs ajánlat', () => {
    const free = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProTrialView, { status: null, loggedIn: true, pro: false, checking: true })));
    expect(free).toContain(TRIAL_TEXT.title);
    expect(free).toContain('Állapot ellenőrzése…');
    expect(free).toMatch(/<button[^>]*disabled/);
    expect(renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProTrialView, { status: null, loggedIn: true, pro: true, checking: true })))).toBe('');
    const proErr = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProTrialView, { status: null, loggedIn: true, pro: true, loadError: 'x' })));
    expect(proErr).not.toContain(TRIAL_TEXT.button);
  });

  it('FREE felhasználó: a PRO oldalon és a nyitóoldalon az első rendereléskor (a szerver válasza előtt) is ott az ajánlat', () => {
    for (const Page of [Pro, Dashboard]) {
      const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Page)));
      expect(html).toContain(TRIAL_TEXT.title);
      expect(html).toContain(TRIAL_TEXT.description);
    }
  });

  it('a PRO oldalon és a bejelentkezés utáni nyitóoldalon is megjelenik a „Már PRO tag vagy, köszönjük!” szöveg', () => {
    plan.pro = true; plan.end = new Date(Date.now() + 25 * DAY).toISOString();
    try {
      for (const Page of [Pro, Dashboard]) {
        const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Page)));
        expect(html).toContain(TRIAL_TEXT.proMember);
        expect(html).not.toContain(TRIAL_TEXT.button);
      }
      // aktív próbaidőszak alatt (≤ 3 napos lejárat) a köszönet NEM jelenik meg a szerver válasza előtt
      plan.end = new Date(Date.now() + 2 * DAY).toISOString();
      expect(renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Pro)))).not.toContain(TRIAL_TEXT.proMember);
    } finally { plan.pro = false; plan.end = null; }
  });

  it('admin kártya: felhasználónév, e-mail, igénylés ideje, állapot és döntési gombok (csak függőnél)', () => {
    const base = {
      id: '33333333-3333-3333-3333-333333333333', userId: A.user, email: A.email, displayName: 'Anna', createdAt: '2026-10-27T10:00:00.000Z',
      decidedAt: null, trialStart: null, trialEnd: null, profile: { status: 'free', subscriptionEnd: null, stripeManaged: false },
    };
    const pending = renderToStaticMarkup(createElement(AdminTrialCard, { r: { ...base, status: 'pending' }, onDone: () => {} }));
    for (const s of ['Anna', A.email, 'Igényelve', 'Függőben', 'Elfogadás', 'Elutasítás']) expect(pending).toContain(s);
    const done = renderToStaticMarkup(createElement(AdminTrialCard, { r: { ...base, status: 'rejected', decidedAt: '2026-10-27T11:00:00.000Z' }, onDone: () => {} }));
    expect(done).toContain('Elutasítva');
    expect(done).not.toContain('<button');
  });
});
