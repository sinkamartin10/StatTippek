/**
 * Coin store + service (5b szakasz).
 *
 * A tesztek a VALÓDI `CoinService`-t és a VALÓDI `SqliteCoinStore`-t futtatják.
 * A SQLite tároló sémája a `0011` migráció megszorításait tükrözi (UNIQUE,
 * CHECK), ezért az idempotenciát és a dupla vásárlás elleni védelmet itt is
 * ADATBÁZIS kényszeríti, nem alkalmazáskód.
 *
 * A PostgreSQL oldali megfelelőt külön, valódi PostgreSQL 17 példányon
 * ellenőrizzük (`tippstats_0011_test`); ez a fájl a szolgáltatás-réteg
 * szerződését és a biztonsági korlátait rögzíti.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { CoinError, CoinService } from '../src/server/coins/service';
import { SqliteCoinStore, type CoinStore } from '../src/server/coins/store';
import {
  COIN_HISTORY_DEFAULT_LIMIT, COIN_HISTORY_MAX_LIMIT, COIN_REWARDS, COIN_REWARD_LABEL,
  SHOP_SEED, competitionSourceKey, dailySourceKey, predictionSourceKey, purchaseSourceKey,
} from '../src/shared/shop';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const PRICE = (key: string) => SHOP_SEED.find((i) => i.itemKey === key)!.priceCoins;

type Db = InstanceType<typeof DatabaseSync>;
let db: Db;
let store: SqliteCoinStore;
let svc: CoinService;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  store = new SqliteCoinStore(db);
  svc = new CoinService(store);
});

/** Közvetlen jóváírás a teszt előkészítéséhez (a szolgáltatáson keresztül). */
const fund = (user: string, amount: number, key: string) =>
  svc.awardCoins({ userId: user, type: 'ADMIN_ADJUSTMENT', amount, sourceKey: key });

const err = async (fn: () => Promise<unknown>): Promise<CoinError> => {
  try { await fn(); } catch (e) { return e as CoinError; }
  throw new Error('nem dobott hibát');
};

// ============================================================================
// EGYENLEG
// ============================================================================

describe('Coin – egyenleg', () => {
  it('új felhasználó egyenlege 0, és az OLVASÁS nem hoz létre sort', () => {
    return svc.getBalance(A).then(async (b) => {
      expect(b).toEqual({ balance: 0, updatedAt: null });
      // Nincs write-on-read: így sem versenyhelyzet, sem duplikált sor nem lehet
      const n = Number((db.prepare('SELECT COUNT(*) AS n FROM user_coins').get() as any).n);
      expect(n).toBe(0);
      // Ismételt olvasás sem ír
      await svc.getBalance(A);
      expect(Number((db.prepare('SELECT COUNT(*) AS n FROM user_coins').get() as any).n)).toBe(0);
    });
  });

  it('az egyenleg-sort az RPC-megfelelő hozza létre, idempotensen', async () => {
    await fund(A, 100, 'seed:1');
    await fund(A, 100, 'seed:2');
    expect((await svc.getBalance(A)).balance).toBe(200);
    const rows = Number((db.prepare('SELECT COUNT(*) AS n FROM user_coins WHERE user_id = ?').get(A) as any).n);
    expect(rows, 'pontosan EGY egyenleg-sor').toBe(1);
  });

  it('az egyenleg a DB aktuális állapotát adja (nincs kliens- vagy memória-authority)', async () => {
    await fund(A, 500, 'seed:1');
    // A DB-t a szolgáltatás háta mögött módosítjuk: a következő olvasás ezt látja
    db.prepare('UPDATE user_coins SET balance = 777 WHERE user_id = ?').run(A);
    expect((await svc.getBalance(A)).balance).toBe(777);
  });

  it('az egyenleg a hitelesített felhasználóhoz van kötve: más user egyenlege nem kérhető', async () => {
    await fund(A, 500, 'seed:1');
    await fund(B, 999, 'seed:1');
    // A szolgáltatásnak NINCS olyan paramétere, amivel „célfelhasználót" lehetne
    // kérni: az egyetlen argumentum maga a hívó. Egy extra argumentum nem hat.
    expect(svc.getBalance.length).toBe(1);
    expect((await (svc.getBalance as any)(A, B)).balance).toBe(500);
    expect((await svc.getBalance(B)).balance).toBe(999);
  });

  it('érvénytelen vagy hiányzó felhasználó esetén 401', async () => {
    for (const bad of ['', 'nem-uuid', '11111111', null, undefined, 42, {}]) {
      const e = await err(() => svc.getBalance(bad as never));
      expect(e).toBeInstanceOf(CoinError);
      expect(e.status, String(bad)).toBe(401);
      expect(e.code).toBe('AUTH_REQUIRED');
    }
  });
});

