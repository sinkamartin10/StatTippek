/**
 * FREE napi Tippverseny-kvóta – EGYETLEN konfigurációs hely.
 *
 * Üzleti szabály:
 *  - FREE felhasználó naponta legfeljebb 3 ÚJ Tippverseny-tippet adhat le,
 *  - a kvóta USER-szintű és versenyfüggetlen (minden aktív verseny együtt számít),
 *  - meglévő tipp MÓDOSÍTÁSA nem fogyaszt kvótát,
 *  - a nap Europe/Budapest szerint fordul,
 *  - PRO felhasználóra nincs limit.
 *
 * A napszámítás a küldetéseknél már bevezetett, DST-biztos eszközöket használja
 * újra (`dayKey`, `periodEndsAt`) – szándékosan nincs második időzóna-logika.
 * Az adatbázis UTC dátuma SOHA nem üzleti szabály.
 */
import { MISSION_TZ, dayKey, periodEndsAt } from './missions';

/** A FREE csomag napi ÚJ tipp limitje. Innen jön minden ellenőrzés és kijelzés. */
export const FREE_DAILY_PREDICTION_LIMIT = 3;

/** A kvóta időzónája – azonos a küldetésekével, hogy a két számláló ne csúszhasson el. */
export const QUOTA_TZ = MISSION_TZ;

/** Egy budapesti nap félig nyitott intervalluma: [start, end). */
export interface DayWindow {
  /** a nap első pillanata, ISO */
  start: string;
  /** a KÖVETKEZŐ nap első pillanata, ISO – a számlálás ezt már nem tartalmazza */
  end: string;
  /** a nap kulcsa, YYYY-MM-DD (budapesti naptár szerint) */
  key: string;
}

/**
 * A megadott pillanatot tartalmazó budapesti nap intervalluma.
 *
 * A nap VÉGE a már tesztelt `periodEndsAt('daily')`. A nap KEZDETE az előző nap vége:
 * 24 órával korábbra lépve biztosan az előző budapesti napban vagyunk (egy nap hossza
 * az időszámítás-váltás miatt 23–25 óra, ezért a visszalépés sosem ugrik át két napot),
 * és annak a napnak a vége éppen a keresett nyitó pillanat. Így a téli/nyári
 * időszámítás váltása sem tud elcsúszást okozni.
 */
export function budapestDayWindow(at: Date = new Date()): DayWindow {
  return {
    start: snapToMinute(periodEndsAt('daily', new Date(at.getTime() - 86_400_000))),
    end: snapToMinute(periodEndsAt('daily', at)),
    key: dayKey(at),
  };
}

/**
 * A napváltás pillanatára igazítás percre.
 *
 * A `periodEndsAt` bináris keresése a valódi határ FELETT áll meg, legfeljebb egy
 * percre tőle, és a pontos eredmény a kiindulási időponttól is függ. A budapesti
 * napváltás viszont mindig egész percre (sőt egész órára) esik, ezért lefelé
 * percre kerekítve pontosan a határt kapjuk. Így a `resetAt` ugyanarra a napra
 * MINDIG bitre azonos – két egymás utáni kérés nem adhat eltérő értéket.
 */
function snapToMinute(iso: string): string {
  return new Date(Math.floor(new Date(iso).getTime() / 60_000) * 60_000).toISOString();
}

/** A kliensnek visszaadott kvóta-állapot. A szerver számolja – a kliens értéke sosem forrás. */
export interface DailyQuota {
  limit: number;
  used: number;
  remaining: number;
  /** a következő budapesti nap kezdete, ISO – ekkor indul újra a számláló */
  resetAt: string;
}

/** Kvóta-állapot a felhasznált darabszámból. `used` felül is lehet a limiten – a remaining akkor 0. */
export function quotaFrom(used: number, window: DayWindow, limit = FREE_DAILY_PREDICTION_LIMIT): DailyQuota {
  const safeUsed = Math.max(0, Math.floor(used));
  return { limit, used: safeUsed, remaining: Math.max(0, limit - safeUsed), resetAt: window.end };
}

/** Rövid, felületre szánt szöveg. Csak tájékoztatás – a szerver marad a source of truth. */
export const quotaLabel = (q: DailyQuota): string =>
  (q.remaining > 0 ? `Mai tippek: ${q.used} / ${q.limit}` : 'Mai tippkereted elfogyott.');
