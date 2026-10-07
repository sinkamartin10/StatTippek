/**
 * Shop felületi logika (5f).
 *
 * A projekt tesztkészletében nincs DOM-futtató (jsdom) és nincs
 * @testing-library – új tesztkönyvtárat ebben a fázisban nem vezetek be.
 * Ezért a felület minden DÖNTÉSE a `src/client/lib/shopView.ts` tiszta
 * függvényeibe került, és azokat teszteljük: szűrés, rendezés, állapot-
 * feliratok, hibaszövegek és az élő előnézet összeállítása.
 *
 * Amit ez a fájl NEM tud bizonyítani: a tényleges DOM-kimenetet és a
 * reszponzív viselkedést. Azt valódi böngészőben, három képernyőméreten
 * ellenőriztem (lásd az 5f reportot).
 */
import { describe, expect, it } from 'vitest';
import {
  ACTION_LABEL, CATEGORY_FILTERS, SORT_OPTIONS, actionFor, blockedText, catalogSummary,
  filterByCategory, formatCoins, groupByCategory, isEquipped, onlyOwned, previewEquips,
  purchaseErrorText, rarityClass, slotOf, sortItems, stateBadge,
} from '../src/client/lib/shopView';
import {
  CATEGORY_LABEL, CATEGORY_TO_SLOT, EMPTY_EQUIPS, PROFILE_SLOTS, RARITY_LABEL, RARITY_ORDER,
  SHOP_CATEGORIES, SHOP_SEED,
  type ShopCategory, type ShopEquips, type ShopItem, type ShopItemView,
} from '../src/shared/shop';
import { api } from '../src/client/lib/api';

/** Egy katalógus-elem a vetőmagból, a szerver által számolt mezőkkel. */
function view(itemKey: string, over: Partial<ShopItemView> = {}): ShopItemView {
  const seed = SHOP_SEED.find((i) => i.itemKey === itemKey);
  if (!seed) throw new Error(`nincs ilyen seed item: ${itemKey}`);
  return {
    id: `id-${itemKey}`,
    itemKey: seed.itemKey,
    category: seed.category,
    name: seed.name,
    description: seed.description,
    rarity: seed.rarity,
    priceCoins: seed.priceCoins,
    metadata: seed.metadata ?? {},
    isActive: true,
    isLimited: false,
    availableUntil: null,
    sortOrder: 0,
    owned: false,
    equipped: false,
    purchasable: true,
    blockedReason: null,
    ...over,
  };
}

const item = (key: string): ShopItem => view(key);

// ===========================================================================
// Katalógus: szűrés és csoportosítás
// ===========================================================================

describe('Shop UI – katalógus', () => {
  it('G1. a kategória-szűrő a BACKEND enumjából épül (nincs kézi lista)', () => {
    expect(CATEGORY_FILTERS[0]).toEqual({ value: 'all', label: 'Összes' });
    expect(CATEGORY_FILTERS.slice(1).map((f) => f.value)).toEqual(SHOP_CATEGORIES);
    for (const c of SHOP_CATEGORIES) {
      expect(CATEGORY_FILTERS.find((f) => f.value === c)!.label).toBe(CATEGORY_LABEL[c]);
    }
    expect(CATEGORY_FILTERS).toHaveLength(7);
  });

  it('G2. az „Összes" szűrő mindent meghagy, a kategória-szűrő csak az adott kategóriát', () => {
    const items = [view('frame_fire'), view('name_gold'), view('title_goat')];
    expect(filterByCategory(items, 'all')).toHaveLength(3);
    expect(filterByCategory(items, 'frame').map((i) => i.itemKey)).toEqual(['frame_fire']);
    expect(filterByCategory(items, 'name_color').map((i) => i.itemKey)).toEqual(['name_gold']);
    expect(filterByCategory(items, 'avatar')).toEqual([]);
  });

  it('G3. a szűrés a MÁR betöltött listán megy – a bemenetet nem módosítja', () => {
    const items = [view('frame_fire'), view('name_gold')];
    const copy = JSON.parse(JSON.stringify(items));
    filterByCategory(items, 'frame');
    expect(items).toEqual(copy);
  });

  it('G4. a csoportosítás a kategória-sorrendet tartja, és üres csoportot nem ad', () => {
    const items = [view('bg_galaxy'), view('frame_fire'), view('name_gold')];
    const groups = groupByCategory(items);
    expect(groups.map((g) => g.category)).toEqual(['frame', 'name_color', 'profile_background']);
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
    expect(groups[0].label).toBe(CATEGORY_LABEL.frame);
  });

  it('G5. a „Saját elemeim" nézet csak a birtokoltakat adja', () => {
    const items = [view('frame_fire', { owned: true }), view('name_gold'), view('title_goat', { owned: true })];
    expect(onlyOwned(items).map((i) => i.itemKey)).toEqual(['frame_fire', 'title_goat']);
  });

  it('G6. az összegzés a megkapott listából számol', () => {
    const items = [
      view('frame_fire', { owned: true, purchasable: false, blockedReason: 'owned' }),
      view('name_gold'),
      view('frame_dragon', { purchasable: false, blockedReason: 'insufficient_coins' }),
    ];
    expect(catalogSummary(items)).toEqual({ total: 3, owned: 1, affordable: 1 });
  });
});

