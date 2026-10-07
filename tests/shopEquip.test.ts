/**
 * Shop item → profil-slot leképezés és a felvétel (equip) ELLENŐRZÉSE (5e).
 *
 * Ez a fájl a séma-független, TISZTA logikát rögzíti: a kategória → slot
 * leképezést és a `sanitizeShopEquips()` birtoklás-ellenőrzését. A tárolás és
 * az equip API a `user_profile_settings` bővítését igényli, ami külön
 * jóváhagyásra vár – ezért itt még nincs HTTP-szintű teszt.
 *
 * A meglévő, MEGSZOLGÁLT kozmetikumok ellenőrzése változatlanul a
 * `sanitizeSettings()` dolga; azt ez a modul nem váltja ki és nem módosítja.
 */
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_TO_SLOT, EMPTY_EQUIPS, PROFILE_SLOTS, PROFILE_SLOT_LABEL, SHOP_CATEGORIES, SHOP_SEED,
  SLOT_TO_CATEGORY, isProfileSlot, sanitizeShopEquips,
  type ProfileSlot, type ShopCategory,
} from '../src/shared/shop';
import {
  AVATAR_PARTS, AVATAR_SLOTS, BORDERS, DEFAULT_SETTINGS, EMPTY_STATS, TITLES,
  sanitizeSettings,
} from '../src/shared/progression';

/** Birtoklás-térkép a vetőmagból: itemKey → kategória. */
const ownedOf = (...keys: string[]): Map<string, ShopCategory> =>
  new Map(keys.map((k) => {
    const item = SHOP_SEED.find((i) => i.itemKey === k);
    if (!item) throw new Error(`nincs ilyen seed item: ${k}`);
    return [k, item.category];
  }));

// ===========================================================================
// Kategória → slot leképezés
// ===========================================================================

describe('Shop equip – kategória → slot leképezés', () => {
  it('E1. mind a hat kategóriához tartozik slot, és a leképezés kétirányú', () => {
    expect(PROFILE_SLOTS).toHaveLength(6);
    expect(SHOP_CATEGORIES).toHaveLength(6);
    for (const c of SHOP_CATEGORIES) {
      const slot = CATEGORY_TO_SLOT[c];
      expect(slot, c).toBeTruthy();
      expect(SLOT_TO_CATEGORY[slot], `${c} → ${slot} → vissza`).toBe(c);
    }
    for (const s of PROFILE_SLOTS) {
      expect(CATEGORY_TO_SLOT[SLOT_TO_CATEGORY[s]], s).toBe(s);
    }
  });

  it('E2. a leképezés pontosan a jóváhagyott párosítás', () => {
    expect(CATEGORY_TO_SLOT).toEqual({
      frame: 'frame',
      name_color: 'nameColor',
      name_effect: 'nameEffect',
      title: 'title',
      avatar: 'avatar',
      profile_background: 'profileBackground',
    });
  });

  it('E3. a `profileBackground` KÜLÖN slot az avatar `background` mezőjétől (D4)', () => {
    expect(PROFILE_SLOTS).toContain('profileBackground');
    expect(PROFILE_SLOTS).not.toContain('background');
    // az avatar-rendszer background slotja változatlanul létezik, és más entitás
    expect(AVATAR_SLOTS).toContain('background');
    expect(DEFAULT_SETTINGS.avatar.background).toBe('solid');
    expect(SLOT_TO_CATEGORY.profileBackground).toBe('profile_background');
  });

  it('E4. minden slothoz tartozik címke, és az `isProfileSlot` szigorú', () => {
    for (const s of PROFILE_SLOTS) expect(PROFILE_SLOT_LABEL[s], s).toBeTruthy();
    for (const bad of ['background', 'border', 'Frame', 'frame ', '', null, 42, {}]) {
      expect(isProfileSlot(bad), String(bad)).toBe(false);
    }
    for (const s of PROFILE_SLOTS) expect(isProfileSlot(s)).toBe(true);
  });

  it('E5. a vetőmag minden itemének van érvényes slotja', () => {
    for (const i of SHOP_SEED) {
      expect(CATEGORY_TO_SLOT[i.category], i.itemKey).toBeTruthy();
    }
  });
});

