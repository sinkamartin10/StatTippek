/**
 * PRO előfizetés kézi fizetéssel (banki átutalás / Revolut).
 *
 *  GET  /api/pro-payments                    ár + kedvezményezett adatai; bejelentkezve a saját kérelmek
 *  POST /api/pro-payments                    „Befizetés elküldve ellenőrzésre” → FÜGGŐ kérelem (PRO-t NEM aktivál)
 *  GET  /api/admin/pro-payments?status=      kérelmek listája (csak admin)
 *  POST /api/admin/pro-payments/:id/approve  jóváhagyás + PRO aktiválás egy tranzakcióban (csak admin)
 *  POST /api/admin/pro-payments/:id/reject   elutasítás (csak admin)
 *
 * Biztonság:
 *  - a kérelmezőt KIZÁRÓLAG a hitelesített token azonosítja (res.locals.plan.user);
 *    a törzsből csak a fizetési mód olvasódik ki – userId, összeg, státusz, PRO soha,
 *  - az összeget és az időtartamot a szerver írja be (currentProPrice), nem a kliens,
 *  - a kérelem elküldése nem változtat a jogosultságon; a PRO-t az admin jóváhagyása
 *    aktiválja, ugyanúgy, mint eddig a Stripe webhook: a profiles két előfizetési
 *    mezőjének szerveroldali (service_role) írásával, majd a jogosultság-cache ürítésével,
 *  - ugyanaz a kérelem nem dolgozható fel kétszer (zárolt, feltételes állapotváltás),
 *  - élő Stripe-előfizetésű fiókot kézzel nem aktiválunk (stripe_conflict).
 */
import { Router, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { invalidateEntitlement, planOf, requireAuthenticated } from './entitlement';
import {
  PAYEE, PAYMENT_METHODS, type AdminPaymentRequestView, type BillingInterval, type PaymentMethod,
  type PaymentRequestStatus, type PaymentRequestView, type ProPaymentInfo, type ProPrice,
} from '../../shared/manualPayment';

// ---------------------------------------------------------------------------
// Tároló
// ---------------------------------------------------------------------------

export interface StoredRequest extends PaymentRequestView {
  userId: string;
  email: string;
  decidedBy: string | null;
}

/** A döntéshez szükséges profilállapot (a profiles táblából). */
export interface ProfileState { status: string; subscriptionEnd: string | null; stripeSubscriptionId: string | null }

export interface NewRequest {
  userId: string; email: string; method: PaymentMethod; price: ProPrice; reference: string;
}

export type ApproveResult =
  | { outcome: 'approved'; request: StoredRequest }
  | { outcome: 'already_processed' | 'stripe_conflict' | 'profile_missing'; request: StoredRequest }
  | { outcome: 'not_found' };

export type RejectResult =
  | { outcome: 'rejected'; request: StoredRequest }
  | { outcome: 'already_processed'; request: StoredRequest }
  | { outcome: 'not_found' };

export interface ManualPaymentStore {
  /** Új függő kérelem; ha már van függő kérelme, AZT adja vissza (created: false) – nem hoz létre másodikat. */
  createPending(r: NewRequest): Promise<{ request: StoredRequest; created: boolean }>;
  listForUser(userId: string, limit: number): Promise<StoredRequest[]>;
  list(status: PaymentRequestStatus | null, limit: number): Promise<StoredRequest[]>;
  profileStates(userIds: string[]): Promise<Map<string, ProfileState>>;
  /** Jóváhagyás + PRO aktiválás atomikusan (Postgres: approve_pro_payment_request). */
  approve(id: string, adminId: string): Promise<ApproveResult>;
  /** Elutasítás: csak függő kérelem, egyetlen feltételes írással. */
  reject(id: string, adminId: string, note: string | null): Promise<RejectResult>;
}

type Row = Record<string, any>;
const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());

