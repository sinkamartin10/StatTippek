/**
 * Email Center: admin kampányok (marketing / rendszerüzenet), marketing-hozzájárulás és leiratkozás.
 *
 *  GET  /api/email/consent                  saját marketing-hozzájárulás (bejelentkezve)
 *  PUT  /api/email/consent                  { consented } – saját hozzájárulás megadása / visszavonása (forrás: profile)
 *  (a regisztrációs jelölőnégyzet hozzájárulását a 0025 adatbázis-triggere rögzíti a regisztrációval egy tranzakcióban)
 *  GET  /api/email/unsubscribe?t=           leiratkozó oldal megerősítő gombbal (a GET semmit nem módosít)
 *  POST /api/email/unsubscribe?t=           leiratkozás – azonnal; RFC 8058 egykattintásos leiratkozás is
 *  /api/admin/email/...                     kampányok, előnézet, teszt, küldés, újrapróbálás (requireAdmin a mount helyén)
 *
 * Biztonság és szabályok:
 *  - a címzetteket és címeiket KIZÁRÓLAG a szerver olvassa (service_role); a kliens soha nem kap címlistát,
 *  - marketing: csak a küldés pillanatában is hozzájárulóknak (kötegenként újraellenőrizve), minden levélben
 *    leiratkozó link + List-Unsubscribe fejléc; a hozzájárulás feltétele szűrőtől függetlenül mindig érvényes,
 *  - rendszerüzenet: nem célozhatja a marketing-hozzájárulókat, nem tartalmazhat marketingelemet (szerveroldali
 *    tartalomellenőrzés), és csak az admin kifejezett nyilatkozatával küldhető,
 *  - minden levél egyetlen címzettnek megy (nincs közös CC/BCC); egy kampányban egy fiók egyszer (DB-egyediség),
 *  - a küldés megerősítése: a szerver által számolt címzettszámot kell visszaküldeni; kampányonkénti küldési korlát,
 *  - a leiratkozó link HMAC-kel aláírt (nem találgatható, nem árul el címet), a végpont IP-nként korlátozott.
 */
import express, { Router, type Request, type Response } from 'express';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { planOf, requireAuthenticated } from '../billing/entitlement';
import type { Delivery, EmailStore, Recipient } from './store';
import {
  AUDIENCES_FOR, CONSENT_TEXT, CONSENT_TEXT_VERSION, type CampaignPreview, type CampaignStatus, type CampaignView, type DeliveryStats,
  type EmailAudience, type EmailCenterStatus, type EmailKind,
} from '../../shared/email';

// ---------------------------------------------------------------------------
// Beállítások
// ---------------------------------------------------------------------------

export interface EmailConfig {
  apiKey: string | null;
  from: string | null;
  replyTo: string | null;
  unsubscribeSecret: string | null;
  /** a backend publikus címe (a leiratkozó link ide mutat), pl. https://stattippek.onrender.com */
  publicApiUrl: string | null;
  maxRecipients: number;
}

export const DEFAULT_MAX_RECIPIENTS = 5000;
export const BATCH_SIZE = 50;
/** kötegek között: legfeljebb ~2 kérés / mp (a Resend alapkorlátja 10 / mp – bőven alatta) */
export const BATCH_INTERVAL_MS = 500;
/** egy címzettre legfeljebb ennyi küldési kísérlet (az újrapróbálással együtt) */
export const MAX_ATTEMPTS = 3;
/** egy kötegen belül átmeneti hibánál (429, 5xx, hálózat) ennyi azonnali újrapróbálás */
const SEND_RETRIES = 2;

export function emailConfig(env: Record<string, string | undefined>): EmailConfig {
  const s = (v: string | undefined) => (v?.trim() ? v.trim() : null);
  const max = Number.parseInt(env.EMAIL_MAX_RECIPIENTS ?? '', 10);
  return {
    apiKey: s(env.RESEND_API_KEY), from: s(env.EMAIL_FROM), replyTo: s(env.EMAIL_REPLY_TO),
    unsubscribeSecret: s(env.EMAIL_UNSUBSCRIBE_SECRET), publicApiUrl: s(env.API_PUBLIC_URL)?.replace(/\/+$/, '') ?? null,
    maxRecipients: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_RECIPIENTS,
  };
}