// ===========================================================================
// Birtoklás mint authority
// ===========================================================================

describe('Shop equip – a birtoklás az authority', () => {
  it('E6. BIRTOKOLT item a helyes slotba felvehető', () => {
    const owned = ownedOf('frame_fire', 'name_gold', 'effect_glow', 'title_goat', 'avatar_brain', 'bg_stadium');
    const { equips, rejected } = sanitizeShopEquips({
      frame: 'frame_fire', nameColor: 'name_gold', nameEffect: 'effect_glow',
      title: 'title_goat', avatar: 'avatar_brain', profileBackground: 'bg_stadium',
    }, owned);
    expect(rejected).toEqual([]);
    expect(equips).toEqual({
      frame: 'frame_fire', nameColor: 'name_gold', nameEffect: 'effect_glow',
      title: 'title_goat', avatar: 'avatar_brain', profileBackground: 'bg_stadium',
    });
  });

  it('E7. NEM birtokolt item elutasítva – a slot üres marad', () => {
    const { equips, rejected } = sanitizeShopEquips({ frame: 'frame_fire' }, new Map());
    expect(equips.frame).toBeNull();
    expect(rejected).toEqual(['frame:frame_fire']);
  });

  it('E8. a legdrágább item sem vehető fel birtoklás nélkül', () => {
    const { equips, rejected } = sanitizeShopEquips({
      frame: 'frame_animated_diamond', title: 'title_goat', nameEffect: 'effect_rainbow',
    }, new Map());
    expect(equips).toEqual(EMPTY_EQUIPS);
    expect(rejected).toHaveLength(3);
  });

  it('E9. kitalált kulcs elutasítva (a katalógusban sem létezik)', () => {
    const { equips, rejected } = sanitizeShopEquips({ frame: 'sajat_legendary_frame' }, new Map());
    expect(equips.frame).toBeNull();
    expect(rejected).toEqual(['frame:sajat_legendary_frame']);
  });

  it('E10. alaki szemét elutasítva, a DB-ig sem jut el', () => {
    const owned = ownedOf('frame_fire');
    for (const bad of ['', 'ab', 'Frame_Fire', 'frame fire', "frame'; drop table shop_items; --", '#ff0000', 'a'.repeat(65), 42, {}, ['frame_fire']]) {
      const { equips, rejected } = sanitizeShopEquips({ frame: bad as never }, owned);
      expect(equips.frame, JSON.stringify(bad)).toBeNull();
      expect(rejected).toHaveLength(1);
    }
  });

  it('E11. MÁS felhasználó itemje nem vehető fel (az ő készlete nincs az `owned`-ban)', () => {
    // A hívó KIZÁRÓLAG a saját készletéből építi az `owned` térképet
    const myOwned = ownedOf('name_green');
    const { equips, rejected } = sanitizeShopEquips({ frame: 'frame_fire', nameColor: 'name_green' }, myOwned);
    expect(equips.frame, 'a másik felhasználó kerete').toBeNull();
    expect(equips.nameColor, 'a sajátja').toBe('name_green');
    expect(rejected).toEqual(['frame:frame_fire']);
  });
});

// ===========================================================================
// Slot / kategória ütközés
// ===========================================================================

