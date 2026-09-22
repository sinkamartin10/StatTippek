/**
 * Hitelesítési állapot (Supabase Auth): felhasználó, munkamenet, be-/kijelentkezés, regisztráció, jelszó-visszaállítás.
 * A munkamenetet a Supabase SDK tárolja (localStorage) és frissíti; az onAuthStateChange tartja szinkronban a UI-t.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { authConfigured, supabase } from '../lib/supabase';

interface AuthState {
  configured: boolean;
  loading: boolean;
  user: User | null;
  session: Session | null;
  /** true, ha jelszó-visszaállító linkről érkezett a felhasználó (új jelszót kell adnia) */
  passwordRecovery: boolean;
  signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  resetPassword(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Supabase hibaüzenetek magyarul */
function hu(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'Hibás e-mail-cím vagy jelszó.';
  if (m.includes('email not confirmed')) return 'Az e-mail-cím még nincs megerősítve – nézd meg a postaládádat.';
  if (m.includes('user already registered')) return 'Ezzel az e-mail-címmel már van fiók.';
  if (m.includes('password should be at least')) return 'A jelszó legalább 6 karakter legyen.';
  if (m.includes('unable to validate email') || m.includes('invalid email')) return 'Érvénytelen e-mail-cím.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Túl sok próbálkozás – várj egy kicsit, majd próbáld újra.';
  if (m.includes('same password')) return 'Az új jelszó nem egyezhet meg a régivel.';
  return message;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(authConfigured);
  const [passwordRecovery, setPasswordRecovery] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    // Meglévő munkamenet betöltése (perzisztens bejelentkezés)
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);
      if (event === 'SIGNED_OUT') setPasswordRecovery(false);
      setLoading(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const ensure = () => {
    if (!supabase) throw new Error('A hitelesítés nincs beállítva (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY).');
    return supabase;
  };

  const value: AuthState = {
    configured: authConfigured,
    loading,
    user,
    session,
    passwordRecovery,
    async signUp(email, password) {
      const { data, error } = await ensure().auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/bejelentkezes` } });
      if (error) throw new Error(hu(error.message));
      // Ha az e-mail-megerősítés be van kapcsolva, nincs azonnali munkamenet
      return { needsConfirmation: !data.session };
    },
    async signIn(email, password) {
      const { error } = await ensure().auth.signInWithPassword({ email, password });
      if (error) throw new Error(hu(error.message));
    },
    async signOut() {
      const { error } = await ensure().auth.signOut();
      if (error) throw new Error(hu(error.message));
    },
    async resetPassword(email) {
      const { error } = await ensure().auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/uj-jelszo` });
      if (error) throw new Error(hu(error.message));
    },
    async updatePassword(password) {
      const { error } = await ensure().auth.updateUser({ password });
      if (error) throw new Error(hu(error.message));
      setPasswordRecovery(false);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth csak AuthProvider-en belül használható');
  return ctx;
}
