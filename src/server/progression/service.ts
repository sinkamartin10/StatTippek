/**
 * Tipster Progression üzleti logika.
 *
 * ELKÜLÖNÍTVE a Tippverseny pontozásától: a verseny pontszámítása (5 / 3 / 0) változatlan,
 * ez a réteg csak RÁÉPÜL a már kiértékelt eredményekre.
 *
 *   tipp eredménye → (meglévő) Tippverseny scoring → pont
 *   tipp eredménye → (új) progression → XP / sorozat / achievement
 *
 * Minden döntés szerveroldali:
 *   • a kliens által küldött XP / level / achievement / unlock mezőket sosem olvassuk,
 *   • XP-t és achievementet kizárólag PRO felhasználó kaphat (szerveroldali ellenőrzés),
 *   • minden XP-esemény idempotens: ugyanaz a forrás csak egyszer ad XP-t.
 */
import {
  ACHIEVEMENTS, AVATAR_PARTS, AVATAR_SLOTS, BORDERS, DEFAULT_SETTINGS, EMPTY_STATS,
  EXACT_MILESTONE_AT, MAX_SHOWCASE, PLACEMENT_XP, TITLES, XP_EXACT_MILESTONE_BONUS, XP_STREAK_BONUS,
  HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT,
  buildHistory, computeStats, computeTipsterStats, earnedAchievementKeys, isExact, levelFromXp,
  sanitizeSettings, streakBonusPredictionIds, viewCosmetics, xpForPredictionPoints,
  type AvatarSlot, type CosmeticView, type HistoryEntry, type ProfileSettings, type ProgressionStats,
  type TipsterStats,
} from '../../shared/progression';
import type { PublicProfile } from '../../shared/competition';
import {
  EMPTY_EQUIPS, SLOT_TO_CATEGORY, isProfileSlot, isValidItemKey, sanitizeShopEquips,
  type ProfileSlot, type ShopCategory, type ShopEquips,
} from '../../shared/shop';
import type { ProgressionStore } from './store';

/** Üzleti hiba, amiből a route-réteg HTTP státuszt képez. */
export class ProgressionError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

export interface SyncResult {
  /** most jóváírt XP (0, ha minden esemény már korábban rögzült) */
  awardedXp: number;
  /** most feloldott achievement kulcsok */
  unlockedAchievements: string[];
  totalXp: number;
  level: number;
}

export interface AchievementView {
  key: string; name: string; description: string; icon: string; category: string;
  unlocked: boolean; unlockedAt: string | null;
}

export interface ProgressionProfile {
  /** false esetén a progression zárolva van (FREE csomag) */
  pro: boolean;
  /**
   * A felvett SHOP kozmetikumok slotonként. KÜLÖN réteg a megszolgált
   * `settings` mezőtől; FREE felhasználónál is kitöltött lehet.
   */
  shop: ShopEquips;
  xp: number;
  level: number;
  levelTier: string;
  xpIntoLevel: number;
  xpForNextLevel: number;
  progress: number;
  stats: ProgressionStats;
  achievements: AchievementView[];
  settings: ProfileSettings;
  catalog: {
    avatar: Record<AvatarSlot, CosmeticView[]>;
    borders: CosmeticView[];
    titles: CosmeticView[];
    maxShowcase: number;
  };
}

export class ProgressionService {
  /**
   * @param store   Progression tároló (XP-napló, achievementek, beállítások)
   * @param isPro   Szerveroldali PRO-ellenőrzés (a meglévő profiles/Stripe állapotból).
   *                A frontend állapotát sosem hisszük el.
   */
  constructor(
    private store: ProgressionStore,
    private isPro: (userId: string) => Promise<boolean>,
    /**
     * Kötegelt PRO-ellenőrzés a ranglistához (N felhasználó → EGY lekérdezés).
     * Ha nincs megadva, az egyesével történő ellenőrzésre esik vissza.
     */
    private proUserIds?: (userIds: string[]) => Promise<Set<string>>,
    /**
     * Opcionális shop-birtoklás feloldó: `userId → (itemKey → kategória)`.
     * SZÁNDÉKOSAN szűk felület, hogy a progression ne függjön a coin-modultól.
     * Ha nincs megadva, a shop-réteg üres, és a működés bitre azonos a
     * korábbival.
     */
    private shopOwnership?: (userIds: string[]) => Promise<Map<string, Map<string, ShopCategory>>>,
  ) {}

