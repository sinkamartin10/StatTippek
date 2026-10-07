/**
 * Coin + Customization Shop – EGYETLEN konfigurációs hely.
 *
 * KÉT KÜLÖNBÖZŐ DOLOG VAN ITT, és fontos nem összekeverni őket:
 *
 *  1) COIN_REWARDS – a jutalmazási szabályok. Ezek KÓD-konfigurációk: egy helyen
 *     szerkeszthetők, és a szerver kizárólag innen veszi az értékeket. A kliens
 *     sosem küld összeget.
 *
 *  2) SHOP_SEED – az induló item-katalógus. Ez CSAK VETŐMAG: a `0011` migráció
 *     egyszer beszúrja a `shop_items` táblába, és onnantól az adatbázis az
 *     egyetlen igazság (az admin ott módosíthat árat, aktivitást, ritkaságot).
 *     A szerver FUTÁSIDŐBEN a táblából olvas, nem ebből a tömbből.
 *
 * KOMPETITÍV INTEGRITÁS: a coin kizárólag kozmetikumra váltható. Egyetlen item
 * sem ad XP-t, Tippverseny-pontot, jobb elemzést, több tipp-helyet vagy PRO
 * hozzáférést. A ritkaság és az ár is csak megjelenést és költséget jelent.
 */

// ===========================================================================
// 1) Ritkaság
// ===========================================================================

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** Rendezéshez és összehasonlításhoz. */
export const RARITY_ORDER: Record<Rarity, number> = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4,
};

export const RARITY_LABEL: Record<Rarity, string> = {
  common: 'Gyakori',
  uncommon: 'Nem gyakori',
  rare: 'Ritka',
  epic: 'Epikus',
  legendary: 'Legendás',
};

/**
 * A ritkaság megjelenítési kulcsa. A konkrét CSS-t a felület adja; itt csak a
 * szándékolt erősséget jelöljük, hogy ne legyen vizuális káosz:
 *   common    – semleges, nincs effekt
 *   uncommon  – halvány derengés
 *   rare      – erősebb keret/derengés
 *   epic      – gradiens + látványosabb derengés
 *   legendary – animált, de visszafogott (shimmer)
 */
export const RARITY_TONE: Record<Rarity, { color: string; glow: 'none' | 'soft' | 'strong' | 'gradient' | 'animated' }> = {
  common: { color: '#98a2b3', glow: 'none' },
  uncommon: { color: '#17b877', glow: 'soft' },
  rare: { color: '#4f6ef7', glow: 'strong' },
  epic: { color: '#8b5cf6', glow: 'gradient' },
  legendary: { color: '#f0b429', glow: 'animated' },
};

// ===========================================================================
// 2) Kategóriák
// ===========================================================================

export type ShopCategory = 'frame' | 'name_color' | 'name_effect' | 'title' | 'avatar' | 'profile_background';

export const SHOP_CATEGORIES: ShopCategory[] = [
  'frame', 'name_color', 'name_effect', 'title', 'avatar', 'profile_background',
];

export const CATEGORY_LABEL: Record<ShopCategory, string> = {
  frame: 'Keretek',
  name_color: 'Névszínek',
  name_effect: 'Név-effektek',
  title: 'Címek',
  avatar: 'Avatarok',
  profile_background: 'Profil-hátterek',
};

export const CATEGORY_ICON: Record<ShopCategory, string> = {
  frame: '🖼️', name_color: '🌈', name_effect: '✨', title: '🏷️', avatar: '👤', profile_background: '🎨',
};

/**
 * Kategóriánként egyszerre ennyi item lehet felszerelve. Mind 1: a kombinálás
 * a KATEGÓRIÁK között történik (pl. arany név + tűz effekt), nem egy
 * kategórián belül.
 */
export const MAX_EQUIPPED_PER_CATEGORY: Record<ShopCategory, number> = {
  frame: 1, name_color: 1, name_effect: 1, title: 1, avatar: 1, profile_background: 1,
};

// ===========================================================================
// 3) Coin-jutalmak – KÓD-konfiguráció, egy helyen
// ===========================================================================

/**
 * A jutalom típusa. A `source_key` ebből és a kiváltó entitásból épül, és a
 * `(user_id, source_key)` egyediség zárja ki a duplikációt – ugyanaz a tipp,
 * meccs vagy verseny sosem fizethet kétszer.
 */
