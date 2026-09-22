/**
 * Szerveroldali Supabase hozzáférés.
 *  - Admin kliens (SERVICE_ROLE kulcs): a profiles előfizetési mezőit CSAK ez írja (RLS-t megkerüli). A kulcs sosem hagyja el a szervert.
 *  - Felhasználó-azonosítás: a frontend Authorization: Bearer <access_token> fejlécét a Supabase Auth ellenőrzi (auth.getUser).
 * Ha nincs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, a számlázás ki van kapcsolva (az app többi része változatlanul fut).
 */
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { Request } from 'express';

export interface ProfileRow {
  id: string;
  email: string | null;
  subscription_status: 'free' | 'pro' | 'past_due' | 'canceled';
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_end: string | null;
}

const url = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL)?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

export const supabaseConfigured = !!(url && serviceKey);

export const supabaseAdmin: SupabaseClient | null = supabaseConfigured
  ? createClient(url!, serviceKey!, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

/** Bearer token → Supabase felhasználó (null, ha nincs/érvénytelen). */
export async function getUserFromRequest(req: Request): Promise<User | null> {
  if (!supabaseAdmin) return null;
  const h = req.headers.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

export async function getProfile(userId: string): Promise<ProfileRow | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, email, subscription_status, stripe_customer_id, stripe_subscription_id, subscription_end')
    .eq('id', userId)
    .maybeSingle();
  if (error) { console.error('[supabase] profil olvasás:', error.message); return null; }
  return (data as ProfileRow | null) ?? null;
}

export async function findProfileByCustomer(customerId: string): Promise<ProfileRow | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, email, subscription_status, stripe_customer_id, stripe_subscription_id, subscription_end')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  if (error) { console.error('[supabase] profil keresés ügyfél szerint:', error.message); return null; }
  return (data as ProfileRow | null) ?? null;
}

/** Előfizetési mezők írása – kizárólag a szerver (service_role) hívja. */
export async function updateProfile(userId: string, patch: Partial<Omit<ProfileRow, 'id' | 'email'>>): Promise<void> {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin.from('profiles').update(patch).eq('id', userId);
  if (error) throw new Error(`profil frissítés sikertelen: ${error.message}`);
}

/** Szerveroldali PRO-ellenőrzés (a frontend állapotát sosem hisszük el). */
export function profileIsPro(p: ProfileRow | null): boolean {
  if (!p || p.subscription_status !== 'pro') return false;
  return !p.subscription_end || new Date(p.subscription_end).getTime() > Date.now();
}