  // -------------------------------------------------------------------------
  // Shop kozmetikumok FELVÉTELE (equip)
  //
  // KÜLÖN RENDSZER a megszolgált testreszabástól:
  //   - saját oszlopok (0012), saját slotok, saját ellenőrzés,
  //   - a `sanitizeSettings()`-et NEM hívja és nem gyengíti,
  //   - NINCS PRO-kapu: a coin FREE-vel is megszerezhető, ezért a megvásárolt
  //     kozmetikum FREE felhasználónak is felvehető (jóváhagyott döntés).
  //     A MEGSZOLGÁLT kozmetikumok PRO-kapuja (`saveSettings`) változatlan.
  // -------------------------------------------------------------------------

  /** A hívó birtokolt itemei kategóriával – a felvétel authority-ja. */
  private async ownedCategories(userId: string): Promise<Map<string, ShopCategory>> {
    if (!this.shopOwnership) return new Map();
    return (await this.shopOwnership([userId])).get(userId) ?? new Map();
  }

  /**
   * A hívó felvett shop itemei. A tárolt értéket MINDEN olvasásnál újra
   * ellenőrizzük a jelenlegi birtoklás ellen – ugyanaz az elv, mint a
   * megszolgált kozmetikumoknál: a tárolt választás nem authority.
   */
  async shopCustomization(userId: string): Promise<ShopEquips> {
    const [stored, owned] = await Promise.all([
      this.store.getShopEquips(userId),
      this.ownedCategories(userId),
    ]);
    return sanitizeShopEquips(stored, owned).equips;
  }

  /**
   * Egy slot felvétele vagy levétele. `itemKey === null` → levétel.
   *
   * CSAK a profil-beállítást módosítja: coint nem von le és nem ad, készletet
   * nem hoz létre és nem módosít, tranzakciót nem naplóz. A birtoklás és a
   * kategória-egyezés ellenőrzése a MENTÉS ELŐTT történik, ezért elutasított
   * kérés után a tárolt állapot bitre változatlan.
   */
  async equipShopItem(userId: string, slot: unknown, itemKey: unknown): Promise<{ equips: ShopEquips; slot: ProfileSlot }> {
    if (!isProfileSlot(slot)) {
      throw new ProgressionError('Érvénytelen slot.', 400, 'INVALID_SLOT');
    }
    if (itemKey !== null && itemKey !== undefined && !isValidItemKey(itemKey)) {
      throw new ProgressionError('Érvénytelen item azonosító.', 400, 'INVALID_ITEM_KEY');
    }

    const owned = await this.ownedCategories(userId);

    if (itemKey !== null && itemKey !== undefined) {
      const category = owned.get(itemKey);
      if (!category) {
        throw new ProgressionError('Ez az elem nincs a készletedben.', 403, 'ITEM_NOT_OWNED');
      }
      if (SLOT_TO_CATEGORY[slot] !== category) {
        throw new ProgressionError('Ez az elem nem ebbe a slotba tartozik.', 422, 'SLOT_CATEGORY_MISMATCH');
      }
    }

    // A tárolt állapotból indulunk, és CSAK a kért slotot írjuk át
    const current = await this.store.getShopEquips(userId);
    const wanted: ShopEquips = { ...current, [slot]: itemKey ?? null };
    // Védőháló: a többi slot is átmegy a birtoklás-ellenőrzésen, így egy
    // korábban felvett, de már érvénytelen kulcs sem íródik vissza.
    const { equips } = sanitizeShopEquips(wanted, owned);
    await this.store.saveShopEquips(userId, equips);
    return { equips, slot };
  }

  private async proSet(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    if (this.proUserIds) return this.proUserIds(userIds);
    const out = new Set<string>();
    for (const id of userIds) if (await this.isPro(id)) out.add(id);
    return out;
  }

  // -------------------------------------------------------------------------
  // XP jóváírás
  // -------------------------------------------------------------------------

