/**
 * Csomag-állapot az egész alkalmazásnak: FREE vagy PRO.
 *  - Supabase nélkül (nincs beállítva a hitelesítés): a helyi eszköz teljes hozzáférésű (pro = true).
 *  - Bejelentkezés nélküli látogató vagy 'free' státusz: FREE (napi 3 tipp, részletes statisztika és modell-indoklás lakattal).
 *  - 'pro' státusz (érvényes subscription_end-del): PRO.
 * A korlátozás jelenleg a felületen történik; a szerveroldali korlátozás a Stripe-integrációval együtt kerül be.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Crown } from 'lucide-react';
import { useAuth } from './AuthContext';
import { useProfile, type Profile } from './useProfile';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';

// A FREE/PRO szabályok a szerverrel közös modulból jönnek (a szerver kényszeríti ki, a felület csak megjeleníti)
import { FREE_DAILY_TIPS, freeMatchIds, freeMatchQuota } from '@shared/engine/plan';
export { FREE_DAILY_TIPS, freeMatchIds, freeMatchQuota };

/**
 * Egy adott nap FREE-hozzáférése: a szűretlen napi meccslistából számol (így a szűrőkkel nem kerülhető meg).
 * PRO esetén minden meccs elérhető, és nem indít lekérést.
 */
export function useFreeDay(date: string | null) {
  const { pro } = usePlan();
  const day = useAsync(() => (pro || !date ? Promise.resolve(null) : api.matches({ date })), [date, pro]);
  return useMemo(() => {
    const list = day.data ?? [];
    const ids = pro ? null : freeMatchIds(list);
    return {
      loading: day.loading,
      total: list.length,
      quota: pro ? Infinity : freeMatchQuota(list.length),
      /** true, ha a meccs megnyitható (PRO, vagy a nap ingyenes meccsei között van) */
      allowed: (matchId: string) => pro || (ids?.has(matchId) ?? false),
      /** true, ha a meccs a FREE csomagban zárva van */
      locked: (matchId: string) => !pro && !day.loading && !(ids?.has(matchId) ?? false),
    };
  }, [day.data, day.loading, pro]);
}

interface PlanState {
  configured: boolean;
  loggedIn: boolean;
  loading: boolean;
  pro: boolean;
  profile: Profile | null;
  error: string | null;
  reload: () => Promise<void>;
}

const PlanContext = createContext<PlanState | null>(null);

export function PlanProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const { profile, loading, error, reload, pro } = useProfile();
  const value: PlanState = {
    configured: auth.configured,
    loggedIn: !!auth.user,
    loading: auth.loading || loading,
    pro: !auth.configured ? true : pro,
    profile,
    error,
    reload,
  };
  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

export function usePlan(): PlanState {
  const ctx = useContext(PlanContext);
  if (!ctx) throw new Error('usePlan csak PlanProvider-en belül használható');
  return ctx;
}

/** Lakat-jelvény PRO funkciókhoz (feliratokhoz, gombokhoz). */
export function ProLock({ label = 'PRO' }: { label?: string }) {
  return (
    <Link to="/pro" className="badge badge-yellow transition hover:border-warning" title="PRO előfizetéssel elérhető">
      <Lock className="h-3 w-3" /> {label}
    </Link>
  );
}

/** Lezárt tartalom helyőrzője: cím, rövid magyarázat, PRO gomb. Láthatóan, de nem agresszíven zárt. */
export function LockedBlock({ title, text, compact }: { title: string; text?: string; compact?: boolean }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border-2 border-dashed border-warning/40 bg-warning-soft text-center ${compact ? 'p-5' : 'p-8'}`}>
      <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-2xl bg-card text-2xl shadow-soft">🔒</span>
      <div className="text-base font-extrabold">{title}</div>
      {text && <div className="max-w-md text-sm font-semibold text-text-muted">{text}</div>}
      <Link to="/pro" className="btn btn-primary mt-1"><Crown className="h-4 w-4" /> PRO kipróbálása</Link>
    </div>
  );
}
