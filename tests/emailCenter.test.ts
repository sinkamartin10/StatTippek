/**
 * Email Center – HTTP-szintű, szolgáltatási és felületi tesztek.
 *
 * A VALÓDI routerekkel, a VALÓDI requireAuthenticated / requireAdmin őrökkel és a valódi szolgáltatással;
 * a `res.locals.plan` az egyetlen szimulált elem. Valódi email NEM megy ki: a küldő hamis (rögzíti a kéréseket),
 * a globális fetch pedig minden külső hívásra hibát dob. A Resend-klienst hamis fetch-csel ellenőrizzük.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { EmailStoreError, MemoryEmailStore, PostgresEmailStore } from '../src/server/email/store';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from '../src/client/lib/api';
import {
  EmailCenterService, EmailSendError, MAX_ATTEMPTS, ResendSender, adminEmailRouter, contentIssues, emailConfig, emailRouter, finalStatus,
  missingConfig, renderEmail, unsubscribeToken, verifyUnsubscribeToken, type EmailSender, type OutgoingEmail,
} from '../src/server/email/emailCenter';
import { requireAdmin } from '../src/server/billing/entitlement';
import { CONSENT_TEXT_VERSION, type CampaignView } from '../src/shared/email';
import { CampaignRow, errorText, sendBlockers } from '../src/client/pages/AdminEmailCenter';

const ADMIN = { user: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@example.com' };
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SECRET = 'x'.repeat(40);
const BASE = 'https://api.example.test';
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';
/** 1–4 FREE, 5–7 PRO (7: lejárt PRO → FREE), 8: érvénytelen cím, 9: nincs cím, 10: az 1-es címe más kis-nagybetűvel */
const USERS = [
  { userId: U(1), email: 'u1@example.com', status: 'free', end: null },
  { userId: U(2), email: 'u2@example.com', status: 'free', end: null },
  { userId: U(3), email: 'u3@example.com', status: 'canceled', end: null },
  { userId: U(4), email: 'u4@example.com', status: 'free', end: null },
  { userId: U(5), email: 'u5@example.com', status: 'pro', end: FUTURE },
  { userId: U(6), email: 'u6@example.com', status: 'pro', end: null },
  { userId: U(7), email: 'u7@example.com', status: 'pro', end: PAST },
  { userId: U(8), email: 'nem-email', status: 'free', end: null },
  { userId: U(9), email: null, status: 'pro', end: null },
  { userId: U(10), email: 'U1@Example.com', status: 'free', end: null },
];

/** hamis küldő: rögzít mindent; a `plan` szerint hibázhat */
class FakeSender implements EmailSender {
  calls: { emails: OutgoingEmail[]; key: string }[] = [];
  plan: (n: number) => Error | null = () => null;
  async sendBatch(emails: OutgoingEmail[], key: string) {
    this.calls.push({ emails, key });
    const err = this.plan(this.calls.length);
    if (err) throw err;
    return emails.map((_, i) => `msg-${this.calls.length}-${i}`);
  }
  get sent() { return this.calls.flatMap((c) => c.emails); }
}

interface Harness { url: string; close: () => Promise<void>; store: MemoryEmailStore; sender: FakeSender; svc: EmailCenterService; sleeps: number[] }
const cfg = (over: Record<string, string> = {}) => emailConfig({ RESEND_API_KEY: 're_test', EMAIL_FROM: 'TippStats <hello@example.com>', EMAIL_UNSUBSCRIBE_SECRET: SECRET, API_PUBLIC_URL: BASE, ...over });

async function startApp(opts: { config?: ReturnType<typeof emailConfig>; noSender?: boolean } = {}): Promise<Harness> {
  const store = new MemoryEmailStore(USERS.map((u) => ({ ...u })));
  const sender = new FakeSender();
  const sleeps: number[] = [];
  const svc = new EmailCenterService({ store, sender: opts.noSender ? null : sender, config: opts.config ?? cfg(), sleep: async (ms) => { sleeps.push(ms); }, log: () => {} });
  const app = express();
  app.use(express.json({ limit: '400kb' }));
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    const email = (req.header('x-test-email') ?? '').toLowerCase();
    // a regisztrációs jelölőnégyzet: élesben a Supabase hitelesített user_metadata-ja
    const user_metadata = req.header('x-test-optin') === '1' ? { marketing_opt_in: true, marketing_opt_in_version: 'v1' } : {};
    res.locals.plan = { enforced: true, user: id ? { id, email, user_metadata } : null, pro: false, admin: email === ADMIN.email };
    next();
  });
  app.use('/api/email', emailRouter(svc));
  app.use('/api/admin/email', requireAdmin, adminEmailRouter(svc));
  const server: Server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())), store, sender, svc, sleeps };
}