  /**
   * A felhasználó progressionjének szinkronizálása a már KIÉRTÉKELT tippjeiből.
   * IDEMPOTENS: minden XP-esemény egyedi forráskulcsot kap, ezért az ismételt
   * futtatás (pl. többszöri meccs-szinkron) nem ad dupla XP-t.
   * FREE felhasználó semmit nem kap.
   */
  async syncUser(userId: string): Promise<SyncResult> {
    if (!(await this.isPro(userId))) {
      const xp = await this.store.totalXp(userId);
      return { awardedXp: 0, unlockedAchievements: [], totalXp: xp, level: levelFromXp(xp).level };
    }

    const settled = await this.store.settledPredictions(userId);
    let awarded = 0;

    // 1) Tippenkénti XP – a forráskulcs maga a tipp azonosítója
    for (const p of settled) {
      const xp = xpForPredictionPoints(p.points);
      if (xp <= 0) continue; // rossz tippért nem jár XP
      if (await this.store.claimEvent(userId, 'prediction', p.predictionId, xp)) awarded += xp;
    }

    // 2) Sorozat-bónusz – ahány sorozat elérte az 5 helyes tippet.
    //    A kulcs SORSZÁM (streak:1, streak:2, …), nem a kiváltó tipp azonosítója: így a
    //    jóváírt bónuszok száma sosem haladhatja meg a ténylegesen elért sorozatok számát,
    //    még akkor sem, ha egy mérkőzés eredménye utólag módosul és a sorozatok átrendeződnek.
    const streaks = streakBonusPredictionIds(settled).length;
    for (let i = 1; i <= streaks; i++) {
      if (await this.store.claimEvent(userId, 'streak_bonus', `streak:${i}`, XP_STREAK_BONUS)) awarded += XP_STREAK_BONUS;
    }

    // 3) Pontos eredmény mérföldkő – egyszer, a 10. pontos eredménynél
    const exactCount = settled.filter((p) => isExact(p.points)).length;
    if (exactCount >= EXACT_MILESTONE_AT) {
      if (await this.store.claimEvent(userId, 'exact_milestone', `exact:${EXACT_MILESTONE_AT}`, XP_EXACT_MILESTONE_BONUS)) {
        awarded += XP_EXACT_MILESTONE_BONUS;
      }
    }

    const unlocked = await this.syncAchievements(userId, settled);
    const totalXp = await this.store.totalXp(userId);
    return { awardedXp: awarded, unlockedAchievements: unlocked, totalXp, level: levelFromXp(totalXp).level };
  }

  /**
   * Verseny-helyezésért járó egyszeri XP. Csak a verseny végleges lezárásakor hívjuk.
   * A (verseny, helyezés) forráskulcs miatt az ismételt lezárás nem ad újra XP-t.
   */
  async awardPlacement(userId: string, competitionId: string, placement: number): Promise<number> {
    const xp = PLACEMENT_XP[placement];
    if (!xp) return 0;
    if (!(await this.isPro(userId))) return 0;
    const claimed = await this.store.claimEvent(userId, 'placement', `${competitionId}:${placement}`, xp);
    await this.syncUser(userId); // a helyezés achievementet és szintet is nyithat
    return claimed ? xp : 0;
  }

  /** A teljesülő achievementek feloldása (egy achievement csak egyszer oldható fel). */
  private async syncAchievements(userId: string, settled?: Awaited<ReturnType<ProgressionStore['settledPredictions']>>): Promise<string[]> {
    const stats = await this.statsFor(userId, settled);
    const already = new Set((await this.store.listAchievements(userId)).map((a) => a.key));
    const newly: string[] = [];
    for (const key of earnedAchievementKeys(stats)) {
      if (already.has(key)) continue;
      if (await this.store.unlockAchievement(userId, key)) newly.push(key);
    }
    return newly;
  }

  /** Statisztika a nyers adatokból (a Tippverseny tábláit csak olvassuk). */
  private async statsFor(userId: string, settled?: Awaited<ReturnType<ProgressionStore['settledPredictions']>>): Promise<ProgressionStats> {
    const rows = settled ?? await this.store.settledPredictions(userId);
    const [placements, xp] = await Promise.all([this.store.placements(userId), this.store.totalXp(userId)]);
    return computeStats(rows, placements, xp);
  }

