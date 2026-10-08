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
import {
  isLookupSafeDisplayName, isSearchableDisplayName, normalizeDisplayName, sameDisplayName,
} from '../../shared/displayName';

export type SetNameResult = { ok: true } | { ok: false; reason: 'TAKEN' | 'FAILED'; message: string };

export interface DisplayNameDirectory {
  /** A felhasználó tárolt neve, vagy null, ha még nem állított be. */
  get(userId: string): Promise<string | null>;
  /** Több felhasználó neve egyszerre (ranglistához). A név nélkülieket nem tartalmazza. */
  getMany(userIds: string[]): Promise<Map<string, string>>;
  /**
   * Névből felhasználó – kis-nagybetűtől FÜGGETLENÜL, a `profiles_display_name_unique_ci`
   * indexre támaszkodva (ezért legfeljebb egy találat lehet).
   *
   * A visszatérő `userId` KIZÁRÓLAG szerveroldali használatra szolgál: a nyilvános
   * profil válaszába SOHA nem kerül bele. A `displayName` a tárolt, eredeti írásmód.
   */
  findByName(name: string): Promise<{ userId: string; displayName: string } | null>;
  /**
   * ELŐTAG-keresés névre, kis-nagybetűtől függetlenül. Legfeljebb `limit`
   * találat, determinisztikus (név szerinti) sorrendben.
   *
   * Szándékosan ELŐTAG és nem tetszőleges részlet: az előtag illeszkedik a
   * `lower(display_name)` indexhez, és nem teszi lehetővé a névtér
   * végigpásztázását egyetlen karakterrel.
   */
  searchByName(prefix: string, limit: number): Promise<{ userId: string; displayName: string }[]>;

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

  async findByName(name: string): Promise<{ userId: string; displayName: string } | null> {
    if (!supabaseAdmin) return null;
    if (!isLookupSafeDisplayName(name)) return null;
    const needle = normalizeDisplayName(name);

    // Paraméteres lekérdezés (nincs szövegösszefűzés). Az `ilike` LIKE-minta,
    // ezért az `_` karakter többet is megfoghatna – a végső egyezést ezért
    // MINDIG a `sameDisplayName()` dönti el, nem az adatbázis mintája.
    const { data, error } = await supabaseAdmin
      .from('profiles').select('id, display_name').ilike('display_name', needle).limit(5);
    if (error) { console.error('[profil] név keresés:', error.message); return null; }

    for (const row of (data ?? []) as { id: string; display_name: string | null }[]) {
      if (row.display_name && sameDisplayName(row.display_name, needle)) {
        return { userId: row.id, displayName: row.display_name };
      }
    }
    return null;
  }

  async searchByName(prefix: string, limit: number): Promise<{ userId: string; displayName: string }[]> {
    if (!supabaseAdmin) return [];
    const needle = normalizeDisplayName(prefix);
    if (!isSearchableDisplayName(needle)) return [];
    const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));

    // Paraméteres lekérdezés (nincs szövegösszefűzés). A `%` nem fordulhat elő
    // a bemenetben (az `isSearchableDisplayName` nem engedi), az `_` viszont
    // engedélyezett névkarakter ÉS LIKE-joker – ezért a végső szűrés JS-ben
    // történik, előtag-egyezésre. Így az `_` nem tud idegen nevet behozni.
    const { data, error } = await supabaseAdmin
      .from('profiles').select('id, display_name')
      .ilike('display_name', `${needle}%`)
      .order('display_name', { ascending: true })
      .limit(safeLimit * 3);
    if (error) { console.error('[profil] név keresés (előtag):', error.message); return []; }

    const lower = needle.toLowerCase();
    return ((data ?? []) as { id: string; display_name: string | null }[])
      .filter((r) => !!r.display_name && r.display_name.toLowerCase().startsWith(lower))
      .slice(0, safeLimit)
      .map((r) => ({ userId: r.id, displayName: r.display_name! }));
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

  async findByName(name: string): Promise<{ userId: string; displayName: string } | null> {
    if (!isLookupSafeDisplayName(name)) return null;
    const userId = this.takenBy.get(normalizeDisplayName(name).toLowerCase());
    if (!userId) return null;
    const displayName = this.byUser.get(userId);
    return displayName ? { userId, displayName } : null;
  }

  async searchByName(prefix: string, limit: number): Promise<{ userId: string; displayName: string }[]> {
    const needle = normalizeDisplayName(prefix);
    if (!isSearchableDisplayName(needle)) return [];
    const lower = needle.toLowerCase();
    return [...this.byUser.entries()]
      .filter(([, name]) => name.toLowerCase().startsWith(lower))
      .sort((a, b) => a[1].localeCompare(b[1], 'hu'))
      .slice(0, Math.min(50, Math.max(1, Math.floor(limit))))
      .map(([userId, displayName]) => ({ userId, displayName }));
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