function toRequest(r: Row): StoredRequest {
  return {
    id: String(r.id), userId: String(r.user_id), email: String(r.email), method: r.method as PaymentMethod,
    amount: Number(r.amount), currency: String(r.currency), interval: r.billing_interval as BillingInterval,
    reference: String(r.reference), status: r.status as PaymentRequestStatus, createdAt: iso(r.created_at)!,
    decidedAt: iso(r.decided_at), decidedBy: r.decided_by ?? null, decisionNote: r.decision_note ?? null,
    activatedUntil: iso(r.activated_until),
  };
}

/** Éles tároló: Supabase (service_role). A jóváhagyás a 0020 SQL-függvényével, egy tranzakcióban. */
export class PostgresManualPaymentStore implements ManualPaymentStore {
  constructor(private db: SupabaseClient) {}

  private fail(op: string, error: { message: string } | null): void {
    if (error) throw new Error(`[pro-payments] ${op}: ${error.message}`);
  }

  async createPending(r: NewRequest): Promise<{ request: StoredRequest; created: boolean }> {
    const { data, error } = await this.db.from('pro_payment_requests').insert({
      user_id: r.userId, email: r.email, method: r.method, amount: r.price.amount, currency: r.price.currency,
      billing_interval: r.price.interval, reference: r.reference,
    }).select('id');
    // Ütközés az egyedi részindexen (23505: már van függő kérelme) → a meglévőt adjuk vissza.
    // A hibakódra nem hagyatkozunk: bármely beszúrási hibánál előbb a függő kérelmet keressük.
    if (error) {
      const pending = (await this.listForUser(r.userId, 20)).find((x) => x.status === 'pending');
      if (pending) return { request: pending, created: false };
    }
    this.fail('createPending', error);
    return { request: await this.byId(String((data ?? [])[0]?.id)), created: true };
  }

  private async byId(id: string): Promise<StoredRequest> {
    const { data, error } = await this.db.from('pro_payment_requests').select('*').eq('id', id).maybeSingle();
    this.fail('byId', error);
    if (!data) throw new Error(`[pro-payments] a kérelem nem olvasható vissza: ${id}`);
    return toRequest(data);
  }

  async listForUser(userId: string, limit: number): Promise<StoredRequest[]> {
    const { data, error } = await this.db.from('pro_payment_requests').select('*')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
    this.fail('listForUser', error);
    return (data ?? []).map(toRequest);
  }

  async list(status: PaymentRequestStatus | null, limit: number): Promise<StoredRequest[]> {
    let q = this.db.from('pro_payment_requests').select('*');
    if (status) q = q.eq('status', status);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
    this.fail('list', error);
    return (data ?? []).map(toRequest);
  }

  async profileStates(userIds: string[]): Promise<Map<string, ProfileState>> {
    const out = new Map<string, ProfileState>();
    if (!userIds.length) return out;
    const { data, error } = await this.db.from('profiles')
      .select('id, subscription_status, subscription_end, stripe_subscription_id').in('id', userIds);
    this.fail('profileStates', error);
    for (const p of (data ?? []) as Row[]) {
      out.set(String(p.id), { status: String(p.subscription_status), subscriptionEnd: iso(p.subscription_end), stripeSubscriptionId: p.stripe_subscription_id ?? null });
    }
    return out;
  }

  async approve(id: string, adminId: string): Promise<ApproveResult> {
    const { data, error } = await this.db.rpc('approve_pro_payment_request', { p_request_id: id, p_admin: adminId });
    this.fail('approve', error);
    const r = (data ?? {}) as { outcome?: string; request?: Row };
    if (r.outcome === 'not_found') return { outcome: 'not_found' };
    if ((r.outcome === 'approved' || r.outcome === 'already_processed' || r.outcome === 'stripe_conflict' || r.outcome === 'profile_missing') && r.request) {
      return { outcome: r.outcome, request: toRequest(r.request) };
    }
    throw new Error(`[pro-payments] approve: váratlan válasz (${JSON.stringify(data)})`);
  }

