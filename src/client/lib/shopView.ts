/**
 * Shop felületi logika – TISZTA függvények, React nélkül.
 *
 * Itt él minden olyan döntés, amit a felület a MÁR MEGKAPOTT szerveradatból
 * hoz: szűrés, rendezés, csoportosítás, állapot-feliratok, hibaszövegek és az
 * élő előnézet összeállítása.
 *
 * AMIT EZ A MODUL SOHA NEM TESZ:
 *   - nem számol árat, ritkaságot, birtoklást vagy egyenleget (mind a szerverről jön),
 *   - nem dönt vásárlásról és felvételről (azt a szerver dönti el),
 *   - nem ír semmit: az előnézet kizárólag lokális, levezetett állapot.
 */
import {
  CATEGORY_LABEL, CATEGORY_TO_SLOT, RARITY_LABEL, RARITY_ORDER, SHOP_CATEGORIES,
  type ProfileSlot, type Rarity, type ShopCategory, type ShopEquips, type ShopItem, type ShopItemView,
} from '@shared/shop';

// ---------------------------------------------------------------------------
// Kategória-szűrő
// ---------------------------------------------------------------------------

export type CategoryFilter = 'all' | ShopCategory;

/** A szűrő lehetőségei. A kategóriák a BACKEND enumjából jönnek, nem kézzel. */
export const CATEGORY_FILTERS: { value: CategoryFilter; label: string }[] = [
  { value: 'all', label: 'Összes' },
  ...SHOP_CATEGORIES.map((c) => ({ value: c as CategoryFilter, label: CATEGORY_LABEL[c] })),
];

/** Kliensoldali szűrés a MÁR betöltött katalógusból – nincs újabb szerverkérés. */
export function filterByCategory<T extends { category: ShopCategory }>(items: T[], filter: CategoryFilter): T[] {
  return filter === 'all' ? items : items.filter((i) => i.category === filter);
}

/** Csak a birtokolt itemek (a „Saját elemeim" nézethez). */
export const onlyOwned = <T extends { owned: boolean }>(items: T[]): T[] => items.filter((i) => i.owned);

// ---------------------------------------------------------------------------
// Rendezés
// ---------------------------------------------------------------------------

export type SortKey = 'recommended' | 'price_asc' | 'price_desc' | 'rarity' | 'owned_first';

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'recommended', label: 'Ajánlott' },
  { value: 'price_asc', label: 'Ár szerint ↑' },
  { value: 'price_desc', label: 'Ár szerint ↓' },
  { value: 'rarity', label: 'Ritkaság' },
  { value: 'owned_first', label: 'Megvettek elöl' },
];

/**
 * Rendezés. STABIL: minden összehasonlítás holtversenyét a kategória, a
 * `sortOrder` és végül az item kulcsa oldja fel, ezért ugyanaz a bemenet mindig
 * ugyanazt a sorrendet adja.
 */
export function sortItems(items: ShopItemView[], key: SortKey): ShopItemView[] {
  const base = (a: ShopItemView, b: ShopItemView) =>
    SHOP_CATEGORIES.indexOf(a.category) - SHOP_CATEGORIES.indexOf(b.category)
    || a.sortOrder - b.sortOrder
    || a.itemKey.localeCompare(b.itemKey);

  const cmp: Record<SortKey, (a: ShopItemView, b: ShopItemView) => number> = {
    // A szerver sorrendje (kategória + sortOrder) – a katalógus marad az authority
    recommended: base,
    price_asc: (a, b) => a.priceCoins - b.priceCoins || base(a, b),
    price_desc: (a, b) => b.priceCoins - a.priceCoins || base(a, b),
    rarity: (a, b) => RARITY_ORDER[b.rarity] - RARITY_ORDER[a.rarity] || a.priceCoins - b.priceCoins || base(a, b),
    owned_first: (a, b) => Number(b.owned) - Number(a.owned) || base(a, b),
  };
  return [...items].sort(cmp[key]);
}

// ---------------------------------------------------------------------------
// Állapot-feliratok
// ---------------------------------------------------------------------------

export type ItemAction = 'buy' | 'equip' | 'unequip' | 'blocked';

/**
 * Milyen műveletet kínálunk az itemen? A `equipped` a FELVETT állapot a
 * profil-beállításból, az `owned` a készletből – mindkettő szerveradat.
 */
export function actionFor(item: ShopItemView, equipped: boolean): ItemAction {
  if (equipped) return 'unequip';
  if (item.owned) return 'equip';
  return item.purchasable ? 'buy' : 'blocked';
}

export const ACTION_LABEL: Record<ItemAction, string> = {
  buy: 'Megveszem',
  equip: 'Felveszem',
  unequip: 'Leveszem',
  blocked: 'Nem elérhető',
};

/** Rövid állapot-címke a kártya sarkára. `null` = nincs külön jelölés. */
export function stateBadge(item: ShopItemView, equipped: boolean): { label: string; tone: 'equipped' | 'owned' | 'blocked' } | null {
  if (equipped) return { label: 'Felvéve', tone: 'equipped' };
  if (item.owned) return { label: 'Megvan', tone: 'owned' };
  if (item.blockedReason === 'expired') return { label: 'Lejárt', tone: 'blocked' };
  if (item.blockedReason === 'inactive') return { label: 'Kivonva', tone: 'blocked' };
  return null;
}

