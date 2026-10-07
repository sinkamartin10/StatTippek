/**
 * Coin üzleti logika. A szabályok itt (szerveroldalon) dőlnek el, de a
 * PÉNZMOZGÁS-SZERŰ műveletek authority-ja az ADATBÁZIS marad.
 *
 * AMIT EZ A RÉTEG TESZ:
 *   - érvényesít (felhasználó, összeg, típus, forráskulcs, item-kulcs),
 *   - meghívja a `0011` migráció két plpgsql függvényét,
 *   - a DB kimenetét egységes API-alakra és egységes hibákra képezi le.
 *
 * AMIT SOHA NEM TESZ:
 *   - nem von le és nem ír jóvá coint a függvényeket megkerülve,
 *   - nem implementálja újra az idempotenciát alkalmazásszinten: a
 *     `(user_id, source_key)` egyediség és a függvény dönt, nem egy itteni
 *     előzetes ellenőrzés,
 *   - nem fogad el a hívótól árat, ritkaságot, egyenleget vagy birtoklást,
 *   - nem számolja újra a vásárlást.
 *
 * A FELHASZNÁLÓT kizárólag a hívó réteg azonosítja a hitelesített tokenből, és
 * minden metódus CSAK a saját felhasználójára dolgozik: nincs egyetlen olyan
 * paraméter sem, amellyel egy másik felhasználó egyenlegét, naplóját vagy
 * készletét el lehetne érni vagy módosítani.
 */
import {
  COIN_HISTORY_DEFAULT_LIMIT, COIN_HISTORY_MAX_LIMIT, COIN_REWARDS, COIN_REWARD_LABEL,
  MAX_TRANSACTION_ABS, SHOP_CATEGORIES, isValidItemKey, itemExpired, itemPurchasable, purchaseSourceKey,
  type CoinAwardResult, type CoinBalance, type CoinHistoryPage, type CoinPurchaseResult,
  type CoinRewardType, type CoinTransactionType,
  type ShopCatalogResponse, type ShopCategory, type ShopInventoryResponse, type ShopItemView,
} from '../../shared/shop';
import type { CoinStore } from './store';

/** Üzleti hiba, amiből a route-réteg HTTP státuszt képez (a meglévő minta). */
export class CoinError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    /** a hibaválaszba beolvasztandó, SZERVER által számolt extra mezők */
    public details?: Record<string, unknown>,
  ) { super(message); }
}

/** Egy jutalmazás kérése. Az összeg alapesetben a szerver konfigurációjából jön. */
export interface AwardRequest {
  userId: string;
  type: CoinTransactionType;
  sourceKey: string;
  /**
   * Explicit összeg. KIZÁRÓLAG `ADMIN_ADJUSTMENT` típusnál engedett – minden
   * más típusnál a `COIN_REWARDS` konfiguráció az egyetlen forrás, hogy a
   * jutalom összege ne függhessen a hívás helyétől (és így a kliensből
   * érkező adattól sem).
   */
  amount?: number;
  /** Felülírható megjelenítési címke; alapértelmezésben a típus címkéje. */
  label?: string;
}

export interface HistoryOptions {
  limit?: number;
  /** kurzor: ennél régebbi tranzakciók (created_at ISO) */
  before?: string;
  types?: CoinTransactionType[];
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const REWARD_TYPES = new Set<string>(Object.keys(COIN_REWARDS));
const KNOWN_TYPES = new Set<string>(Object.keys(COIN_REWARD_LABEL));

export class CoinService {
  constructor(private store: CoinStore) {}

  /** Minden metódus ezzel kezd: a hívó azonosítója kötelező és ellenőrzött. */
  private owner(userId: string): string {
    if (typeof userId !== 'string' || !UUID.test(userId)) {
      throw new CoinError('Bejelentkezés szükséges.', 401, 'AUTH_REQUIRED');
    }
    return userId;
  }

