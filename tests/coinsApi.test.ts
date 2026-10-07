/**
 * Coin + Shop API (5d) – HTTP szint.
 *
 * Valódi Express alkalmazást indítunk a VALÓDI routerekkel és a VALÓDI
 * `requireAuthenticated` őrrel; az egyetlen szimulált elem a `res.locals.plan`
 * előállítása (élesben az `attachPlan` tölti ki a hitelesített tokenből) –
 * ugyanaz a minta, amit a Tippverseny, a küldetés és az értesítés tesztjei
 * használnak. A coin-műveletek a valódi `CoinService`-en és a valódi
 * `SqliteCoinStore` megszorításain mennek át.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { SqliteCoinStore } from '../src/server/coins/store';
import { CoinService } from '../src/server/coins/service';
import { coinsRouter, shopRouter } from '../src/server/routes/coins';
import {
  COIN_HISTORY_DEFAULT_LIMIT, COIN_HISTORY_MAX_LIMIT, COIN_REWARDS, SHOP_CATEGORIES, SHOP_SEED,
  dailySourceKey, predictionSourceKey, purchaseSourceKey,
} from '../src/shared/shop';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const PRICE = (k: string) => SHOP_SEED.find((i) => i.itemKey === k)!.priceCoins;

interface Harness {
  url: string;
  close: () => Promise<void>;
  db: InstanceType<typeof DatabaseSync>;
  svc: CoinService;
}

async function startApp(): Promise<Harness> {
  const db = new DatabaseSync(':memory:');
  const svc = new CoinService(new SqliteCoinStore(db));

  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    // Élesben ezt az attachPlan állítja elő a hitelesített Supabase tokenből
    res.locals.plan = { enforced: true, user: id ? { id, email: '' } : null, pro: false, admin: false };
    next();
  });
  app.use('/api/coins', coinsRouter(svc));
  app.use('/api/shop', shopRouter(svc));

  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    db, svc,
  };
}

async function call(h: Harness, method: string, path: string, user?: string, body?: unknown) {
  const res = await fetch(`${h.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* nem JSON */ }
  return { status: res.status, body: json, raw: text };
}

let h: Harness;
beforeEach(async () => { h = await startApp(); });
afterEach(async () => { await h.close(); });

/** Egyenleg feltöltése a szolgáltatáson keresztül (adminisztratív korrekció). */
const fund = (user: string, amount: number, key = 'adj:seed') =>
  h.svc.awardCoins({ userId: user, type: 'ADMIN_ADJUSTMENT', amount, sourceKey: key });

// ===========================================================================
// GET /api/coins/balance
// ===========================================================================

describe('API – GET /api/coins/balance', () => {
  it('D1. hitelesítés nélkül 401', async () => {
    const r = await call(h, 'GET', '/api/coins/balance');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('AUTH_REQUIRED');
  });

  it('D2. új felhasználónál 0, és az olvasás NEM hoz létre sort', async () => {
    const r = await call(h, 'GET', '/api/coins/balance', A);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ balance: 0, updatedAt: null });
    expect(Number((h.db.prepare('SELECT COUNT(*) AS n FROM user_coins').get() as any).n)).toBe(0);
  });

  it('D3. a jóváírt egyenleget adja, a DB aktuális állapotából', async () => {
    await fund(A, 1250);
    const r = await call(h, 'GET', '/api/coins/balance', A);
    expect(r.body.balance).toBe(1250);
    // a DB háta mögötti változást a következő kérés azonnal látja (nincs stale cache)
    h.db.prepare('UPDATE user_coins SET balance = 7 WHERE user_id = ?').run(A);
    expect((await call(h, 'GET', '/api/coins/balance', A)).body.balance).toBe(7);
  });

  it('D4. MÁS felhasználó egyenlege nem kérhető semmilyen paraméterrel', async () => {
    await fund(A, 100);
    await fund(B, 9999);
    for (const qs of ['?userId=' + B, '?user_id=' + B, '?targetUserId=' + B, '?recipient=' + B, '?id=' + B]) {
      const r = await call(h, 'GET', `/api/coins/balance${qs}`, A);
      expect(r.body.balance, qs).toBe(100);
    }
  });
});

// ===========================================================================
// GET /api/coins/history
// ===========================================================================

