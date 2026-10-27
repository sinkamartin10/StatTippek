/**
 * Ingyenes, 3 napos PRO próbaidőszak – admin-jóváhagyással.
 *
 *  GET  /api/pro-trial                      a saját próbaidőszak-állapot (a szerver számolja)
 *  POST /api/pro-trial                      igénylés → FÜGGŐ igénylés (PRO-t NEM aktivál); törzs nincs
 *  GET  /api/admin/pro-trials?status=       igénylések listája (csak admin)
 *  POST /api/admin/pro-trials/:id/approve   jóváhagyás + PRO pontosan 3 napra, egy tranzakcióban (csak admin)
 *  POST /api/admin/pro-trials/:id/reject    elutasítás – végleges (csak admin)
 *
 * Biztonság:
 *  - a kérelmezőt KIZÁRÓLAG a hitelesített token azonosítja; a törzsből semmi nem olvasódik ki,
 *  - fiókonként EGY igénylés, örökre: az adatbázis unique(user_id) indexe garantálja, párhuzamos
 *    kérésnél is (a második beszúrás ütközik, a meglévőt adjuk vissza 409-cel),
 *  - a jóváhagyás a meglévő előfizetési mezőket írja (profiles.subscription_status = 'pro',
 *    subscription_end = most + 3 nap), ugyanúgy, mint a kézi befizetés – a lejáratot a meglévő
 *    jogosultság-ellenőrzés (profileIsPro / is_pro) kezeli, ütemező nélkül,
 *  - a próbaidőszak nem írja felül és nem hosszabbítja a meglévő PRO-t (already_pro / stripe_conflict),
 *    aktív PRO fiók nem is igényelhet,
 *  - az aktiválásról egyetlen értesítés megy a meglévő értesítési rendszeren (forráskulcs igénylésenként).
 */
import { Router, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { invalidateEntitlement, planOf, requireAuthenticated } from './entitlement';
import type { ProfileState } from './manualPayments';
import type { NewNotification } from '../../shared/notifications';
import {
  PRO_TRIAL_DAYS, trialActivatedText, trialSourceKey,
  type AdminTrialRequestView, type ProTrialStatus, type TrialRequestStatus,
} from '../../shared/proTrial';

// ---------------------------------------------------------------------------
// Tároló
// ---------------------------------------------------------------------------

export interface StoredTrial {
  id: string;
  userId: string;
  email: string;
  status: TrialRequestStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  trialStart: string | null;
  trialEnd: string | null;
}

export type TrialApproveResult =
  | { outcome: 'approved'; request: StoredTrial }
  | { outcome: 'already_processed' | 'already_pro' | 'stripe_conflict' | 'profile_missing'; request: StoredTrial }
  | { outcome: 'not_found' };

export type TrialRejectResult =
  | { outcome: 'rejected' | 'already_processed'; request: StoredTrial }
  | { outcome: 'not_found' };

export interface ProTrialStore {
  /** Új függő igénylés; ha a fióknak már VAN igénylése (bármilyen állapotban), azt adja vissza (created: false). */
  create(userId: string, email: string): Promise<{ request: StoredTrial; created: boolean }>;
  forUser(userId: string): Promise<StoredTrial | null>;
  get(id: string): Promise<StoredTrial | null>;
  list(status: TrialRequestStatus | null, limit: number): Promise<StoredTrial[]>;
  profileStates(userIds: string[]): Promise<Map<string, ProfileState>>;
  /** Jóváhagyás + 3 napos PRO atomikusan (Postgres: approve_pro_trial_request). */
  approve(id: string, adminId: string): Promise<TrialApproveResult>;
  /** Elutasítás: csak függő igénylés, egyetlen feltételes írással. */
  reject(id: string, adminId: string): Promise<TrialRejectResult>;
}

type Row = Record<string, any>;
const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());

function toTrial(r: Row): StoredTrial {
  return {
    id: String(r.id), userId: String(r.user_id), email: String(r.email), status: r.status as TrialRequestStatus,
    createdAt: iso(r.created_at)!, decidedAt: iso(r.decided_at), decidedBy: r.decided_by ?? null,
    trialStart: iso(r.trial_start), trialEnd: iso(r.trial_end),
  };
}