/** a hiányzó beállítások NEVEI (értékek soha) */
export function missingConfig(c: EmailConfig): string[] {
  const out: string[] = [];
  if (!c.apiKey) out.push('RESEND_API_KEY');
  if (!c.from) out.push('EMAIL_FROM');
  if (!c.unsubscribeSecret || c.unsubscribeSecret.length < 32) out.push('EMAIL_UNSUBSCRIBE_SECRET (legalább 32 karakter)');
  if (!c.publicApiUrl || !/^https?:\/\//.test(c.publicApiUrl)) out.push('API_PUBLIC_URL');
  return out;
}

// ---------------------------------------------------------------------------
// Leiratkozó token: base64url(userId) . HMAC-SHA256 – nem találgatható, nem tartalmaz email-címet
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sign = (secret: string, userId: string) => createHmac('sha256', secret).update(`unsubscribe:v1:${userId}`).digest('base64url');

export function unsubscribeToken(secret: string, userId: string): string {
  return `${Buffer.from(userId).toString('base64url')}.${sign(secret, userId)}`;
}

/** az érvényes tokenhez tartozó felhasználó; minden más esetben null (állandó idejű összevetés) */
export function verifyUnsubscribeToken(secret: string, token: unknown): string | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const [u, sig, ...rest] = token.split('.');
  if (!u || !sig || rest.length) return null;
  const userId = Buffer.from(u, 'base64url').toString('utf8');
  if (!UUID_RE.test(userId)) return null;
  const want = Buffer.from(sign(secret, userId));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want) ? userId : null;
}

// ---------------------------------------------------------------------------
// Tartalom: ellenőrzés és a végleges levél
// ---------------------------------------------------------------------------