export type CoinRewardType =
  | 'PREDICTION_SUBMITTED'
  | 'CORRECT_OUTCOME'
  | 'EXACT_SCORE'
  | 'STREAK_3'
  | 'DAILY_TIPS'
  | 'WEEKLY_TIPS'
  | 'COMPETITION_TOP10'
  | 'COMPETITION_FIRST';

/** Vásárlás és korrekció – ezek is a tranzakciós naplóba kerülnek. */
export type CoinSpendType = 'SHOP_PURCHASE' | 'ADMIN_ADJUSTMENT';

export type CoinTransactionType = CoinRewardType | CoinSpendType;

/**
 * A jutalmak összege. A D3 döntés szerint újraszámolva, hogy a célzott
 * megszerzési idők teljesüljenek (Common néhány nap, Rare 1–2 hét,
 * Epic 2–4 hét, Legendary 1–3 hónap) EGY AKTÍV FREE FELHASZNÁLÓNÁL,
 * aki a napi 3-as kerettel tippel. A PRO nem kap külön jutalmat: a több
 * tippelési lehetőség miatt szerez többet, ami teljesítmény, nem csomag.
 *
 * A súlyozás szándékosan a TELJESÍTMÉNYRE esik: a puszta beküldés 10 coin,
 * a helyes kimenet 75, a pontos eredmény 150.
 */
export const COIN_REWARDS: Record<CoinRewardType, number> = {
  PREDICTION_SUBMITTED: 10,
  CORRECT_OUTCOME: 75,
  EXACT_SCORE: 150,
  STREAK_3: 150,
  DAILY_TIPS: 20,
  WEEKLY_TIPS: 250,
  COMPETITION_TOP10: 400,
  COMPETITION_FIRST: 1500,
};

export const COIN_REWARD_LABEL: Record<CoinTransactionType, string> = {
  PREDICTION_SUBMITTED: 'Tipp leadása',
  CORRECT_OUTCOME: 'Helyes kimenet',
  EXACT_SCORE: 'Pontos eredmény',
  STREAK_3: '3 helyes tipp egymás után',
  DAILY_TIPS: 'Napi tippek teljesítve',
  WEEKLY_TIPS: 'Heti tippek teljesítve',
  COMPETITION_TOP10: 'Tippverseny top 10',
  COMPETITION_FIRST: 'Tippverseny 1. helyezés',
  SHOP_PURCHASE: 'Shop vásárlás',
  ADMIN_ADJUSTMENT: 'Adminisztratív korrekció',
};

/**
 * A napi bónuszhoz ennyi ÚJ Tippverseny-tipp kell. A D2 döntés szerint 3, hogy
 * a FREE felhasználó is elérhesse: a Phase 3 óta neki naponta legfeljebb 3 új
 * tippje van, ezért egy 5-ös küszöb szerkezetileg PRO-only jutalom lenne.
 */
export const DAILY_TIPS_TARGET = 3;

/** A heti bónuszhoz ennyi új tipp kell (FREE-nek is elérhető: 3×7 = 21). */
export const WEEKLY_TIPS_TARGET = 10;

/** Ennyi helyes tipp egymás után ad sorozat-bónuszt. */
export const STREAK_TARGET = 3;

/** A Tippverseny top 10 bónusz eddig a helyezésig jár. */
export const TOP10_PLACEMENT = 10;

// ===========================================================================
// 4) Idempotencia-kulcsok
//
//    A coin-jutalmazás legnagyobb kockázata a duplikáció: egy tipp
//    módosítása, egy meccs újraszinkronizálása, a verseny ismételt lezárása
//    vagy egy API-újrapróbálkozás sem fizethet újra. Ezért MINDEN jutalomnak
//    determinisztikus forráskulcsa van, és a `(user_id, source_key)` páros
//    EGYEDI az adatbázisban.
// ===========================================================================

/** Tipp-alapú jutalom: a tipp azonosítójához kötve, nem a meccshez. */
export const predictionSourceKey = (type: 'PREDICTION_SUBMITTED' | 'CORRECT_OUTCOME' | 'EXACT_SCORE', predictionId: string): string =>
  `prediction:${predictionId}:${type.toLowerCase()}`;

/**
 * Sorozat-bónusz: SORSZÁM szerint, nem a kiváltó tipp szerint. Így ha egy
 * eredmény utólag módosul és a sorozatok átrendeződnek, a kifizetett bónuszok
 * száma sosem haladhatja meg a tényleg elért sorozatok számát. (Ugyanez a
 * megoldás védi a Phase 2-ben az XP sorozat-bónuszt.)
 */
