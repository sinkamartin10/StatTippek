/**
 * Nyilvános PRO-felhasználószám – közös típusok.
 *
 * A nyilvánosan megjelenített szám MINDIG a ténylegesen aktív PRO-előfizetők
 * száma, kézi érték nincs: az admin csak azt dönti el, hogy látszódjon-e.
 * Aktív PRO = ugyanaz a szabály, mint a jogosultság-ellenőrzésnél
 * (`profileIsPro` / `is_pro()`): subscription_status = 'pro', és nincs
 * lejárat, vagy a lejárat a jövőben van.
 */

/** Az `app_settings` kulcsa, ahol a megjelenítési beállítás tartósan él. */
export const PRO_COUNTER_SETTING_KEY = 'public_pro_counter';

export const ACTIVE_PRO_DEFINITION = 'subscription_status = „pro”, és nincs lejárat vagy a lejárat a jövőben van (ugyanaz a szabály, mint a PRO-jogosultság ellenőrzésénél)';

/** Nyilvános válasz: a szám csak akkor szerepel, ha a megjelenítés be van kapcsolva. */
export interface PublicProCount {
  show: boolean;
  count: number | null;
}

/** Admin nézet. */
export interface AdminProStats {
  /** a ténylegesen aktív PRO-előfizetők száma (frissen számolva); null, ha nem számolható (nincs adatbázis) */
  activeProCount: number | null;
  showPublic: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  definition: string;
}

/** „13 PRO-felhasználó” – ezres tagolással, nem törhető szóközzel. */
export function formatProUsers(count: number): string {
  return `${String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} PRO-felhasználó`;
}
