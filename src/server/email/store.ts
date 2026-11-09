/**
 * Email Center tároló: marketing-hozzájárulás (0025 set_marketing_consent), címzettek, kampányok, küldési napló.
 *
 *  - PostgresEmailStore : éles; Supabase service_role (a címzettek és címeik KIZÁRÓLAG itt, a szerveren olvashatók)
 *  - MemoryEmailStore   : tesztekhez; ugyanazokat a szabályokat követi (a 0025 SQL-t a PG-teszt ellenőrzi)
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CONSENT_TEXT_VERSION, type CampaignStatus, type CampaignView, type ConsentSource, type DeliveryStats, type DeliveryStatus,
  type EmailAudience, type EmailKind, type MarketingConsentView,
} from '../../shared/email';

export interface Recipient { userId: string; email: string; pro: boolean; consented: boolean }
export interface Delivery { id: string; campaignId: string; userId: string; email: string; status: DeliveryStatus; attempts: number; lastError: string | null; providerMessageId: string | null }
export interface NewCampaign { kind: EmailKind; audience: EmailAudience; subject: string; html: string; createdBy: string }
export type DraftPatch = Partial<Pick<NewCampaign, 'kind' | 'audience' | 'subject' | 'html'>>;
export interface DeliveryPatch { status: DeliveryStatus; attempts?: number; lastError?: string | null; providerMessageId?: string | null; sentAt?: string | null }

export interface EmailStore {
  getConsent(userId: string): Promise<MarketingConsentView>;
  /** változatlan állapotnál no-op (changed: false); a napló és az állapot egy tranzakcióban */
  setConsent(userId: string, granted: boolean, source: ConsentSource): Promise<{ changed: boolean; consent: MarketingConsentView }>;
  /** a marketinghez jelenleg hozzájáruló felhasználók száma */
  countConsented(): Promise<number>;
  /** a MEGERŐSÍTETT email-című fiókok címe, PRO-állapota és marketing-hozzájárulása (csak szerveroldalon) */
  listRecipients(): Promise<Recipient[]>;
  /** a megadott fiókok közül a JELENLEG hozzájárulók (küldés előtti újraellenőrzéshez) */
  consentedAmong(userIds: string[]): Promise<Set<string>>;
  createCampaign(c: NewCampaign): Promise<CampaignView>;
  /** csak piszkozat módosítható; null, ha nincs ilyen piszkozat */
  updateDraft(id: string, patch: DraftPatch): Promise<CampaignView | null>;
  getCampaign(id: string): Promise<CampaignView | null>;
  listCampaigns(limit: number): Promise<CampaignView[]>;
  /** feltételes állapotváltás „sending”-re (csak a `from` állapotokból) – egyszerre egy küldés; null, ha nem sikerült */
  claimCampaign(id: string, from: CampaignStatus[], confirm?: { admin: string; attested: boolean; recipientCount: number }): Promise<CampaignView | null>;
  finishCampaign(id: string, status: CampaignStatus, stats: DeliveryStats): Promise<void>;
  /** címzettek felvétele a küldési naplóba; a már szereplő fiók / cím kimarad (duplikáció ellen) */
  addDeliveries(campaignId: string, recipients: Recipient[]): Promise<number>;
  deliveriesToSend(campaignId: string, statuses: DeliveryStatus[], maxAttempts: number, limit: number): Promise<Delivery[]>;
  updateDeliveries(ids: string[], patch: DeliveryPatch): Promise<void>;
  deliveryStats(campaignId: string): Promise<DeliveryStats>;
}

type Row = Record<string, any>;

/**
 * Adatbázis-hiba a tárolóból: a lépés neve és a Postgres / PostgREST hibakód (pl. 42501, PGRST205) biztonságosan
 * továbbadható a felületnek; a nyers üzenet és a részletek (amelyekben adat is lehet) CSAK a szervernaplóba kerülnek.
 */
export class EmailStoreError extends Error {
  constructor(public op: string, public dbCode: string | null, public detail: string) { super(`[email] ${op}: ${detail}`); }
}
const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());
const NO_CONSENT: MarketingConsentView = { consented: false, consentedAt: null, consentSource: null, revokedAt: null };
const isPro = (status: unknown, end: unknown, now = Date.now()) => status === 'pro' && (end == null || new Date(String(end)).getTime() > now);

