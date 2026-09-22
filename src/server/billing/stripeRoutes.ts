/**
 * Stripe előfizetés (Checkout + webhook) – a lehető legkisebb szerveroldali réteg.
 *
 *  POST /api/billing/checkout   bejelentkezett Supabase felhasználónak Checkout Session-t nyit (mode: subscription)
 *  POST /api/billing/portal     Stripe ügyfélportál (lemondás, kártya csere)
 *  GET  /api/billing/config     ár/terméknév a Stripe Price-ból (a felület ezt mutatja) + konfigurációs állapot
 *  GET  /api/billing/me         szerver által ellenőrzött előfizetés-állapot
 *  POST /api/billing/webhook    Stripe események aláírás-ellenőrzéssel → profiles frissítés (service_role)
 *
 * Biztonság: STRIPE_SECRET_KEY és SUPABASE_SERVICE_ROLE_KEY csak itt, a szerveren; a webhook aláírását mindig ellenőrizzük;
 * a felhasználó–ügyfél összerendelés a Supabase user id-n alapul (customer.metadata + Checkout client_reference_id),
 * a frontendről érkező PRO/FREE állapotot sosem használjuk jogosultsághoz.
 */
import { Router, type Request, type Response } from 'express';
import Stripe from 'stripe';
import type { Database } from '../db/database';
import { findProfileByCustomer, getProfile, getUserFromRequest, profileIsPro, supabaseConfigured, updateProfile, type ProfileRow } from './supabaseAdmin';
import { invalidateEntitlement } from './entitlement';