describe('API – GET /api/coins/history', () => {
  const seedHistory = async (user: string, n: number) => {
    for (let i = 0; i < n; i++) {
      await h.svc.awardCoins({
        userId: user, type: 'PREDICTION_SUBMITTED',
        sourceKey: predictionSourceKey('PREDICTION_SUBMITTED', `p${i}`),
      });
    }
  };

  it('D5. hitelesítés nélkül 401', async () => {
    const r = await call(h, 'GET', '/api/coins/history');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('AUTH_REQUIRED');
  });

  it('D6. a saját napló, az egyenleggel és a lapozás-jelzőkkel', async () => {
    await seedHistory(A, 3);
    const r = await call(h, 'GET', '/api/coins/history', A);
    expect(r.status).toBe(200);
    expect(r.body.transactions).toHaveLength(3);
    expect(r.body.balance).toBe(3 * COIN_REWARDS.PREDICTION_SUBMITTED);
    expect(r.body.hasMore).toBe(false);
    expect(r.body.nextBefore).toBeNull();
    const t = r.body.transactions[0];
    for (const field of ['id', 'amount', 'type', 'label', 'sourceKey', 'balanceAfter', 'createdAt']) {
      expect(t, field).toHaveProperty(field);
    }
  });

  it('D7. LAPOZ: limit + before kurzor, átfedés nélkül', async () => {
    await seedHistory(A, 12);
    const first = await call(h, 'GET', '/api/coins/history?limit=5', A);
    expect(first.body.transactions).toHaveLength(5);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextBefore).toBeTruthy();

    const second = await call(h, 'GET', `/api/coins/history?limit=5&before=${encodeURIComponent(first.body.nextBefore)}`, A);
    expect(second.status).toBe(200);
    const ids = new Set(first.body.transactions.map((x: any) => x.id));
    for (const t of second.body.transactions) expect(ids.has(t.id)).toBe(false);
  });

  it('D8. a limit felső korlátos, érvénytelen limitnél az alapértelmezés érvényes', async () => {
    await seedHistory(A, 30);
    const huge = await call(h, 'GET', '/api/coins/history?limit=100000', A);
    expect(huge.body.transactions.length).toBeLessThanOrEqual(COIN_HISTORY_MAX_LIMIT);
    for (const bad of ['0', '-5', 'abc', '']) {
      const r = await call(h, 'GET', `/api/coins/history?limit=${bad}`, A);
      expect(r.status, bad).toBe(200);
      expect(r.body.transactions.length, bad).toBeLessThanOrEqual(COIN_HISTORY_DEFAULT_LIMIT);
    }
  });

  it('D9. érvénytelen cursor → 400', async () => {
    const r = await call(h, 'GET', '/api/coins/history?before=nem-datum', A);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_CURSOR');
  });

  it('D10. típus szerint szűrhető, és ismeretlen típust nem lehet becsempészni', async () => {
    await h.svc.awardCoins({ userId: A, type: 'EXACT_SCORE', sourceKey: predictionSourceKey('EXACT_SCORE', 'p1') });
    await h.svc.awardCoins({ userId: A, type: 'DAILY_TIPS', sourceKey: dailySourceKey('2026-10-07') });

    const only = await call(h, 'GET', '/api/coins/history?type=EXACT_SCORE', A);
    expect(only.body.transactions).toHaveLength(1);
    expect(only.body.transactions[0].type).toBe('EXACT_SCORE');

    const both = await call(h, 'GET', '/api/coins/history?type=EXACT_SCORE,DAILY_TIPS', A);
    expect(both.body.transactions).toHaveLength(2);

    // Ismeretlen típus: a szűrő elhagyásra kerül, nem hibázik és nem vezet be típust
    const unknown = await call(h, 'GET', '/api/coins/history?type=HACK', A);
    expect(unknown.status).toBe(200);
    expect(unknown.body.transactions).toHaveLength(2);
  });

  it('D11. MÁS felhasználó naplója nem kérhető', async () => {
    await h.svc.awardCoins({ userId: A, type: 'EXACT_SCORE', sourceKey: predictionSourceKey('EXACT_SCORE', 'pa') });
    await h.svc.awardCoins({ userId: B, type: 'EXACT_SCORE', sourceKey: predictionSourceKey('EXACT_SCORE', 'pb') });
    for (const qs of ['?userId=' + B, '?user_id=' + B, '?targetUserId=' + B]) {
      const r = await call(h, 'GET', `/api/coins/history${qs}`, A);
      expect(r.body.transactions, qs).toHaveLength(1);
      expect(r.body.transactions[0].sourceKey).toBe('prediction:pa:exact_score');
    }
  });
});

// ===========================================================================
// GET /api/shop/items
// ===========================================================================

