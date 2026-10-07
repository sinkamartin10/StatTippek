/**
 * Coin + Shop API.
 *
 * Biztonsági elvek (a meglévő rendszerrel azonosak):
 *  - a hívót KIZÁRÓLAG a hitelesített Supabase token azonosítja
 *    (`res.locals.plan.user.id`); a kérésben küldött user_id / userId /
 *    targetUserId / recipient mezőt SOHA nem olvassuk ki,
 *  - a kliens EGYETLEN authority inputja az `itemKey`. Árat, ritkaságot,
 *    kategóriát, egyenleget vagy jutalom-összeget a kérésből sosem veszünk át:
 *    ezek a `shop_items` sorából és a `COIN_REWARDS` konfigurációból jönnek,
 *  - a vásárlás atomicitását a `purchase_shop_item()` adja, nem ez a réteg;
 *    a route a service eredményét adja tovább, és SEMMIT nem számol újra,
 *  - FREE és PRO egyaránt használhatja: csak bejelentkezés kell. A coin
 *    kozmetikumra váltható, ezért nincs mögötte PRO-kapu.
 *
 * KÉRÉS-KORLÁT: az `/api` szintű, IP-alapú korlát (240 kérés/perc) ezekre az
 * útvonalakra is érvényes – nem építünk párhuzamos megoldást. A vásárlást
 * ezen túl az adatbázis korlátozza: egy item egyszer vehető meg
 * (`(user_id, item_id)` egyediség), és az egyenleg nem mehet negatívba.
 */
import { Router, type Response } from 'express';
import { planOf, requireAuthenticated } from '../billing/entitlement';
import { CoinError, type CoinService } from '../coins/service';
import {
  COIN_HISTORY_DEFAULT_LIMIT, COIN_HISTORY_MAX_LIMIT, COIN_REWARD_LABEL,
  type CoinBalance, type CoinHistoryPage, type CoinTransactionType,
  type ShopCatalogResponse, type ShopInventoryResponse, type ShopPurchaseResponse,
} from '../../shared/shop';

const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000000';

/** A művelet tulajdonosa: kizárólag a hitelesített tokenből. */
function ownerId(res: Response): string | null {
  const plan = planOf(res);
  if (!plan.enforced) return LOCAL_USER_ID;
  return plan.user?.id ?? null;
}

const needAuth = (res: Response) => res.status(401).json({ error: 'Bejelentkezés szükséges.', code: 'AUTH_REQUIRED' });

/**
 * Üzleti hiba → HTTP. A `CoinError` hordozza a státuszt és a kódot, a
 * `details` pedig a SZERVER által számolt extra mezőket (pl. a hiányzó coin).
 * Minden más hiba egységes 500: a DB belső hibája (SQLSTATE, táblanév,
 * stack trace) SOHA nem szivárog ki a válaszba.
 */
function handle(res: Response, e: unknown): void {
  if (e instanceof CoinError) {
    res.status(e.status).json({ error: e.message, code: e.code, ...(e.details ?? {}) });
    return;
  }
  console.error('[coins]', e);
  res.status(500).json({ error: 'Szerverhiba a coin művelet feldolgozásakor.', code: 'COIN_STORE_ERROR' });
}

const q = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A `type` szűrő a kérésből: csak ISMERT típus maradhat (új típust nem lehet bevezetni). */
function typesOf(raw: unknown): CoinTransactionType[] | undefined {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const known = list
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t): t is CoinTransactionType => t in COIN_REWARD_LABEL);
  return known.length ? known : undefined;
}

export function coinsRouter(svc: CoinService): Router {
  const r = Router();

  /** A hívó SAJÁT egyenlege, mindig a DB aktuális állapotából. */
  r.get('/balance', requireAuthenticated, async (_req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try {
      const balance: CoinBalance = await svc.getBalance(userId);
      res.json(balance);
    } catch (e) { handle(res, e); }
  });

  /**
   * A hívó SAJÁT tranzakciós naplója, cursor-alapú lapozással (`before`),
   * nem offsettel: a lista eleje folyamatosan nő, offsettel a lapok
   * elcsúsznának. Az egyenleg UGYANEBBEN a válaszban jön (nincs külön kérés).
   */
  r.get('/history', requireAuthenticated, async (req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);

    const raw = parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, COIN_HISTORY_MAX_LIMIT) : COIN_HISTORY_DEFAULT_LIMIT;

    const before = q(req.query.before);
    if (before && Number.isNaN(new Date(before).getTime())) {
      return res.status(400).json({ error: 'Érvénytelen cursor.', code: 'INVALID_CURSOR' });
    }

    try {
      const page: CoinHistoryPage = await svc.getHistory(userId, { limit, before, types: typesOf(req.query.type) });
      res.json(page);
    } catch (e) { handle(res, e); }
  });

  return r;
}

export function shopRouter(svc: CoinService): Router {
  const r = Router();

  /**
   * Az AKTÍV katalógus. Az ÁR, a ritkaság, a kategória és a lejárat
   * kizárólag az adatbázisból jön; a `owned` / `purchasable` / `blockedReason`
   * mezőket a szerver számolja a hívó készletéből és egyenlegéből, EGY
   * kötegelt lekérdezéssel (item-enként nincs külön kérés).
   */
  r.get('/items', requireAuthenticated, async (_req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try {
      const catalog: ShopCatalogResponse = await svc.listCatalog(userId);
      res.json(catalog);
    } catch (e) { handle(res, e); }
  });

  /** A hívó SAJÁT készlete. Más felhasználó készlete ezen az úton sem érhető el. */
  r.get('/inventory', requireAuthenticated, async (_req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try {
      const inventory: ShopInventoryResponse = await svc.getInventory(userId);
      res.json(inventory);
    } catch (e) { handle(res, e); }
  });

  /**
   * Vásárlás. A kérés törzséből KIZÁRÓLAG az `itemKey`-t olvassuk ki – minden
   * további mező (priceCoins, price, coins, rarity, category, item, balance,
   * userId, targetUserId) figyelmen kívül marad.
   *
   * A levonás / készlet / napló hármast a `purchase_shop_item()` írja egyetlen
   * tranzakcióban, a vásárlóra vett advisory lockkal; a fizetett árat a DB
   * adja vissza, ez a réteg nem számolja újra.
   */
  r.post('/purchase', requireAuthenticated, async (req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);

    // A body egyetlen figyelembe vett mezője. A `?? req.body?.item_key` csak
    // alaki kényelem – mindkettő ugyanazon a validáción megy át a service-ben.
    const itemKey: unknown = req.body?.itemKey ?? req.body?.item_key;

    try {
      const result = await svc.purchaseShopItem(userId, itemKey);
      const body: ShopPurchaseResponse = {
        itemKey: result.item.itemKey,
        paidCoins: result.item.priceCoins,
        balance: result.balance,
        item: result.item,
      };
      res.status(201).json(body);
    } catch (e) { handle(res, e); }
  });

  return r;
}