export const streakSourceKey = (ordinal: number): string => `streak:${ordinal}`;

/** Napi bónusz: budapesti nap-kulcsra (YYYY-MM-DD). */
export const dailySourceKey = (dayKey: string): string => `daily:${dayKey}`;

/** Heti bónusz: ISO hét-kulcsra (YYYY-Www). */
export const weeklySourceKey = (weekKey: string): string => `weekly:${weekKey}`;

/** Verseny-helyezés: (verseny, jutalomtípus) párra, hogy az ismételt lezárás se fizessen újra. */
export const competitionSourceKey = (competitionId: string, type: 'COMPETITION_TOP10' | 'COMPETITION_FIRST'): string =>
  `competition:${competitionId}:${type.toLowerCase()}`;

/**
 * Vásárlás forráskulcsa. PONTOSAN azt az alakot adja, amit a `0011` migráció
 * `purchase_shop_item()` függvénye ír – az adatbázis az authority, ez a helper
 * csak kiolvasható alakban ismétli meg. Időbélyeg SZÁNDÉKOSAN nincs benne:
 * egy itemet életében egyszer lehet megvenni, ezt a készlet-tábla
 * `(user_id, item_id)` egyedisége védi, nem ez a kulcs.
 */
export const purchaseSourceKey = (itemKey: string): string => `purchase:${itemKey}`;

// ===========================================================================
// 5) Adatalakok
// ===========================================================================

/** A `shop_items` tábla egy sora – az adatbázis az igazság, nem a vetőmag. */
export interface ShopItem {
  id: string;
  itemKey: string;
  category: ShopCategory;
  name: string;
  description: string | null;
  rarity: Rarity;
  priceCoins: number;
  /** megjelenítési segédadat (szín, gradiens, animáció, avatar-slot) */
  metadata: Record<string, unknown>;
  isActive: boolean;
  isLimited: boolean;
  availableUntil: string | null;
  sortOrder: number;
}

/** Egy item a felhasználó szempontjából – a szerver állítja elő. */
export interface ShopItemView extends ShopItem {
  owned: boolean;
  equipped: boolean;
  /** megvásárolható-e MOST (aktív, nem járt le, nincs meg, és van rá elég coin) */
  purchasable: boolean;
  /** ha nem vásárolható meg, ennek az oka – a felület ezt mutatja */
  blockedReason: 'owned' | 'inactive' | 'expired' | 'insufficient_coins' | null;
}

export interface CoinBalance {
  balance: number;
  updatedAt: string | null;
}

export interface CoinTransactionRow {
  id: string;
  /** pozitív = jóváírás, negatív = terhelés */
  amount: number;
  type: CoinTransactionType;
  /** emberi olvasatú megnevezés a naplóhoz */
  label: string;
  sourceKey: string;
  balanceAfter: number;
  createdAt: string;
}

/** Az `award_coins()` RPC kimenete. A DB dönt, nem az alkalmazás. */
export type CoinAwardOutcome = 'awarded' | 'already_awarded';

/** A `purchase_shop_item()` RPC kimenete. */
export type CoinPurchaseOutcome =
  | 'purchased' | 'already_owned' | 'insufficient_coins' | 'not_found' | 'inactive' | 'expired';

/** Egy jutalmazás eredménye, ahogy a szolgáltatás a hívónak adja. */
export interface CoinAwardResult {
  outcome: CoinAwardOutcome;
  /** az egyenleg a művelet UTÁN */
  balance: number;
  /** amit MOST írtunk jóvá; ismételt forráskulcsnál 0 */
  amount: number;
}

/** Egy sikeres vásárlás eredménye. A kudarcot a szolgáltatás hibaként jelzi. */
export interface CoinPurchaseResult {
  balance: number;
  item: ShopItem;
}

/**
 * Egy lap a tranzakciós naplóból. A lapozás a meglévő értesítés-konvenciót
 * követi: `limit` + `before` kurzor, `hasMore` és `nextBefore` a válaszban.
 */
export interface CoinHistoryPage {
  transactions: CoinTransactionRow[];
  /** az aktuális egyenleg ugyanebben a válaszban – nincs külön kérés */
  balance: number;
  hasMore: boolean;
  nextBefore: string | null;
}