describe('API – GET /api/shop/items', () => {
  it('D12. hitelesítés nélkül 401', async () => {
    const r = await call(h, 'GET', '/api/shop/items');
    expect(r.status).toBe(401);
  });

  it('D13. a teljes aktív katalógust adja, az adatbázis árával', async () => {
    const r = await call(h, 'GET', '/api/shop/items', A);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(SHOP_SEED.length);
    expect(r.body.categories).toEqual(SHOP_CATEGORIES);
    expect(r.body.balance).toBe(0);
    const fire = r.body.items.find((i: any) => i.itemKey === 'frame_fire');
    expect(fire.priceCoins).toBe(PRICE('frame_fire'));
    expect(fire.rarity).toBe('rare');
    expect(fire.category).toBe('frame');
    expect(fire.name).toBeTruthy();
    expect(fire.metadata).toBeTruthy();
    expect(fire).toHaveProperty('availableUntil');
  });

  it('D14. az árat a DB adja – a kliens kérésben küldött ár hatástalan', async () => {
    const r = await call(h, 'GET', '/api/shop/items?priceCoins=1&rarity=legendary&category=title', A);
    const fire = r.body.items.find((i: any) => i.itemKey === 'frame_fire');
    expect(fire.priceCoins).toBe(PRICE('frame_fire'));
    expect(fire.rarity).toBe('rare');
    expect(fire.category).toBe('frame');
  });

  it('D15. az INAKTÍV item nem jelenik meg', async () => {
    h.db.prepare("UPDATE shop_items SET is_active = 0 WHERE item_key = 'frame_fire'").run();
    const r = await call(h, 'GET', '/api/shop/items', A);
    expect(r.body.items).toHaveLength(SHOP_SEED.length - 1);
    expect(r.body.items.find((i: any) => i.itemKey === 'frame_fire')).toBeUndefined();
  });

  it('D16. a LEJÁRT időszakos item nem jelenik meg, a még élő igen', async () => {
    h.db.prepare("UPDATE shop_items SET is_limited = 1, available_until = '2020-01-01T00:00:00.000Z' WHERE item_key = 'name_green'").run();
    const future = new Date(Date.now() + 86400_000).toISOString();
    h.db.prepare('UPDATE shop_items SET is_limited = 1, available_until = ? WHERE item_key = ?').run(future, 'name_blue');
    const r = await call(h, 'GET', '/api/shop/items', A);
    expect(r.body.items.find((i: any) => i.itemKey === 'name_green')).toBeUndefined();
    const blue = r.body.items.find((i: any) => i.itemKey === 'name_blue');
    expect(blue.isLimited).toBe(true);
    expect(blue.availableUntil).toBe(future);
  });

  it('D17. az `owned` és a `purchasable` a SZERVER számítása, kötegelt készletből', async () => {
    await fund(A, PRICE('name_green') + 10);
    await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'name_green' });

    const r = await call(h, 'GET', '/api/shop/items', A);
    const green = r.body.items.find((i: any) => i.itemKey === 'name_green');
    expect(green.owned).toBe(true);
    expect(green.purchasable).toBe(false);
    expect(green.blockedReason).toBe('owned');

    const dragon = r.body.items.find((i: any) => i.itemKey === 'frame_dragon');
    expect(dragon.owned).toBe(false);
    expect(dragon.purchasable).toBe(false);
    expect(dragon.blockedReason).toBe('insufficient_coins');
  });

  it('D18. elegendő egyenleggel a megvásárolható item `purchasable`', async () => {
    await fund(A, 999_999);
    const r = await call(h, 'GET', '/api/shop/items', A);
    const dragon = r.body.items.find((i: any) => i.itemKey === 'frame_dragon');
    expect(dragon.purchasable).toBe(true);
    expect(dragon.blockedReason).toBeNull();
  });

  it('D19. a másik felhasználó birtoklása nem látszik a saját katalógusban', async () => {
    await fund(B, 999_999, 'adj:b');
    await call(h, 'POST', '/api/shop/purchase', B, { itemKey: 'frame_fire' });
    const r = await call(h, 'GET', '/api/shop/items', A);
    expect(r.body.items.find((i: any) => i.itemKey === 'frame_fire').owned).toBe(false);
  });
});

// ===========================================================================
// GET /api/shop/inventory
// ===========================================================================