  async reject(id: string, adminId: string, note: string | null): Promise<RejectResult> {
    const { data, error } = await this.db.from('pro_payment_requests')
      .update({ status: 'rejected', decided_at: new Date().toISOString(), decided_by: adminId, decision_note: note })
      .eq('id', id).eq('status', 'pending').select('id');
    this.fail('reject', error);
    if ((data ?? []).length === 1) return { outcome: 'rejected', request: await this.byId(id) };
    const { data: cur, error: e2 } = await this.db.from('pro_payment_requests').select('*').eq('id', id).maybeSingle();
    this.fail('reject (olvasás)', e2);
    return cur ? { outcome: 'already_processed', request: toRequest(cur) } : { outcome: 'not_found' };
  }
}

/**
 * Memóriabeli tároló (tesztekhez / Supabase nélküli futtatáshoz). Ugyanazokat a
 * szabályokat követi, mint a 0020 SQL-függvény – azt a PG-teszt külön ellenőrzi.
 */
export class MemoryManualPaymentStore implements ManualPaymentStore {
  readonly requests = new Map<string, StoredRequest>();
  constructor(public profiles = new Map<string, ProfileState>(), private now = () => new Date()) {}

  async createPending(r: NewRequest): Promise<{ request: StoredRequest; created: boolean }> {
    const pending = [...this.requests.values()].find((x) => x.userId === r.userId && x.status === 'pending');
    if (pending) return { request: { ...pending }, created: false };
    const req: StoredRequest = {
      id: randomUUID(), userId: r.userId, email: r.email, method: r.method, amount: r.price.amount, currency: r.price.currency,
      interval: r.price.interval, reference: r.reference, status: 'pending', createdAt: this.now().toISOString(),
      decidedAt: null, decidedBy: null, decisionNote: null, activatedUntil: null,
    };
    this.requests.set(req.id, req);
    return { request: { ...req }, created: true };
  }