// ===========================================================================
// 5b/5e) Profil-slotok és a felvett (equipped) shop itemek
//
//    A shop NEM vezet be második testreszabó rendszert: a megvásárolt item
//    ugyanúgy egy PROFIL-BEÁLLÍTÁS, mint a megszolgált kozmetikum. Itt csak a
//    kategória → slot leképezés és a tiszta ellenőrzés él; a tárolás és az
//    API a szerver-rétegek dolga.
//
//    A `profileBackground` SZÁNDÉKOSAN külön slot az avatar `background`
//    mezőjétől (D4 döntés): az avatar háttere az avatar-kompozíció része, ez
//    pedig a profilkártya háttere. A kettő soha nem írja felül egymást.
// ===========================================================================

/** A shop itemek profil-slotjai. A megszolgált kozmetikumok slotjaitól független. */
export type ProfileSlot = 'frame' | 'nameColor' | 'nameEffect' | 'title' | 'avatar' | 'profileBackground';

export const PROFILE_SLOTS: ProfileSlot[] = [
  'frame', 'nameColor', 'nameEffect', 'title', 'avatar', 'profileBackground',
];

/**
 * Kategória → slot. EGYETLEN forrás: sem a route, sem a felület nem dönthet
 * arról, melyik item melyik slotba kerül – és a kliens sem küldhet párosítást.
 */
export const CATEGORY_TO_SLOT: Record<ShopCategory, ProfileSlot> = {
  frame: 'frame',
  name_color: 'nameColor',
  name_effect: 'nameEffect',
  title: 'title',
  avatar: 'avatar',
  profile_background: 'profileBackground',
};

/** Slot → kategória (a visszafelé ellenőrzéshez). */
export const SLOT_TO_CATEGORY: Record<ProfileSlot, ShopCategory> = {
  frame: 'frame',
  nameColor: 'name_color',
  nameEffect: 'name_effect',
  title: 'title',
  avatar: 'avatar',
  profileBackground: 'profile_background',
};

export const PROFILE_SLOT_LABEL: Record<ProfileSlot, string> = {
  frame: 'Keret', nameColor: 'Névszín', nameEffect: 'Név-effekt',
  title: 'Cím', avatar: 'Avatar embléma', profileBackground: 'Profil-háttér',
};

/** A felvett shop itemek slotonként. `null` = ebben a slotban nincs felvett item. */
export type ShopEquips = Record<ProfileSlot, string | null>;

export const EMPTY_EQUIPS: ShopEquips = {
  frame: null, nameColor: null, nameEffect: null, title: null, avatar: null, profileBackground: null,
};

export const isProfileSlot = (v: unknown): v is ProfileSlot =>
  typeof v === 'string' && (PROFILE_SLOTS as string[]).includes(v);

/**
 * A felvett itemek ellenőrzése és „megtisztítása”. TISZTA függvény: a
 * birtoklás az AUTHORITY, nem a kliens állítása.
 *
 * Egy item csak akkor marad a slotban, ha
 *   a) a kulcs alakja érvényes,
 *   b) a felhasználó BIRTOKOLJA (benne van az `owned` térképben), és
 *   c) a kategóriája PONTOSAN ehhez a slothoz tartozik.
 * Minden más esetben a slot `null` lesz, és a kulcs a `rejected` listába kerül.
 *
 * A `owned` térképet a hívó állítja elő a készletből (itemKey → kategória);
 * így ez a függvény nem dönt arról, hogy pl. egy kivont item felvehető-e
 * marad – az üzleti döntés a hívó rétegben látszik.
 */
export function sanitizeShopEquips(
  input: Partial<ShopEquips> | null | undefined,
  owned: Map<string, ShopCategory>,
): { equips: ShopEquips; rejected: string[] } {
  const equips: ShopEquips = { ...EMPTY_EQUIPS };
  const rejected: string[] = [];

  for (const slot of PROFILE_SLOTS) {
    const wanted = input?.[slot];
    if (wanted == null) continue;              // üres slot – nem hiba
    if (!isValidItemKey(wanted)) { rejected.push(`${slot}:${String(wanted)}`); continue; }
    const category = owned.get(wanted);
    if (!category) { rejected.push(`${slot}:${wanted}`); continue; }          // nem birtokolja
    if (CATEGORY_TO_SLOT[category] !== slot) { rejected.push(`${slot}:${wanted}`); continue; } // rossz slot
    equips[slot] = wanted;
  }

  return { equips, rejected };
}

