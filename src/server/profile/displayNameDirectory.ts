/**
 * Megjelenítési nevek tára – a MEGLÉVŐ public.profiles tábla display_name oszlopán.
 * Nincs párhuzamos felhasználó-/profilrendszer: ugyanaz a sor, amit a Stripe-integráció is használ.
 *
 *  - SupabaseDisplayNameDirectory : éles; service_role kulccsal ír (a kliensnek nincs UPDATE joga)
 *  - InMemoryDisplayNameDirectory : helyi, Supabase nélküli futtatás és tesztek
 *
 * Az egyediséget az adatbázis `profiles_display_name_unique_ci` egyedi indexe garantálja
 * (lower(display_name)); a kódbeli előellenőrzés csak szebb hibaüzenetet ad.
 */
import { supabaseAdmin } from '../billing/supabaseAdmin';
import { normalizeDisplayName } from '../../shared/displayName';

export type SetNameResult = { ok: true } | { ok: false; reason: 'TAKEN' | 'FAILED'; message: string };

export interface DisplayNameDirectory {
  /** A felhasználó tárolt neve, vagy null, ha még nem állított be. */
  get(userId: string): Promise<string | null>;
  /** Több felhasználó neve egyszerre (ranglistához). A név nélkülieket nem tartalmazza. */
  getMany(userIds: string[]): Promise<Map<string, string>>;
  /** Mentés. A hívó előtte KÖTELEZŐEN lefuttatja a validateDisplayName ellenőrzést. */
  set(userId: string, value: string): Promise<SetNameResult>;
}

const TAKEN_MESSAGE = 'Ez a megjelenítési név már foglalt.';

export class SupabaseDisplayNameDirectory implements DisplayNameDirectory {
  async get(userId: string): Promise<string | null> {
    if (!supabaseAdmin) return null;
    const { data, error } = await supabaseAdmin.from('profiles').select('display_name').eq('id', userId).maybeSingle();
    if (error) { console.error('[profil] név olvasás:', error.message); return null; }
    const v = (data as { display_name: string | null } | null)?.display_name ?? null;
    return v && v.trim() ? v : null;
  }

  async getMany(userIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!supabaseAdmin || !userIds.length) return out;
    const { data, error } = await supabaseAdmin.from('profiles').select('id, display_name').in('id', userIds);
    if (error) { console.error('[profil] nevek olvasása:', error.message); return out; }
    for (const row of (data ?? []) as { id: string; display_name: string | null }[]) {
      if (row.display_name && row.display_name.trim()) out.set(row.id, row.display_name);
    }
    return out;
  }

  async set(userId: string, value: string): Promise<SetNameResult> {
    if (!supabaseAdmin) return { ok: false, reason: 'FAILED', message: 'A profil mentése nincs beállítva a szerveren.' };
    const name = normalizeDisplayName(value);

    // Előellenőrzés a szebb hibaüzenetért – a tényleges garancia az adatbázis egyedi indexe
    const { data: clash } = await supabaseAdmin
      .from('profiles').select('id').ilike('display_name', name).maybeSingle();
    if (clash && (clash as { id: string }).id !== userId) return { ok: false, reason: 'TAKEN', message: TAKEN_MESSAGE };

    const { error } = await supabaseAdmin.from('profiles').update({ display_name: name }).eq('id', userId);
    if (error) {
      // 23505 = unique_violation → párhuzamos mentésnél is pontosan egy név nyer
      if (error.code === '23505') return { ok: false, reason: 'TAKEN', message: TAKEN_MESSAGE };
      console.error('[profil] név mentés:', error.message);
      return { ok: false, reason: 'FAILED', message: 'A megjelenítési név mentése nem sikerült.' };
    }
    return { ok: true };
  }
}

/** Helyi/teszt tár: ugyanaz a szerződés, kis-nagybetűtől független egyediséggel. */
export class InMemoryDisplayNameDirectory implements DisplayNameDirectory {
  private byUser = new Map<string, string>();
  private takenBy = new Map<string, string>(); // lower(name) → userId

  async get(userId: string): Promise<string | null> { return this.byUser.get(userId) ?? null; }

  async getMany(userIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of userIds) { const v = this.byUser.get(id); if (v) out.set(id, v); }
    return out;
  }

  async set(userId: string, value: string): Promise<SetNameResult> {
    const name = normalizeDisplayName(value);
    const key = name.toLowerCase();
    const owner = this.takenBy.get(key);
    if (owner && owner !== userId) return { ok: false, reason: 'TAKEN', message: TAKEN_MESSAGE };
    const previous = this.byUser.get(userId);
    if (previous) this.takenBy.delete(previous.toLowerCase());
    this.byUser.set(userId, name);
    this.takenBy.set(key, userId);
    return { ok: true };
  }
}