// ============================================================================
// NAPLÓ
// ============================================================================

describe('Coin – tranzakciós napló', () => {
  it('a saját napló minden kötelező mezőt tartalmaz', async () => {
    await svc.awardCoins({ userId: A, type: 'EXACT_SCORE', sourceKey: predictionSourceKey('EXACT_SCORE', 'p1') });
    const page = await svc.getHistory(A);
    expect(page.transactions).toHaveLength(1);
    const t = page.transactions[0];
    expect(t.amount).toBe(COIN_REWARDS.EXACT_SCORE);
    expect(t.type).toBe('EXACT_SCORE');
    expect(t.label).toBe(COIN_REWARD_LABEL.EXACT_SCORE);
    expect(t.sourceKey).toBe('prediction:p1:exact_score');
    expect(t.balanceAfter).toBe(COIN_REWARDS.EXACT_SCORE);
    expect(typeof t.createdAt).toBe('string');
    expect(t.id).toBeTruthy();
    expect(page.balance).toBe(COIN_REWARDS.EXACT_SCORE);
  });

  it('a napló fordított időrendben jön, és az összege az egyenleg', async () => {
    for (let n = 0; n < 5; n++) {
      await svc.awardCoins({ userId: A, type: 'PREDICTION_SUBMITTED', sourceKey: predictionSourceKey('PREDICTION_SUBMITTED', `p${n}`) });
    }
    // A sorrendet KULONBOZO idobelyegeken ellenorizzuk: az ot jovairas ugyanabba
    // a milliszekundumba eshet, es akkor a created_at nem valaszt kozuluk.
    const ids = (db.prepare('SELECT id FROM coin_transactions ORDER BY balance_after').all() as any[]).map((r) => r.id);
    ids.forEach((id, n) => db.prepare('UPDATE coin_transactions SET created_at = ? WHERE id = ?')
      .run(new Date(Date.UTC(2026, 9, 7, 12, n)).toISOString(), id));

    const page = await svc.getHistory(A);
    expect(page.transactions).toHaveLength(5);
    const after = page.transactions.map((t) => t.balanceAfter);
    expect(after, 'legfrissebb elol').toEqual([...after].sort((x, y) => y - x));
    expect(page.balance).toBe(5 * COIN_REWARDS.PREDICTION_SUBMITTED);
  });

  it('LAPOZ: nem tölti le egyszerre az egészet, és a kurzorral folytatható', async () => {
    for (let n = 0; n < 12; n++) {
      await svc.awardCoins({ userId: A, type: 'PREDICTION_SUBMITTED', sourceKey: predictionSourceKey('PREDICTION_SUBMITTED', `p${n}`) });
    }
    const first = await svc.getHistory(A, { limit: 5 });
    expect(first.transactions).toHaveLength(5);
    expect(first.hasMore).toBe(true);
    expect(first.nextBefore).toBeTruthy();

    const second = await svc.getHistory(A, { limit: 5, before: first.nextBefore! });
    expect(second.transactions.length).toBeLessThanOrEqual(5);
    // Nincs átfedés a két lap között
    const ids = new Set(first.transactions.map((t) => t.id));
    for (const t of second.transactions) expect(ids.has(t.id)).toBe(false);
  });

  it('a limit felső korlátos, és érvénytelen limitnél az alapértelmezés érvényes', async () => {
    for (let n = 0; n < 3; n++) {
      await svc.awardCoins({ userId: A, type: 'PREDICTION_SUBMITTED', sourceKey: predictionSourceKey('PREDICTION_SUBMITTED', `p${n}`) });
    }
    // A kliens nem tudja „az összeset" lekérni: a limitet a szerver vágja
    expect((await svc.getHistory(A, { limit: 10_000 })).transactions.length).toBeLessThanOrEqual(COIN_HISTORY_MAX_LIMIT);
    for (const bad of [0, -1, Number.NaN, undefined]) {
      const p = await svc.getHistory(A, { limit: bad as never });
      expect(p.transactions.length).toBeLessThanOrEqual(COIN_HISTORY_DEFAULT_LIMIT);
    }
  });

  it('típus szerint szűrhető, és ismeretlen típust nem lehet becsempészni', async () => {
    await svc.awardCoins({ userId: A, type: 'EXACT_SCORE', sourceKey: predictionSourceKey('EXACT_SCORE', 'p1') });
    await svc.awardCoins({ userId: A, type: 'DAILY_TIPS', sourceKey: dailySourceKey('2026-10-07') });
    expect((await svc.getHistory(A, { types: ['EXACT_SCORE'] })).transactions).toHaveLength(1);
    // Az ismeretlen szűrő elhagyásra kerül – nem hoz létre új típust, és nem is hibázik
    const all = await svc.getHistory(A, { types: ['NEM_LETEZO'] as never });
    expect(all.transactions).toHaveLength(2);
  });

  it('MÁS felhasználó naplója nem kérhető', async () => {
    await svc.awardCoins({ userId: A, type: 'EXACT_SCORE', sourceKey: predictionSourceKey('EXACT_SCORE', 'pa') });
    await svc.awardCoins({ userId: B, type: 'EXACT_SCORE', sourceKey: predictionSourceKey('EXACT_SCORE', 'pb') });
    const page = await svc.getHistory(A);
    expect(page.transactions).toHaveLength(1);
    expect(page.transactions[0].sourceKey).toBe('prediction:pa:exact_score');
    // Nincs „célfelhasználó" paraméter: az opciók között sem lehet átadni
    const sneaky = await svc.getHistory(A, { userId: B, user_id: B, targetUserId: B } as never);
    expect(sneaky.transactions).toHaveLength(1);
    expect(sneaky.transactions[0].sourceKey).toBe('prediction:pa:exact_score');
  });
});

