/**
 * A bejelentkezett felhasználó profilja (public.profiles) – csak olvasás.
 * Az előfizetési mezőket a frontend nem módosíthatja (RLS + trigger), a Stripe-integráció szerveroldalon fogja írni.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';

export type SubscriptionStatus = 'free' | 'pro' | 'past_due' | 'canceled';

export interface Profile {
  id: string;
  email: string | null;
  subscription_status: SubscriptionStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_end: string | null;
  created_at: string;
}

export const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  free: 'Ingyenes',
  pro: 'PRO előfizetés',
  past_due: 'Fizetés elmaradva',
  canceled: 'Lemondva',
};

/** Aktív PRO: státusz 'pro' és nincs lejárt subscription_end */
export function isPro(p: Profile | null): boolean {
  if (!p || p.subscription_status !== 'pro') return false;
  return !p.subscription_end || new Date(p.subscription_end).getTime() > Date.now();
}

/** Lejáratig hátralévő napok (negatív, ha már lejárt); null, ha nincs lejárat. */
export function daysUntilEnd(p: Profile | null): number | null {
  if (!p?.subscription_end) return null;
  return Math.ceil((new Date(p.subscription_end).getTime() - Date.now()) / 86400000);
}

/** Emberi szöveg a lejáratról: „lejár 2026. 10. 21. (30 nap múlva)” / „lejárt …” / „folyamatos” */
export function expiryText(p: Profile | null, fmt: (iso: string) => string): string {
  const d = daysUntilEnd(p);
  if (!p?.subscription_end || d == null) return p?.subscription_status === 'pro' ? 'Folyamatos (nincs lejárat)' : '–';
  if (d < 0) return `Lejárt: ${fmt(p.subscription_end)}`;
  if (d === 0) return `Ma lejár: ${fmt(p.subscription_end)}`;
  return `Lejár: ${fmt(p.subscription_end)} (${d} nap múlva)`;
}

export function useProfile() {
  const { user, configured } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase || !user) { setProfile(null); return; }
    setLoading(true); setError(null);
    const { data, error: err } = await supabase
      .from('profiles')
      .select('id, email, subscription_status, stripe_customer_id, stripe_subscription_id, subscription_end, created_at')
      .eq('id', user.id)
      .maybeSingle();
    if (err) setError(err.message.includes('relation') || err.code === '42P01' ? 'A profiles tábla még nincs létrehozva – futtasd le a supabase/migrations/0001_profiles.sql fájlt.' : err.message);
    setProfile((data as Profile | null) ?? null);
    setLoading(false);
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  return { profile, loading, error, reload: load, configured, pro: isPro(profile) };
}