// --- API-válaszalakok (5d) --------------------------------------------------

/** `GET /api/shop/items` – a teljes aktív katalógus + a hívó egyenlege. */
export interface ShopCatalogResponse {
  items: ShopItemView[];
  balance: number;
  categories: ShopCategory[];
}

/** Egy készlet-elem a hívó saját készletéből. */
export interface InventoryItemView {
  item: ShopItem;
  /** amit TÉNYLEGESEN fizetett érte (az ár később változhat) */
  paidCoins: number;
  purchasedAt: string;
  /** jelenleg fel van-e véve – az equip-rendszer az 5e szakasz feladata */
  equipped: boolean;
}

/** `GET /api/shop/inventory` – a hívó saját készlete. */
export interface ShopInventoryResponse {
  items: InventoryItemView[];
  balance: number;
}

/** `POST /api/shop/purchase` – sikeres vásárlás. */
export interface ShopPurchaseResponse {
  itemKey: string;
  /** amit a DB levont – a route SOHA nem számolja újra */
  paidCoins: number;
  balance: number;
  item: ShopItem;
}

/** Lejárt-e egy időszakos item? SZÁMÍTOTT – a tárolt állapot nem avulhat el. */
export const itemExpired = (i: Pick<ShopItem, 'isLimited' | 'availableUntil'>, now: Date = new Date()): boolean =>
  !!(i.isLimited && i.availableUntil && new Date(i.availableUntil).getTime() <= now.getTime());

/** Megvásárolható-e az item (a birtoklás és az egyenleg nélkül)? */
export const itemPurchasable = (i: Pick<ShopItem, 'isActive' | 'isLimited' | 'availableUntil'>, now: Date = new Date()): boolean =>
  i.isActive && !itemExpired(i, now);

// ===========================================================================
// 6) Induló katalógus (VETŐMAG – a 0011 migráció szúrja be egyszer)
// ===========================================================================

type SeedItem = {
  itemKey: string;
  category: ShopCategory;
  name: string;
  rarity: Rarity;
  priceCoins: number;
  description: string;
  metadata?: Record<string, unknown>;
};

const frames: SeedItem[] = [
  { itemKey: 'frame_green', category: 'frame', name: 'Zöld keret', rarity: 'common', priceCoins: 500, description: 'Letisztult zöld profilkeret.', metadata: { color: '#17b877' } },
  { itemKey: 'frame_blue', category: 'frame', name: 'Kék keret', rarity: 'common', priceCoins: 500, description: 'Letisztult kék profilkeret.', metadata: { color: '#4f6ef7' } },
  { itemKey: 'frame_purple', category: 'frame', name: 'Lila keret', rarity: 'common', priceCoins: 500, description: 'Letisztult lila profilkeret.', metadata: { color: '#8b5cf6' } },
  { itemKey: 'frame_fire', category: 'frame', name: 'Tűz keret', rarity: 'rare', priceCoins: 2500, description: 'Lángoló szegély, meleg derengéssel.', metadata: { color: '#f5533d', animation: 'flame' } },
  { itemKey: 'frame_lightning', category: 'frame', name: 'Villám keret', rarity: 'rare', priceCoins: 2500, description: 'Elektromos kék, lüktető fénnyel.', metadata: { color: '#38bdf8', animation: 'pulse' } },
  { itemKey: 'frame_aqua', category: 'frame', name: 'Aqua keret', rarity: 'rare', priceCoins: 2500, description: 'Hűvös víz-tónus, lágy mozgással.', metadata: { color: '#22d3ee', animation: 'glow' } },
  { itemKey: 'frame_rainbow', category: 'frame', name: 'Szivárvány keret', rarity: 'rare', priceCoins: 3000, description: 'Körbefutó színátmenet.', metadata: { gradient: ['#f5533d', '#f0b429', '#17b877', '#4f6ef7', '#8b5cf6'], animation: 'sweep' } },
  { itemKey: 'frame_ice', category: 'frame', name: 'Jég keret', rarity: 'epic', priceCoins: 5000, description: 'Kristályos jégszegély, hideg csillogással.', metadata: { gradient: ['#e0f2fe', '#7dd3fc'], animation: 'glow' } },
  { itemKey: 'frame_diamond', category: 'frame', name: 'Gyémánt keret', rarity: 'epic', priceCoins: 5000, description: 'Csiszolt gyémánt-fény.', metadata: { gradient: ['#e8f4ff', '#a5c9ff'], animation: 'sweep' } },
  { itemKey: 'frame_galaxy', category: 'frame', name: 'Galaxis keret', rarity: 'epic', priceCoins: 6000, description: 'Mély űrszínek, finom csillagporral.', metadata: { gradient: ['#1e1b4b', '#4c1d95', '#7c3aed'], animation: 'sweep' } },
  { itemKey: 'frame_cosmic', category: 'frame', name: 'Kozmikus keret', rarity: 'epic', priceCoins: 6000, description: 'Nebula-színátmenet lassú mozgással.', metadata: { gradient: ['#312e81', '#db2777', '#f59e0b'], animation: 'sweep' } },
  { itemKey: 'frame_golden_crown', category: 'frame', name: 'Arany korona', rarity: 'legendary', priceCoins: 12500, description: 'Arany korona-motívum, visszafogott csillogással.', metadata: { color: '#f0b429', animation: 'shimmer', crown: true } },
  { itemKey: 'frame_dragon', category: 'frame', name: 'Sárkány keret', rarity: 'legendary', priceCoins: 15000, description: 'Sárkánypikkely-textúra, izzó éllel.', metadata: { gradient: ['#7f1d1d', '#f5533d', '#f0b429'], animation: 'shimmer' } },
  { itemKey: 'frame_legendary_aura', category: 'frame', name: 'Legendás aura', rarity: 'legendary', priceCoins: 15000, description: 'Lélegző aura a profil körül.', metadata: { gradient: ['#f0b429', '#fde68a'], animation: 'shimmer' } },
  { itemKey: 'frame_animated_diamond', category: 'frame', name: 'Animált gyémánt', rarity: 'legendary', priceCoins: 20000, description: 'A legritkább keret: futó fény a gyémánt élein.', metadata: { gradient: ['#ffffff', '#a5c9ff', '#8b5cf6'], animation: 'shimmer' } },
];