// ============================================================================
// JUTALMAZÁS
// ============================================================================

describe('Coin – jutalmazás (award wrapper)', () => {
  it('sikeres jóváírás: az összeg a SZERVER konfigurációjából jön', async () => {
    const r = await svc.awardCoins({ userId: A, type: 'CORRECT_OUTCOME', sourceKey: predictionSourceKey('CORRECT_OUTCOME', 'p1') });
    expect(r.outcome).toBe('awarded');
    expect(r.amount).toBe(COIN_REWARDS.CORRECT_OUTCOME);
    expect(r.balance).toBe(COIN_REWARDS.CORRECT_OUTCOME);
  });

  it('awardReward: a típus határozza meg az összeget', async () => {
    const r = await svc.awardReward(A, 'COMPETITION_FIRST', competitionSourceKey('c1', 'COMPETITION_FIRST'));
    expect(r.amount).toBe(COIN_REWARDS.COMPETITION_FIRST);
    expect((await svc.getBalance(A)).balance).toBe(COIN_REWARDS.COMPETITION_FIRST);
  });

  it('IDEMPOTENS: ugyanaz a source_key másodszor nem ír jóvá újabb coint', async () => {
    const key = predictionSourceKey('EXACT_SCORE', 'p1');
    const first = await svc.awardCoins({ userId: A, type: 'EXACT_SCORE', sourceKey: key });
    const second = await svc.awardCoins({ userId: A, type: 'EXACT_SCORE', sourceKey: key });
    expect(first.outcome).toBe('awarded');
    expect(second.outcome).toBe('already_awarded');
    expect(second.amount).toBe(0);
    expect(second.balance).toBe(first.balance);
    expect((await svc.getHistory(A)).transactions).toHaveLength(1);
  });

  it('az idempotenciát ADATBÁZIS-szintű egyediség adja, nem alkalmazáskód', async () => {
    const key = dailySourceKey('2026-10-07');
    await svc.awardCoins({ userId: A, type: 'DAILY_TIPS', sourceKey: key });
    expect(() => db.prepare(`INSERT INTO coin_transactions
      (id, user_id, amount, type, label, source_key, balance_after, created_at)
      VALUES ('x',?,20,'DAILY_TIPS','x',?,40,?)`).run(A, key, new Date().toISOString())).toThrow();
  });

  it('külön source_key külön jutalmat ad, és felhasználónként független', async () => {
    await svc.awardCoins({ userId: A, type: 'DAILY_TIPS', sourceKey: dailySourceKey('2026-10-07') });
    await svc.awardCoins({ userId: A, type: 'DAILY_TIPS', sourceKey: dailySourceKey('2026-10-08') });
    await svc.awardCoins({ userId: B, type: 'DAILY_TIPS', sourceKey: dailySourceKey('2026-10-07') });
    expect((await svc.getBalance(A)).balance).toBe(2 * COIN_REWARDS.DAILY_TIPS);
    expect((await svc.getBalance(B)).balance).toBe(COIN_REWARDS.DAILY_TIPS);
  });

  it('teljesítmény-jutalomhoz NEM adható meg összeg (a hívó nem írhatja felül)', async () => {
    const e = await err(() => svc.awardCoins({ userId: A, type: 'EXACT_SCORE', sourceKey: 'prediction:p1:exact_score', amount: 999_999 }));
    expect(e.status).toBe(422);
    expect(e.code).toBe('INVALID_AMOUNT');
    expect((await svc.getBalance(A)).balance).toBe(0);
  });

  it('adminisztratív korrekciónál az összeg ellenőrzött', async () => {
    for (const bad of [0, -1, 1.5, 1_000_001, Number.NaN, undefined, '100']) {
      const e = await err(() => svc.awardCoins({ userId: A, type: 'ADMIN_ADJUSTMENT', amount: bad as never, sourceKey: `adj:${bad}` }));
      expect(e.code, String(bad)).toBe('INVALID_AMOUNT');
      expect(e.status).toBe(422);
    }
    expect((await svc.getBalance(A)).balance).toBe(0);
  });

  it('érvénytelen típus és forráskulcs elutasítva', async () => {
    const t = await err(() => svc.awardCoins({ userId: A, type: 'HACK' as never, sourceKey: 'x:1' }));
    expect(t.code).toBe('INVALID_REWARD_TYPE');
    expect(t.status).toBe(422);
    // A vásárlási terhelést nem lehet jóváírásként írni
    const p = await err(() => svc.awardCoins({ userId: A, type: 'SHOP_PURCHASE', sourceKey: 'purchase:frame_fire' }));
    expect(p.code).toBe('INVALID_REWARD_TYPE');
    for (const bad of ['', 'ab', 'x'.repeat(201), null, 7]) {
      const e = await err(() => svc.awardCoins({ userId: A, type: 'DAILY_TIPS', sourceKey: bad as never }));
      expect(e.code, String(bad)).toBe('INVALID_SOURCE_KEY');
    }
    expect((await svc.getHistory(A)).transactions).toHaveLength(0);
  });

  it('a jóváírás a hitelesített felhasználóra megy: érvénytelen azonosító 401', async () => {
    const e = await err(() => svc.awardCoins({ userId: 'nem-uuid', type: 'DAILY_TIPS', sourceKey: 'daily:x' }));
    expect(e.status).toBe(401);
    expect(e.code).toBe('AUTH_REQUIRED');
  });
});