describe('API – GET /api/shop/inventory', () => {
  it('D20. hitelesítés nélkül 401', async () => {
    const r = await call(h, 'GET', '/api/shop/inventory');
    expect(r.status).toBe(401);
  });

  it('D21. üres készlet', async () => {
    const r = await call(h, 'GET', '/api/shop/inventory', A);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(r.body.balance).toBe(0);
  });

  it('D22. a saját készlet az item adataival, a fizetett árral és az időponttal', async () => {
    await fund(A, 999_999);
    await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' });
    const r = await call(h, 'GET', '/api/shop/inventory', A);
    expect(r.body.items).toHaveLength(1);
    const row = r.body.items[0];
    expect(row.item.itemKey).toBe('frame_fire');
    expect(row.item.rarity).toBe('rare');
    expect(row.item.metadata).toBeTruthy();
    expect(row.paidCoins).toBe(PRICE('frame_fire'));
    expect(typeof row.purchasedAt).toBe('string');
    expect(row.equipped).toBe(false);
  });

  it('D23. a MÁR MEGVETT item a készletben marad lejárat/kivonás után is', async () => {
    await fund(A, 999_999);
    await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' });
    h.db.prepare("UPDATE shop_items SET is_active = 0, is_limited = 1, available_until = '2020-01-01T00:00:00.000Z' WHERE item_key = 'frame_fire'").run();
    const r = await call(h, 'GET', '/api/shop/inventory', A);
    expect(r.body.items).toHaveLength(1);
  });

  it('D24. MÁS felhasználó készlete nem kérhető', async () => {
    await fund(A, 999_999);
    await fund(B, 999_999, 'adj:b');
    await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' });
    await call(h, 'POST', '/api/shop/purchase', B, { itemKey: 'name_green' });
    for (const qs of ['?userId=' + B, '?user_id=' + B, '?targetUserId=' + B, '?recipient=' + B]) {
      const r = await call(h, 'GET', `/api/shop/inventory${qs}`, A);
      expect(r.body.items, qs).toHaveLength(1);
      expect(r.body.items[0].item.itemKey).toBe('frame_fire');
    }
  });

  it('D25. a fizetett ár akkor sem változik, ha a katalógus ára módosul', async () => {
    await fund(A, 999_999);
    await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' });
    h.db.prepare("UPDATE shop_items SET price_coins = 1 WHERE item_key = 'frame_fire'").run();
    const r = await call(h, 'GET', '/api/shop/inventory', A);
    expect(r.body.items[0].paidCoins).toBe(PRICE('frame_fire'));
    expect(r.body.items[0].item.priceCoins, 'a katalógus aktuális ára').toBe(1);
  });
});

// ===========================================================================
// POST /api/shop/purchase
// ===========================================================================