const toConsent = (r: Row | null | undefined): MarketingConsentView => (r ? {
  consented: !!r.consented, consentedAt: iso(r.consented_at), consentSource: r.consent_source ?? null, revokedAt: iso(r.revoked_at),
} : { ...NO_CONSENT });
const toCampaign = (r: Row): CampaignView => ({
  id: String(r.id), kind: r.kind, audience: r.audience, subject: String(r.subject), html: String(r.html), status: r.status,
  createdBy: String(r.created_by), createdAt: iso(r.created_at)!, confirmedAt: iso(r.confirmed_at), finishedAt: iso(r.finished_at),
  recipientCount: Number(r.recipient_count ?? 0), sentCount: Number(r.sent_count ?? 0), failedCount: Number(r.failed_count ?? 0),
  skippedCount: Number(r.skipped_count ?? 0), systemAttested: !!r.system_attested,
});
const toDelivery = (r: Row): Delivery => ({
  id: String(r.id), campaignId: String(r.campaign_id), userId: String(r.user_id), email: String(r.email), status: r.status,
  attempts: Number(r.attempts ?? 0), lastError: r.last_error ?? null, providerMessageId: r.provider_message_id ?? null,
});
const PAGE = 1000;

export class PostgresEmailStore implements EmailStore {
  constructor(private db: SupabaseClient) {}

  private fail(op: string, error: { message: string; code?: string; details?: string | null; hint?: string | null } | null): void {
    if (!error) return;
    const detail = [error.message, error.details, error.hint].filter(Boolean).join(' | ');
    throw new EmailStoreError(op, typeof error.code === 'string' && error.code ? error.code : null, detail);
  }

  /** lapozott olvasás (a PostgREST soronként legfeljebb ~1000 sort ad egy kérésben) */
  private async all(table: string, columns: string, filter?: (q: any) => any): Promise<Row[]> {
    const out: Row[] = [];
    for (let from = 0; ; from += PAGE) {
      let q = this.db.from(table).select(columns);
      if (filter) q = filter(q);
      const { data, error } = await q.order(table === 'email_recipients' ? 'id' : 'user_id').range(from, from + PAGE - 1);
      this.fail(`${table} olvasás`, error);
      out.push(...((data ?? []) as Row[]));
      if ((data ?? []).length < PAGE) return out;
    }
  }

  async getConsent(userId: string): Promise<MarketingConsentView> {
    const { data, error } = await this.db.from('email_marketing_consents').select('*').eq('user_id', userId).maybeSingle();
    this.fail('getConsent', error);
    return toConsent(data);
  }

  async setConsent(userId: string, granted: boolean, source: ConsentSource): Promise<{ changed: boolean; consent: MarketingConsentView }> {
    const { data, error } = await this.db.rpc('set_marketing_consent', { p_user: userId, p_granted: granted, p_source: source, p_text_version: CONSENT_TEXT_VERSION });
    this.fail('setConsent', error);
    const r = (data ?? {}) as { changed?: boolean; state?: Row | null };
    return { changed: !!r.changed, consent: toConsent(r.state) };
  }

  async countConsented(): Promise<number> {
    const { count, error } = await this.db.from('email_marketing_consents').select('user_id', { count: 'exact', head: true }).eq('consented', true);
    this.fail('countConsented', error);
    return count ?? 0;
  }

  async listRecipients(): Promise<Recipient[]> {
    const [profiles, consents] = await Promise.all([
      // csak megerősített email-cím: idegen címmel regisztrált, meg nem erősített fiók nem kaphat levelet
      this.all('email_recipients', 'id, email, subscription_status, subscription_end', (q) => q.eq('email_confirmed', true)),
      this.all('email_marketing_consents', 'user_id', (q) => q.eq('consented', true)),
    ]);
    const yes = new Set(consents.map((c) => String(c.user_id)));
    const now = Date.now();
    return profiles.filter((p) => typeof p.email === 'string' && p.email)
      .map((p) => ({ userId: String(p.id), email: String(p.email), pro: isPro(p.subscription_status, p.subscription_end, now), consented: yes.has(String(p.id)) }));
  }

  async consentedAmong(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const { data, error } = await this.db.from('email_marketing_consents').select('user_id').eq('consented', true).in('user_id', userIds);
    this.fail('consentedAmong', error);
    return new Set((data ?? []).map((r: Row) => String(r.user_id)));
  }

  async createCampaign(c: NewCampaign): Promise<CampaignView> {
    const { data, error } = await this.db.from('email_campaigns')
      .insert({ kind: c.kind, audience: c.audience, subject: c.subject, html: c.html, created_by: c.createdBy }).select('id');
    this.fail('createCampaign', error);
    const created = await this.getCampaign(String((data ?? [])[0]?.id));
    if (!created) throw new Error('[email] a kampány nem olvasható vissza');
    return created;
  }