// ============================================================================
// VÁSÁRLÁS
// ============================================================================

describe('Coin – vásárlás (purchase wrapper)', () => {
  it('sikeres vásárlás: levonás, készlet és napló együtt', async () => {
    await fund(A, 3000, 'seed:1');
    const r = await svc.purchaseShopItem(A, 'frame_fire');
    expect(r.item.itemKey).toBe('frame_fire');
    expect(r.item.priceCoins).toBe(PRICE('frame_fire'));
    expect(r.balance).toBe(3000 - PRICE('frame_fire'));
    expect((await svc.getBalance(A)).balance).toBe(r.balance);
    expect(await svc.owns(A, 'frame_fire')).toBe(true);

    const tx = (await svc.getHistory(A)).transactions.find((t) => t.type === 'SHOP_PURCHASE')!;
    expect(tx.amount).toBe(-PRICE('frame_fire'));
    expect(tx.balanceAfter).toBe(r.balance);
    expect(tx.sourceKey).toBe(purchaseSourceKey('frame_fire'));
  });

  it('kevés coin → 402, és SEMMI nem változik', async () => {
    await fund(A, 100, 'seed:1');
    const e = await err(() => svc.purchaseShopItem(A, 'frame_fire'));
    expect(e.status).toBe(402);
    expect(e.code).toBe('INSUFFICIENT_COINS');
    expect(e.details).toMatchObject({ balance: 100, priceCoins: PRICE('frame_fire'), missing: PRICE('frame_fire') - 100 });
    expect((await svc.getBalance(A)).balance).toBe(100);
    expect((await svc.ownedItemKeys(A)).size).toBe(0);
  });

  it('már megvan → 409, nincs újabb levonás', async () => {
    await fund(A, 10000, 'seed:1');
    const first = await svc.purchaseShopItem(A, 'frame_fire');
    const e = await err(() => svc.purchaseShopItem(A, 'frame_fire'));
    expect(e.status).toBe(409);
    expect(e.code).toBe('ITEM_ALREADY_OWNED');
    expect((await svc.getBalance(A)).balance).toBe(first.balance);
    expect((await svc.ownedItemKeys(A)).size).toBe(1);
  });

  it('a dupla vásárlást ADATBÁZIS-szintű egyediség is védi', async () => {
    await fund(A, 10000, 'seed:1');
    await svc.purchaseShopItem(A, 'frame_fire');
    expect(() => db.prepare(
      `INSERT INTO user_shop_items (id, user_id, item_id, paid_coins, purchased_at)
        SELECT 'x', ?, id, 0, ? FROM shop_items WHERE item_key = 'frame_fire'`,
    ).run(A, new Date().toISOString())).toThrow();
  });

  it('inaktív item → 409 ITEM_INACTIVE', async () => {
    await fund(A, 10000, 'seed:1');
    db.prepare("UPDATE shop_items SET is_active = 0 WHERE item_key = 'frame_fire'").run();
    const e = await err(() => svc.purchaseShopItem(A, 'frame_fire'));
    expect(e.status).toBe(409);
    expect(e.code).toBe('ITEM_INACTIVE');
    expect((await svc.getBalance(A)).balance).toBe(10000);
  });

  it('lejárt item → 410 ITEM_EXPIRED, de a MÁR MEGVETT megmarad', async () => {
    await fund(A, 10000, 'seed:1');
    await svc.purchaseShopItem(A, 'name_green');
    db.prepare("UPDATE shop_items SET is_limited = 1, available_until = '2020-01-01T00:00:00.000Z' WHERE item_key IN ('name_green','name_blue')").run();
    const e = await err(() => svc.purchaseShopItem(A, 'name_blue'));
    expect(e.status).toBe(410);
    expect(e.code).toBe('ITEM_EXPIRED');
    expect(await svc.owns(A, 'name_green'), 'a megvett item a készletben marad').toBe(true);
  });

  it('nem létező item → 404 ITEM_NOT_FOUND', async () => {
    await fund(A, 10000, 'seed:1');
    const e = await err(() => svc.purchaseShopItem(A, 'nincs_ilyen_item'));
    expect(e.status).toBe(404);
    expect(e.code).toBe('ITEM_NOT_FOUND');
  });

  it('érvénytelen item-kulcs → 400 INVALID_ITEM_KEY (a DB-ig sem jut el)', async () => {
    await fund(A, 10000, 'seed:1');
    for (const bad of ['', 'ab', 'Frame_Fire', 'frame fire', "frame'; drop table shop_items; --", '../etc', null, 42, { itemKey: 'frame_fire' }, ['frame_fire']]) {
      const e = await err(() => svc.purchaseShopItem(A, bad as never));
      expect(e.code, JSON.stringify(bad)).toBe('INVALID_ITEM_KEY');
      expect(e.status).toBe(400);
    }
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM shop_items').get() as any).n)).toBe(SHOP_SEED.length);
    expect((await svc.getBalance(A)).balance).toBe(10000);
  });

  it('érvénytelen felhasználó → 401, vásárlás nem történik', async () => {
    const e = await err(() => svc.purchaseShopItem('nem-uuid', 'frame_fire'));
    expect(e.status).toBe(401);
    expect(e.code).toBe('AUTH_REQUIRED');
  });

  it('ownership: a készlet a saját itemeket adja, a másik felhasználóét nem', async () => {
    await fund(A, 10000, 'seed:1');
    await fund(B, 10000, 'seed:1');
    await svc.purchaseShopItem(A, 'frame_fire');
    await svc.purchaseShopItem(B, 'name_green');
    expect([...(await svc.ownedItemKeys(A))]).toEqual(['frame_fire']);
    expect([...(await svc.ownedItemKeys(B))]).toEqual(['name_green']);
    expect(await svc.owns(A, 'name_green')).toBe(false);
    expect(await svc.owns(A, 'ervenytelen kulcs')).toBe(false);
  });

  it('getItem: az ár egyetlen forrása a katalógus', async () => {
    const item = await svc.getItem('frame_fire');
    expect(item?.priceCoins).toBe(PRICE('frame_fire'));
    expect(await svc.getItem('nincs_ilyen_item')).toBeNull();
    const e = await err(() => svc.getItem('BAD KEY') as Promise<unknown>);
    expect(e.code).toBe('INVALID_ITEM_KEY');
  });
});

