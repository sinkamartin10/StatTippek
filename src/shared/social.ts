/**
 * Social réteg – követés, játékos-keresés és Top Tipsterek.
 *
 * EGYETLEN KONFIGURÁCIÓS HELY a social korlátokhoz és a Top Tipster
 * küszöbökhöz. A válaszok itt is ENGEDÉLYEZŐ LISTÁval épülnek: a szerializálók
 * mezőnként raknak össze mindent, nyers adatbázis-sor nem jut ki.
 *
 * AMI SOHA NEM KERÜLHET BE: user_id, e-mail, coin, vásárlás, Stripe-adat,
 * privát tipp, privát párbaj-adat, belső adatbázis-azonosító.
 *
 * A követés TISZTÁN SOCIAL: nem ad XP-t, coint, kozmetikumot, és semmilyen
 * pontozást vagy ranglistát nem befolyásol.
 */

// ===========================================================================
// 1) Korlátok – minden kötött, nincs korlátlan lekérdezés
// ===========================================================================

/** Játékos-keresés: ennyi találatot adunk vissza legfeljebb. */
export const SEARCH_LIMIT = 10;
/** Ennél rövidebb keresőszóra nem indul adatbázis-lekérdezés. */
export const SEARCH_MIN_LENGTH = 2;

/** Követettek / követők lista oldalmérete. */
export const FOLLOW_PAGE_SIZE = 20;
export const FOLLOW_PAGE_MAX = 50;

/** Top Tipsterek: hány versenyt nézünk át a jelöltkör összeállításához. */
export const TOP_COMPETITION_LIMIT = 10;
/** Top Tipsterek: hány jelöltet dolgozunk fel legfeljebb. */
export const TOP_CANDIDATE_LIMIT = 200;
/** Kategóriánként ennyi játékos jelenik meg. */
export const TOP_LIST_SIZE = 10;

/**
 * Minimum mintaméret kategóriánként. Kis mintán a „legjobb" cím félrevezető
 * lenne, ezért aki ez alatt van, az NEM kerül rangsorba – nem hamisítunk.
 */
export const MIN_SETTLED_FOR_ACCURACY = 10;
export const MIN_PREDICTIONS_FOR_EXACT = 10;
export const MIN_STREAK_FOR_FORM = 3;

// ===========================================================================
// 2) Követés
// ===========================================================================

/** Egy játékos social kártyája – pontosan ennyi mező, se több. */
export interface PlayerCard {
  displayName: string;
  level: number;
  levelTier: string;
  /** helyes / kiértékelt – null, ha még nincs kiértékelt tipp (sosem NaN) */
  accuracy: number | null;
  /** megjelenéshez: a szerver által ellenőrzött kozmetikumok */
  avatar: Record<string, string>;
  borderKey: string;
  titleKey: string;
  shop?: Record<string, string | null>;
}

export interface FollowStatus {
  displayName: string;
  /** követi-e a hívó ezt a játékost */
  following: boolean;
  followerCount: number;
  followingCount: number;
}

export interface FollowListResponse {
  players: PlayerCard[];
  /** van-e még a lapozásban */
  hasMore: boolean;
  /** a következő lap kurzora (ISO időbélyeg), vagy null */
  nextBefore: string | null;
}

export interface PlayerSearchResponse {
  players: PlayerCard[];
}

// ===========================================================================
// 3) Top Tipsterek
// ===========================================================================

export type TopCategory = 'form' | 'accuracy' | 'exactScore' | 'competition';

export const TOP_CATEGORY_LABEL: Record<TopCategory, string> = {
  form: '🔥 Forma',
  accuracy: '🎯 Pontosság',
  exactScore: '💎 Exact Score',
  competition: '🏆 Tippverseny',
};

/**
 * Vizuális fokozat – KIZÁRÓLAG a listán belüli helyezésből, determinisztikusan.
 *
 * SZÁNDÉKOSAN NEM percentilis: ahhoz a teljes játékosbázis aggregálása kellene
 * minden megjelenítésnél. A fokozat a kategórialista helyezéséből jön:
 *
 *    1. hely          → GOLD
 *    2–3. hely        → SILVER
 *    4–10. hely       → BRONZE
 *
 * A fokozat NEM vásárolható, nem függ cointól és kozmetikumtól, és semmilyen
 * játékbeli előnyt nem ad – tisztán a nyilvános statisztika megjelenítése.
 */
export type TopTier = 'GOLD' | 'SILVER' | 'BRONZE';

export const tierForRank = (rank: number): TopTier =>
  (rank === 1 ? 'GOLD' : rank <= 3 ? 'SILVER' : 'BRONZE');

export interface TopTipsterEntry {
  rank: number;
  tier: TopTier;
  player: PlayerCard;
  /** a kategória mérőszáma, megjelenítésre kész szövegként */
  value: string;
  /** a mintaméret, hogy a felhasználó lássa, mire épül a sorrend */
  sample: string;
}

export interface TopTipstersResponse {
  /** csak azok a kategóriák szerepelnek, amelyek a jelen adatból HELYESEN kiszámolhatók */
  categories: { key: TopCategory; label: string; entries: TopTipsterEntry[] }[];
  /** hány játékos került a jelöltkörbe (átláthatóság) */
  poolSize: number;
}

// ===========================================================================
// 4) Szerializáló – engedélyező lista
// ===========================================================================

/** Biztonságos egész (NaN / Infinity / negatív → 0). */
const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

/**
 * Játékos-kártya összeállítása. MINDEN mező explicit: a bemenet extra mezői
 * (user_id, e-mail, coin…) nem tudnak átjutni.
 */
export function toPlayerCard(input: {
  displayName: string;
  level: number;
  levelTier: string;
  accuracy: number | null;
  avatar?: Record<string, string>;
  borderKey?: string;
  titleKey?: string;
  shop?: Record<string, string | null>;
}): PlayerCard {
  const acc = input.accuracy;
  return {
    displayName: input.displayName,
    level: int(input.level) || 1,
    levelTier: String(input.levelTier ?? ''),
    accuracy: acc == null || !Number.isFinite(acc) ? null : Math.min(1, Math.max(0, acc)),
    avatar: { ...(input.avatar ?? {}) },
    borderKey: input.borderKey ?? 'classic',
    titleKey: input.titleKey ?? 'none',
    ...(input.shop ? { shop: { ...input.shop } } : {}),
  };
}