type Who = { user?: string; email?: string; optIn?: boolean };
async function call(h: Harness, method: string, path: string, who: Who = {}, body?: unknown, raw?: { type: string; data: string }) {
  const res = await realFetch(`${h.url}${path}`, {
    method,
    headers: { 'content-type': raw?.type ?? 'application/json', ...(who.user ? { 'x-test-user': who.user } : {}), ...(who.email ? { 'x-test-email': who.email } : {}), ...(who.optIn ? { 'x-test-optin': '1' } : {}) },
    body: raw ? raw.data : body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text();
  return { status: res.status, text: t, body: res.headers.get('content-type')?.includes('json') && t ? JSON.parse(t) : null, headers: res.headers };
}
const as = (n: number): Who => ({ user: U(n), email: `u${n}@example.com` });

const realFetch = globalThis.fetch;
let h: Harness;
beforeEach(async () => {
  // biztosíték: a teszt semmilyen külső szolgáltatást nem hívhat (valódi email nem mehet ki)
  vi.stubGlobal('fetch', vi.fn(async (u: string, i?: RequestInit) => {
    if (!String(u).startsWith('http://127.0.0.1:')) throw new Error(`külső hívás tiltva: ${u}`);
    return realFetch(u, i);
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h = await startApp();
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await h.close(); });

const consent = (n: number) => call(h, 'PUT', '/api/email/consent', as(n), { consented: true });
const create = (body: Record<string, unknown>) => call(h, 'POST', '/api/admin/email/campaigns', ADMIN, { kind: 'marketing', audience: 'all', subject: 'Újdonság', html: '<p>Szia!</p>', ...body });
const preview = (id: string) => call(h, 'POST', `/api/admin/email/campaigns/${id}/preview`, ADMIN, {});
const send = (id: string, body: Record<string, unknown>) => call(h, 'POST', `/api/admin/email/campaigns/${id}/send`, ADMIN, body);
/** a háttérben futó küldés megvárása */
async function settle(id: string) {
  for (let i = 0; i < 400; i++) { if ((await h.store.getCampaign(id))?.status !== 'sending') return h.store.getCampaign(id); await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('a küldés nem fejeződött be');
}
const recipientsOf = () => h.sender.sent.map((e) => e.to).sort();
async function sendAll(body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const c = (await create(body)).body as CampaignView;
  const p = (await preview(c.id)).body;
  const r = await send(c.id, { recipientCount: p.recipientCount, ...extra });
  return { c, p, r, done: r.status === 202 ? await settle(c.id) : null };
}

// ---------------------------------------------------------------------------

describe('Címzettszűrés', () => {
  it('rendszerüzenet: összes / FREE / PRO – a lejárt PRO FREE; érvénytelen, hiányzó és ismétlődő cím kimarad', async () => {
    const all = await h.svc.recipientsFor('system', 'all');
    expect(all.map((r) => r.userId)).toEqual([U(1), U(2), U(3), U(4), U(5), U(6), U(7)]);
    expect((await h.svc.recipientsFor('system', 'free')).map((r) => r.userId)).toEqual([U(1), U(2), U(3), U(4), U(7)]);
    expect((await h.svc.recipientsFor('system', 'pro')).map((r) => r.userId)).toEqual([U(5), U(6)]);
  });

  it('marketing: a hozzájárulás MINDEN szűrőnél feltétel; a FREE/PRO szűrő a hozzájárulók közül választ', async () => {
    expect(await h.svc.recipientsFor('marketing', 'all')).toEqual([]);
    for (const n of [1, 5]) await consent(n);
    expect((await h.svc.recipientsFor('marketing', 'all')).map((r) => r.userId)).toEqual([U(1), U(5)]);
    expect((await h.svc.recipientsFor('marketing', 'marketing_consent')).map((r) => r.userId)).toEqual([U(1), U(5)]);
    expect((await h.svc.recipientsFor('marketing', 'free')).map((r) => r.userId)).toEqual([U(1)]);
    expect((await h.svc.recipientsFor('marketing', 'pro')).map((r) => r.userId)).toEqual([U(5)]);
  });

  it('az előnézet csak darabszámot ad – email-címet nem', async () => {
    await consent(1);
    const c = (await create({})).body as CampaignView;
    const p = await preview(c.id);
    expect(p.body.recipientCount).toBe(1);
    expect(p.text).not.toContain('u1@example.com');
    expect((await call(h, 'GET', `/api/admin/email/campaigns/${c.id}`, ADMIN)).text).not.toMatch(/u\d@example\.com/);
  });
});

describe('Marketing-hozzájárulás', () => {
  it('a meglévő felhasználó alapból NEM hozzájáruló', async () => {
    expect((await call(h, 'GET', '/api/email/consent', as(2))).body).toMatchObject({ consented: false, consentedAt: null, textVersion: CONSENT_TEXT_VERSION });
  });

  it('megadás a profilban: időpont, forrás és szövegverzió naplózva; ismétlés nem ír újat', async () => {
    const r = await consent(2);
    expect(r.body).toMatchObject({ consented: true, consentSource: 'profile', changed: true });
    expect(r.body.consentedAt).toEqual(expect.any(String));
    expect((await consent(2)).body.changed).toBe(false);
    expect(h.store.consentEvents).toEqual([expect.objectContaining({ userId: U(2), granted: true, source: 'profile', textVersion: CONSENT_TEXT_VERSION })]);
  });

  it('a hozzájárulás végpontjai bejelentkezést kérnek, és csak a saját fiókot érintik', async () => {
    expect((await call(h, 'GET', '/api/email/consent')).status).toBe(401);
    expect((await call(h, 'PUT', '/api/email/consent', {}, { consented: true })).status).toBe(401);
    await call(h, 'PUT', '/api/email/consent', as(2), { consented: true, userId: U(3) });
    expect((await h.store.getConsent(U(3))).consented).toBe(false);
  });

  it('hozzájárulást csak a profilban lehet adni (leiratkozó forrással nem)', async () => {
    await expect(h.store.setConsent(U(2), true, 'unsubscribe_link')).rejects.toThrow();
  });
});

describe('Regisztrációs hozzájárulás – szerveroldal (a rögzítés a 0025 DB-triggeréé, lásd emailCenter.pg.test.ts)', () => {
  it('nincs bejelentkezéskori rögzítés: a régi végpont nem létezik, a bejelölt metaadat sem ad hozzájárulást API-n át', async () => {
    const r = await call(h, 'POST', '/api/email/consent/registration', { ...as(2), optIn: true }, { consented: true });
    expect(r.status).toBe(404);
    expect((await h.store.getConsent(U(2))).consented).toBe(false);
    expect(h.store.consentEvents).toEqual([]);
  });

  it('manipulált kliensadat a profil-végponton: forrás, időbélyeg és más felhasználó azonosítója figyelmen kívül marad', async () => {
    const before = Date.now();
    const r = await call(h, 'PUT', '/api/email/consent', as(2), { consented: true, source: 'registration', consentedAt: '2000-01-01T00:00:00.000Z', userId: U(3) });
    expect(r.body).toMatchObject({ consented: true, consentSource: 'profile' });
    expect(new Date(r.body.consentedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((await h.store.getConsent(U(3))).consented).toBe(false);
    expect(h.store.consentEvents).toEqual([expect.objectContaining({ userId: U(2), source: 'profile' })]);
  });

  it('a „registration” forrás API-n át semmilyen irányban nem használható', async () => {
    await expect(h.store.setConsent(U(2), true, 'registration')).rejects.toThrow();
    await expect(h.store.setConsent(U(2), false, 'registration')).rejects.toThrow();
    expect(h.store.consentEvents).toEqual([]);
  });

  it('meg nem erősített email-cím (pl. idegen címmel regisztrált fiók): sem marketing, sem rendszerüzenet nem megy rá', async () => {
    h.store.users.push({ userId: U(30), email: 'idegen@example.com', status: 'free', end: null, confirmed: false });
    h.store.consents.set(U(30), { consented: true, consentedAt: '2026-11-01T10:00:00.000Z', consentSource: 'registration', revokedAt: null });
    for (const kind of ['marketing', 'system'] as const) {
      expect((await h.svc.recipientsFor(kind, 'all')).map((x) => x.userId)).not.toContain(U(30));
    }
  });
});

describe('Meglévő felhasználók és admin-statisztika', () => {
  it('senki nem hozzájáruló automatikusan; a darabszám a fel- és leiratkozással azonnal változik', async () => {
    const count = async () => (await call(h, 'GET', '/api/admin/email/status', ADMIN)).body.marketingConsentCount;
    expect(await count()).toBe(0);
    expect(await h.svc.recipientsFor('marketing', 'all')).toEqual([]);
    await consent(1); await consent(5);
    expect(await count()).toBe(2);
    await call(h, 'PUT', '/api/email/consent', as(1), { consented: false });
    expect(await count()).toBe(1);
  });

  it('egy kattintás fel- és leiratkozás a profilban: a kampánycímzés követi', async () => {
    const targets = async () => (await h.svc.recipientsFor('marketing', 'all')).map((x) => x.userId);
    expect((await call(h, 'PUT', '/api/email/consent', as(5), { consented: true })).body).toMatchObject({ consented: true, changed: true });
    expect(await targets()).toEqual([U(5)]);
    expect((await call(h, 'PUT', '/api/email/consent', as(5), { consented: false })).body).toMatchObject({ consented: false, changed: true });
    expect(await targets()).toEqual([]);
    await call(h, 'PUT', '/api/email/consent', as(5), { consented: true });
    expect(await targets()).toEqual([U(5)]);
    // a rendszerüzenet a hozzájárulástól függetlenül minden érintettnek szól
    expect((await h.svc.recipientsFor('system', 'pro')).map((x) => x.userId)).toEqual([U(5), U(6)]);
    expect(h.store.consentEvents.map((e) => `${e.granted}:${e.source}`)).toEqual(['true:profile', 'false:profile', 'true:profile']);
  });
});

describe('Leiratkozás', () => {
  const link = (n: number) => `/api/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(SECRET, U(n)))}`;

  it('a GET csak megerősítő oldalt ad (a levelezők előre megnyithatják) – semmi nem változik', async () => {
    await consent(1);
    const r = await call(h, 'GET', link(1));
    expect(r.status).toBe(200);
    expect(r.text).toContain('<form method="post"');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-robots-tag')).toBe('noindex');
    expect((await h.store.getConsent(U(1))).consented).toBe(true);
  });

  it('POST: azonnali leiratkozás, naplózva; ismételt leiratkozás nem ír új bejegyzést', async () => {
    await consent(1);
    const r = await call(h, 'POST', link(1), {}, undefined, { type: 'application/x-www-form-urlencoded', data: '' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('Sikeresen leiratkoztál');
    expect(await h.store.getConsent(U(1))).toMatchObject({ consented: false, revokedAt: expect.any(String) });
    expect(h.store.consentEvents.at(-1)).toMatchObject({ userId: U(1), granted: false, source: 'unsubscribe_link' });
    await call(h, 'POST', link(1), {}, undefined, { type: 'application/x-www-form-urlencoded', data: '' });
    expect(h.store.consentEvents).toHaveLength(2);
  });

  it('RFC 8058 egykattintásos leiratkozás (List-Unsubscribe=One-Click)', async () => {
    await consent(1);
    await call(h, 'POST', link(1), {}, undefined, { type: 'application/x-www-form-urlencoded', data: 'List-Unsubscribe=One-Click' });
    expect(h.store.consentEvents.at(-1)).toMatchObject({ granted: false, source: 'one_click' });
  });

  it('hamis, módosított vagy más titokkal aláírt token: 400, semmi nem változik, címet nem árul el', async () => {
    await consent(1);
    const good = unsubscribeToken(SECRET, U(1));
    for (const t of ['', 'abc', good.slice(0, -2) + 'xx', `${Buffer.from(U(2)).toString('base64url')}.${good.split('.')[1]}`, unsubscribeToken('masik-titok-'.repeat(4), U(1))]) {
      const r = await call(h, 'POST', `/api/email/unsubscribe?t=${encodeURIComponent(t)}`, {}, undefined, { type: 'application/x-www-form-urlencoded', data: '' });
      expect(r.status, t).toBe(400);
      expect(r.text).not.toContain('@');
    }
    expect((await h.store.getConsent(U(1))).consented).toBe(true);
    expect(verifyUnsubscribeToken(SECRET, good)).toBe(U(1));
    expect(verifyUnsubscribeToken(SECRET, 'x'.repeat(500))).toBeNull();
  });

  it('visszaélés ellen IP-nként korlátozott', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await call(h, 'GET', '/api/email/unsubscribe?t=x')).status);
    expect(codes.slice(0, 30).every((c) => c === 400)).toBe(true);
    expect(codes.slice(30)).toEqual([429, 429]);
  });

  it('a küldés közben leiratkozott címzett már nem kap levelet (kötegenként újraellenőrizve)', async () => {
    for (const n of [1, 2]) await consent(n);
    const c = (await create({})).body as CampaignView;
    const p = (await preview(c.id)).body;
    // a megerősítés után, de a köteg előtt iratkozik le
    const orig = h.store.consentedAmong.bind(h.store);
    h.store.consentedAmong = async (ids) => { await h.store.setConsent(U(2), false, 'unsubscribe_link'); return orig(ids); };
    await send(c.id, { recipientCount: p.recipientCount });
    const done = await settle(c.id);
    expect(recipientsOf()).toEqual(['u1@example.com']);
    expect(done).toMatchObject({ status: 'sent', sentCount: 1, skippedCount: 1 });
  });
});

describe('Marketing és rendszerüzenet elkülönítése', () => {
  it('rendszerüzenet nem célozhatja a marketing-hozzájárulókat', async () => {
    expect((await create({ kind: 'system', audience: 'marketing_consent' })).status).toBe(400);
    const c = (await create({ kind: 'system', audience: 'all' })).body as CampaignView;
    expect((await call(h, 'PUT', `/api/admin/email/campaigns/${c.id}`, ADMIN, { audience: 'marketing_consent' })).status).toBe(400);
  });

  it('rendszerüzenetben marketingelem: az előnézet jelzi, a küldés 422 – szóeleji illeszkedés („tranzakció” nem akció)', async () => {
    expect(contentIssues('system', 'all', 'Fiókbiztonság', '<p>Sikeres tranzakció a fiókodon.</p>')).toEqual([]);
    const promo = contentIssues('system', 'all', 'Nagy AKCIÓ!', '<p>20% kedvezmény</p>')[0];
    expect(promo).toMatch(/kedvezmény/);
    expect(promo).toMatch(/akció/);
    const c = (await create({ kind: 'system', subject: 'Black Friday', html: '<p>Kupon: TIPP20</p>' })).body as CampaignView;
    const p = (await preview(c.id)).body;
    expect(p.issues.length).toBeGreaterThan(0);
    const r = await send(c.id, { recipientCount: p.recipientCount, attestSystem: true });
    expect(r.status).toBe(422);
    expect(h.sender.calls).toHaveLength(0);
  });

  it('rendszerüzenet csak az admin nyilatkozatával küldhető', async () => {
    const c = (await create({ kind: 'system', subject: 'Üzemszünet', html: '<p>Vasárnap 2–4 óra között karbantartás.</p>' })).body as CampaignView;
    const p = (await preview(c.id)).body;
    expect((await send(c.id, { recipientCount: p.recipientCount })).body.code).toBe('ATTESTATION_REQUIRED');
    expect((await send(c.id, { recipientCount: p.recipientCount, attestSystem: true })).status).toBe(202);
    const done = await settle(c.id);
    expect(done).toMatchObject({ status: 'sent', sentCount: 7, systemAttested: true });
  });

  it('a rendszerüzenetben nincs leiratkozó link és fejléc; a marketingben van, címzettenként a saját tokennel', async () => {
    const sys = await sendAll({ kind: 'system', subject: 'Üzemszünet', html: '<p>Karbantartás.</p>' }, { attestSystem: true });
    expect(sys.done?.status).toBe('sent');
    for (const e of h.sender.sent) { expect(e.headers).toBeUndefined(); expect(e.html).not.toContain('unsubscribe'); expect(e.html).toContain('szolgáltatási üzenet'); }
    h.sender.calls = [];
    for (const n of [1, 5]) await consent(n);
    await sendAll({ kind: 'marketing' });
    for (const e of h.sender.sent) {
      const n = Number(e.to.match(/u(\d)@/)![1]);
      const url = `${BASE}/api/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(SECRET, U(n)))}`;
      expect(e.headers).toEqual({ 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
      expect(e.html).toContain(url.replace(/&/g, '&amp;'));
    }
  });

  it('veszélyes tartalom (script, eseménykezelő, javascript:) nem küldhető', () => {
    for (const html of ['<script>x</script>', '<img src=x onerror="a()">', '<a href="javascript:alert(1)">x</a>', '<iframe src=x>']) {
      expect(contentIssues('marketing', 'all', 'T', html).length, html).toBeGreaterThan(0);
    }
  });
});

describe('Admin jogosultság', () => {
  it('minden admin végpont: bejelentkezés nélkül 401, nem adminnak 403', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const routes: [string, string][] = [['GET', '/status'], ['GET', '/campaigns'], ['POST', '/campaigns'], ['PUT', `/campaigns/${id}`], ['GET', `/campaigns/${id}`],
      ['POST', `/campaigns/${id}/preview`], ['POST', `/campaigns/${id}/test`], ['POST', `/campaigns/${id}/send`], ['POST', `/campaigns/${id}/retry`]];
    for (const [m, p] of routes) {
      const body = m === 'GET' ? undefined : {};
      expect((await call(h, m, `/api/admin/email${p}`, {}, body)).status, `${m} ${p}`).toBe(401);
      expect((await call(h, m, `/api/admin/email${p}`, as(1), body)).status, `${m} ${p}`).toBe(403);
    }
    expect(h.store.campaigns.size).toBe(0);
    expect(h.sender.calls).toHaveLength(0);
  });

  it('a teszt email kizárólag a bejelentkezett admin saját címére megy, a naplóba nem kerül', async () => {
    const c = (await create({})).body as CampaignView;
    const r = await call(h, 'POST', `/api/admin/email/campaigns/${c.id}/test`, ADMIN, { to: 'valaki@example.com' });
    expect(r.body).toEqual({ to: ADMIN.email });
    expect(h.sender.sent.map((e) => [e.to, e.subject])).toEqual([[ADMIN.email, '[TESZT] Újdonság']]);
    expect(h.store.deliveries.size).toBe(0);
    expect((await call(h, 'POST', `/api/admin/email/campaigns/${c.id}/test`, ADMIN, {})).status).toBe(429);
  });
});

describe('Duplikált küldés ellen', () => {
  it('egy kampány egyszer küldhető: a második megerősítés 409, egy címre egy levél', async () => {
    for (const n of [1, 5, 10]) await consent(n);
    const { c, p, done } = await sendAll({});
    expect(done?.status).toBe('sent');
    expect(recipientsOf()).toEqual(['u1@example.com', 'u5@example.com']); // az U1@Example.com ugyanaz a cím
    expect((await send(c.id, { recipientCount: p.recipientCount })).body.code).toBe('ALREADY_PROCESSED');
    expect(h.sender.sent).toHaveLength(2);
  });

  it('párhuzamos megerősítések: pontosan egy indul el', async () => {
    await consent(1);
    const c = (await create({})).body as CampaignView;
    const p = (await preview(c.id)).body;
    const outs = await Promise.all([1, 2, 3, 4].map(() => send(c.id, { recipientCount: p.recipientCount })));
    expect(outs.filter((o) => o.status === 202)).toHaveLength(1);
    await settle(c.id);
    expect(h.sender.sent).toHaveLength(1);
  });

  it('minden levél egyetlen címzettnek megy; a tároló sem vesz fel kétszer egy fiókot / címet', async () => {
    for (const n of [1, 2, 5]) await consent(n);
    await sendAll({});
    for (const e of h.sender.sent) expect(typeof e.to).toBe('string');
    const id = [...h.store.campaigns.keys()][0];
    expect(await h.store.addDeliveries(id, [{ userId: U(1), email: 'u1@example.com', pro: false, consented: true }, { userId: U(99), email: 'U2@example.com', pro: false, consented: true }])).toBe(0);
  });

  it('megerősítés: a címzettszámnak egyeznie kell a szerver számával; korlát fölött nem küldhető', async () => {
    await consent(1);
    const c = (await create({})).body as CampaignView;
    expect((await send(c.id, { recipientCount: 5 })).body).toMatchObject({ code: 'COUNT_CHANGED', recipientCount: 1 });
    expect((await send(c.id, {})).body.code).toBe('COUNT_CHANGED');
    await h.close();
    h = await startApp({ config: cfg({ EMAIL_MAX_RECIPIENTS: '3' }) });
    const s = (await create({ kind: 'system', subject: 'Üzemszünet', html: '<p>Karbantartás.</p>' })).body as CampaignView;
    expect((await send(s.id, { recipientCount: 7, attestSystem: true })).body.code).toBe('RECIPIENT_LIMIT');
    expect(h.sender.calls).toHaveLength(0);
  });

  it('nincs beállított küldő: a küldés 503, a státusz a hiányzó beállítások NEVÉT adja (értéket nem)', async () => {
    await h.close();
    h = await startApp({ config: emailConfig({}), noSender: true });
    const st = (await call(h, 'GET', '/api/admin/email/status', ADMIN)).body;
    expect(st.sendingConfigured).toBe(false);
    expect(st.missing).toEqual(['RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_UNSUBSCRIBE_SECRET (legalább 32 karakter)', 'API_PUBLIC_URL']);
    const c = (await create({ kind: 'system', subject: 'Üzemszünet', html: '<p>Karbantartás.</p>' })).body as CampaignView;
    expect((await send(c.id, { recipientCount: 7, attestSystem: true })).status).toBe(503);
    expect(missingConfig(cfg())).toEqual([]);
  });
});

describe('Küldési hibák és újrapróbálás', () => {
  it('átmeneti hiba (503, 429): ugyanaz a köteg ugyanazzal a kulccsal újra – végül elküldve', async () => {
    for (const n of [1, 2]) await consent(n);
    h.sender.plan = (n) => (n === 1 ? new EmailSendError('Resend HTTP 503', true) : n === 2 ? new EmailSendError('Resend HTTP 429', true, 2000) : null);
    const { done } = await sendAll({});
    expect(done).toMatchObject({ status: 'sent', sentCount: 2, failedCount: 0 });
    expect(h.sender.calls).toHaveLength(3);
    expect(new Set(h.sender.calls.map((c) => c.key)).size).toBe(1);
    expect(h.sleeps).toEqual([1000, 2000]); // exponenciális várakozás, majd a retry-after
  });

  it('végleges hiba: sikertelen napló hibaüzenettel; az újrapróbálás csak a sikerteleneket küldi újra', async () => {
    for (const n of [1, 2, 5]) await consent(n);
    h.sender.plan = (n) => (n === 1 ? new EmailSendError('Resend HTTP 422: invalid', false) : null);
    const { c, done } = await sendAll({});
    expect(done).toMatchObject({ status: 'failed', sentCount: 0, failedCount: 3 });
    expect([...h.store.deliveries.values()].every((d) => d.status === 'failed' && d.lastError?.includes('422') && d.attempts === 1)).toBe(true);
    const r = await call(h, 'POST', `/api/admin/email/campaigns/${c.id}/retry`, ADMIN, {});
    expect(r.status).toBe(202);
    expect(await settle(c.id)).toMatchObject({ status: 'sent', sentCount: 3, failedCount: 0 });
    expect(recipientsOf()).toEqual(['u1@example.com', 'u2@example.com', 'u5@example.com', 'u1@example.com', 'u2@example.com', 'u5@example.com'].sort());
    // még egy újrapróbálás: elküldött kampány már nem küldhető újra
    expect((await call(h, 'POST', `/api/admin/email/campaigns/${c.id}/retry`, ADMIN, {})).body.code).toBe('NOT_RETRYABLE');
    expect(h.sender.sent).toHaveLength(6);
  });

  it('részleges siker: csak a sikertelen köteg megy újra; a címzettenkénti kísérlet korlátos', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ userId: U(100 + i), email: `m${i}@example.com`, status: 'free', end: null }));
    h.store.users.push(...many);
    for (const u of many) await h.store.setConsent(u.userId, true, 'profile');
    h.sender.plan = (n) => (n === 2 ? new EmailSendError('Resend HTTP 400', false) : null); // a 2. köteg (10 levél) végleg hibás
    const { c, done } = await sendAll({});
    expect(done).toMatchObject({ status: 'partial', sentCount: 50, failedCount: 10 });
    h.sender.plan = () => new EmailSendError('Resend HTTP 400', false);
    for (let i = 0; i < 5; i++) { await call(h, 'POST', `/api/admin/email/campaigns/${c.id}/retry`, ADMIN, {}); await settle(c.id); }
    const failed = [...h.store.deliveries.values()].filter((d) => d.status === 'failed');
    expect(failed).toHaveLength(10);
    expect(failed.every((d) => d.attempts === MAX_ATTEMPTS)).toBe(true);
    expect(h.sender.sent.filter((e) => e.to === 'm0@example.com')).toHaveLength(1); // az elküldött soha nem megy újra
  });

  it('megszakadt küldés (szerver-újraindulás): a „sending” kampány folytatható, a már elküldött címzett nem kap újra', async () => {
    for (const n of [1, 2]) await consent(n);
    const c = (await create({})).body as CampaignView;
    // a megerősítés után a futás „elvész” (újraindulás szimulálása): a címzettek a naplóban, függőben
    await h.store.claimCampaign(c.id, ['draft'], { admin: ADMIN.email, attested: false, recipientCount: 2 });
    await h.store.addDeliveries(c.id, await h.svc.recipientsFor('marketing', 'all'));
    const first = [...h.store.deliveries.values()][0];
    await h.store.updateDeliveries([first.id], { status: 'sent', attempts: 1 });
    expect((await call(h, 'POST', `/api/admin/email/campaigns/${c.id}/retry`, ADMIN, {})).status).toBe(202);
    expect(await settle(c.id)).toMatchObject({ status: 'sent', sentCount: 2 });
    expect(h.sender.sent.map((e) => e.to)).toEqual(['u2@example.com']);
  });

  it('a kampány végállapota', () => {
    expect(finalStatus({ pending: 0, sending: 0, sent: 3, failed: 0, skipped: 2 })).toBe('sent');
    expect(finalStatus({ pending: 0, sending: 0, sent: 3, failed: 1, skipped: 0 })).toBe('partial');
    expect(finalStatus({ pending: 0, sending: 1, sent: 0, failed: 0, skipped: 0 })).toBe('failed');
  });
});

describe('Resend-kliens (hamis fetch – nincs valódi hívás)', () => {
  const emails: OutgoingEmail[] = [
    { to: 'a@example.com', subject: 'S', html: '<p>a</p>', headers: { 'List-Unsubscribe': '<https://x/u?t=1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } },
    { to: 'b@example.com', subject: 'S', html: '<p>b</p>' },
  ];

  it('kötegelt küldés: címzettenként külön levél, CC/BCC nélkül; kulcs, User-Agent és Idempotency-Key fejléc', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'r1' }, { id: 'r2' }] }), { status: 200 }));
    const ids = await new ResendSender('re_kulcs', 'TippStats <hello@example.com>', 'support@example.com', f as unknown as typeof fetch).sendBatch(emails, 'k-1');
    expect(ids).toEqual(['r1', 'r2']);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails/batch');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer re_kulcs', 'Idempotency-Key': 'k-1', 'User-Agent': expect.any(String) });
    const body = JSON.parse(String(init.body));
    expect(body).toHaveLength(2);
    for (const e of body) { expect(e.to).toHaveLength(1); expect(e).not.toHaveProperty('cc'); expect(e).not.toHaveProperty('bcc'); expect(e.reply_to).toBe('support@example.com'); }
    expect(body[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(body[1]).not.toHaveProperty('headers');
  });

  it('hibák: 429 és 5xx átmeneti (retry-after), 4xx és kvóta-túllépés végleges, hálózati hiba átmeneti', async () => {
    const cases: [Response | Error, boolean, number | null][] = [
      [new Response('{"name":"rate_limit_exceeded"}', { status: 429, headers: { 'retry-after': '2' } }), true, 2000],
      [new Response('{"name":"daily_quota_exceeded"}', { status: 429 }), false, null],
      [new Response('oops', { status: 502 }), true, null],
      [new Response('{"name":"validation_error"}', { status: 422 }), false, null],
      [new TypeError('fetch failed'), true, null],
    ];
    for (const [out, retryable, after] of cases) {
      const f = vi.fn(async () => { if (out instanceof Error) throw out; return out; });
      const err = await new ResendSender('k', 'f@example.com', null, f as unknown as typeof fetch).sendBatch(emails, 'k').catch((e) => e);
      expect(err).toBeInstanceOf(EmailSendError);
      expect([err.retryable, err.retryAfterMs]).toEqual([retryable, after]);
    }
  });
});