const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
const priceId = process.env.STRIPE_PRICE_ID_PRO?.trim();
const appUrl = (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');

export const stripeConfigured = !!(secretKey && priceId && supabaseConfigured);
export const stripe: Stripe | null = secretKey ? new Stripe(secretKey) : null;

function toIso(unixSeconds: number | null | undefined): string | null {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

/** Stripe előfizetés-státusz → profiles.subscription_status */
function mapStatus(s: Stripe.Subscription.Status): ProfileRow['subscription_status'] {
  switch (s) {
    case 'active':
    case 'trialing':
      return 'pro';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
    case 'incomplete':
    case 'paused':
    default:
      return 'canceled';
  }
}

/** Az aktuális időszak vége (az API verziótól függően az előfizetésen vagy a tételen van). */
function periodEnd(sub: Stripe.Subscription): number | null {
  const s = sub as unknown as { current_period_end?: number };
  if (s.current_period_end) return s.current_period_end;
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  return item?.current_period_end ?? null;
}

/** Felhasználó-azonosító feloldása egy Stripe ügyfélhez: profiles → customer.metadata. */
async function resolveUserId(customerId: string, hint?: string | null): Promise<string | null> {
  if (hint) return hint;
  const p = await findProfileByCustomer(customerId);
  if (p) return p.id;
  if (!stripe) return null;
  const c = await stripe.customers.retrieve(customerId);
  if (!c.deleted && c.metadata?.supabase_user_id) return c.metadata.supabase_user_id;
  return null;
}

/** Előfizetés objektum → profil mezők írása. Egyetlen helyen, minden esemény ezt használja. */
async function applySubscription(sub: Stripe.Subscription, userHint?: string | null): Promise<void> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const userId = await resolveUserId(customerId, userHint ?? sub.metadata?.supabase_user_id);
  if (!userId) { console.error('[stripe] nem található felhasználó az ügyfélhez:', customerId); return; }
  const status = mapStatus(sub.status);
  // Lemondás az időszak végén: marad PRO a lejáratig (subscription_end = időszak vége), a webhook a tényleges lejáratkor 'canceled'-re vált.
  const end = sub.status === 'canceled' ? (sub.ended_at ?? sub.canceled_at ?? periodEnd(sub)) : periodEnd(sub);
  await updateProfile(userId, {
    subscription_status: status,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    subscription_end: toIso(end),
  });
  invalidateEntitlement(userId);
  console.log(`[stripe] profil frissítve: user=${userId} status=${status} sub=${sub.id} end=${toIso(end)}`);
}

export function billingRouter(db: Database): Router {
  const r = Router();

  r.get('/config', async (_req, res) => {
    if (!stripe || !priceId) return res.json({ configured: false, supabase: supabaseConfigured });
    try {
      const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
      const product = price.product as Stripe.Product;
      const amount = (price.unit_amount ?? 0) / 100;
      const currency = price.currency.toUpperCase();
      const label = currency === 'HUF' ? `${Math.round(amount).toLocaleString('hu-HU')} Ft/${price.recurring?.interval === 'year' ? 'év' : 'hó'}` : `${amount} ${currency}/${price.recurring?.interval ?? 'hó'}`;
      res.json({ configured: stripeConfigured, supabase: supabaseConfigured, productName: product.name, amount, currency, interval: price.recurring?.interval ?? 'month', label });
    } catch (e) {
      console.error('[stripe] ár lekérés:', (e as Error).message);
      res.json({ configured: false, supabase: supabaseConfigured, error: 'A Stripe ár nem érhető el – ellenőrizd a STRIPE_PRICE_ID_PRO értéket.' });
    }
  });

  r.get('/me', async (req, res) => {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Bejelentkezés szükséges.' });
    const profile = await getProfile(user.id);
    res.json({ userId: user.id, email: user.email, pro: profileIsPro(profile), profile });
  });

  r.post('/checkout', async (req, res) => {
    if (!stripe || !stripeConfigured) return res.status(503).json({ error: 'A fizetés nincs beállítva a szerveren (STRIPE_SECRET_KEY, STRIPE_PRICE_ID_PRO, SUPABASE_SERVICE_ROLE_KEY).' });
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Az előfizetéshez bejelentkezés szükséges.' });
    try {
      const profile = await getProfile(user.id);
      if (profileIsPro(profile)) return res.status(409).json({ error: 'Már aktív PRO előfizetésed van.' });

      // Ügyfél: a profilban tárolt, különben új – a Supabase user id-vel összekötve
      let customerId = profile?.stripe_customer_id ?? null;
      if (customerId) {
        const c = await stripe.customers.retrieve(customerId).catch(() => null);
        if (!c || c.deleted) customerId = null;
      }
      if (!customerId) {
        const c = await stripe.customers.create({ email: user.email ?? undefined, metadata: { supabase_user_id: user.id } });
        customerId = c.id;
        await updateProfile(user.id, { stripe_customer_id: customerId });
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        client_reference_id: user.id,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${appUrl}/pro?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/pro?checkout=cancel`,
        allow_promotion_codes: true,
        metadata: { supabase_user_id: user.id },
        subscription_data: { metadata: { supabase_user_id: user.id } },
      });
      res.json({ url: session.url });
    } catch (e) {
      console.error('[stripe] checkout:', (e as Error).message);
      res.status(500).json({ error: 'A fizetési oldal nem indítható: ' + (e as Error).message });
    }
  });

  /**
   * Szinkronizálás közvetlenül a Stripe-ból (védőháló, ha egy webhook nem érkezett meg):
   * a bejelentkezett felhasználó ügyfeléhez tartozó legfrissebb előfizetést kérdezi le és írja a profilba.
   * Csak a saját fiókra hat, és a forrás a Stripe – a frontend állapotát itt sem hisszük el.
   */
  r.post('/sync', async (req, res) => {
    if (!stripe || !stripeConfigured) return res.status(503).json({ error: 'A fizetés nincs beállítva a szerveren.' });
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Bejelentkezés szükséges.' });
    try {
      const profile = await getProfile(user.id);
      let customerId = profile?.stripe_customer_id ?? null;
      if (!customerId) {
        // ügyfél keresése a Supabase user id alapján (metadata), ha a profilban még nincs
        const found = await stripe.customers.search({ query: `metadata['supabase_user_id']:'${user.id}'`, limit: 1 });
        customerId = found.data[0]?.id ?? null;
      }
      if (!customerId) return res.json({ synced: false, reason: 'Nincs Stripe ügyfél ehhez a fiókhoz.' });
      const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
      // a legfrissebb (aktív előnyben) előfizetés
      const rank = (st: Stripe.Subscription.Status) => (st === 'active' || st === 'trialing' ? 0 : st === 'past_due' || st === 'unpaid' ? 1 : 2);
      const sub = [...subs.data].sort((a, b) => rank(a.status) - rank(b.status) || b.created - a.created)[0];
      if (!sub) return res.json({ synced: false, reason: 'Nincs előfizetés ehhez az ügyfélhez.' });
      await applySubscription(sub, user.id);
      const fresh = await getProfile(user.id);
      res.json({ synced: true, pro: profileIsPro(fresh), status: fresh?.subscription_status, subscription_end: fresh?.subscription_end });
    } catch (e) {
      console.error('[stripe] sync:', (e as Error).message);
      res.status(500).json({ error: 'A szinkronizálás sikertelen: ' + (e as Error).message });
    }
  });

  r.post('/portal', async (req, res) => {
    if (!stripe || !stripeConfigured) return res.status(503).json({ error: 'A fizetés nincs beállítva a szerveren.' });
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Bejelentkezés szükséges.' });
    const profile = await getProfile(user.id);
    if (!profile?.stripe_customer_id) return res.status(404).json({ error: 'Ehhez a fiókhoz még nem tartozik Stripe ügyfél.' });
    try {
      const portal = await stripe.billingPortal.sessions.create({ customer: profile.stripe_customer_id, return_url: `${appUrl}/pro` });
      res.json({ url: portal.url });
    } catch (e) {
      res.status(500).json({ error: 'Az ügyfélportál nem nyitható meg: ' + (e as Error).message });
    }
  });

  return r;
}

/** Webhook kezelő – NYERS body-val kell regisztrálni (express.raw), az aláírás-ellenőrzés miatt. */
export async function stripeWebhook(db: Database, req: Request, res: Response): Promise<void> {
  if (!stripe || !webhookSecret) { res.status(503).send('webhook nincs beállítva'); return; }
  const sig = req.headers['stripe-signature'];
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig as string, webhookSecret);
  } catch (e) {
    console.error('[stripe] érvénytelen webhook aláírás:', (e as Error).message);
    res.status(400).send(`Webhook Error: ${(e as Error).message}`);
    return;
  }

  // Idempotencia ATOMI módon: az esemény „igénylése” egyetlen INSERT … ON CONFLICT DO NOTHING.
  // Párhuzamos kézbesítésnél csak az egyik hívás kapja meg a feldolgozás jogát.
  if (!(await db.claimStripeEvent(event.id, event.type))) { res.json({ received: true, duplicate: true }); return; }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
          const sub = await stripe.subscriptions.retrieve(subId);
          await applySubscription(sub, session.client_reference_id ?? session.metadata?.supabase_user_id);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await applySubscription(event.data.object);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
        if (customerId) {
          const userId = await resolveUserId(customerId);
          if (userId) {
            await updateProfile(userId, { subscription_status: 'past_due' });
            invalidateEntitlement(userId);
            console.log(`[stripe] sikertelen fizetés: user=${userId} → past_due`);
          }
        }
        break;
      }
      default:
        // más események: nem érdekesek, de nyugtázzuk
        break;
    }
    res.json({ received: true });
  } catch (e) {
    // Hiba esetén felszabadítjuk az igénylést, hogy a Stripe újraküldése ténylegesen feldolgozódjon
    await db.releaseStripeEvent(event.id).catch(() => undefined);
    // 500 → a Stripe később újrapróbálja
    console.error(`[stripe] webhook feldolgozási hiba (${event.type}):`, (e as Error).message);
    res.status(500).send('feldolgozási hiba');
  }
}