// ===========================================================================
// Rendezés
// ===========================================================================

describe('Shop UI – rendezés', () => {
  const sample = () => [view('frame_dragon'), view('name_green'), view('effect_glow'), view('title_goat')];

  it('G7. az öt rendezési mód elérhető', () => {
    expect(SORT_OPTIONS.map((o) => o.value)).toEqual(['recommended', 'price_asc', 'price_desc', 'rarity', 'owned_first']);
  });

  it('G8. ár szerint növekvő és csökkenő', () => {
    expect(sortItems(sample(), 'price_asc').map((i) => i.priceCoins)).toEqual([300, 1500, 15000, 20000]);
    expect(sortItems(sample(), 'price_desc').map((i) => i.priceCoins)).toEqual([20000, 15000, 1500, 300]);
  });

  it('G9. ritkaság szerint a legértékesebb elöl', () => {
    const sorted = sortItems(sample(), 'rarity');
    const order = sorted.map((i) => RARITY_ORDER[i.rarity]);
    expect(order).toEqual([...order].sort((a, b) => b - a));
    expect(sorted[0].rarity).toBe('legendary');
  });

  it('G10. „Megvettek elöl" a birtokoltakat emeli ki', () => {
    const items = [view('frame_dragon'), view('name_green', { owned: true }), view('effect_glow')];
    expect(sortItems(items, 'owned_first')[0].itemKey).toBe('name_green');
  });

  it('G11. az „Ajánlott" a SZERVER sorrendjét követi (kategória + sortOrder)', () => {
    const items = [
      view('bg_galaxy', { sortOrder: 20 }),
      view('frame_ice', { sortOrder: 30 }),
      view('frame_green', { sortOrder: 10 }),
    ];
    expect(sortItems(items, 'recommended').map((i) => i.itemKey)).toEqual(['frame_green', 'frame_ice', 'bg_galaxy']);
  });

  it('G12. a rendezés STABIL és nem módosítja a bemenetet', () => {
    const items = sample();
    const copy = JSON.parse(JSON.stringify(items));
    const a = sortItems(items, 'rarity').map((i) => i.itemKey);
    const b = sortItems(items, 'rarity').map((i) => i.itemKey);
    expect(a).toEqual(b);
    expect(items).toEqual(copy);
  });
});

// ===========================================================================
// Állapotok és műveletek
// ===========================================================================