// ============================================================================
// BIZTONSÁG – amit a szolgáltatás-réteg NEM tud megtenni
// ============================================================================

describe('Coin – biztonság', () => {
  it('a vásárlásra NEM lehet tetszőleges coin-összeget ráerőltetni', async () => {
    await fund(A, 10000, 'seed:1');
    // A metódusnak két paramétere van: a hívó és az item kulcsa. Bármi további
    // argumentum figyelmen kívül marad – az ár a katalógusból jön.
    expect(svc.purchaseShopItem.length).toBe(2);
    const r = await (svc.purchaseShopItem as any)(A, 'frame_fire', { amount: 1, priceCoins: 1, price: 1, coins: 1 });
    expect(r.balance).toBe(10000 - PRICE('frame_fire'));
    expect(r.item.priceCoins).toBe(PRICE('frame_fire'));
  });

  it('a vásárlásra NEM lehet tetszőleges árat vagy rarityt megadni', async () => {
    await fund(A, 10000, 'seed:1');
    // Objektumként átadott „item" nem kulcs: elutasítva, a DB-ig sem jut el
    const e = await err(() => svc.purchaseShopItem(A, { itemKey: 'frame_fire', priceCoins: 1, rarity: 'common' } as never));
    expect(e.code).toBe('INVALID_ITEM_KEY');
    // A katalógus ára és ritkasága változatlan
    const item = await svc.getItem('frame_fire');
    expect(item?.priceCoins).toBe(PRICE('frame_fire'));
    expect(item?.rarity).toBe('rare');
    expect((await svc.getBalance(A)).balance).toBe(10000);
  });

  it('a kliens NEM tud új itemet vagy ritkaságot bevezetni a vásárlással', async () => {
    await fund(A, 10000, 'seed:1');
    const e = await err(() => svc.purchaseShopItem(A, 'sajat_legendary_item'));
    expect(e.code).toBe('ITEM_NOT_FOUND'); // nincs ilyen a katalógusban – nem jön létre
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM shop_items').get() as any).n)).toBe(SHOP_SEED.length);
  });

  it('MÁS felhasználónak nem lehet coint adni', async () => {
    // Nincs „célfelhasználó" paraméter: a kérés egyetlen felhasználó-mezője a hívó.
    await svc.awardCoins({
      userId: A, type: 'DAILY_TIPS', sourceKey: dailySourceKey('2026-10-07'),
      // ezek a mezők nem léteznek a szerződésben, ezért hatástalanok
      targetUserId: B, toUserId: B, user_id: B, recipient: B,
    } as never);
    expect((await svc.getBalance(A)).balance).toBe(COIN_REWARDS.DAILY_TIPS);
    expect((await svc.getBalance(B)).balance).toBe(0);
    expect((await svc.getHistory(B)).transactions).toHaveLength(0);
  });

  it('MÁS felhasználó készletét nem lehet módosítani', async () => {
    await fund(A, 10000, 'seed:1');
    await fund(B, 10000, 'seed:1');
    await (svc.purchaseShopItem as any)(A, 'frame_fire', { userId: B, user_id: B });
    expect((await svc.ownedItemKeys(B)).size).toBe(0);
    expect((await svc.getBalance(B)).balance).toBe(10000);
    expect((await svc.ownedItemKeys(A)).size).toBe(1);
  });

  it('a szolgáltatás nem kerüli meg a DB-t: nincs közvetlen egyenleg-író metódusa', () => {
    const methods = Object.getOwnPropertyNames(CoinService.prototype);
    for (const forbidden of ['setBalance', 'addBalance', 'deductBalance', 'updateBalance', 'grantItem', 'setOwnership']) {
      expect(methods, forbidden).not.toContain(forbidden);
    }
    // A nyilvános felület pontosan a szerződés szerinti metódusok
    expect(methods.filter((m) => m !== 'constructor').sort()).toEqual([
      'awardCoins', 'awardReward', 'getBalance', 'getHistory', 'getInventory', 'getItem',
      'guard', 'listCatalog', 'ownedCategories', 'ownedCategoriesMany', 'ownedItemKeys',
      'owner', 'owns', 'purchaseKeyFor', 'purchaseShopItem',
    ]);
  });
});