const nameColors: SeedItem[] = [
  { itemKey: 'name_green', category: 'name_color', name: 'Zöld név', rarity: 'common', priceCoins: 300, description: 'Zöld névszín.', metadata: { color: '#17b877' } },
  { itemKey: 'name_blue', category: 'name_color', name: 'Kék név', rarity: 'common', priceCoins: 300, description: 'Kék névszín.', metadata: { color: '#4f6ef7' } },
  { itemKey: 'name_purple', category: 'name_color', name: 'Lila név', rarity: 'common', priceCoins: 300, description: 'Lila névszín.', metadata: { color: '#8b5cf6' } },
  { itemKey: 'name_red', category: 'name_color', name: 'Vörös név', rarity: 'common', priceCoins: 300, description: 'Vörös névszín.', metadata: { color: '#e23d4b' } },
  { itemKey: 'name_gold', category: 'name_color', name: 'Arany név', rarity: 'rare', priceCoins: 1500, description: 'Arany névszín.', metadata: { color: '#f0b429' } },
  { itemKey: 'name_cyan', category: 'name_color', name: 'Cián név', rarity: 'rare', priceCoins: 1500, description: 'Cián névszín.', metadata: { color: '#22d3ee' } },
  { itemKey: 'name_pink', category: 'name_color', name: 'Rózsaszín név', rarity: 'rare', priceCoins: 1500, description: 'Rózsaszín névszín.', metadata: { color: '#ec4899' } },
  { itemKey: 'name_diamond', category: 'name_color', name: 'Gyémánt név', rarity: 'epic', priceCoins: 4000, description: 'Hideg gyémánt-színátmenet.', metadata: { gradient: ['#e8f4ff', '#a5c9ff'] } },
  { itemKey: 'name_rainbow', category: 'name_color', name: 'Szivárvány név', rarity: 'epic', priceCoins: 5000, description: 'Karakterenként változó színátmenet.', metadata: { gradient: ['#f5533d', '#f0b429', '#17b877', '#4f6ef7', '#8b5cf6'], perCharacter: true } },
];