describe('Shop equip – slot és kategória egyezése', () => {
  it('E12. címet NEM lehet keret-slotba tenni', () => {
    const owned = ownedOf('title_predictor');
    const { equips, rejected } = sanitizeShopEquips({ frame: 'title_predictor' }, owned);
    expect(equips.frame).toBeNull();
    expect(rejected).toEqual(['frame:title_predictor']);
  });

  it('E13. keretet NEM lehet cím-slotba tenni', () => {
    const owned = ownedOf('frame_fire');
    const { equips, rejected } = sanitizeShopEquips({ title: 'frame_fire' }, owned);
    expect(equips.title).toBeNull();
    expect(rejected).toEqual(['title:frame_fire']);
  });

  it('E14. a profil-hátteret NEM lehet avatar-slotba tenni (és fordítva)', () => {
    const owned = ownedOf('bg_galaxy', 'avatar_ai');
    const a = sanitizeShopEquips({ avatar: 'bg_galaxy' }, owned);
    expect(a.equips.avatar).toBeNull();
    const b = sanitizeShopEquips({ profileBackground: 'avatar_ai' }, owned);
    expect(b.equips.profileBackground).toBeNull();
  });

  it('E15. névszínt NEM lehet név-effekt slotba tenni (és fordítva)', () => {
    const owned = ownedOf('name_gold', 'effect_glow');
    expect(sanitizeShopEquips({ nameEffect: 'name_gold' }, owned).equips.nameEffect).toBeNull();
    expect(sanitizeShopEquips({ nameColor: 'effect_glow' }, owned).equips.nameColor).toBeNull();
  });

  it('E16. MINDEN rossz párosítás elutasítva – a vetőmag teljes keresztpróbája', () => {
    // minden kategóriából egy item, minden slotba: csak az egyező páros maradhat
    const samples = SHOP_CATEGORIES.map((c) => SHOP_SEED.find((i) => i.category === c)!);
    const owned = ownedOf(...samples.map((i) => i.itemKey));
    for (const item of samples) {
      for (const slot of PROFILE_SLOTS) {
        const { equips } = sanitizeShopEquips({ [slot]: item.itemKey } as never, owned);
        const expected = CATEGORY_TO_SLOT[item.category] === slot ? item.itemKey : null;
        expect(equips[slot], `${item.itemKey} → ${slot}`).toBe(expected);
      }
    }
  });

  it('E17. a kliens nem küldhet kategóriát, ritkaságot vagy árat: a függvény nem is olvas ilyet', () => {
    const owned = ownedOf('title_predictor');
    const { equips } = sanitizeShopEquips({
      frame: 'title_predictor',
      // ezek a mezők nem részei a szerződésnek, ezért hatástalanok
      category: 'frame', rarity: 'legendary', priceCoins: 0, metadata: { color: '#fff' },
    } as never, owned);
    expect(equips.frame, 'a kategória a KÉSZLETBŐL jön, nem a kérésből').toBeNull();
  });
});

// ===========================================================================
// Levétel (unequip)
// ===========================================================================

describe('Shop equip – levétel', () => {
  it('E18. `null` kiüríti a slotot, a többit nem érinti', () => {
    const owned = ownedOf('frame_fire', 'name_gold');
    const full = sanitizeShopEquips({ frame: 'frame_fire', nameColor: 'name_gold' }, owned).equips;
    const after = sanitizeShopEquips({ ...full, frame: null }, owned);
    expect(after.equips.frame).toBeNull();
    expect(after.equips.nameColor).toBe('name_gold');
    expect(after.rejected, 'a levétel nem hiba').toEqual([]);
  });

  it('E19. a hiányzó slot sem hiba, és nem is lesz felvett item', () => {
    const owned = ownedOf('frame_fire');
    const { equips, rejected } = sanitizeShopEquips({}, owned);
    expect(equips).toEqual(EMPTY_EQUIPS);
    expect(rejected).toEqual([]);
  });

  it('E20. `null` bemenet teljesen üres felvételt ad', () => {
    expect(sanitizeShopEquips(null, new Map()).equips).toEqual(EMPTY_EQUIPS);
    expect(sanitizeShopEquips(undefined, new Map()).equips).toEqual(EMPTY_EQUIPS);
  });

  it('E21. slotonként legfeljebb EGY item (a típus is ezt kényszeríti)', () => {
    const owned = ownedOf('frame_fire', 'frame_ice');
    const { equips } = sanitizeShopEquips({ frame: 'frame_ice' }, owned);
    expect(equips.frame).toBe('frame_ice');
    // a korábbi felvétel helyére lép, nem gyűlik
    expect(Object.values(equips).filter((v) => v !== null)).toHaveLength(1);
  });
});

// ===========================================================================
// A MEGSZOLGÁLT kozmetikumok érintetlenek
// ===========================================================================