// ============================================================================
// HIBAKEZELÉS – DB/RPC hiba leképezése
// ============================================================================

/** Minden műveleten elhasaló tároló: a DB-hiba leképezését bizonyítja. */
class BrokenStore implements CoinStore {
  readonly kind = 'postgres' as const;
  private boom(): never { throw new Error('[coins] relation "user_coins" does not exist (SQLSTATE 42P01)'); }
  async healthCheck() { return ['user_coins']; }
  async getBalance(): Promise<never> { this.boom(); }
  async listTransactions(): Promise<never> { this.boom(); }
  async award(): Promise<never> { this.boom(); }
  async purchase(): Promise<never> { this.boom(); }
  async getItemByKey(): Promise<never> { this.boom(); }
  async ownedItemKeys(): Promise<never> { this.boom(); }
  async listItems(): Promise<never> { this.boom(); }
  async listInventory(): Promise<never> { this.boom(); }
  async ownedCategoriesMany(): Promise<never> { this.boom(); }
}

describe('Coin – DB/RPC hiba leképezése', () => {
  const broken = new CoinService(new BrokenStore());

  it('minden művelet 500 COIN_STORE_ERROR-ra képződik, SQL-részletek nélkül', async () => {
    const ops: Array<[string, () => Promise<unknown>]> = [
      ['getBalance', () => broken.getBalance(A)],
      ['getHistory', () => broken.getHistory(A)],
      ['awardCoins', () => broken.awardCoins({ userId: A, type: 'DAILY_TIPS', sourceKey: dailySourceKey('2026-10-07') })],
      ['purchaseShopItem', () => broken.purchaseShopItem(A, 'frame_fire')],
      ['ownedItemKeys', () => broken.ownedItemKeys(A)],
      ['getItem', () => broken.getItem('frame_fire') as Promise<unknown>],
      ['listCatalog', () => broken.listCatalog(A)],
      ['getInventory', () => broken.getInventory(A)],
    ];
    for (const [name, op] of ops) {
      const e = await err(op);
      expect(e, name).toBeInstanceOf(CoinError);
      expect(e.status, name).toBe(500);
      expect(e.code, name).toBe('COIN_STORE_ERROR');
      // A belső hibaszöveg nem szivárog ki a hívóhoz
      expect(e.message, name).not.toMatch(/SQLSTATE|relation|user_coins/);
    }
  });

  it('az érvényesítési hibák a DB-hiba előtt dőlnek el (nem nyelődnek el 500-ba)', async () => {
    expect((await err(() => broken.purchaseShopItem(A, 'BAD KEY'))).code).toBe('INVALID_ITEM_KEY');
    expect((await err(() => broken.getBalance('nem-uuid'))).code).toBe('AUTH_REQUIRED');
    expect((await err(() => broken.awardCoins({ userId: A, type: 'HACK' as never, sourceKey: 'x:1' }))).code).toBe('INVALID_REWARD_TYPE');
  });
});