  /** A tároló hibáit egységes 500-as üzleti hibává képezzük (nem szivárog SQL). */
  private async guard<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CoinError) throw e;
      console.error(`[coins] ${op}:`, (e as Error).message);
      throw new CoinError('A coin művelet most nem elérhető.', 500, 'COIN_STORE_ERROR');
    }
  }

  // --------------------------------------------------------------------------
  // Egyenleg
  // --------------------------------------------------------------------------

  /**
   * A hívó SAJÁT egyenlege, mindig az adatbázis aktuális állapotából.
   * Ha még nincs sora, `0`-t ad és NEM ír – az egyenleg-sort kizárólag a két
   * RPC hozza létre `on conflict do nothing`-gal, ezért sem versenyhelyzet,
   * sem duplikált sor nem keletkezhet. (Lásd: „Egyenleg-inicializálás".)
   */
  getBalance(userId: string): Promise<CoinBalance> {
    const id = this.owner(userId);
    return this.guard('getBalance', () => this.store.getBalance(id));
  }

  // --------------------------------------------------------------------------
  // Napló
  // --------------------------------------------------------------------------

  /**
   * Egy lap a hívó SAJÁT tranzakciós naplójából. A lapozás a meglévő
   * értesítés-konvenciót követi: `limit` + `before` kurzor, és a válasz
   * `hasMore` / `nextBefore` mezője mondja meg, hogyan folytatható. A teljes
   * napló sosem töltődik le egyszerre: a limit felső korlátja kötött.
   */
  async getHistory(userId: string, opts: HistoryOptions = {}): Promise<CoinHistoryPage> {
    const id = this.owner(userId);
    const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0
      ? Math.min(Math.trunc(opts.limit as number), COIN_HISTORY_MAX_LIMIT)
      : COIN_HISTORY_DEFAULT_LIMIT;
    // Ismeretlen típusszűrőt csendben elhagyunk: a szűrő kényelmi funkció,
    // nem jogosultsági döntés, és a kliens nem tudhat vele új típust bevezetni.
    const types = opts.types?.filter((t) => KNOWN_TYPES.has(t));

    return this.guard('getHistory', async () => {
      const [page, balance] = await Promise.all([
        this.store.listTransactions(id, limit, opts.before, types?.length ? types : undefined),
        this.store.getBalance(id),
      ]);
      return {
        transactions: page.rows,
        balance: balance.balance,
        hasMore: page.hasMore,
        nextBefore: page.hasMore && page.rows.length ? page.rows[page.rows.length - 1].createdAt : null,
      };
    });
  }

  // --------------------------------------------------------------------------
  // Jutalmazás
  // --------------------------------------------------------------------------

  /**
   * Coin jóváírása. IDEMPOTENS, de az idempotenciát az ADATBÁZIS adja: ugyanaz
   * a `(user_id, source_key)` páros másodszor `already_awarded`-ot ad és nem ír
   * újat. Ez a réteg nem ellenőrzi előre, hogy „megvan-e már" – az pont az a
   * versenyhelyzetes minta, amit a DB-megszorítás kivált.
   *
   * Az ÖSSZEG a `COIN_REWARDS` konfigurációból jön; explicit összeget csak
   * adminisztratív korrekció adhat meg.
   */
  async awardCoins(req: AwardRequest): Promise<CoinAwardResult> {
    const id = this.owner(req.userId);

    if (typeof req.type !== 'string' || !KNOWN_TYPES.has(req.type)) {
      throw new CoinError('Érvénytelen jutalomtípus.', 422, 'INVALID_REWARD_TYPE');
    }
    if (req.type === 'SHOP_PURCHASE') {
      // A terhelést kizárólag a purchase_shop_item() írja – jóváírásként soha.
      throw new CoinError('A vásárlási terhelést nem lehet jóváírásként írni.', 422, 'INVALID_REWARD_TYPE');
    }
    if (typeof req.sourceKey !== 'string' || req.sourceKey.length < 3 || req.sourceKey.length > 200) {
      throw new CoinError('Érvénytelen jutalom-forráskulcs.', 422, 'INVALID_SOURCE_KEY');
    }

    let amount: number;
    if (req.type === 'ADMIN_ADJUSTMENT') {
      if (!Number.isInteger(req.amount) || (req.amount as number) <= 0 || (req.amount as number) > MAX_TRANSACTION_ABS) {
        throw new CoinError('Érvénytelen jutalom-összeg.', 422, 'INVALID_AMOUNT');
      }
      amount = req.amount as number;
    } else {
      if (req.amount !== undefined) {
        // A jutalom összege KONFIGURÁCIÓS döntés, nem hívási paraméter.
        throw new CoinError('Ehhez a jutalomtípushoz nem adható meg összeg.', 422, 'INVALID_AMOUNT');
      }
      amount = COIN_REWARDS[req.type as CoinRewardType];
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new CoinError('Érvénytelen jutalom-összeg.', 422, 'INVALID_AMOUNT');
      }
    }

    const label = (typeof req.label === 'string' && req.label.trim() ? req.label.trim() : COIN_REWARD_LABEL[req.type]).slice(0, 120);

    return this.guard('awardCoins', () => this.store.award({
      userId: id, amount, type: req.type, label, sourceKey: req.sourceKey,
    }));
  }

  /**
   * Kényelmi alak a teljesítmény-jutalmakhoz (ezt használja majd az 5c):
   * a típus meghatározza az összeget, a forráskulcsot a hívó építi a
   * `shared/shop.ts` determinisztikus kulcs-építőivel.
   */
  awardReward(userId: string, type: CoinRewardType, sourceKey: string): Promise<CoinAwardResult> {
    if (!REWARD_TYPES.has(type)) {
      throw new CoinError('Érvénytelen jutalomtípus.', 422, 'INVALID_REWARD_TYPE');
    }
    return this.awardCoins({ userId, type, sourceKey });
  }

  // --------------------------------------------------------------------------
  // Vásárlás
  // --------------------------------------------------------------------------

  /**
   * Shop item megvásárlása. A hívó KIZÁRÓLAG az item kulcsát adja meg; az ár,
   * a ritkaság, az aktivitás és a lejárat a `shop_items` sorából jön, a
   * levonás / készlet / napló hármast pedig a `purchase_shop_item()` függvény
   * írja egyetlen tranzakcióban, a vásárlóra vett advisory lockkal.
   *
   * Ez a metódus szándékosan NEM vesz át összeget, árat, ritkaságot vagy
   * birtoklási állapotot – nincs is ilyen paramétere.
   */
  async purchaseShopItem(userId: string, itemKey: unknown): Promise<CoinPurchaseResult> {
    const id = this.owner(userId);
    if (!isValidItemKey(itemKey)) {
      throw new CoinError('Érvénytelen item azonosító.', 400, 'INVALID_ITEM_KEY');
    }

    const result = await this.guard('purchaseShopItem', () =>
      this.store.purchase(id, itemKey, new Date().toISOString()));

    switch (result.outcome) {
      case 'purchased':
        if (!result.item || result.balance === null) {
          throw new CoinError('A vásárlás nem értelmezhető.', 500, 'COIN_STORE_ERROR');
        }
        return { balance: result.balance, item: result.item };

      case 'already_owned':
        throw new CoinError('Ez az elem már a tiéd.', 409, 'ITEM_ALREADY_OWNED', {
          balance: result.balance ?? 0,
          itemKey,
        });

      case 'insufficient_coins':
        throw new CoinError('Nincs elég coinod ehhez az elemhez.', 402, 'INSUFFICIENT_COINS', {
          balance: result.balance ?? 0,
          priceCoins: result.item?.priceCoins ?? null,
          missing: result.item ? Math.max(0, result.item.priceCoins - (result.balance ?? 0)) : null,
          itemKey,
        });

      case 'not_found':
        throw new CoinError('Ez az elem nem található.', 404, 'ITEM_NOT_FOUND', { itemKey });

      case 'inactive':
        throw new CoinError('Ez az elem jelenleg nem kapható.', 409, 'ITEM_INACTIVE', { itemKey });

      case 'expired':
        throw new CoinError('Ennek az elemnek lejárt az elérhetősége.', 410, 'ITEM_EXPIRED', { itemKey });

      default:
        throw new CoinError('A vásárlás nem értelmezhető.', 500, 'COIN_STORE_ERROR');
    }
  }

  /** A vásárlás naplóbejegyzésének forráskulcsa – ugyanaz, amit a DB ír. */
  purchaseKeyFor(itemKey: string): string { return purchaseSourceKey(itemKey); }

  // --------------------------------------------------------------------------
  // Birtoklás
  // --------------------------------------------------------------------------

  /** A hívó SAJÁT készlete, item-kulcsok halmazaként. */
  ownedItemKeys(userId: string): Promise<Set<string>> {
    const id = this.owner(userId);
    return this.guard('ownedItemKeys', () => this.store.ownedItemKeys(id));
  }

  /**
   * A hívó birtokolt itemei kategóriával: a FELVÉTEL (equip) authority-ja.
   * Ezt adja át a profil-réteg a `sanitizeShopEquips()`-nek.
   */
  async ownedCategories(userId: string): Promise<Map<string, ShopCategory>> {
    const id = this.owner(userId);
    return this.guard('ownedCategories', async () =>
      (await this.store.ownedCategoriesMany([id])).get(id) ?? new Map());
  }

  /**
   * Kötegelt birtoklás a ranglistához. SZÁNDÉKOSAN nem ellenőrzi, hogy a hívó
   * ki: ez nem felhasználói adat-olvasás, hanem a NYILVÁNOS megjelenítéshez
   * kell (ki milyen kozmetikumot vehet fel) – a hívó a szerver maga.
   */
  ownedCategoriesMany(userIds: string[]): Promise<Map<string, Map<string, ShopCategory>>> {
    return this.guard('ownedCategoriesMany', () => this.store.ownedCategoriesMany(userIds));
  }

  /** Birtokolja-e a hívó az adott itemet? */
  async owns(userId: string, itemKey: string): Promise<boolean> {
    if (!isValidItemKey(itemKey)) return false;
    return (await this.ownedItemKeys(userId)).has(itemKey);
  }

  // --------------------------------------------------------------------------
  // Katalógus és készlet (olvasás)
  // --------------------------------------------------------------------------

  /**
   * Az AKTÍV katalógus a hívó szempontjából. HÁROM lekérdezés, fixen:
   * katalógus + készlet (kötegelt kulcshalmaz) + egyenleg – item-enként NINCS
   * külön kérés. A `owned` / `purchasable` / `blockedReason` mezőket a SZERVER
   * számolja; a lejárt időszakos itemek kimaradnak a listából.
   *
   * Az `equipped` ebben a szakaszban mindig `false`: a felvétel (equip)
   * rendszere az 5e feladata, és nem duplikáljuk ide a logikáját.
   */
  async listCatalog(userId: string): Promise<ShopCatalogResponse> {
    const id = this.owner(userId);
    return this.guard('listCatalog', async () => {
      const now = new Date();
      const [items, owned, balance] = await Promise.all([
        this.store.listItems(),
        this.store.ownedItemKeys(id),
        this.store.getBalance(id),
      ]);
      const views: ShopItemView[] = items
        .filter((i) => !itemExpired(i, now))
        .map((i) => {
          const isOwned = owned.has(i.itemKey);
          const available = itemPurchasable(i, now);
          const affordable = balance.balance >= i.priceCoins;
          const blockedReason: ShopItemView['blockedReason'] = isOwned ? 'owned'
            : !i.isActive ? 'inactive'
            : !available ? 'expired'
            : !affordable ? 'insufficient_coins'
            : null;
          return { ...i, owned: isOwned, equipped: false, purchasable: blockedReason === null, blockedReason };
        });
      return { items: views, balance: balance.balance, categories: [...SHOP_CATEGORIES] };
    });
  }

  /**
   * A hívó SAJÁT készlete. A lejárt vagy kivont item is benne marad – amit
   * megvett, az az övé. Két lekérdezés: készlet (beágyazott item-adattal) és
   * egyenleg; elemenként nincs külön kérés.
   */
  async getInventory(userId: string): Promise<ShopInventoryResponse> {
    const id = this.owner(userId);
    return this.guard('getInventory', async () => {
      const [rows, balance] = await Promise.all([
        this.store.listInventory(id),
        this.store.getBalance(id),
      ]);
      return {
        items: rows.map((r) => ({ item: r.item, paidCoins: r.paidCoins, purchasedAt: r.purchasedAt, equipped: false })),
        balance: balance.balance,
      };
    });
  }

  /** Egy item a katalógusból – az ÁR egyetlen forrása a felületek számára is. */
  getItem(itemKey: unknown) {
    if (!isValidItemKey(itemKey)) {
      throw new CoinError('Érvénytelen item azonosító.', 400, 'INVALID_ITEM_KEY');
    }
    return this.guard('getItem', () => this.store.getItemByKey(itemKey));
  }
}