/** Éles tároló: Supabase (service_role). A jóváhagyás a 0024 SQL-függvényével, egy tranzakcióban. */
export class PostgresProTrialStore implements ProTrialStore {
  constructor(private db: SupabaseClient) {}

  private fail(op: string, error: { message: string } | null): void {
    if (error) throw new Error(`[pro-trial] ${op}: ${error.message}`);
  }

  async create(userId: string, email: string): Promise<{ request: StoredTrial; created: boolean }> {
    const { data, error } = await this.db.from('pro_trial_requests').insert({ user_id: userId, email }).select('id');
    // Ütközés a unique(user_id) indexen (már van igénylése) → a meglévőt adjuk vissza.
    // A hibakódra nem hagyatkozunk: bármely beszúrási hibánál előbb a meglévő igénylést keressük.
    if (error) {
      const existing = await this.forUser(userId);
      if (existing) return { request: existing, created: false };
    }
    this.fail('create', error);
    const created = await this.get(String((data ?? [])[0]?.id));
    if (!created) throw new Error('[pro-trial] az igénylés nem olvasható vissza');
    return { request: created, created: true };
  }

  async forUser(userId: string): Promise<StoredTrial | null> {
    const { data, error } = await this.db.from('pro_trial_requests').select('*').eq('user_id', userId).maybeSingle();
    this.fail('forUser', error);
    return data ? toTrial(data) : null;
  }

  async get(id: string): Promise<StoredTrial | null> {
    const { data, error } = await this.db.from('pro_trial_requests').select('*').eq('id', id).maybeSingle();
    this.fail('get', error);
    return data ? toTrial(data) : null;
  }

  async list(status: TrialRequestStatus | null, limit: number): Promise<StoredTrial[]> {
    let q = this.db.from('pro_trial_requests').select('*');
    if (status) q = q.eq('status', status);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
    this.fail('list', error);
    return (data ?? []).map(toTrial);
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

  async approve(id: string, adminId: string): Promise<TrialApproveResult> {
    const { data, error } = await this.db.rpc('approve_pro_trial_request', { p_request_id: id, p_admin: adminId });
    this.fail('approve', error);
    const r = (data ?? {}) as { outcome?: string; request?: Row };
    if (r.outcome === 'not_found') return { outcome: 'not_found' };
    if ((r.outcome === 'approved' || r.outcome === 'already_processed' || r.outcome === 'already_pro' || r.outcome === 'stripe_conflict' || r.outcome === 'profile_missing') && r.request) {
      return { outcome: r.outcome, request: toTrial(r.request) };
    }
    throw new Error(`[pro-trial] approve: váratlan válasz (${JSON.stringify(data)})`);
  }

  async reject(id: string, adminId: string): Promise<TrialRejectResult> {
    const { data, error } = await this.db.from('pro_trial_requests')
      .update({ status: 'rejected', decided_at: new Date().toISOString(), decided_by: adminId })
      .eq('id', id).eq('status', 'pending').select('id');
    this.fail('reject', error);
    const cur = await this.get(id);
    if (!cur) return { outcome: 'not_found' };
    return { outcome: (data ?? []).length === 1 ? 'rejected' : 'already_processed', request: cur };
  }
}

const isLivePro = (p: ProfileState | undefined, now: number) =>
  !!p && p.status === 'pro' && (p.subscriptionEnd == null || new Date(p.subscriptionEnd).getTime() > now);

/** Élő vagy elmaradt fizetésű Stripe-előfizetés: azt a Stripe kezeli, a próbaidőszak nem írhatja felül. */
const stripeManaged = (p: ProfileState | undefined, now: number) =>
  !!p?.stripeSubscriptionId && (p.status === 'past_due' || isLivePro(p, now));

/**
 * Memóriabeli tároló (tesztekhez). Ugyanazokat a szabályokat követi, mint a 0024 SQL-függvény –
 * azt a proTrial.pg.test.ts külön ellenőrzi. A létrehozás await nélkül, egy lépésben fut, így a
 * párhuzamos kérések itt is legfeljebb egy igénylést hoznak létre.
 */
export class MemoryProTrialStore implements ProTrialStore {
  readonly requests = new Map<string, StoredTrial>();
  constructor(public profiles = new Map<string, ProfileState>(), public now = () => new Date()) {}