describe('Kampányküldés a felület útján (mentés → előnézet → címzettszám → kétlépéses megerősítés; hamis Resend-küldő)', () => {
  const put = (id: string, body: Record<string, unknown>) => call(h, 'PUT', `/api/admin/email/campaigns/${id}`, ADMIN, body);

  it('mentett, érvényes piszkozat: az előnézet címzettszáma alapján a küldés elindul, és csak a hozzájárulók kapják meg', async () => {
    for (const n of [1, 5]) await consent(n);
    const c = (await create({ subject: 'Első' })).body as CampaignView;                 // mentés (új)
    expect(c.status).toBe('draft');
    expect((await put(c.id, { subject: 'Heti hírek' })).body.subject).toBe('Heti hírek'); // mentés (piszkozat)
    const p = (await preview(c.id)).body;                                                // előnézet + címzettszám
    expect(p).toMatchObject({ recipientCount: 2, maxRecipients: 5000, issues: [] });
    expect(p.html).toContain('Leiratkozás');
    // a felület ugyanebből számol: nincs akadály → megjelenik a „Küldés N címzettnek” gomb
    expect(sendBlockers({ campaign: c, preview: p, kind: 'marketing', sendingConfigured: true })).toEqual([]);
    expect(h.sender.calls).toHaveLength(0);                                               // előnézet / mentés nem küld
    const r = await send(c.id, { recipientCount: p.recipientCount });                    // „Igen, küldés”
    expect(r.status).toBe(202);
    expect(r.body.campaign.status).toBe('sending');
    expect((await settle(c.id))?.status).toBe('sent');
    expect(recipientsOf()).toEqual(['u1@example.com', 'u5@example.com']);
    for (const e of h.sender.sent) expect(e.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('elindított / elküldött kampány nem indítható újra, és már nem szerkeszthető', async () => {
    await consent(1);
    const { c, p, done } = await sendAll({});
    expect(done?.status).toBe('sent');
    expect((await send(c.id, { recipientCount: p.recipientCount })).body.code).toBe('ALREADY_PROCESSED');
    expect((await call(h, 'POST', `/api/admin/email/campaigns/${c.id}/retry`, ADMIN, {})).body.code).toBe('NOT_RETRYABLE');
    expect((await put(c.id, { subject: 'Más' })).body.code).toBe('NOT_DRAFT');
    expect(sendBlockers({ campaign: done!, preview: p, kind: 'marketing', sendingConfigured: true })[0]).toMatch(/már nem piszkozat/);
    expect(h.sender.sent).toHaveLength(1);
  });

  it('nincs hozzájáruló: a felület kiírja az okot (nem rejti el szó nélkül a gombot), a szerver is elutasítja', async () => {
    const c = (await create({})).body as CampaignView;
    const p = (await preview(c.id)).body;
    expect(p.recipientCount).toBe(0);
    expect(sendBlockers({ campaign: c, preview: p, kind: 'marketing', sendingConfigured: true }).join(' ')).toMatch(/Nincs címzett: marketing csak megerősített email-című, marketinghez hozzájáruló/);
    expect((await send(c.id, { recipientCount: 0 })).body.code).toBe('NO_RECIPIENTS');
    expect(h.sender.calls).toHaveLength(0);
  });

  it('akadályok: mentetlen, tartalmi hiba, beállítás hiánya, korlát – mindegyik megnevezve', () => {
    const p = { html: '', recipientCount: 3, maxRecipients: 5000, issues: [] as string[] };
    const draft = { id: 'c1', status: 'draft' } as CampaignView;
    expect(sendBlockers({ campaign: null, preview: p, kind: 'marketing', sendingConfigured: true })).toEqual(['Előbb mentsd el a kampányt.']);
    expect(sendBlockers({ campaign: draft, preview: { ...p, issues: ['x'] }, kind: 'system', sendingConfigured: true })[0]).toMatch(/tartalmi hibákat/);
    expect(sendBlockers({ campaign: draft, preview: p, kind: 'marketing', sendingConfigured: false })[0]).toMatch(/nincs beállítva/);
    expect(sendBlockers({ campaign: draft, preview: { ...p, recipientCount: 6000 }, kind: 'marketing', sendingConfigured: true })[0]).toMatch(/meghaladja/);
    // ismeretlen beállítási állapot (a státusz még tölt) nem tilt – a szerver úgyis ellenőriz
    expect(sendBlockers({ campaign: draft, preview: p, kind: 'marketing', sendingConfigured: null })).toEqual([]);
  });
});

describe('Előnézet: adatbázis-hiba a címzettlista lekérésekor („A művelet nem sikerült” helyett pontos, biztonságos hiba)', () => {
  const RAW = 'permission denied for table users | titkos.cim@example.com | at Object.<anonymous> (store.ts:107)';
  const breakRecipients = (code: string | null) => {
    h.store.listRecipients = async () => { throw new EmailStoreError('email_recipients olvasás', code, RAW); };
  };

  it('jogosultsági hiba (42501): 503, megnevezett lépés és teendő; nyers DB-üzenet, email-cím, stack trace nincs a válaszban, csak a naplóban', async () => {
    const c = (await create({})).body as CampaignView;
    breakRecipients('42501');
    const r = await preview(c.id);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'EMAIL_DB_ERROR', dbCode: '42501', step: 'email_recipients olvasás' });
    expect(r.body.error).toMatch(/Nem sikerült: a címzettlista lekérése \(email_recipients nézet\)/);
    expect(r.body.error).toMatch(/jogosultság/);
    for (const leak of ['permission denied', 'titkos.cim@example.com', 'store.ts', 'at Object']) expect(r.text).not.toContain(leak);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('permission denied for table users');
    expect(h.sender.calls).toHaveLength(0);
  });

  it('hiányzó nézet / sémaeltérés (PGRST205, 42P01): 503 a migrációra utaló üzenettel', async () => {
    const c = (await create({})).body as CampaignView;
    for (const code of ['PGRST205', '42P01']) {
      breakRecipients(code);
      const r = await preview(c.id);
      expect(r.status).toBe(503);
      expect(r.body.dbCode).toBe(code);
      expect(r.body.error).toMatch(/0025_email_center\.sql/);
    }
  });

  it('ismeretlen adatbázis-hiba: 500, de a lépés és a kód ekkor is látszik; a küldés is ugyanígy jelez, és nem indul el', async () => {
    await consent(1);
    const c = (await create({})).body as CampaignView;
    const p = (await preview(c.id)).body;
    breakRecipients(null);
    const r = await preview(c.id);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: 'EMAIL_DB_ERROR', dbCode: null });
    expect(r.body.error).toMatch(/címzettlista/);
    const s = await send(c.id, { recipientCount: p.recipientCount });
    expect(s.body.code).toBe('EMAIL_DB_ERROR');
    expect((await h.store.getCampaign(c.id))?.status).toBe('draft');
    expect(h.sender.calls).toHaveLength(0);
  });

  it('a Postgres-tároló a PostgREST hibakódját továbbadja (a nyers üzenet csak a hiba részleteiben, naplózásra)', async () => {
    const q: any = { select: () => q, eq: () => q, order: () => q, range: async () => ({ data: null, error: { message: 'permission denied for table users', code: '42501', details: null, hint: null } }) };
    const store = new PostgresEmailStore({ from: () => q } as unknown as SupabaseClient);
    const e = await store.listRecipients().catch((x) => x);
    expect(e).toBeInstanceOf(EmailStoreError);
    expect(e).toMatchObject({ dbCode: '42501', detail: 'permission denied for table users' });
    expect(['email_recipients olvasás', 'email_marketing_consents olvasás']).toContain(e.op);
  });

  it('a felület a szerver biztonságos üzenetét mutatja HTTP-státusszal és kóddal', () => {
    expect(errorText(new ApiError('Nem sikerült: a címzettlista lekérése.', 503, 'EMAIL_DB_ERROR', { dbCode: '42501' })))
      .toBe('Nem sikerült: a címzettlista lekérése. (HTTP 503, EMAIL_DB_ERROR, adatbázis-kód: 42501)');
    expect(errorText(new ApiError('A kampány nem található.', 404, 'NOT_FOUND', {}))).toBe('A kampány nem található. (HTTP 404, NOT_FOUND)');
    expect(errorText('x')).toBe('Ismeretlen hiba.');
  });
});