describe('Shop UI – item állapotok', () => {
  it('G13. nem birtokolt + megvásárolható → MEGVESZEM', () => {
    expect(actionFor(view('frame_fire'), false)).toBe('buy');
    expect(ACTION_LABEL.buy).toBe('Megveszem');
    expect(stateBadge(view('frame_fire'), false)).toBeNull();
  });

  it('G14. birtokolt, de nincs felvéve → FELVESZEM + „Megvan" jelölés', () => {
    const owned = view('frame_fire', { owned: true, purchasable: false, blockedReason: 'owned' });
    expect(actionFor(owned, false)).toBe('equip');
    expect(stateBadge(owned, false)).toEqual({ label: 'Megvan', tone: 'owned' });
  });

  it('G15. felvett item → LEVESZEM + „Felvéve" jelölés (BUY gomb NINCS)', () => {
    const owned = view('frame_fire', { owned: true, purchasable: false, blockedReason: 'owned' });
    expect(actionFor(owned, true)).toBe('unequip');
    expect(stateBadge(owned, true)).toEqual({ label: 'Felvéve', tone: 'equipped' });
    expect(actionFor(owned, true)).not.toBe('buy');
  });

  it('G16. kivont és lejárt item nem vásárolható, és jelölést kap', () => {
    const inactive = view('frame_fire', { isActive: false, purchasable: false, blockedReason: 'inactive' });
    const expired = view('name_green', { isLimited: true, purchasable: false, blockedReason: 'expired' });
    expect(actionFor(inactive, false)).toBe('blocked');
    expect(actionFor(expired, false)).toBe('blocked');
    expect(stateBadge(inactive, false)).toEqual({ label: 'Kivonva', tone: 'blocked' });
    expect(stateBadge(expired, false)).toEqual({ label: 'Lejárt', tone: 'blocked' });
  });

  it('G17. kevés coin esetén a hiányzó összeget a SZERVER ára és egyenlege adja', () => {
    const pricey = view('frame_dragon', { purchasable: false, blockedReason: 'insufficient_coins' });
    expect(blockedText(pricey, 2500)).toBe('Még 12 500 coin kell hozzá.');
    expect(blockedText(pricey, 15000)).toBe('Még 0 coin kell hozzá.');
    expect(blockedText(view('frame_fire'), 0)).toBeNull();
  });

  it('G18. a ritkaság minden értékére van címke és CSS-osztály', () => {
    for (const i of SHOP_SEED) {
      expect(RARITY_LABEL[i.rarity], i.itemKey).toBeTruthy();
      expect(rarityClass(i.rarity)).toBe(`rarity-${i.rarity}`);
    }
  });

  it('G19. az ár emberi formátumú, ezres csoportosítással', () => {
    expect(formatCoins(2450)).toBe('2 450');
    expect(formatCoins(20000)).toBe('20 000');
    expect(formatCoins(300)).toBe('300');
    expect(formatCoins(0)).toBe('0');
  });
});

// ===========================================================================
// Hibaszövegek
// ===========================================================================

