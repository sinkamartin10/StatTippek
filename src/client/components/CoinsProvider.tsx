/**
 * Coin-egyenleg megosztott állapota. A MEGLÉVŐ context-mintát követi
 * (AuthContext / PlanContext) – nincs új state-kezelő könyvtár.
 *
 * AZ EGYENLEG AUTHORITY-JA A SZERVER. Ez az állapot csak megjelenítési
 * gyorsítótár: minden értéket a `/api/coins/balance` vagy egy vásárlás
 * szerverválasza ír, a felület maga SOHA nem számol egyenleget.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Coins } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatCoins } from '../lib/shopView';
import { useAuth } from '../auth/AuthContext';

interface CoinsState {
  /** `null`, amíg a szerver válasza meg nem jött */
  balance: number | null;
  loading: boolean;
  /** Újratöltés a szerverről (a DB aktuális állapota). */
  refresh: () => Promise<void>;
  /**
   * Az egyenleg átvétele egy SZERVERVÁLASZBÓL (pl. vásárlás után), hogy ne
   * kelljen külön kérés. Kizárólag szerver által adott értékkel hívható.
   */
  applyServerBalance: (balance: number) => void;
}

const CoinsContext = createContext<CoinsState>({
  balance: null, loading: false, refresh: async () => {}, applyServerBalance: () => {},
});

export function CoinsProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // Supabase nélküli helyi módban is van egyenleg (a szerver LOCAL_USER_ID-t használ)
  const enabled = !auth.configured || !!auth.user;

  const refresh = useCallback(async () => {
    if (!enabled) { setBalance(null); return; }
    setLoading(true);
    try { setBalance((await api.coinBalance()).balance); }
    catch { setBalance(null); }
    finally { setLoading(false); }
  }, [enabled]);

  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo<CoinsState>(() => ({
    balance, loading, refresh, applyServerBalance: setBalance,
  }), [balance, loading, refresh]);

  return <CoinsContext.Provider value={value}>{children}</CoinsContext.Provider>;
}

export const useCoins = () => useContext(CoinsContext);

/**
 * Egyenleg-jelvény a fejlécben. Kattintásra a Shopba vezet, ezért link –
 * így billentyűzetről is elérhető, és a képernyőolvasó is linkként olvassa.
 */
export function CoinBalancePill({ className = '' }: { className?: string }) {
  const { balance, loading } = useCoins();
  const label = balance == null ? '–' : formatCoins(balance);
  return (
    <Link
      to="/shop"
      className={`coin-pill ${className}`}
      aria-label={balance == null ? 'Coin egyenleg betöltése – Shop megnyitása' : `${label} coin – Shop megnyitása`}
      title="Coin egyenleg – kattints a Shopért"
    >
      <Coins className="h-4 w-4 shrink-0" aria-hidden />
      <span className={`mono tabular-nums ${loading && balance == null ? 'opacity-60' : ''}`}>{label}</span>
    </Link>
  );
}