const nameEffects: SeedItem[] = [
  { itemKey: 'effect_glow', category: 'name_effect', name: 'Derengés', rarity: 'rare', priceCoins: 1500, description: 'Lágy fény a név körül.', metadata: { effect: 'glow' } },
  { itemKey: 'effect_shimmer', category: 'name_effect', name: 'Csillámlás', rarity: 'rare', priceCoins: 2000, description: 'Végigfutó csillanás.', metadata: { effect: 'shimmer' } },
  { itemKey: 'effect_fire', category: 'name_effect', name: 'Tűz effekt', rarity: 'epic', priceCoins: 4000, description: 'Meleg, pislákoló fény.', metadata: { effect: 'fire' } },
  { itemKey: 'effect_ice', category: 'name_effect', name: 'Jég effekt', rarity: 'epic', priceCoins: 4000, description: 'Hideg, kristályos ragyogás.', metadata: { effect: 'ice' } },
  { itemKey: 'effect_electric', category: 'name_effect', name: 'Elektromos effekt', rarity: 'epic', priceCoins: 4500, description: 'Elektromos lüktetés.', metadata: { effect: 'electric' } },
  { itemKey: 'effect_rainbow', category: 'name_effect', name: 'Szivárvány effekt', rarity: 'legendary', priceCoins: 8000, description: 'A legritkább effekt: folyamatos színhullám.', metadata: { effect: 'rainbow' } },
];

/**
 * Shop-címek. A D1 döntés szerint SZÁNDÉKOSAN nem ütköznek a megszolgálható
 * címekkel: a `Tipster`, `Analyst`, `Expert`, `Legend` és `Champion` kizárólag
 * szintből és achievementből szerezhető, és a shopban nem kapható.
 */
const titles: SeedItem[] = [
  { itemKey: 'title_predictor', category: 'title', name: 'Predictor', rarity: 'common', priceCoins: 750, description: 'Aki rendszeresen tippel.' },
  { itemKey: 'title_rising_star', category: 'title', name: 'Rising Star', rarity: 'rare', priceCoins: 1500, description: 'Felfelé tartó forma.' },
  { itemKey: 'title_hot_hand', category: 'title', name: 'Hot Hand', rarity: 'rare', priceCoins: 2500, description: 'Aki épp nem hibázik.' },
  { itemKey: 'title_risk_taker', category: 'title', name: 'Risk Taker', rarity: 'rare', priceCoins: 3000, description: 'Bátor tippek kedvelője.' },
  { itemKey: 'title_clutch', category: 'title', name: 'Clutch', rarity: 'epic', priceCoins: 5000, description: 'Amikor a legnagyobb a nyomás.' },
  { itemKey: 'title_streak_hunter', category: 'title', name: 'Streak Hunter', rarity: 'epic', priceCoins: 5000, description: 'Sorozatokra játszik.' },
  { itemKey: 'title_mastermind', category: 'title', name: 'Mastermind', rarity: 'epic', priceCoins: 7500, description: 'Aki előre látja a meccset.' },
  { itemKey: 'title_goat', category: 'title', name: 'GOAT', rarity: 'legendary', priceCoins: 20000, description: 'A legdrágább cím a shopban.' },
];

/**
 * Shop-avatarok. A meglévő avatar-rendszert használják: a `metadata.avatarSlot`
 * mondja meg, melyik slotba kerülnek. Nincs második avatar-rendszer.
 * (A slot-hozzárendelés véglegesítése az 5e szakasz feladata.)
 */
const avatars: SeedItem[] = [
  { itemKey: 'avatar_football', category: 'avatar', name: 'Futball embléma', rarity: 'common', priceCoins: 750, description: 'Klasszikus futball-motívum.', metadata: { avatarSlot: 'accessory', emblem: 'football' } },
  { itemKey: 'avatar_tipster', category: 'avatar', name: 'Tippmester embléma', rarity: 'common', priceCoins: 1000, description: 'A tippelő jelvénye.', metadata: { avatarSlot: 'accessory', emblem: 'tipster' } },
  { itemKey: 'avatar_brain', category: 'avatar', name: 'Agy embléma', rarity: 'rare', priceCoins: 1500, description: 'Az elemző jelvénye.', metadata: { avatarSlot: 'accessory', emblem: 'brain' } },
  { itemKey: 'avatar_fire', category: 'avatar', name: 'Tűz embléma', rarity: 'rare', priceCoins: 2500, description: 'Forró forma.', metadata: { avatarSlot: 'accessory', emblem: 'fire' } },
  { itemKey: 'avatar_ai', category: 'avatar', name: 'AI embléma', rarity: 'epic', priceCoins: 5000, description: 'Az algoritmus jelvénye.', metadata: { avatarSlot: 'accessory', emblem: 'ai' } },
  { itemKey: 'avatar_diamond', category: 'avatar', name: 'Gyémánt embléma', rarity: 'epic', priceCoins: 5000, description: 'Csiszolt gyémánt-jelvény.', metadata: { avatarSlot: 'accessory', emblem: 'diamond' } },
  { itemKey: 'avatar_champion', category: 'avatar', name: 'Bajnok embléma', rarity: 'epic', priceCoins: 7500, description: 'A győztesek jelvénye.', metadata: { avatarSlot: 'accessory', emblem: 'champion' } },
  { itemKey: 'avatar_goat', category: 'avatar', name: 'GOAT embléma', rarity: 'legendary', priceCoins: 10000, description: 'A legritkább embléma.', metadata: { avatarSlot: 'accessory', emblem: 'goat' } },
];