describe('Shop UI – hibaszövegek', () => {
  it('G20. a 402 a SZERVER `missing` értékét mutatja', () => {
    expect(purchaseErrorText({ status: 402, code: 'INSUFFICIENT_COINS', details: { missing: 1250 } }))
      .toBe('Nincs elég coinod. Még 1 250 coin kell hozzá.');
    expect(purchaseErrorText({ status: 402, code: 'INSUFFICIENT_COINS' }))
      .toBe('Nincs elég coinod ehhez az elemhez.');
  });

  it('G21. minden backend hibakódhoz EMBERI szöveg tartozik', () => {
    const codes = [
      'ITEM_ALREADY_OWNED', 'ITEM_NOT_FOUND', 'ITEM_INACTIVE', 'ITEM_EXPIRED',
      'INVALID_ITEM_KEY', 'ITEM_NOT_OWNED', 'SLOT_CATEGORY_MISMATCH', 'INVALID_SLOT', 'AUTH_REQUIRED',
    ];
    for (const code of codes) {
      const text = purchaseErrorText({ code });
      expect(text, code).toBeTruthy();
      expect(text, code).not.toMatch(/undefined|null|\[object/);
    }
  });

  it('G22. minden HTTP-státuszhoz van szöveg, kód nélkül is', () => {
    for (const status of [401, 403, 404, 409, 410, 422, 500, 503]) {
      expect(purchaseErrorText({ status }), String(status)).toBeTruthy();
    }
  });

  it('G23. a felhasználó SOHA nem látja a DB belső hibáját', () => {
    const leaky = {
      status: 500,
      message: 'relation "user_coins" does not exist (SQLSTATE 42P01)\n  at Object.<anonymous> (store.ts:42)',
      details: { hint: 'pg_catalog', detail: 'relation user_coins' },
    };
    const text = purchaseErrorText(leaky);
    expect(text).not.toMatch(/SQLSTATE|relation|user_coins|\.ts:|at Object|pg_catalog/);
    expect(text).toBe('A művelet most nem sikerült. Próbáld újra kicsit később.');
  });
});

// ===========================================================================
// Élő előnézet
// ===========================================================================

describe('Shop UI – élő előnézet', () => {
  it('G24. az előnézet a kipróbált itemet a SAJÁT slotjába teszi', () => {
    const p = previewEquips({ ...EMPTY_EQUIPS }, item('frame_fire'));
    expect(p.frame).toBe('frame_fire');
    expect(p.nameColor).toBeNull();
    expect(p.title).toBeNull();
  });

  it('G25. az előnézet NEM módosítja a tárolt állapotot (nincs írás)', () => {
    const current: ShopEquips = { ...EMPTY_EQUIPS, frame: 'frame_green' };
    const snapshot = { ...current };
    const p = previewEquips(current, item('frame_fire'));
    expect(current).toEqual(snapshot);
    expect(p).not.toBe(current);
    expect(p.frame).toBe('frame_fire');
  });

  it('G26. a kipróbált item csak a saját slotját írja felül, a többit megtartja', () => {
    const current: ShopEquips = { ...EMPTY_EQUIPS, frame: 'frame_green', title: 'title_predictor' };
    const p = previewEquips(current, item('name_gold'));
    expect(p.frame).toBe('frame_green');
    expect(p.title).toBe('title_predictor');
    expect(p.nameColor).toBe('name_gold');
  });

  it('G27. előnézet nélkül a felvett állapot látszik', () => {
    const current: ShopEquips = { ...EMPTY_EQUIPS, frame: 'frame_green' };
    expect(previewEquips(current, null)).toEqual(current);
  });

  it('G28. minden kategóriához helyes slot tartozik (6×6 ellenőrzés)', () => {
    for (const c of SHOP_CATEGORIES) {
      const seed = SHOP_SEED.find((i) => i.category === c)!;
      expect(slotOf(seed)).toBe(CATEGORY_TO_SLOT[c]);
      const p = previewEquips({ ...EMPTY_EQUIPS }, item(seed.itemKey));
      for (const slot of PROFILE_SLOTS) {
        expect(p[slot], `${seed.itemKey} → ${slot}`).toBe(slot === CATEGORY_TO_SLOT[c] ? seed.itemKey : null);
      }
    }
  });

  it('G29. a felvett állapotot a SZERVER `shop` mezője dönti el', () => {
    const equips: ShopEquips = { ...EMPTY_EQUIPS, frame: 'frame_fire' };
    expect(isEquipped(equips, item('frame_fire'))).toBe(true);
    expect(isEquipped(equips, item('frame_ice'))).toBe(false);
    expect(isEquipped(equips, item('name_gold'))).toBe(false);
    expect(isEquipped({ ...EMPTY_EQUIPS }, item('frame_fire'))).toBe(false);
  });
});

// ===========================================================================
// Nincs kliens-authority
// ===========================================================================

describe('Shop UI – a frontend nem authority', () => {
  it('G30. a felület nem tartalmaz hardcode-olt katalógust: nincs ár a nézet-logikában', () => {
    const src = require('node:fs').readFileSync('src/client/lib/shopView.ts', 'utf8') as string;
    // Nincs beégetett árszám és nincs item-kulcs a felületi logikában
    expect(src).not.toMatch(/\b(300|750|1500|2500|5000|12500|15000|20000)\b/);
    expect(src).not.toMatch(/frame_fire|title_goat|bg_galaxy|name_gold/);
  });

  it('G31. a Shop oldal sem tartalmaz item-listát vagy árat', () => {
    const src = require('node:fs').readFileSync('src/client/pages/Shop.tsx', 'utf8') as string;
    expect(src).not.toMatch(/frame_fire|title_goat|bg_galaxy|avatar_brain/);
    expect(src).not.toMatch(/priceCoins:\s*\d/);
    // Az árat KIZÁRÓLAG megjelenítjük, és a vásárlás csak a kulcsot küldi
    expect(src).toContain('purchaseShopItem(item.itemKey)');
  });

  it('G32. a vásárlás kérése KIZÁRÓLAG az item kulcsát küldi', () => {
    const src = require('node:fs').readFileSync('src/client/lib/api.ts', 'utf8') as string;
    const line = src.split('\n').find((l) => l.includes('/purchase'))!;
    expect(line).toContain('JSON.stringify({ itemKey })');
    expect(line).not.toMatch(/price|coins|rarity|category|balance|userId/i);
  });

  it('G33. a felvétel kérése csak slotot és kulcsot küld', () => {
    const src = require('node:fs').readFileSync('src/client/lib/api.ts', 'utf8') as string;
    expect(src).toContain('JSON.stringify({ slot, itemKey })');
    const equipBlock = src.slice(src.indexOf('equipShopItem'), src.indexOf('equipShopItem') + 320);
    expect(equipBlock).not.toMatch(/price|rarity|category|balance|userId|targetUserId/i);
  });

  it('G34. az egyenleget a felület sosem számolja: nincs rá aritmetika a providerben', () => {
    const src = require('node:fs').readFileSync('src/client/components/CoinsProvider.tsx', 'utf8') as string;
    // Az egyenleg csak szerverválaszból kerül az állapotba
    expect(src).toContain('(await api.coinBalance()).balance');
    expect(src).not.toMatch(/balance\s*[-+]=|balance\s*[-+]\s*\d|setBalance\(\s*balance/);
  });

  it('G35. az API-kliens a mount-prefix konvenciót követi (nincs ismételt szegmens)', () => {
    // ugyanaz az elv, amit a tests/apiUrls.test.ts őriz a többi modulra
    for (const key of ['coinBalance', 'coinHistory', 'shopItems', 'shopInventory', 'purchaseShopItem', 'customization', 'equipShopItem']) {
      expect(typeof (api as unknown as Record<string, unknown>)[key], key).toBe('function');
    }
    const src = require('node:fs').readFileSync('src/client/lib/api.ts', 'utf8') as string;
    const coinLines = src.split('\n').filter((l) => l.includes("'/api/coins'"));
    const shopLines = src.split('\n').filter((l) => l.includes("'/api/shop'"));
    expect(coinLines.length).toBeGreaterThan(0);
    expect(shopLines.length).toBeGreaterThan(0);
    for (const l of coinLines) expect(l, l).not.toMatch(/request<[^>]*>\('\/coins/);
    for (const l of shopLines) expect(l, l).not.toMatch(/request<[^>]*>\('\/shop/);
  });
});

// ===========================================================================
// Megszolgált és shop kozmetikum szétválasztása a felületen
// ===========================================================================

describe('Shop UI – a két kozmetikum-rendszer külön', () => {
  it('G36. a profil-háttér és az avatar háttere KÜLÖN slot a felületen is', () => {
    const p = previewEquips({ ...EMPTY_EQUIPS }, item('bg_galaxy'));
    expect(p.profileBackground).toBe('bg_galaxy');
    expect(Object.keys(p)).not.toContain('background');
  });

  it('G37. a megjelenítő a megszolgált és a shop réteget külön mezőben kapja', () => {
    const src = require('node:fs').readFileSync('src/client/components/CosmeticProfile.tsx', 'utf8') as string;
    // megszolgált: borderKey / titleKey / avatar – shop: shop
    for (const prop of ['borderKey', 'titleKey', 'avatar?', 'shop?']) expect(src).toContain(prop);
    // a shop cím nem írja át a megszolgált kulcsot, csak a megjelenítésben nyer
    expect(src).toContain('shopTitle?.name ?? earnedTitleName(titleKey)');
  });

  it('G38. a ranglista a MEGLÉVŐ megjelenítőt használja (nincs külön shop-renderer)', () => {
    const src = require('node:fs').readFileSync('src/client/components/LeaderboardList.tsx', 'utf8') as string;
    expect(src).toContain('CosmeticProfile');
    expect(src).not.toMatch(/ShopLeaderboard|ShopRow/);
    // a sorrend és a pont továbbra is a szerverről jön
    expect(src).toContain('{row.points} pont');
  });

  it('G39. a shop-avatar a MEGLÉVŐ avatar-kompozícióra épül', () => {
    const src = require('node:fs').readFileSync('src/client/components/CosmeticProfile.tsx', 'utf8') as string;
    expect(src).toContain("import { Avatar }");
    // az AVATAR_PARTS katalógust a shop nem írja át
    expect(src).not.toMatch(/AVATAR_PARTS\s*(\[|\.)/);
  });
});