describe('Levélsablon és felület', () => {
  it('a tárgy a sablonban escape-elve; marketingnél leiratkozás, rendszerüzenetnél szolgáltatási lábléc', () => {
    expect(renderEmail('marketing', '<b>x</b>', '<p>t</p>', 'https://x/u?t=1&a=2')).toContain('<title>&lt;b&gt;x&lt;/b&gt;</title>');
    expect(renderEmail('marketing', 'S', '<p>t</p>', 'https://x/u?t=1&a=2')).toContain('href="https://x/u?t=1&amp;a=2"');
    expect(renderEmail('system', 'S', '<p>t</p>', null)).not.toContain('Leiratkozás');
  });

  it('kampánysor: státusz, statisztika, és újraküldés csak hibás kampánynál', () => {
    const base: CampaignView = { id: 'c1', kind: 'marketing', audience: 'all', subject: 'Hírek', html: '', status: 'partial', createdBy: 'a', createdAt: '2026-11-09T10:00:00.000Z',
      confirmedAt: null, finishedAt: null, recipientCount: 10, sentCount: 8, failedCount: 2, skippedCount: 0, systemAttested: false };
    const html = renderToStaticMarkup(createElement(CampaignRow, { c: base, onOpen: () => {}, onChanged: () => {} }));
    for (const s of ['Hírek', 'Részben sikertelen', 'elküldve: 8', 'sikertelen: 2', 'Sikertelenek újraküldése']) expect(html).toContain(s);
    expect(renderToStaticMarkup(createElement(CampaignRow, { c: { ...base, status: 'sent' }, onOpen: () => {}, onChanged: () => {} }))).not.toContain('újraküldése');
    expect(renderToStaticMarkup(createElement(CampaignRow, { c: { ...base, status: 'sending' }, onOpen: () => {}, onChanged: () => {} }))).toContain('Folytatás (ha megszakadt)');
  });
});