describe('Shop equip – a megszolgált kozmetikumok érintetlenek', () => {
  it('E22. a shop-címek NEM szerepelnek a megszolgált címek között', () => {
    const earnedKeys = new Set(TITLES.map((t) => t.key));
    const earnedNames = new Set(TITLES.map((t) => t.name));
    for (const item of SHOP_SEED.filter((i) => i.category === 'title')) {
      expect(earnedKeys.has(item.itemKey), item.itemKey).toBe(false);
      expect(earnedNames.has(item.name), item.name).toBe(false);
    }
    // a megszolgált címek változatlanul megvannak
    for (const key of ['none', 'tier_tipster', 'tier_analyst', 'tier_expert', 'tier_legend', 'champion', 'sharpshooter', 'on_fire']) {
      expect(earnedKeys.has(key), key).toBe(true);
    }
  });

  it('E23. a shop-keretek NEM szerepelnek a megszolgált keretek között', () => {
    const earned = new Set(BORDERS.map((b) => b.key));
    for (const item of SHOP_SEED.filter((i) => i.category === 'frame')) {
      expect(earned.has(item.itemKey), item.itemKey).toBe(false);
    }
    for (const key of ['none', 'classic', 'sharp_shooter', 'goal_hunter', 'elite_tipster', 'flame', 'champion', 'legend']) {
      expect(earned.has(key), key).toBe(true);
    }
  });

  it('E24. a shop item NEM kerülhet a megszolgált slotokba a `sanitizeSettings()`-en', () => {
    // A két rendszer külön: a megszolgált ellenőrző a shop kulcsait nem ismeri
    const { settings, rejected } = sanitizeSettings(
      { border: 'frame_fire', title: 'title_goat', avatar: { accessory: 'avatar_brain' } } as never,
      EMPTY_STATS, new Set(),
    );
    expect(settings.border).toBe(DEFAULT_SETTINGS.border);
    expect(settings.title).toBe(DEFAULT_SETTINGS.title);
    expect(settings.avatar.accessory).toBe(DEFAULT_SETTINGS.avatar.accessory);
    expect(rejected).toContain('border:frame_fire');
    expect(rejected).toContain('title:title_goat');
    expect(rejected).toContain('avatar.accessory:avatar_brain');
  });

  it('E25. a megszolgált kozmetikum nem igényel készlet-rekordot', () => {
    // feloldott achievementtel a megszolgált cím továbbra is menthető, shop item nélkül
    const stats = { ...EMPTY_STATS, level: 60, exactScores: 30, bestStreak: 6, competitionsWon: 2 };
    const { settings, rejected } = sanitizeSettings(
      { border: 'legend', title: 'tier_master_tipster', avatar: { ...DEFAULT_SETTINGS.avatar, background: 'pitch' } },
      stats, new Set(['champion', 'sharpshooter']),
    );
    expect(settings.border).toBe('legend');
    expect(settings.title).toBe('tier_master_tipster');
    expect(settings.avatar.background).toBe('pitch');
    expect(rejected).toEqual([]);
  });

  it('E26. a shop-felvétel és a megszolgált beállítás nem írja felül egymást', () => {
    const owned = ownedOf('bg_galaxy', 'frame_fire');
    const shop = sanitizeShopEquips({ profileBackground: 'bg_galaxy', frame: 'frame_fire' }, owned).equips;
    const earned = sanitizeSettings(
      { border: 'classic', avatar: { ...DEFAULT_SETTINGS.avatar } },
      EMPTY_STATS, new Set(),
    ).settings;

    expect(shop.profileBackground).toBe('bg_galaxy');
    expect(earned.avatar.background, 'az avatar háttere változatlan').toBe('solid');
    expect(shop.frame).toBe('frame_fire');
    expect(earned.border, 'a megszolgált keret változatlan').toBe('classic');
  });

  it('E27. a shop-avatarok az avatar-rendszer `accessory` slotjára hivatkoznak', () => {
    for (const i of SHOP_SEED.filter((x) => x.category === 'avatar')) {
      expect((i.metadata as Record<string, unknown>).avatarSlot, i.itemKey).toBe('accessory');
    }
    // a meglévő `accessory` opciók változatlanok – a shop nem írja át őket
    expect(AVATAR_PARTS.accessory.map((o) => o.key)).toEqual(['none', 'headband', 'shades', 'captain']);
  });
});
