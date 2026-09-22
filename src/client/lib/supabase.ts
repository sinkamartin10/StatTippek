/**
 * Supabase kliens inicializálás.
 * A URL és a PUBLISHABLE (anon) kulcs Vite környezeti változóból jön (.env, VITE_ előtag) – ezek nyilvános, frontendbe szánt értékek.
 * A service_role / secret kulcs SOHA nem kerülhet ide.
 * Ha nincs beállítva, `supabase` null és a hitelesítés ki van kapcsolva (az app változatlanul működik).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;

export const authConfigured = !!(url && key);

export const supabase: SupabaseClient | null = authConfigured
  ? createClient(url!, key!, {
      auth: {
        persistSession: true, // munkamenet localStorage-ban – újratöltés után is bejelentkezve marad
        autoRefreshToken: true,
        detectSessionInUrl: true, // jelszó-visszaállító / megerősítő linkek kezelése
      },
    })
  : null;
