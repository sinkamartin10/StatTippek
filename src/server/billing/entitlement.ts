/**
 * Szerveroldali jogosultság. A frontend FREE/PRO állapotát sosem hisszük el:
 *  - a felhasználót a Supabase access token azonosítja (auth.getUser),
 *  - a csomagot a profiles tábla adja (60 mp cache, webhook után ürítve),
 *  - a PRO végpontok 401/403-mal válaszolnak, a nyilvános végpontok FREE-nézetet adnak (a szerver rövidít/kitakar).
 * Ha a szerveren nincs Supabase admin konfiguráció (helyi, egyfelhasználós futtatás), minden nyitott – ezt az /api/status jelzi.
 */
import type { NextFunction, Request, Response } from 'express';
import type { User } from '@supabase/supabase-js';
import { getProfile, getUserFromRequest, profileIsPro, supabaseConfigured } from './supabaseAdmin';

export interface Plan {
  /** false: nincs Supabase admin → nyitott, egyfelhasználós mód */
  enforced: boolean;
  user: User | null;
  pro: boolean;
  admin: boolean;
}

const cache = new Map<string, { at: number; pro: boolean }>();
const TTL = 60_000;
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

export async function resolvePlan(req: Request): Promise<Plan> {
  if (!supabaseConfigured) return { enforced: false, user: null, pro: true, admin: true };
  const user = await getUserFromRequest(req);
  if (!user) return { enforced: true, user: null, pro: false, admin: false };
  const hit = cache.get(user.id);
  let pro = hit && Date.now() - hit.at < TTL ? hit.pro : null;
  if (pro == null) {
    pro = profileIsPro(await getProfile(user.id));
    cache.set(user.id, { at: Date.now(), pro });
  }
  return { enforced: true, user, pro, admin: !!user.email && ADMIN_EMAILS.has(user.email.toLowerCase()) };
}

/** Minden /api kérésre kiszámolja a csomagot (res.locals.plan) – a nyilvános végpontok ebből döntik el, mit takarnak ki. */
export async function attachPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.locals.plan = await resolvePlan(req); } catch { res.locals.plan = { enforced: true, user: null, pro: false, admin: false } satisfies Plan; }
  next();
}

export function planOf(res: Response): Plan {
  return (res.locals.plan as Plan | undefined) ?? { enforced: true, user: null, pro: false, admin: false };
}

/** PRO-csak végpontok: bejelentkezés + aktív előfizetés. */
export async function requirePro(req: Request, res: Response, next: NextFunction): Promise<void> {
  const plan = res.locals.plan ? planOf(res) : await resolvePlan(req);
  if (!plan.enforced || plan.pro) { next(); return; }
  if (!plan.user) { res.status(401).json({ error: 'Bejelentkezés szükséges.', code: 'AUTH_REQUIRED' }); return; }
  res.status(403).json({ error: 'Ez a funkció PRO előfizetéssel érhető el.', code: 'PRO_REQUIRED' });
}

/** Globális beállításokat módosító végpontok: csak ADMIN_EMAILS-ben felsorolt fiók. */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const plan = res.locals.plan ? planOf(res) : await resolvePlan(req);
  if (!plan.enforced || plan.admin) { next(); return; }
  if (!plan.user) { res.status(401).json({ error: 'Bejelentkezés szükséges.', code: 'AUTH_REQUIRED' }); return; }
  res.status(403).json({ error: 'Ehhez adminisztrátori jogosultság szükséges.', code: 'ADMIN_REQUIRED' });
}

/** A webhook profil-frissítés után ürítjük a cache-t, hogy azonnal érvényes legyen az új státusz. */
export function invalidateEntitlement(userId?: string): void {
  if (userId) cache.delete(userId); else cache.clear();
}