  async listForUser(userId: string, limit: number): Promise<StoredRequest[]> {
    return [...this.requests.values()].filter((x) => x.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((x) => ({ ...x }));
  }

  async list(status: PaymentRequestStatus | null, limit: number): Promise<StoredRequest[]> {
    return [...this.requests.values()].filter((x) => !status || x.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((x) => ({ ...x }));
  }

  async profileStates(userIds: string[]): Promise<Map<string, ProfileState>> {
    return new Map(userIds.filter((id) => this.profiles.has(id)).map((id) => [id, { ...this.profiles.get(id)! }]));
  }

  async approve(id: string, adminId: string): Promise<ApproveResult> {
    const r = this.requests.get(id);
    if (!r) return { outcome: 'not_found' };
    if (r.status !== 'pending') return { outcome: 'already_processed', request: { ...r } };
    const p = this.profiles.get(r.userId);
    if (!p) return { outcome: 'profile_missing', request: { ...r } };
    const now = this.now();
    const live = (end: string | null) => end == null || new Date(end).getTime() > now.getTime();
    if (p.stripeSubscriptionId && (p.status === 'past_due' || (p.status === 'pro' && live(p.subscriptionEnd)))) {
      return { outcome: 'stripe_conflict', request: { ...r } };
    }
    let end: string | null = null;
    if (!(p.status === 'pro' && p.subscriptionEnd == null)) {
      const base = new Date(p.status === 'pro' && live(p.subscriptionEnd) ? p.subscriptionEnd! : now.toISOString());
      if (r.interval === 'year') base.setUTCFullYear(base.getUTCFullYear() + 1); else base.setUTCMonth(base.getUTCMonth() + 1);
      end = base.toISOString();
      this.profiles.set(r.userId, { ...p, status: 'pro', subscriptionEnd: end });
    }
    Object.assign(r, { status: 'approved', decidedAt: now.toISOString(), decidedBy: adminId, activatedUntil: end });
    return { outcome: 'approved', request: { ...r } };
  }

  async reject(id: string, adminId: string, note: string | null): Promise<RejectResult> {
    const r = this.requests.get(id);
    if (!r) return { outcome: 'not_found' };
    if (r.status !== 'pending') return { outcome: 'already_processed', request: { ...r } };
    Object.assign(r, { status: 'rejected', decidedAt: this.now().toISOString(), decidedBy: adminId, decisionNote: note });
    return { outcome: 'rejected', request: { ...r } };
  }
}

// ---------------------------------------------------------------------------
// Útvonalak
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-fA-F-]{36}$/;
const STATUSES: PaymentRequestStatus[] = ['pending', 'approved', 'rejected'];
const LIST_LIMIT = 200;

/** Felhasználói nézet: az admin-mezők (decidedBy, userId) nélkül. */
const toView = ({ userId: _u, email: _e, decidedBy: _d, ...v }: StoredRequest): PaymentRequestView => v;

/** Élő Stripe-előfizetés: a Stripe kezeli → kézi kérelem/aktiválás helyett ott kell rendezni. */
function stripeManaged(p: ProfileState | undefined, now = Date.now()): boolean {
  if (!p?.stripeSubscriptionId) return false;
  return p.status === 'past_due' || (p.status === 'pro' && (p.subscriptionEnd == null || new Date(p.subscriptionEnd).getTime() > now));
}

const unavailable = (res: Response) => res.status(503).json({
  error: 'A kézi PRO-igénylés ezen a példányon nem érhető el (nincs bejelentkezési rendszer / adatbázis).', code: 'PAYMENTS_UNAVAILABLE',
});

export function proPaymentsRouter(store: ManualPaymentStore | null, price: () => Promise<ProPrice>): Router {
  const r = Router();

  /** Fizetési adatok + (bejelentkezve) a saját kérelmek. Nyilvános: az ár és a kedvezményezett nem titok. */
  r.get('/', async (_req, res) => {
    try {
      const plan = planOf(res);
      const user = plan.enforced ? plan.user : null;
      // A saját kérelmek hibája (pl. még nincs 0020 tábla) nem rejtheti el a fizetési adatokat
      const requests = user && store
        ? await store.listForUser(user.id, 20).then((rs) => rs.map(toView), (e) => { console.error('[pro-payments] saját kérelmek:', (e as Error).message); return []; })
        : [];
      const info: ProPaymentInfo = { price: await price(), payee: PAYEE, requests, reference: user?.email ?? null };
      res.json(info);
    } catch (e) {
      console.error('[pro-payments] info:', (e as Error).message);
      res.status(500).json({ error: 'A fizetési adatok nem tölthetők be.' });
    }
  });

  /**
   * „Befizetés elküldve ellenőrzésre”. CSAK függő kérelmet rögzít – a PRO-t nem
   * aktiválja. A törzsből kizárólag a `method` olvasódik ki.
   */
  r.post('/', requireAuthenticated, async (req, res) => {
    const plan = planOf(res);
    if (!store || !plan.enforced || !plan.user) return unavailable(res);
    const method = req.body?.method;
    if (!PAYMENT_METHODS.includes(method)) {
      return res.status(400).json({ error: 'Válassz fizetési módot (banki átutalás vagy Revolut).', code: 'INVALID_METHOD' });
    }
    const email = plan.user.email?.trim();
    if (!email) return res.status(400).json({ error: 'A fiókodhoz nem tartozik e-mail-cím, ezért a közlemény nem azonosítható.', code: 'EMAIL_REQUIRED' });
    try {
      const profile = (await store.profileStates([plan.user.id])).get(plan.user.id);
      if (stripeManaged(profile)) {
        return res.status(409).json({ error: 'Aktív Stripe-előfizetésed van – a kézi befizetés kettős fizetést jelentene. Kezeld a meglévő előfizetésedet, vagy írj nekünk.', code: 'ACTIVE_STRIPE_SUBSCRIPTION' });
      }
      const out = await store.createPending({ userId: plan.user.id, email, method, price: await price(), reference: email });
      res.status(out.created ? 201 : 200).json({ request: toView(out.request), created: out.created });
    } catch (e) {
      console.error('[pro-payments] kérelem:', (e as Error).message);
      res.status(500).json({ error: 'A kérelem nem rögzült. Próbáld újra később.', code: 'REQUEST_FAILED' });
    }
  });

  return r;
}

/** Admin útvonalak – a mount helyén requireAdmin védi mindet. */
export function adminProPaymentsRouter(store: ManualPaymentStore | null): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    if (!store) return unavailable(res);
    const raw = String(req.query.status ?? 'pending');
    if (raw !== 'all' && !STATUSES.includes(raw as PaymentRequestStatus)) {
      return res.status(400).json({ error: 'Érvénytelen állapotszűrő.', code: 'BAD_REQUEST' });
    }
    try {
      const rows = await store.list(raw === 'all' ? null : (raw as PaymentRequestStatus), LIST_LIMIT);
      const profiles = await store.profileStates([...new Set(rows.map((x) => x.userId))]);
      const out: AdminPaymentRequestView[] = rows.map((x) => {
        const p = profiles.get(x.userId);
        return { ...x, profile: p ? { status: p.status, subscriptionEnd: p.subscriptionEnd, stripeManaged: stripeManaged(p) } : null };
      });
      res.json(out);
    } catch (e) {
      console.error('[pro-payments] admin lista:', (e as Error).message);
      res.status(500).json({ error: 'A kérelmek nem tölthetők be.' });
    }
  });

  r.post('/:id/approve', async (req, res) => {
    if (!store) return unavailable(res);
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Érvénytelen azonosító.' });
    const admin = planOf(res).user?.id ?? 'local-admin';
    try {
      const out = await store.approve(req.params.id, admin);
      switch (out.outcome) {
        case 'approved':
          invalidateEntitlement(out.request.userId); // a jogosultság azonnal érvényes legyen
          console.log(`[pro-payments] jóváhagyva: kérelem=${out.request.id} user=${out.request.userId} admin=${admin} until=${out.request.activatedUntil}`);
          return res.json({ request: out.request });
        case 'not_found': return res.status(404).json({ error: 'A kérelem nem található.', code: 'NOT_FOUND' });
        case 'already_processed': return res.status(409).json({ error: 'Ezt a kérelmet már feldolgozták.', code: 'ALREADY_PROCESSED', request: out.request });
        case 'stripe_conflict': return res.status(409).json({ error: 'A felhasználónak élő Stripe-előfizetése van – kézi aktiválás előtt azt kell rendezni.', code: 'ACTIVE_STRIPE_SUBSCRIPTION', request: out.request });
        case 'profile_missing': return res.status(409).json({ error: 'A kérelmezőhöz nem tartozik profil.', code: 'PROFILE_MISSING', request: out.request });
      }
    } catch (e) {
      console.error('[pro-payments] jóváhagyás:', (e as Error).message);
      res.status(500).json({ error: 'A jóváhagyás nem sikerült – a kérelem és a profil változatlan.', code: 'APPROVE_FAILED' });
    }
  });

  r.post('/:id/reject', async (req, res) => {
    if (!store) return unavailable(res);
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Érvénytelen azonosító.' });
    const rawNote = req.body?.note;
    if (rawNote != null && (typeof rawNote !== 'string' || rawNote.length > 300)) {
      return res.status(400).json({ error: 'A megjegyzés legfeljebb 300 karakter lehet.', code: 'BAD_REQUEST' });
    }
    const note = typeof rawNote === 'string' && rawNote.trim() ? rawNote.trim() : null;
    const admin = planOf(res).user?.id ?? 'local-admin';
    try {
      const out = await store.reject(req.params.id, admin, note);
      if (out.outcome === 'rejected') return res.json({ request: out.request });
      if (out.outcome === 'not_found') return res.status(404).json({ error: 'A kérelem nem található.', code: 'NOT_FOUND' });
      return res.status(409).json({ error: 'Ezt a kérelmet már feldolgozták.', code: 'ALREADY_PROCESSED', request: out.request });
    } catch (e) {
      console.error('[pro-payments] elutasítás:', (e as Error).message);
      res.status(500).json({ error: 'Az elutasítás nem sikerült.', code: 'REJECT_FAILED' });
    }
  });

  return r;
}