/** Miért nem vehető meg? EMBERI nyelven, a szerver által számolt adatból. */
export function blockedText(item: ShopItemView, balance: number): string | null {
  switch (item.blockedReason) {
    case 'owned': return 'Ez már a tiéd.';
    case 'inactive': return 'Ez az elem jelenleg nem kapható.';
    case 'expired': return 'Ennek az elemnek lejárt az elérhetősége.';
    case 'insufficient_coins': return `Még ${formatCoins(Math.max(0, item.priceCoins - balance))} coin kell hozzá.`;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Hibaszövegek
// ---------------------------------------------------------------------------

/**
 * A szerver hibájából EMBERI szöveg. A `missing` / `balance` / `priceCoins`
 * értékeket a SZERVER számolja (a 402 `details`-éből) – itt nem számolunk újra.
 * DB-részlet, SQL-állapot és verem sosem jelenik meg: ha nem ismerjük a kódot,
 * általános üzenetet adunk.
 */
export function purchaseErrorText(
  e: { status?: number; code?: string; message?: string; details?: Record<string, unknown> },
): string {
  const missing = typeof e.details?.missing === 'number' ? (e.details.missing as number) : null;
  switch (e.code) {
    case 'INSUFFICIENT_COINS':
      return missing != null
        ? `Nincs elég coinod. Még ${formatCoins(missing)} coin kell hozzá.`
        : 'Nincs elég coinod ehhez az elemhez.';
    case 'ITEM_ALREADY_OWNED': return 'Ez az elem már a tiéd.';
    case 'ITEM_NOT_FOUND': return 'Ez az elem nem található.';
    case 'ITEM_INACTIVE': return 'Ez az elem jelenleg nem kapható.';
    case 'ITEM_EXPIRED': return 'Ennek az elemnek lejárt az elérhetősége.';
    case 'INVALID_ITEM_KEY': return 'Érvénytelen elem.';
    case 'ITEM_NOT_OWNED': return 'Ez az elem nincs a készletedben.';
    case 'SLOT_CATEGORY_MISMATCH': return 'Ez az elem nem ebbe a helyre tartozik.';
    case 'INVALID_SLOT': return 'Érvénytelen hely.';
    case 'AUTH_REQUIRED': return 'Jelentkezz be a folytatáshoz.';
    default: break;
  }
  if (e.status === 401) return 'Jelentkezz be a folytatáshoz.';
  if (e.status === 403) return 'Ehhez nincs jogosultságod.';
  if (e.status === 404) return 'Ez az elem nem található.';
  if (e.status === 409) return 'Ez a művelet most nem végezhető el.';
  if (e.status === 410) return 'Ez az elem már nem elérhető.';
  if (e.status === 422) return 'Érvénytelen kérés.';
  return 'A művelet most nem sikerült. Próbáld újra kicsit később.';
}

// ---------------------------------------------------------------------------
// Élő előnézet
// ---------------------------------------------------------------------------

/**
 * Az előnézethez használt megjelenés: a FELVETT állapot, a kipróbált itemmel
 * felülírva. LEVEZETETT érték – a tárolt beállítást nem módosítja, és nem
 * keletkezik belőle sem kérés, sem írás.
 */
export function previewEquips(current: ShopEquips, tried: ShopItem | null): ShopEquips {
  if (!tried) return { ...current };
  return { ...current, [CATEGORY_TO_SLOT[tried.category]]: tried.itemKey };
}

/** Melyik slotba kerülne az item? A kategóriából, egyetlen leképezéssel. */
export const slotOf = (item: Pick<ShopItem, 'category'>): ProfileSlot => CATEGORY_TO_SLOT[item.category];

/** Fel van-e véve az adott item? A szerver `shop` állapotából. */
export const isEquipped = (equips: ShopEquips, item: Pick<ShopItem, 'category' | 'itemKey'>): boolean =>
  equips[CATEGORY_TO_SLOT[item.category]] === item.itemKey;

// ---------------------------------------------------------------------------
// Megjelenítési segédek
// ---------------------------------------------------------------------------

/**
 * Ezres csoportosítás magyar módra: 2450 → „2 450".
 * SZÁNDÉKOSAN nem `toLocaleString`: annak kimenete az ICU-adattól függ (a
 * Node és a böngésző eltérhet), ez pedig mindenhol ugyanazt adja.
 */
export function formatCoins(n: number): string {
  const v = Math.trunc(Math.abs(Number.isFinite(n) ? n : 0));
  const grouped = String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (n < 0 ? '-' : '') + grouped;
}

export const rarityLabel = (r: Rarity): string => RARITY_LABEL[r];

/** A ritkaság CSS-osztálya (a színeket a styles.css tokenjei adják). */
export const rarityClass = (r: Rarity): string => `rarity-${r}`;

/** Kategória szerint csoportosítva, a katalógus sorrendjét megtartva. */
export function groupByCategory(items: ShopItemView[]): { category: ShopCategory; label: string; items: ShopItemView[] }[] {
  return SHOP_CATEGORIES
    .map((category) => ({ category, label: CATEGORY_LABEL[category], items: items.filter((i) => i.category === category) }))
    .filter((g) => g.items.length > 0);
}

/** Összegző számok a fejléchez – mind a megkapott listából. */
export function catalogSummary(items: ShopItemView[]): { total: number; owned: number; affordable: number } {
  return {
    total: items.length,
    owned: items.filter((i) => i.owned).length,
    affordable: items.filter((i) => i.purchasable).length,
  };
}