  // -------------------------------------------------------------------------
  // Olvasás
  // -------------------------------------------------------------------------

  /** A bejelentkezett felhasználó teljes progression-állapota (saját adat). */
  async profile(userId: string): Promise<ProgressionProfile> {
    const pro = await this.isPro(userId);
    // A shop-réteg FREE felhasználónál is kitöltött lehet (külön rendszer)
    const shop = await this.shopCustomization(userId);
    const xp = await this.store.totalXp(userId);
    const level = levelFromXp(xp);
    const stats = pro || xp > 0 ? await this.statsFor(userId) : { ...EMPTY_STATS };
    const unlockedRows = await this.store.listAchievements(userId);
    const unlockedMap = new Map(unlockedRows.map((a) => [a.key, a.unlockedAt]));
    const unlockedSet = new Set(unlockedMap.keys());

    const stored = await this.store.getSettings(userId);
    // A tárolt választást minden olvasáskor újraellenőrizzük: ha egy elem valamiért
    // már nem jár (pl. katalógus-változás), az alapértelmezés jelenik meg helyette.
    const { settings } = sanitizeSettings(stored ?? DEFAULT_SETTINGS, stats, unlockedSet);

    const avatar = {} as Record<AvatarSlot, CosmeticView[]>;
    for (const slot of AVATAR_SLOTS) avatar[slot] = viewCosmetics(AVATAR_PARTS[slot], stats, unlockedSet);

    return {
      pro,
      shop,
      xp,
      level: level.level,
      levelTier: level.tier,
      xpIntoLevel: level.xpIntoLevel,
      xpForNextLevel: level.xpForNextLevel,
      progress: level.progress,
      stats,
      achievements: ACHIEVEMENTS.map((a) => ({
        key: a.key, name: a.name, description: a.description, icon: a.icon, category: a.category,
        unlocked: unlockedMap.has(a.key), unlockedAt: unlockedMap.get(a.key) ?? null,
      })),
      settings,
      catalog: { avatar, borders: viewCosmetics(BORDERS, stats, unlockedSet), titles: viewCosmetics(TITLES, stats, unlockedSet), maxShowcase: MAX_SHOWCASE },
    };
  }

  // -------------------------------------------------------------------------
  // Testreszabás mentése
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Személyes statisztika és tipp-előzmény (saját adat)
  // -------------------------------------------------------------------------

  /**
   * A bejelentkezett felhasználó tipster statisztikája.
   * Minden érték a MEGLÉVŐ adatokból számolódik (tippek, XP-napló, jutalmak);
   * nincs új tábla és nincs kitalált érték – ami nem számolható, az null marad.
   * Három lekérdezés, a résztvevők/tippek számától függetlenül (nincs N+1).
   */
  async tipsterStats(userId: string, trendLimit = 30): Promise<TipsterStats> {
    const [rows, placements, xp] = await Promise.all([
      this.store.allPredictions(userId),
      this.store.placements(userId),
      this.store.totalXp(userId),
    ]);
    return computeTipsterStats(rows, placements, xp, trendLimit);
  }

  /**
   * A bejelentkezett felhasználó SAJÁT tipp-előzménye, legfrissebb elöl.
   * A limitet a szerver korlátozza; a felhasználó mások adatait nem érheti el,
   * mert a lekérdezés mindig a hitelesített azonosítóra szűr.
   */
  async predictionHistory(userId: string, limit?: number): Promise<{ entries: HistoryEntry[]; total: number; limit: number }> {
    const safeLimit = Math.min(HISTORY_MAX_LIMIT, Math.max(1, Math.floor(limit ?? HISTORY_DEFAULT_LIMIT)));
    const [rows, xpByPrediction] = await Promise.all([
      this.store.allPredictions(userId),
      this.store.predictionXp(userId),
    ]);
    return { entries: buildHistory(rows, xpByPrediction, safeLimit), total: rows.length, limit: safeLimit };
  }