// ============================================================================
// TÁROLÓ – szerződés és vetőmag
// ============================================================================

describe('Coin store – szerződés', () => {
  it('a helyi tároló a teljes katalógust felveti, duplikáció nélkül', () => {
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM shop_items').get() as any).n)).toBe(SHOP_SEED.length);
    new SqliteCoinStore(db); // ismételt indítás
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM shop_items').get() as any).n)).toBe(SHOP_SEED.length);
  });

  it('az ismételt indítás nem írja felül az admin által módosított árat', () => {
    db.prepare("UPDATE shop_items SET price_coins = 1 WHERE item_key = 'frame_fire'").run();
    new SqliteCoinStore(db);
    expect(Number((db.prepare("SELECT price_coins FROM shop_items WHERE item_key = 'frame_fire'").get() as any).price_coins)).toBe(1);
  });

  it('a negatív egyenleget a tároló sémája is kizárja', async () => {
    await fund(A, 100, 'seed:1');
    expect(() => db.prepare('UPDATE user_coins SET balance = -1 WHERE user_id = ?').run(A)).toThrow();
  });

  it('az ár későbbi változása nem írja át a már megfizetett összeget', async () => {
    await fund(A, 10000, 'seed:1');
    await svc.purchaseShopItem(A, 'frame_fire');
    db.prepare("UPDATE shop_items SET price_coins = 1 WHERE item_key = 'frame_fire'").run();
    const paid = Number((db.prepare('SELECT paid_coins FROM user_shop_items WHERE user_id = ?').get(A) as any).paid_coins);
    expect(paid).toBe(PRICE('frame_fire'));
  });

  it('a tároló hibája nem hagy félkész állapotot (tranzakció)', async () => {
    await fund(A, 10000, 'seed:1');
    // A napló-beszúrás elhasal: a `type` megszorítás túl rövid értéket nem fogad
    await expect(store.award({ userId: A, amount: 50, type: 'XX' as never, label: 'x', sourceKey: 'tx:fail' })).rejects.toThrow();
    expect((await svc.getBalance(A)).balance).toBe(10000);
    expect((await svc.getHistory(A)).transactions).toHaveLength(1);
  });
});