  async create(userId: string, email: string): Promise<{ request: StoredTrial; created: boolean }> {
    const existing = [...this.requests.values()].find((x) => x.userId === userId);
    if (existing) return { request: { ...existing }, created: false };
    const req: StoredTrial = {
      id: randomUUID(), userId, email, status: 'pending', createdAt: this.now().toISOString(),
      decidedAt: null, decidedBy: null, trialStart: null, trialEnd: null,
    };
    this.requests.set(req.id, req);
    return { request: { ...req }, created: true };
  }

  async forUser(userId: string): Promise<StoredTrial | null> {
    const r = [...this.requests.values()].find((x) => x.userId === userId);
    return r ? { ...r } : null;
  }

  async get(id: string): Promise<StoredTrial | null> {
    const r = this.requests.get(id);
    return r ? { ...r } : null;
  }

  async list(status: TrialRequestStatus | null, limit: number): Promise<StoredTrial[]> {
    return [...this.requests.values()].filter((x) => !status || x.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((x) => ({ ...x }));
  }

  async profileStates(userIds: string[]): Promise<Map<string, ProfileState>> {
    return new Map(userIds.filter((id) => this.profiles.has(id)).map((id) => [id, { ...this.profiles.get(id)! }]));
  }

  async approve(id: string, adminId: string): Promise<TrialApproveResult> {
    const r = this.requests.get(id);
    if (!r) return { outcome: 'not_found' };
    if (r.status !== 'pending') return { outcome: 'already_processed', request: { ...r } };
    const p = this.profiles.get(r.userId);
    if (!p) return { outcome: 'profile_missing', request: { ...r } };
    const now = this.now();
    if (stripeManaged(p, now.getTime())) return { outcome: 'stripe_conflict', request: { ...r } };
    if (isLivePro(p, now.getTime())) return { outcome: 'already_pro', request: { ...r } };
    const end = new Date(now.getTime() + PRO_TRIAL_DAYS * 86_400_000).toISOString();
    this.profiles.set(r.userId, { ...p, status: 'pro', subscriptionEnd: end });
    Object.assign(r, { status: 'approved', decidedAt: now.toISOString(), decidedBy: adminId, trialStart: now.toISOString(), trialEnd: end });
    return { outcome: 'approved', request: { ...r } };
  }

  async reject(id: string, adminId: string): Promise<TrialRejectResult> {
    const r = this.requests.get(id);
    if (!r) return { outcome: 'not_found' };
    if (r.status !== 'pending') return { outcome: 'already_processed', request: { ...r } };
    Object.assign(r, { status: 'rejected', decidedAt: this.now().toISOString(), decidedBy: adminId });
    return { outcome: 'rejected', request: { ...r } };
  }
}

// ---------------------------------------------------------------------------
// Állapot és értesítés
// ---------------------------------------------------------------------------

/**
 * A felhasználó próbaidőszak-állapota a szerver adataiból. „Aktív próbaidőszak” csak akkor,
 * ha a profil PRO-lejárata ma is a próbaidőszak vége (azaz közben nem fizetett elő); minden
 * más élő PRO „már PRO tag” – annak próbaidőszak nem jár.
 */
export function trialStatus(t: StoredTrial | null, p: ProfileState | undefined, now = Date.now()): ProTrialStatus {
  const base = { requestedAt: t?.createdAt ?? null, trialEnd: t?.trialEnd ?? null };
  const viaTrial = t?.status === 'approved' && t.trialEnd != null && new Date(t.trialEnd).getTime() > now
    && !p?.stripeSubscriptionId && p?.subscriptionEnd != null
    && Math.abs(new Date(p.subscriptionEnd).getTime() - new Date(t.trialEnd).getTime()) < 1000;
  if (isLivePro(p, now)) return { ...base, state: viaTrial ? 'active' : 'pro_member' };
  if (!t) return { ...base, state: 'available' };
  if (t.status === 'pending') return { ...base, state: 'pending' };
  if (t.status === 'rejected') return { ...base, state: 'rejected' };
  return { ...base, state: 'used' };
}

/** Az aktiválási értesítés – forráskulcsa igénylésenként egyedi, így egyszer jelenik meg. */
export function trialNotification(t: StoredTrial): NewNotification | null {
  if (t.status !== 'approved' || !t.trialEnd) return null;
  return { userId: t.userId, type: 'pro_trial_activated', ...trialActivatedText(t.trialEnd), sourceKey: trialSourceKey(t.id), metadata: { trialEnd: t.trialEnd } };
}

/**
 * Értesítés-újraszármaztató: ha az aktiválás pillanatában az értesítés ritka hiba miatt
 * elmaradt, a következő listázás pótolja (ugyanazzal a forráskulccsal – duplikáció kizárt).
 */
export function trialNotificationCandidates(store: ProTrialStore | null) {
  return async (userId: string): Promise<NewNotification[]> => {
    if (!store) return [];
    const t = await store.forUser(userId);
    const n = t ? trialNotification(t) : null;
    return n ? [n] : [];
  };
}

// ---------------------------------------------------------------------------
// Útvonalak
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-fA-F-]{36}$/;
const STATUSES: TrialRequestStatus[] = ['pending', 'approved', 'rejected'];
const LIST_LIMIT = 200;

const unavailable = (res: Response) => res.status(503).json({
  error: 'Az ingyenes próbaidőszak ezen a példányon nem érhető el (nincs bejelentkezési rendszer / adatbázis).', code: 'TRIAL_UNAVAILABLE',
});

export function proTrialRouter(store: ProTrialStore | null): Router {
  const r = Router();

  r.get('/', async (_req, res) => {
    const plan = planOf(res);
    if (!store || !plan.enforced) return res.json({ state: 'unavailable', requestedAt: null, trialEnd: null } satisfies ProTrialStatus);
    if (!plan.user) return res.json({ state: 'available', requestedAt: null, trialEnd: null } satisfies ProTrialStatus);
    try {
      const [t, profiles] = await Promise.all([store.forUser(plan.user.id), store.profileStates([plan.user.id])]);
      res.json(trialStatus(t, profiles.get(plan.user.id)));
    } catch (e) {
      console.error('[pro-trial] állapot:', (e as Error).message);
      res.status(500).json({ error: 'A próbaidőszak állapota nem tölthető be.' });
    }
  });

  /** Igénylés. CSAK függő igénylést rögzít – a PRO-t nem aktiválja. A törzsből semmi nem olvasódik ki. */
  r.post('/', requireAuthenticated, async (_req, res) => {
    const plan = planOf(res);
    if (!store || !plan.enforced || !plan.user) return unavailable(res);
    const email = plan.user.email?.trim();
    if (!email) return res.status(400).json({ error: 'A fiókodhoz nem tartozik e-mail-cím.', code: 'EMAIL_REQUIRED' });
    try {
      const now = Date.now();
      const profile = (await store.profileStates([plan.user.id])).get(plan.user.id);
      const existing = await store.forUser(plan.user.id);
      if (existing) return res.status(409).json({ error: 'Ingyenes próbaidőszakot fiókonként csak egyszer lehet igényelni.', code: 'ALREADY_REQUESTED', status: trialStatus(existing, profile, now) });
      if (isLivePro(profile, now) || stripeManaged(profile, now)) {
        return res.status(409).json({ error: 'Már PRO tag vagy, köszönjük!', code: 'ALREADY_PRO', status: trialStatus(null, profile, now) });
      }
      const out = await store.create(plan.user.id, email);
      // párhuzamos kérés: a másik már létrehozta – ugyanaz a válasz, mint egy második igénylésre
      if (!out.created) return res.status(409).json({ error: 'Ingyenes próbaidőszakot fiókonként csak egyszer lehet igényelni.', code: 'ALREADY_REQUESTED', status: trialStatus(out.request, profile, now) });
      console.log(`[pro-trial] igénylés: kérelem=${out.request.id} user=${plan.user.id}`);
      res.status(201).json({ status: trialStatus(out.request, profile, now) });
    } catch (e) {
      console.error('[pro-trial] igénylés:', (e as Error).message);
      res.status(500).json({ error: 'Az igénylés nem rögzült. Próbáld újra később.', code: 'REQUEST_FAILED' });
    }
  });

  return r;
}

export interface AdminProTrialsDeps {
  /** a meglévő értesítési szolgáltatás kibocsátója (NotificationService.emit – soha nem dob) */
  notify: (n: NewNotification) => Promise<boolean>;
  /** felhasználónevek a listához (a meglévő profiles.display_name) */
  displayNames?: (userIds: string[]) => Promise<Map<string, string>>;
}

/** Admin útvonalak – a mount helyén requireAdmin védi mindet. */
export function adminProTrialsRouter(store: ProTrialStore | null, deps: AdminProTrialsDeps): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    if (!store) return unavailable(res);
    const raw = String(req.query.status ?? 'pending');
    if (raw !== 'all' && !STATUSES.includes(raw as TrialRequestStatus)) {
      return res.status(400).json({ error: 'Érvénytelen állapotszűrő.', code: 'BAD_REQUEST' });
    }
    try {
      const rows = await store.list(raw === 'all' ? null : (raw as TrialRequestStatus), LIST_LIMIT);
      const ids = [...new Set(rows.map((x) => x.userId))];
      const [profiles, names] = await Promise.all([
        store.profileStates(ids),
        (deps.displayNames?.(ids) ?? Promise.resolve(new Map<string, string>())).catch(() => new Map<string, string>()),
      ]);
      const now = Date.now();
      const out: AdminTrialRequestView[] = rows.map(({ decidedBy: _d, ...x }) => {
        const p = profiles.get(x.userId);
        return { ...x, displayName: names.get(x.userId) ?? null, profile: p ? { status: p.status, subscriptionEnd: p.subscriptionEnd, stripeManaged: stripeManaged(p, now) } : null };
      });
      res.json(out);
    } catch (e) {
      console.error('[pro-trial] admin lista:', (e as Error).message);
      res.status(500).json({ error: 'Az igénylések nem tölthetők be.' });
    }
  });

  r.post('/:id/approve', async (req, res) => {
    if (!store) return unavailable(res);
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Érvénytelen azonosító.' });
    const admin = planOf(res).user?.id ?? 'local-admin';
    try {
      const out = await store.approve(req.params.id, admin);
      switch (out.outcome) {
        case 'approved': {
          invalidateEntitlement(out.request.userId); // a jogosultság azonnal érvényes legyen
          console.log(`[pro-trial] jóváhagyva: kérelem=${out.request.id} user=${out.request.userId} admin=${admin} until=${out.request.trialEnd}`);
          const n = trialNotification(out.request);
          if (n) await deps.notify(n);
          return res.json({ request: out.request });
        }
        case 'not_found': return res.status(404).json({ error: 'Az igénylés nem található.', code: 'NOT_FOUND' });
        case 'already_processed': return res.status(409).json({ error: 'Ezt az igénylést már feldolgozták.', code: 'ALREADY_PROCESSED', request: out.request });
        case 'already_pro': return res.status(409).json({ error: 'A felhasználó már PRO tag – a próbaidőszak nem írja felül és nem hosszabbítja a meglévő PRO-t.', code: 'ALREADY_PRO', request: out.request });
        case 'stripe_conflict': return res.status(409).json({ error: 'A felhasználónak Stripe-előfizetése van – a próbaidőszak nem aktiválható.', code: 'ACTIVE_STRIPE_SUBSCRIPTION', request: out.request });
        case 'profile_missing': return res.status(409).json({ error: 'A kérelmezőhöz nem tartozik profil.', code: 'PROFILE_MISSING', request: out.request });
      }
    } catch (e) {
      console.error('[pro-trial] jóváhagyás:', (e as Error).message);
      res.status(500).json({ error: 'A jóváhagyás nem sikerült – az igénylés és a profil változatlan.', code: 'APPROVE_FAILED' });
    }
  });

  r.post('/:id/reject', async (req, res) => {
    if (!store) return unavailable(res);
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Érvénytelen azonosító.' });
    const admin = planOf(res).user?.id ?? 'local-admin';
    try {
      const out = await store.reject(req.params.id, admin);
      if (out.outcome === 'rejected') return res.json({ request: out.request });
      if (out.outcome === 'not_found') return res.status(404).json({ error: 'Az igénylés nem található.', code: 'NOT_FOUND' });
      return res.status(409).json({ error: 'Ezt az igénylést már feldolgozták.', code: 'ALREADY_PROCESSED', request: out.request });
    } catch (e) {
      console.error('[pro-trial] elutasítás:', (e as Error).message);
      res.status(500).json({ error: 'Az elutasítás nem sikerült.', code: 'REJECT_FAILED' });
    }
  });

  return r;
}