/**
 * Profil-hátterek. KÜLÖN rendszer az `avatar.background` slottól (D4 döntés):
 * az avatar háttere az avatar-kompozíció része, ez pedig a profilkártya háttere.
 */
const backgrounds: SeedItem[] = [
  { itemKey: 'bg_stadium', category: 'profile_background', name: 'Stadion', rarity: 'rare', priceCoins: 1500, description: 'Esti stadion-hangulat.', metadata: { gradient: ['#0f172a', '#1e293b'] } },
  { itemKey: 'bg_pitch', category: 'profile_background', name: 'Futballpálya', rarity: 'rare', priceCoins: 1500, description: 'Friss pálya felülről.', metadata: { gradient: ['#064e3b', '#17b877'] } },
  { itemKey: 'bg_galaxy', category: 'profile_background', name: 'Galaxis', rarity: 'epic', priceCoins: 4000, description: 'Csillagos mély ég.', metadata: { gradient: ['#1e1b4b', '#4c1d95'] } },
  { itemKey: 'bg_fire', category: 'profile_background', name: 'Tűz', rarity: 'epic', priceCoins: 4000, description: 'Izzó háttér.', metadata: { gradient: ['#7f1d1d', '#f5533d'] } },
  { itemKey: 'bg_ice', category: 'profile_background', name: 'Jég', rarity: 'epic', priceCoins: 4000, description: 'Jeges, hűvös háttér.', metadata: { gradient: ['#0c4a6e', '#7dd3fc'] } },
  { itemKey: 'bg_gold', category: 'profile_background', name: 'Arany', rarity: 'epic', priceCoins: 7500, description: 'Meleg arany tónus.', metadata: { gradient: ['#78350f', '#f0b429'] } },
  { itemKey: 'bg_cosmic', category: 'profile_background', name: 'Kozmikus', rarity: 'legendary', priceCoins: 10000, description: 'A legritkább háttér: nebula-színek.', metadata: { gradient: ['#312e81', '#db2777', '#f59e0b'] } },
];

/**
 * A teljes induló katalógus. CSAK VETŐMAG: a `0011` migráció szúrja be a
 * `shop_items` táblába `on conflict (item_key) do nothing`-gal, tehát az
 * újrafuttatás nem ír felül admin által módosított árat vagy állapotot.
 */
export const SHOP_SEED: SeedItem[] = [
  ...frames, ...nameColors, ...nameEffects, ...titles, ...avatars, ...backgrounds,
];

export const SHOP_SEED_KEYS = new Set(SHOP_SEED.map((i) => i.itemKey));

/** Az item kulcsának megengedett alakja – a kliens csak ilyet küldhet. */
export const ITEM_KEY_PATTERN = /^[a-z0-9_]{3,64}$/;
export const isValidItemKey = (k: unknown): k is string =>
  typeof k === 'string' && ITEM_KEY_PATTERN.test(k);

// ===========================================================================
// 7) Lekérdezési korlátok
// ===========================================================================

export const COIN_HISTORY_DEFAULT_LIMIT = 25;
export const COIN_HISTORY_MAX_LIMIT = 100;

/** Az egyenleg sosem lehet negatív – az adatbázis CHECK-je is ezt mondja. */
export const MIN_BALANCE = 0;
/** Védőháló a korrekciókra: ennél nagyobb egyetlen tranzakció sem lehet. */
export const MAX_TRANSACTION_ABS = 1_000_000;