  /**
   * A RANGLISTÁHOZ: több felhasználó megjelenítendő profilja EGY menetben.
   *
   * Nincs N+1: a tároló kötegelt metódusait használja, így a lekérdezések száma
   * független a résztvevők számától. Nincs külön ranglista-gyorsítótár sem, ezért
   * a felhasználó beállítás-változása a következő lekérésnél azonnal látszik.
   *
   * A megjelenített elemeket UGYANAZ a `sanitizeSettings()` ellenőrzés adja, mint a
   * saját profilnál: fel nem oldott vagy ismeretlen kulcs helyére az alapértelmezés kerül.
   * FREE felhasználó mindig az alapértelmezett megjelenést kapja.
   */
  async publicProfiles(userIds: string[]): Promise<Map<string, PublicProfile>> {
    const out = new Map<string, PublicProfile>();
    const unique = [...new Set(userIds)];
    if (!unique.length) return out;

    const fallback: PublicProfile = { avatar: DEFAULT_SETTINGS.avatar, borderKey: DEFAULT_SETTINGS.border, titleKey: DEFAULT_SETTINGS.title };
    const pro = await this.proSet(unique);
    const proIds = unique.filter((id) => pro.has(id));

    // FREE felhasználó: MEGSZOLGÁLT testreszabás nincs – marad az alapértelmezés
    for (const id of unique) out.set(id, fallback);

    // SHOP-RÉTEG: a megvásárolt és felvett kozmetikum FREE és PRO
    // felhasználónál EGYARÁNT látszik (jóváhagyott döntés). Külön réteg: a
    // megszolgált kozmetikumok jogosultságát nem kerüli meg, mert csak a
    // SHOP-slotokat tölti, és minden kulcsot a birtoklás ellen ellenőriz.
    if (this.shopOwnership) {
      try {
        const [equips, owned] = await Promise.all([
          this.store.getShopEquipsMany(unique),
          this.shopOwnership(unique),
        ]);
        for (const id of unique) {
          const stored = equips.get(id);
          if (!stored) continue;
          const { equips: safe } = sanitizeShopEquips(stored, owned.get(id) ?? new Map());
          if (Object.values(safe).every((v) => v === null)) continue;
          out.set(id, { ...(out.get(id) ?? fallback), shop: safe });
        }
      } catch (e) {
        // A shop-réteg hibája NEM törheti meg a ranglistát
        console.error('[progression] shop-réteg hiba:', (e as Error).message);
      }
    }

    if (!proIds.length) return out;

    const [settings, achievements, xp, predictions, placements] = await Promise.all([
      this.store.getSettingsMany(proIds),
      this.store.listAchievementsMany(proIds),
      this.store.totalXpMany(proIds),
      this.store.settledPredictionsMany(proIds),
      this.store.placementsMany(proIds),
    ]);

    for (const id of proIds) {
      const stored = settings.get(id);
      if (!stored) continue; // még nem szabta testre – marad az alapértelmezés
      const stats = computeStats(predictions.get(id) ?? [], placements.get(id) ?? [], xp.get(id) ?? 0);
      const unlocked = new Set(achievements.get(id) ?? []);
      const { settings: safe } = sanitizeSettings(stored, stats, unlocked);
      // A shop-réteget MEGTARTJUK: a megszolgált réteg csak a saját mezőit írja
      const shop = out.get(id)?.shop;
      out.set(id, {
        avatar: safe.avatar, borderKey: safe.border, titleKey: safe.title,
        ...(shop ? { shop } : {}),
      });
    }
    return out;
  }

  /**
   * A felhasználó választásának mentése. A szerver MINDEN elemet ellenőriz:
   * nem létező vagy fel nem oldott elem nem menthető, a kiemelés legfeljebb 3 achievement.
   */
  async saveSettings(userId: string, input: Partial<ProfileSettings> | null): Promise<{ settings: ProfileSettings; rejected: string[] }> {
    if (!(await this.isPro(userId))) {
      throw new ProgressionError('A profil testreszabása PRO előfizetéssel érhető el.', 403, 'PRO_REQUIRED');
    }
    const stats = await this.statsFor(userId);
    const unlocked = new Set((await this.store.listAchievements(userId)).map((a) => a.key));
    const { settings, rejected } = sanitizeSettings(input, stats, unlocked);
    await this.store.saveSettings(userId, settings);
    return { settings, rejected };
  }
}