const FORBIDDEN: [RegExp, string][] = [
  [/<\s*script\b/i, 'script elem nem lehet a levélben'],
  [/<\s*(iframe|object|embed|form)\b/i, 'iframe / object / embed / form elem nem lehet a levélben'],
  [/\son[a-z]+\s*=/i, 'eseménykezelő attribútum (on…=) nem lehet a levélben'],
  [/javascript\s*:/i, 'javascript: hivatkozás nem lehet a levélben'],
];
/** marketingelemek, amelyek rendszerüzenetben nem lehetnek (szóeleji illeszkedés: a „tranzakció” nem „akció”) */
const PROMO_TERMS = ['kedvezmény', 'akció', 'kupon', 'promóció', 'leárazás', 'black friday', 'ajándék', 'ajánlat', 'vásárolj', 'rendeld meg', 'limitált', 'hírlevél'];
const promoRe = (t: string) => new RegExp(`(?<!\\p{L})${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu');
const textOf = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');

export function contentIssues(kind: EmailKind, audience: EmailAudience, subject: string, html: string): string[] {
  const issues: string[] = [];
  if (!AUDIENCES_FOR[kind].includes(audience)) issues.push('Rendszerüzenet nem célozhatja a marketing-hozzájárulókat – az marketingnek minősül.');
  if (!subject.trim()) issues.push('A tárgy nem lehet üres.');
  if (!textOf(html).trim()) issues.push('A levél tartalma nem lehet üres.');
  for (const [re, msg] of FORBIDDEN) if (re.test(html)) issues.push(msg[0].toUpperCase() + msg.slice(1) + '.');
  if (kind === 'system') {
    const found = PROMO_TERMS.filter((t) => promoRe(t).test(`${subject} ${textOf(html)}`));
    if (found.length) issues.push(`Rendszerüzenetben nem lehet marketingelem (${found.join(', ')}). Ilyen tartalmat marketingkampányként küldj.`);
  }
  return issues;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** a végleges levél: az admin HTML-je egységes keretben, kategóriánként kötelező lábléccel */
export function renderEmail(kind: EmailKind, subject: string, html: string, unsubscribeUrl: string | null): string {
  const footer = kind === 'marketing'
    ? `Ezt a levelet azért kaptad, mert hozzájárultál, hogy a TippStats marketing emaileket küldjön neked.<br><a href="${esc(unsubscribeUrl ?? '#')}" style="color:#4a69f4">Leiratkozás</a> – egy kattintással, azonnal.`
    : 'Ez szolgáltatási üzenet a TippStats-fiókoddal kapcsolatban, ezért a marketing-beállításaidtól függetlenül megkapod.';
  return `<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>`
    + '<body style="margin:0;padding:0;background:#f1f3f6">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f6"><tr><td align="center" style="padding:24px 12px">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px">'
    + '<tr><td style="padding:20px 24px;background:#111a33;border-radius:12px 12px 0 0;color:#ffffff;font:700 18px Arial,sans-serif">TippStats</td></tr>'
    + `<tr><td style="padding:24px;font:15px/1.6 Arial,sans-serif;color:#1d2539">${html}</td></tr>`
    + `<tr><td style="padding:16px 24px;border-top:1px solid #dce1e9;font:12px/1.5 Arial,sans-serif;color:#606b84">${footer}</td></tr>`
    + '</table></td></tr></table></body></html>';
}

// ---------------------------------------------------------------------------
// Küldőszolgáltatás (Resend REST API – kulcs csak szerveroldali környezeti változóból)
// ---------------------------------------------------------------------------

export interface OutgoingEmail { to: string; subject: string; html: string; headers?: Record<string, string> }

export class EmailSendError extends Error {
  constructor(message: string, public retryable: boolean, public retryAfterMs: number | null = null) { super(message); }
}

export interface EmailSender {
  /** egy köteg (≤ 100) levél; minden levélnek PONTOSAN egy címzettje van. Visszaad: szolgáltatói azonosítók (index szerint). */
  sendBatch(emails: OutgoingEmail[], idempotencyKey: string): Promise<(string | null)[]>;
}

export class ResendSender implements EmailSender {
  constructor(private apiKey: string, private from: string, private replyTo: string | null = null, private fetchImpl: typeof fetch = fetch) {}

  async sendBatch(emails: OutgoingEmail[], idempotencyKey: string): Promise<(string | null)[]> {
    let res: globalThis.Response;
    try {
      res = await this.fetchImpl('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'TippStats-EmailCenter/1.0', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(emails.map((e) => ({
          from: this.from, to: [e.to], subject: e.subject, html: e.html,
          ...(this.replyTo ? { reply_to: this.replyTo } : {}), ...(e.headers ? { headers: e.headers } : {}),
        }))),
      });
    } catch (e) {
      throw new EmailSendError(`hálózati hiba: ${(e as Error).message}`, true);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      const ra = Number.parseFloat(res.headers.get('retry-after') ?? '');
      // a napi / havi kvóta túllépése nem múlik el másodpercek alatt → nem próbáljuk azonnal újra
      const quota = /quota/i.test(body);
      throw new EmailSendError(`Resend HTTP ${res.status}: ${body}`, !quota && (res.status === 429 || res.status >= 500), Number.isFinite(ra) ? ra * 1000 : null);
    }
    const data = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
    return emails.map((_, i) => data?.data?.[i]?.id ?? null);
  }
}

// ---------------------------------------------------------------------------
// Szolgáltatás
// ---------------------------------------------------------------------------

export class EmailCenterError extends Error {
  constructor(message: string, public status: number, public code: string, public extra: Record<string, unknown> = {}) { super(message); }
}

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const isKind = (v: unknown): v is EmailKind => v === 'marketing' || v === 'system';
const isAudience = (v: unknown): v is EmailAudience => v === 'all' || v === 'free' || v === 'pro' || v === 'marketing_consent';

export interface EmailCenterDeps {
  store: EmailStore | null;
  sender: EmailSender | null;
  config: EmailConfig;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export class EmailCenterService {
  /** az ebben a folyamatban éppen futó küldések (ugyanaz a kampány egyszerre csak egyszer) */
  private running = new Set<string>();
  private lastTest = new Map<string, number>();
  private sleep: (ms: number) => Promise<void>;
  private log: (msg: string) => void;

  constructor(private d: EmailCenterDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = d.log ?? ((m) => console.log(m));
  }

  get store(): EmailStore | null { return this.d.store; }
  get unsubscribeSecret(): string | null { return this.d.config.unsubscribeSecret; }

  async status(): Promise<EmailCenterStatus> {
    const missing = missingConfig(this.d.config);
    return {
      sendingConfigured: !!this.d.sender && !!this.d.store && missing.length === 0, missing, maxRecipients: this.d.config.maxRecipients,
      marketingConsentCount: this.d.store ? await this.d.store.countConsented() : null,
    };
  }

  private requireStore(): EmailStore {
    if (!this.d.store) throw new EmailCenterError('Az Email Center ezen a példányon nem érhető el (nincs adatbázis).', 503, 'EMAIL_UNAVAILABLE');
    return this.d.store;
  }

  private requireSending(): { store: EmailStore; sender: EmailSender; secret: string; base: string } {
    const store = this.requireStore();
    const missing = missingConfig(this.d.config);
    if (!this.d.sender || missing.length) throw new EmailCenterError(`Az emailküldés nincs beállítva (hiányzik: ${missing.join(', ') || 'küldőszolgáltatás'}).`, 503, 'SENDING_NOT_CONFIGURED');
    return { store, sender: this.d.sender, secret: this.d.config.unsubscribeSecret!, base: this.d.config.publicApiUrl! };
  }

  /**
   * A címzettek a JELENLEGI állapot szerint. Marketingnél a hozzájárulás MINDIG feltétel (a szűrőtől függetlenül);
   * érvénytelen cím kimarad; egy cím csak egyszer szerepel.
   */
  async recipientsFor(kind: EmailKind, audience: EmailAudience): Promise<Recipient[]> {
    const all = await this.requireStore().listRecipients();
    const seen = new Set<string>();
    return all.filter((r) => {
      if (!EMAIL_RE.test(r.email)) return false;
      if (kind === 'marketing' && !r.consented) return false;
      if (audience === 'free' && r.pro) return false;
      if (audience === 'pro' && !r.pro) return false;
      if (audience === 'marketing_consent' && !r.consented) return false;
      const key = r.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private parseDraft(body: any, partial: boolean) {
    const out: { kind?: EmailKind; audience?: EmailAudience; subject?: string; html?: string } = {};
    if (body?.kind !== undefined || !partial) { if (!isKind(body?.kind)) throw new EmailCenterError('Érvénytelen kategória.', 400, 'BAD_REQUEST'); out.kind = body.kind; }
    if (body?.audience !== undefined || !partial) { if (!isAudience(body?.audience)) throw new EmailCenterError('Érvénytelen címzettszűrő.', 400, 'BAD_REQUEST'); out.audience = body.audience; }
    if (body?.subject !== undefined || !partial) {
      if (typeof body?.subject !== 'string' || !body.subject.trim() || body.subject.length > 200) throw new EmailCenterError('A tárgy 1–200 karakter lehet.', 400, 'BAD_REQUEST');
      out.subject = body.subject.trim();
    }
    if (body?.html !== undefined || !partial) {
      if (typeof body?.html !== 'string' || !body.html.trim() || body.html.length > 200_000) throw new EmailCenterError('A tartalom 1–200 000 karakter lehet.', 400, 'BAD_REQUEST');
      out.html = body.html;
    }
    return out;
  }

  async create(admin: string, body: unknown): Promise<CampaignView> {
    const p = this.parseDraft(body, false);
    if (!AUDIENCES_FOR[p.kind!].includes(p.audience!)) throw new EmailCenterError('Rendszerüzenet nem célozhatja a marketing-hozzájárulókat.', 400, 'BAD_AUDIENCE');
    return this.requireStore().createCampaign({ kind: p.kind!, audience: p.audience!, subject: p.subject!, html: p.html!, createdBy: admin });
  }

  async update(id: string, body: unknown): Promise<CampaignView> {
    const store = this.requireStore();
    const cur = await store.getCampaign(id);
    if (!cur) throw new EmailCenterError('A kampány nem található.', 404, 'NOT_FOUND');
    const p = this.parseDraft(body, true);
    if (!AUDIENCES_FOR[p.kind ?? cur.kind].includes(p.audience ?? cur.audience)) throw new EmailCenterError('Rendszerüzenet nem célozhatja a marketing-hozzájárulókat.', 400, 'BAD_AUDIENCE');
    const out = await store.updateDraft(id, p);
    if (!out) throw new EmailCenterError('Csak piszkozat módosítható.', 409, 'NOT_DRAFT');
    return out;
  }

  private async campaign(id: string): Promise<CampaignView> {
    const c = await this.requireStore().getCampaign(id);
    if (!c) throw new EmailCenterError('A kampány nem található.', 404, 'NOT_FOUND');
    return c;
  }

  private unsubscribeUrl(base: string, secret: string, userId: string) {
    return `${base}/api/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(secret, userId))}`;
  }

  async preview(id: string): Promise<CampaignPreview> {
    const c = await this.campaign(id);
    const sample = `${this.d.config.publicApiUrl ?? ''}/api/email/unsubscribe?t=minta`;
    return {
      html: renderEmail(c.kind, c.subject, c.html, c.kind === 'marketing' ? sample : null),
      recipientCount: (await this.recipientsFor(c.kind, c.audience)).length,
      maxRecipients: this.d.config.maxRecipients,
      issues: contentIssues(c.kind, c.audience, c.subject, c.html),
    };
  }

  /** teszt email KIZÁRÓLAG a bejelentkezett admin saját címére; a küldési naplóba nem kerül */
  async sendTest(id: string, adminEmail: string | null | undefined): Promise<{ to: string }> {
    const { sender } = this.requireSending();
    if (!adminEmail || !EMAIL_RE.test(adminEmail)) throw new EmailCenterError('Az admin fiókhoz nem tartozik érvényes email-cím.', 400, 'NO_ADMIN_EMAIL');
    const c = await this.campaign(id);
    const issues = contentIssues(c.kind, c.audience, c.subject, c.html);
    if (issues.length) throw new EmailCenterError(issues.join(' '), 422, 'CONTENT_ISSUES', { issues });
    const last = this.lastTest.get(id) ?? 0;
    if (Date.now() - last < 10_000) throw new EmailCenterError('Várj néhány másodpercet a következő teszt email előtt.', 429, 'TEST_COOLDOWN');
    this.lastTest.set(id, Date.now());
    const sample = `${this.d.config.publicApiUrl}/api/email/unsubscribe?t=minta`;
    await sender.sendBatch([{ to: adminEmail, subject: `[TESZT] ${c.subject}`, html: renderEmail(c.kind, c.subject, c.html, c.kind === 'marketing' ? sample : null) }], `tippstats-test-${randomUUID()}`);
    this.log(`[email] teszt: kampány=${id}`);
    return { to: adminEmail };
  }

  /**
   * Küldés megerősítése: a kliens a szerver által számolt címzettszámot küldi vissza; rendszerüzenetnél a
   * szolgáltatási célú nyilatkozat kötelező. A kampány feltételesen „sending” állapotba kerül (egyszerre egy küldés),
   * a címzettek a küldési naplóba (egyediség), majd a háttérben kötegenként kimennek.
   */
  async confirmSend(id: string, admin: string, body: any): Promise<{ campaign: CampaignView; job: Promise<void> }> {
    const { store } = this.requireSending();
    const c = await this.campaign(id);
    if (c.status !== 'draft') throw new EmailCenterError('Ezt a kampányt már elküldték.', 409, 'ALREADY_PROCESSED');
    const issues = contentIssues(c.kind, c.audience, c.subject, c.html);
    if (issues.length) throw new EmailCenterError(issues.join(' '), 422, 'CONTENT_ISSUES', { issues });
    if (c.kind === 'system' && body?.attestSystem !== true) {
      throw new EmailCenterError('Rendszerüzenethez nyilatkoznod kell, hogy szolgáltatási vagy biztonsági célú, és nincs benne marketing.', 400, 'ATTESTATION_REQUIRED');
    }
    const recipients = await this.recipientsFor(c.kind, c.audience);
    if (!recipients.length) throw new EmailCenterError('Nincs a feltételeknek megfelelő címzett.', 409, 'NO_RECIPIENTS');
    if (recipients.length > this.d.config.maxRecipients) {
      throw new EmailCenterError(`A címzettek száma (${recipients.length}) meghaladja a kampányonkénti korlátot (${this.d.config.maxRecipients}).`, 409, 'RECIPIENT_LIMIT', { recipientCount: recipients.length });
    }
    if (body?.recipientCount !== recipients.length) {
      throw new EmailCenterError(`A címzettek száma közben megváltozott (most ${recipients.length}). Nézd meg újra az előnézetet, és erősítsd meg a küldést.`, 409, 'COUNT_CHANGED', { recipientCount: recipients.length });
    }
    const claimed = await store.claimCampaign(id, ['draft'], { admin, attested: c.kind === 'system', recipientCount: recipients.length });
    if (!claimed) throw new EmailCenterError('Ezt a kampányt már elküldték.', 409, 'ALREADY_PROCESSED');
    await store.addDeliveries(id, recipients);
    this.log(`[email] küldés indul: kampány=${id} kategória=${c.kind} címzett=${recipients.length} admin=${admin}`);
    return { campaign: claimed, job: this.run(claimed, ['pending']) };
  }

  /** sikertelen (és egy megszakadt futásból függőben maradt) címzettek újraküldése – a már elküldötteké soha */
  async retry(id: string): Promise<{ campaign: CampaignView; job: Promise<void> }> {
    const { store } = this.requireSending();
    if (this.running.has(id)) throw new EmailCenterError('A kampány küldése éppen folyamatban van.', 409, 'IN_PROGRESS');
    const claimed = await store.claimCampaign(id, ['partial', 'failed', 'sending']);
    if (!claimed) throw new EmailCenterError('Csak részben sikertelen vagy megszakadt kampány küldhető újra.', 409, 'NOT_RETRYABLE');
    this.log(`[email] újrapróbálás: kampány=${id}`);
    return { campaign: claimed, job: this.run(claimed, ['pending', 'failed']) };
  }

  private async sendWithRetry(sender: EmailSender, emails: { to: string; subject: string; html: string; headers?: Record<string, string> }[], key: string) {
    for (let attempt = 0; ; attempt++) {
      try { return await sender.sendBatch(emails, key); } catch (e) {
        const retryable = e instanceof EmailSendError && e.retryable;
        if (!retryable || attempt >= SEND_RETRIES) throw e;
        await this.sleep(Math.min((e as EmailSendError).retryAfterMs ?? 1000 * 2 ** attempt, 30_000));
      }
    }
  }

  private async run(c: CampaignView, statuses: ('pending' | 'failed')[]): Promise<void> {
    if (this.running.has(c.id)) return;
    const { store, sender, secret, base } = this.requireSending();
    this.running.add(c.id);
    try {
      // a futás elején rögzített lista: minden címzett legfeljebb egyszer kerül sorra ebben a futásban
      const todo = await store.deliveriesToSend(c.id, statuses, MAX_ATTEMPTS, this.d.config.maxRecipients + BATCH_SIZE);
      for (let i = 0; i < todo.length; i += BATCH_SIZE) {
        let batch: Delivery[] = todo.slice(i, i + BATCH_SIZE);
        if (c.kind === 'marketing') {
          // a leiratkozás azonnal érvényes: kötegenként újraellenőrizzük a hozzájárulást
          const ok = await store.consentedAmong(batch.map((d) => d.userId));
          const gone = batch.filter((d) => !ok.has(d.userId));
          if (gone.length) await store.updateDeliveries(gone.map((d) => d.id), { status: 'skipped', lastError: 'nincs marketing-hozzájárulás (leiratkozott)' });
          batch = batch.filter((d) => ok.has(d.userId));
        }
        if (!batch.length) continue;
        for (const att of new Set(batch.map((d) => d.attempts))) {
          await store.updateDeliveries(batch.filter((d) => d.attempts === att).map((d) => d.id), { status: 'sending', attempts: att + 1 });
        }
        const emails = batch.map((d) => {
          const unsub = c.kind === 'marketing' ? this.unsubscribeUrl(base, secret, d.userId) : null;
          return {
            to: d.email, subject: c.subject, html: renderEmail(c.kind, c.subject, c.html, unsub),
            ...(unsub ? { headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
          };
        });
        // ugyanaz a köteg ugyanazzal a kulccsal megy újra (24 órán belül a Resend nem küldi ki kétszer)
        const key = `tippstats-${c.id}-${createHash('sha256').update(batch.map((d) => d.id).sort().join(',')).digest('hex').slice(0, 32)}`;
        try {
          const ids = await this.sendWithRetry(sender, emails, key);
          const sentAt = new Date().toISOString();
          for (const [k, d] of batch.entries()) await store.updateDeliveries([d.id], { status: 'sent', providerMessageId: ids[k] ?? null, lastError: null, sentAt });
        } catch (e) {
          const msg = (e as Error).message.slice(0, 500);
          await store.updateDeliveries(batch.map((d) => d.id), { status: 'failed', lastError: msg });
          console.error(`[email] köteg sikertelen: kampány=${c.id} címzett=${batch.length}: ${msg}`);
        }
        if (i + BATCH_SIZE < todo.length) await this.sleep(BATCH_INTERVAL_MS);
      }
    } catch (e) {
      console.error(`[email] küldés megszakadt: kampány=${c.id}: ${(e as Error).message}`);
    } finally {
      try {
        const s = await store.deliveryStats(c.id);
        await store.finishCampaign(c.id, finalStatus(s), s);
        this.log(`[email] küldés vége: kampány=${c.id} elküldve=${s.sent} sikertelen=${s.failed} kihagyva=${s.skipped}`);
      } catch (e) { console.error(`[email] a kampány lezárása sikertelen: ${(e as Error).message}`); }
      this.running.delete(c.id);
    }
  }
}

/** sikertelen vagy bizonytalan kimenetű (megszakadt „sending”) címzett esetén nem „sent” */
export function finalStatus(s: DeliveryStats): CampaignStatus {
  if (s.failed + s.sending + s.pending === 0) return 'sent';
  return s.sent > 0 ? 'partial' : 'failed';
}

// ---------------------------------------------------------------------------
// Útvonalak
// ---------------------------------------------------------------------------

function fail(res: Response, e: unknown, op: string) {
  if (e instanceof EmailCenterError) return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
  console.error(`[email] ${op}:`, (e as Error).message);
  return res.status(500).json({ error: 'A művelet nem sikerült.', code: 'EMAIL_FAILED' });
}

/** egyszerű, IP-nkénti korlát a leiratkozó végpontra (a globális /api korláton felül) */
function unsubscribeLimiter(max = 30, windowMs = 10 * 60_000) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request): boolean => {
    const ip = req.ip ?? 'ismeretlen';
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now > h.reset) { hits.set(ip, { n: 1, reset: now + windowMs }); if (hits.size > 10_000) hits.clear(); return true; }
    return ++h.n <= max;
  };
}

const page = (res: Response, status: number, title: string, body: string) => {
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex',
    // a token az URL-ben van: más oldalra nem szivároghat (Referer), a lap nem keretezhető
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  }).send(`<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} – TippStats</title>`
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:#f1f3f6;color:#1d2539;font-family:Arial,sans-serif}'
    + 'main{max-width:420px;background:#fff;border-radius:16px;padding:28px;text-align:center}h1{font-size:20px;margin:0 0 10px}p{color:#606b84;line-height:1.5}'
    + 'button{font:inherit;font-weight:700;color:#fff;background:#4a69f4;border:0;border-radius:12px;padding:12px 22px;cursor:pointer}</style></head>'
    + `<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`);
};

/** nyilvános és felhasználói végpontok: /api/email */
export function emailRouter(svc: EmailCenterService): Router {
  const r = Router();
  const allow = unsubscribeLimiter();

  r.get('/consent', requireAuthenticated, async (_req, res) => {
    const plan = planOf(res);
    if (!svc.store || !plan.enforced || !plan.user) return res.status(503).json({ error: 'Ezen a példányon nem érhető el.', code: 'EMAIL_UNAVAILABLE' });
    try { res.json({ ...(await svc.store.getConsent(plan.user.id)), text: CONSENT_TEXT, textVersion: CONSENT_TEXT_VERSION }); } catch (e) { fail(res, e, 'hozzájárulás'); }
  });

  r.put('/consent', requireAuthenticated, async (req, res) => {
    const plan = planOf(res);
    if (!svc.store || !plan.enforced || !plan.user) return res.status(503).json({ error: 'Ezen a példányon nem érhető el.', code: 'EMAIL_UNAVAILABLE' });
    if (typeof req.body?.consented !== 'boolean') return res.status(400).json({ error: 'Hiányzó beállítás.', code: 'BAD_REQUEST' });
    try {
      const out = await svc.store.setConsent(plan.user.id, req.body.consented, 'profile');
      res.json({ ...out.consent, changed: out.changed, text: CONSENT_TEXT, textVersion: CONSENT_TEXT_VERSION });
    } catch (e) { fail(res, e, 'hozzájárulás mentése'); }
  });

  const invalid = (res: Response) => page(res, 400, 'Érvénytelen leiratkozó link', '<p>A link érvénytelen vagy hiányos. A marketing emaileket a TippStats profilodban is kikapcsolhatod.</p>');

  // a GET semmit nem módosít (a levelezők és biztonsági szkennerek előre megnyithatják a linket)
  r.get('/unsubscribe', (req, res) => {
    if (!allow(req)) return page(res, 429, 'Túl sok kérés', '<p>Próbáld újra néhány perc múlva.</p>');
    const secret = svc.unsubscribeSecret;
    if (!secret || !svc.store) return page(res, 503, 'Átmenetileg nem érhető el', '<p>Próbáld újra később, vagy kapcsold ki a marketing emaileket a TippStats profilodban.</p>');
    if (!verifyUnsubscribeToken(secret, req.query.t)) return invalid(res);
    const t = encodeURIComponent(String(req.query.t));
    return page(res, 200, 'Leiratkozás a marketing emailekről', `<p>A leiratkozás után nem kapsz több marketing emailt a TippStatstól. A fiókoddal kapcsolatos szolgáltatási üzenetek továbbra is megérkeznek.</p><form method="post" action="?t=${t}"><button type="submit">Leiratkozom</button></form>`);
  });

  r.post('/unsubscribe', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
    if (!allow(req)) return page(res, 429, 'Túl sok kérés', '<p>Próbáld újra néhány perc múlva.</p>');
    const secret = svc.unsubscribeSecret;
    if (!secret || !svc.store) return page(res, 503, 'Átmenetileg nem érhető el', '<p>Próbáld újra később, vagy kapcsold ki a marketing emaileket a TippStats profilodban.</p>');
    const userId = verifyUnsubscribeToken(secret, req.query.t);
    if (!userId) return invalid(res);
    try {
      // RFC 8058: a levelező „List-Unsubscribe=One-Click” törzzsel küldi
      const oneClick = req.body?.['List-Unsubscribe'] === 'One-Click';
      await svc.store.setConsent(userId, false, oneClick ? 'one_click' : 'unsubscribe_link');
      return page(res, 200, 'Sikeresen leiratkoztál', '<p>Mostantól nem kapsz marketing emailt a TippStatstól. Ha meggondolod magad, a profilodban újra bekapcsolhatod.</p>');
    } catch (e) {
      console.error('[email] leiratkozás:', (e as Error).message);
      return page(res, 500, 'A leiratkozás nem sikerült', '<p>Próbáld újra később, vagy kapcsold ki a marketing emaileket a TippStats profilodban.</p>');
    }
  });

  return r;
}

/** admin végpontok: /api/admin/email – a mount helyén requireAdmin védi mindet */
export function adminEmailRouter(svc: EmailCenterService): Router {
  const r = Router();
  const admin = (res: Response) => planOf(res).user?.email ?? 'local-admin';
  const UUID = /^[0-9a-fA-F-]{36}$/;
  const withId = (fn: (id: string, req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    if (!UUID.test(String(req.params.id))) return res.status(400).json({ error: 'Érvénytelen azonosító.', code: 'BAD_REQUEST' });
    try { await fn(String(req.params.id), req, res); } catch (e) { fail(res, e, req.path); }
  };

  r.get('/status', async (_req, res) => {
    try { res.json(await svc.status()); } catch (e) { fail(res, e, 'státusz'); }
  });

  r.get('/campaigns', async (_req, res) => {
    try {
      if (!svc.store) throw new EmailCenterError('Az Email Center ezen a példányon nem érhető el (nincs adatbázis).', 503, 'EMAIL_UNAVAILABLE');
      res.json(await svc.store.listCampaigns(100));
    } catch (e) { fail(res, e, 'kampánylista'); }
  });

  r.post('/campaigns', async (req, res) => {
    try { res.status(201).json(await svc.create(admin(res), req.body)); } catch (e) { fail(res, e, 'kampány létrehozása'); }
  });

  r.put('/campaigns/:id', withId(async (id, req, res) => res.json(await svc.update(id, req.body))));

  r.get('/campaigns/:id', withId(async (id, _req, res) => {
    const c = await svc.store?.getCampaign(id);
    if (!c) return res.status(404).json({ error: 'A kampány nem található.', code: 'NOT_FOUND' });
    res.json({ campaign: c, stats: await svc.store!.deliveryStats(id) });
  }));

  r.post('/campaigns/:id/preview', withId(async (id, _req, res) => res.json(await svc.preview(id))));
  r.post('/campaigns/:id/test', withId(async (id, _req, res) => res.json(await svc.sendTest(id, planOf(res).user?.email))));

  r.post('/campaigns/:id/send', withId(async (id, req, res) => {
    const { campaign, job } = await svc.confirmSend(id, admin(res), req.body);
    void job; // a küldés a háttérben fut; az állapot a kampánylistában és a statisztikában követhető
    res.status(202).json({ campaign });
  }));

  r.post('/campaigns/:id/retry', withId(async (id, _req, res) => {
    const { campaign, job } = await svc.retry(id);
    void job;
    res.status(202).json({ campaign });
  }));

  return r;
}