  async updateDraft(id: string, patch: DraftPatch): Promise<CampaignView | null> {
    const { data, error } = await this.db.from('email_campaigns')
      .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'draft').select('id');
    this.fail('updateDraft', error);
    return (data ?? []).length === 1 ? this.getCampaign(id) : null;
  }

  async getCampaign(id: string): Promise<CampaignView | null> {
    const { data, error } = await this.db.from('email_campaigns').select('*').eq('id', id).maybeSingle();
    this.fail('getCampaign', error);
    return data ? toCampaign(data) : null;
  }

  async listCampaigns(limit: number): Promise<CampaignView[]> {
    const { data, error } = await this.db.from('email_campaigns').select('*').order('created_at', { ascending: false }).limit(limit);
    this.fail('listCampaigns', error);
    return (data ?? []).map(toCampaign);
  }

  async claimCampaign(id: string, from: CampaignStatus[], confirm?: { admin: string; attested: boolean; recipientCount: number }): Promise<CampaignView | null> {
    const now = new Date().toISOString();
    const patch: Row = { status: 'sending', updated_at: now, finished_at: null };
    if (confirm) Object.assign(patch, { confirmed_by: confirm.admin, confirmed_at: now, system_attested: confirm.attested, recipient_count: confirm.recipientCount });
    const { data, error } = await this.db.from('email_campaigns').update(patch).eq('id', id).in('status', from).select('id');
    this.fail('claimCampaign', error);
    return (data ?? []).length === 1 ? this.getCampaign(id) : null;
  }

  async finishCampaign(id: string, status: CampaignStatus, s: DeliveryStats): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.db.from('email_campaigns').update({
      status, finished_at: now, updated_at: now, sent_count: s.sent, failed_count: s.failed, skipped_count: s.skipped,
    }).eq('id', id);
    this.fail('finishCampaign', error);
  }

  async addDeliveries(campaignId: string, recipients: Recipient[]): Promise<number> {
    let added = 0;
    for (let i = 0; i < recipients.length; i += 500) {
      const rows = recipients.slice(i, i + 500).map((r) => ({ campaign_id: campaignId, user_id: r.userId, email: r.email }));
      const { data, error } = await this.db.from('email_deliveries').upsert(rows, { onConflict: 'campaign_id,user_id', ignoreDuplicates: true }).select('id');
      this.fail('addDeliveries', error);
      added += (data ?? []).length;
    }
    return added;
  }

  async deliveriesToSend(campaignId: string, statuses: DeliveryStatus[], maxAttempts: number, limit: number): Promise<Delivery[]> {
    const { data, error } = await this.db.from('email_deliveries').select('*').eq('campaign_id', campaignId)
      .in('status', statuses).lt('attempts', maxAttempts).order('created_at').order('id').limit(limit);
    this.fail('deliveriesToSend', error);
    return (data ?? []).map(toDelivery);
  }

  async updateDeliveries(ids: string[], p: DeliveryPatch): Promise<void> {
    if (!ids.length) return;
    const row: Row = { status: p.status, updated_at: new Date().toISOString() };
    if (p.attempts !== undefined) row.attempts = p.attempts;
    if (p.lastError !== undefined) row.last_error = p.lastError == null ? null : p.lastError.slice(0, 500);
    if (p.providerMessageId !== undefined) row.provider_message_id = p.providerMessageId;
    if (p.sentAt !== undefined) row.sent_at = p.sentAt;
    const { error } = await this.db.from('email_deliveries').update(row).in('id', ids);
    this.fail('updateDeliveries', error);
  }

  async deliveryStats(campaignId: string): Promise<DeliveryStats> {
    const out: DeliveryStats = { pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    await Promise.all((Object.keys(out) as DeliveryStatus[]).map(async (s) => {
      const { count, error } = await this.db.from('email_deliveries').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', s);
      this.fail('deliveryStats', error);
      out[s] = count ?? 0;
    }));
    return out;
  }
}

/** Memóriabeli tároló (tesztekhez). A 0025 szabályait követi: piszkozat-zár, egyszeri címzett, no-op hozzájárulás. */
export class MemoryEmailStore implements EmailStore {
  readonly consents = new Map<string, MarketingConsentView>();
  readonly consentEvents: { userId: string; granted: boolean; source: ConsentSource; textVersion: string; at: string }[] = [];
  readonly campaigns = new Map<string, CampaignView>();
  readonly deliveries = new Map<string, Delivery & { order: number }>();
  private seq = 0;
  /** `confirmed: false` = meg nem erősített email-cím (alapból megerősített) */
  constructor(public users: { userId: string; email: string | null; status: string; end: string | null; confirmed?: boolean }[] = [], private now = () => new Date()) {}

  async getConsent(userId: string) { return { ...(this.consents.get(userId) ?? NO_CONSENT) }; }