describe('API – POST /api/shop/purchase', () => {
  it('D26. hitelesítés nélkül 401, és nem történik vásárlás', async () => {
    const r = await call(h, 'POST', '/api/shop/purchase', undefined, { itemKey: 'frame_fire' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('AUTH_REQUIRED');
    expect(Number((h.db.prepare('SELECT COUNT(*) AS n FROM user_shop_items').get() as any).n)).toBe(0);
  });

  it('D27. sikeres vásárlás → 201, a DB által levont árral', async () => {
    await fund(A, 3000);
    const r = await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' });
    expect(r.status).toBe(201);
    expect(r.body.itemKey).toBe('frame_fire');
    expect(r.body.paidCoins).toBe(PRICE('frame_fire'));
    expect(r.body.balance).toBe(3000 - PRICE('frame_fire'));
    expect(r.body.item.itemKey).toBe('frame_fire');
    // a napló a DB kulcsával
    const tx = (await call(h, 'GET', '/api/coins/history', A)).body.transactions
      .find((t: any) => t.type === 'SHOP_PURCHASE');
    expect(tx.sourceKey).toBe(purchaseSourceKey('frame_fire'));
    expect(tx.amount).toBe(-PRICE('frame_fire'));
  });

  it('D28. kevés coin → 402, a hiányzó összeggel, és semmi nem változik', async () => {
    await fund(A, 100);
    const r = await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('INSUFFICIENT_COINS');
    expect(r.body.balance).toBe(100);
    expect(r.body.priceCoins).toBe(PRICE('frame_fire'));
    expect(r.body.missing).toBe(PRICE('frame_fire') - 100);
    expect((await call(h, 'GET', '/api/coins/balance', A)).body.balance).toBe(100);
    expect((await call(h, 'GET', '/api/shop/inventory', A)).body.items).toHaveLength(0);
  });

  it('D29. már megvan → 409, nincs újabb levonás', async () => {
    await fund(A, 10_000);
    const first = await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' });
    const second = await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ITEM_ALREADY_OWNED');
    expect((await call(h, 'GET', '/api/coins/balance', A)).body.balance).toBe(first.body.balance);
    expect((await call(h, 'GET', '/api/shop/inventory', A)).body.items).toHaveLength(1);
  });

  it('D30. ISMÉTELT kérés (dupla klikk) csak egyszer von le', async () => {
    await fund(A, 10_000);
    const results = await Promise.all([
      call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' }),
      call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' }),
      call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' }),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await call(h, 'GET', '/api/coins/balance', A)).body.balance).toBe(10_000 - PRICE('frame_fire'));
    expect((await call(h, 'GET', '/api/shop/inventory', A)).body.items).toHaveLength(1);
  });

  it('D31. inaktív item → 409 ITEM_INACTIVE', async () => {
    await fund(A, 10_000);
    h.db.prepare("UPDATE shop_items SET is_active = 0 WHERE item_key = 'frame_fire'").run();
    const r = await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ITEM_INACTIVE');
    expect((await call(h, 'GET', '/api/coins/balance', A)).body.balance).toBe(10_000);
  });

  it('D32. lejárt item → 410 ITEM_EXPIRED', async () => {
    await fund(A, 10_000);
    h.db.prepare("UPDATE shop_items SET is_limited = 1, available_until = '2020-01-01T00:00:00.000Z' WHERE item_key = 'frame_fire'").run();
    const r = await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' });
    expect(r.status).toBe(410);
    expect(r.body.code).toBe('ITEM_EXPIRED');
  });

  it('D33. nem létező item → 404 ITEM_NOT_FOUND', async () => {
    await fund(A, 10_000);
    const r = await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'nincs_ilyen_item' });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('ITEM_NOT_FOUND');
  });

  it('D34. érvénytelen vagy hiányzó itemKey → 400 INVALID_ITEM_KEY', async () => {
    await fund(A, 10_000);
    const bodies = [
      {}, { itemKey: '' }, { itemKey: 'ab' }, { itemKey: 'Frame_Fire' }, { itemKey: 'frame fire' },
      { itemKey: "frame'; drop table shop_items; --" }, { itemKey: 42 }, { itemKey: null },
      { itemKey: ['frame_fire'] }, { itemKey: { itemKey: 'frame_fire' } }, { itemKey: 'a'.repeat(65) },
    ];
    for (const body of bodies) {
      const r = await call(h, 'POST', '/api/shop/purchase', A, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe('INVALID_ITEM_KEY');
    }
    // a katalógus és az egyenleg érintetlen
    expect(Number((h.db.prepare('SELECT COUNT(*) AS n FROM shop_items').get() as any).n)).toBe(SHOP_SEED.length);
    expect((await call(h, 'GET', '/api/coins/balance', A)).body.balance).toBe(10_000);
  });

  it('D35. a kérés törzsében küldött ÁR hatástalan', async () => {
    await fund(A, 10_000);
    const r = await call(h, 'POST', '/api/shop/purchase', A, {
      itemKey: 'frame_fire', priceCoins: 1, price: 1, paidCoins: 1, cost: 1,
    });
    expect(r.status).toBe(201);
    expect(r.body.paidCoins).toBe(PRICE('frame_fire'));
    expect(r.body.balance).toBe(10_000 - PRICE('frame_fire'));
  });

  it('D36. a kérés törzsében küldött COIN / BALANCE hatástalan', async () => {
    await fund(A, 100);
    const r = await call(h, 'POST', '/api/shop/purchase', A, {
      itemKey: 'frame_fire', coins: 999_999, balance: 999_999, amount: 999_999,
    });
    expect(r.status, 'továbbra sincs elég coin').toBe(402);
    expect((await call(h, 'GET', '/api/coins/balance', A)).body.balance).toBe(100);
  });

  it('D37. a kérés törzsében küldött RARITY / CATEGORY / ITEM hatástalan', async () => {
    await fund(A, 10_000);
    const r = await call(h, 'POST', '/api/shop/purchase', A, {
      itemKey: 'frame_fire',
      rarity: 'legendary', category: 'title',
      item: { itemKey: 'frame_animated_diamond', priceCoins: 0, rarity: 'common' },
    });
    expect(r.status).toBe(201);
    expect(r.body.item.rarity).toBe('rare');
    expect(r.body.item.category).toBe('frame');
    expect(r.body.itemKey).toBe('frame_fire');
    expect((await call(h, 'GET', '/api/shop/inventory', A)).body.items[0].item.itemKey).toBe('frame_fire');
  });

  it('D38. a kérés törzsében küldött userId / targetUserId hatástalan', async () => {
    await fund(A, 10_000);
    await fund(B, 10_000, 'adj:b');
    const r = await call(h, 'POST', '/api/shop/purchase', A, {
      itemKey: 'frame_fire', userId: B, user_id: B, targetUserId: B, recipient: B,
    });
    expect(r.status).toBe(201);
    expect((await call(h, 'GET', '/api/shop/inventory', A)).body.items).toHaveLength(1);
    expect((await call(h, 'GET', '/api/shop/inventory', B)).body.items).toHaveLength(0);
    expect((await call(h, 'GET', '/api/coins/balance', B)).body.balance).toBe(10_000);
  });

  it('D39. a vásárlás nem ad coint és nem módosít idegen egyenleget', async () => {
    await fund(A, 10_000);
    await fund(B, 500, 'adj:b');
    await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' });
    expect((await call(h, 'GET', '/api/coins/balance', B)).body.balance).toBe(500);
    // a napló összege mindig az egyenleg
    const page = (await call(h, 'GET', '/api/coins/history?limit=100', A)).body;
    const sum = page.transactions.reduce((s: number, t: any) => s + t.amount, 0);
    expect(sum).toBe(page.balance);
  });
});

// ===========================================================================
// Biztonság: nincs coin-írás HTTP-n, és nem szivárog DB-hiba
// ===========================================================================

describe('API – biztonság', () => {
  it('D40. nincs olyan végpont, amellyel coint lehet írni magának', async () => {
    const attempts: [string, string, unknown][] = [
      ['POST', '/api/coins/balance', { balance: 999_999 }],
      ['PUT', '/api/coins/balance', { balance: 999_999 }],
      ['PATCH', '/api/coins/balance', { balance: 999_999 }],
      ['POST', '/api/coins/award', { amount: 999_999, type: 'DAILY_TIPS', sourceKey: 'hack:1' }],
      ['POST', '/api/coins/history', { amount: 999_999 }],
      ['POST', '/api/shop/items', { itemKey: 'sajat_item', priceCoins: 0 }],
      ['POST', '/api/shop/inventory', { itemKey: 'frame_animated_diamond' }],
      ['DELETE', '/api/coins/history', undefined],
    ];
    for (const [method, path, body] of attempts) {
      const r = await call(h, method, path, A, body);
      expect([404, 405], `${method} ${path}`).toContain(r.status);
    }
    expect((await call(h, 'GET', '/api/coins/balance', A)).body.balance).toBe(0);
    expect(Number((h.db.prepare('SELECT COUNT(*) AS n FROM coin_transactions').get() as any).n)).toBe(0);
  });

  it('D41. DB-hiba esetén 500, SQL-részletek nélkül', async () => {
    // A tábla eltüntetésével valódi tárolóhibát váltunk ki
    h.db.exec('DROP TABLE user_coins');
    const bal = await call(h, 'GET', '/api/coins/balance', A);
    expect(bal.status).toBe(500);
    expect(bal.body.code).toBe('COIN_STORE_ERROR');
    expect(bal.raw).not.toMatch(/SQLSTATE|no such table|user_coins|at Object|\.ts:/);

    const buy = await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' });
    expect(buy.status).toBe(500);
    expect(buy.body.code).toBe('COIN_STORE_ERROR');
    expect(buy.raw).not.toMatch(/SQLSTATE|no such table|user_coins|at Object|\.ts:/);
  });

  it('D42. az érvényesítési hibák a DB-hiba ELŐTT dőlnek el', async () => {
    h.db.exec('DROP TABLE user_coins');
    const r = await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'BAD KEY' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_ITEM_KEY');
  });

  it('D43. a coin semmilyen kompetitív előnyt nem ad: a válaszban nincs XP/pont/kvóta', async () => {
    await fund(A, 10_000);
    const buy = await call(h, 'POST', '/api/shop/purchase', A, { itemKey: 'frame_fire' });
    const catalog = await call(h, 'GET', '/api/shop/items', A);
    const forbidden = /\b(xp|points|pontok|quota|kvota|dailyLimit|pro)\b/i;
    expect(buy.raw).not.toMatch(forbidden);
    expect(catalog.raw).not.toMatch(forbidden);
  });
});