  async setConsent(userId: string, granted: boolean, source: ConsentSource) {
    // mint a 0025 set_marketing_consent(): itt csak a profilban adható hozzájárulás; a regisztrációs a DB-triggeré
    if (granted && source !== 'profile') throw new Error('Hozzájárulást csak a profilban lehet adni.');
    if (source === 'registration') throw new Error('A regisztrációs hozzájárulást csak a regisztráció rögzítheti.');
    const cur = this.consents.get(userId);
    if ((cur?.consented ?? false) === granted) return { changed: false, consent: { ...(cur ?? NO_CONSENT) } };
    const at = this.now().toISOString();
    this.consentEvents.push({ userId, granted, source, textVersion: CONSENT_TEXT_VERSION, at });
    const next: MarketingConsentView = granted
      ? { consented: true, consentedAt: at, consentSource: source, revokedAt: cur?.revokedAt ?? null }
      : { consented: false, consentedAt: cur?.consentedAt ?? null, consentSource: cur?.consentSource ?? null, revokedAt: at };
    this.consents.set(userId, next);
    return { changed: true, consent: { ...next } };
  }

  async listRecipients(): Promise<Recipient[]> {
    const now = this.now().getTime();
    return this.users.filter((u) => u.email && u.confirmed !== false).map((u) => ({ userId: u.userId, email: u.email!, pro: isPro(u.status, u.end, now), consented: !!this.consents.get(u.userId)?.consented }));
  }

  async countConsented() { return [...this.consents.values()].filter((c) => c.consented).length; }

  async consentedAmong(userIds: string[]) { return new Set(userIds.filter((id) => this.consents.get(id)?.consented)); }

  async createCampaign(c: NewCampaign): Promise<CampaignView> {
    const v: CampaignView = {
      id: randomUUID(), ...c, status: 'draft', createdAt: this.now().toISOString(), confirmedAt: null, finishedAt: null,
      recipientCount: 0, sentCount: 0, failedCount: 0, skippedCount: 0, systemAttested: false,
    };
    this.campaigns.set(v.id, v);
    return { ...v };
  }

  async updateDraft(id: string, patch: DraftPatch) {
    const c = this.campaigns.get(id);
    if (!c || c.status !== 'draft') return null;
    Object.assign(c, patch);
    return { ...c };
  }

  async getCampaign(id: string) { const c = this.campaigns.get(id); return c ? { ...c } : null; }

  async listCampaigns(limit: number) {
    return [...this.campaigns.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((c) => ({ ...c }));
  }

  async claimCampaign(id: string, from: CampaignStatus[], confirm?: { admin: string; attested: boolean; recipientCount: number }) {
    const c = this.campaigns.get(id);
    if (!c || !from.includes(c.status)) return null;
    c.status = 'sending'; c.finishedAt = null;
    if (confirm) Object.assign(c, { confirmedAt: this.now().toISOString(), systemAttested: confirm.attested, recipientCount: confirm.recipientCount });
    return { ...c };
  }

  async finishCampaign(id: string, status: CampaignStatus, s: DeliveryStats) {
    const c = this.campaigns.get(id);
    if (c) Object.assign(c, { status, finishedAt: this.now().toISOString(), sentCount: s.sent, failedCount: s.failed, skippedCount: s.skipped });
  }

  async addDeliveries(campaignId: string, recipients: Recipient[]) {
    let added = 0;
    const mine = () => [...this.deliveries.values()].filter((d) => d.campaignId === campaignId);
    for (const r of recipients) {
      if (mine().some((d) => d.userId === r.userId || d.email.toLowerCase() === r.email.toLowerCase())) continue;
      const d = { id: randomUUID(), campaignId, userId: r.userId, email: r.email, status: 'pending' as DeliveryStatus, attempts: 0, lastError: null, providerMessageId: null, order: this.seq++ };
      this.deliveries.set(d.id, d);
      added++;
    }
    return added;
  }

  async deliveriesToSend(campaignId: string, statuses: DeliveryStatus[], maxAttempts: number, limit: number) {
    return [...this.deliveries.values()].filter((d) => d.campaignId === campaignId && statuses.includes(d.status) && d.attempts < maxAttempts)
      .sort((a, b) => a.order - b.order).slice(0, limit).map(({ order: _o, ...d }) => d);
  }

  async updateDeliveries(ids: string[], p: DeliveryPatch) {
    for (const id of ids) {
      const d = this.deliveries.get(id);
      if (!d) continue;
      d.status = p.status;
      if (p.attempts !== undefined) d.attempts = p.attempts;
      if (p.lastError !== undefined) d.lastError = p.lastError;
      if (p.providerMessageId !== undefined) d.providerMessageId = p.providerMessageId;
    }
  }

  async deliveryStats(campaignId: string) {
    const out: DeliveryStats = { pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const d of this.deliveries.values()) if (d.campaignId === campaignId) out[d.status]++;
    return out;
  }
}
