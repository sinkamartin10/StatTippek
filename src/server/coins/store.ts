/**
 * Coin-tároló. A meglévő tárolók mintáját követi (saját táblák, saját
 * interfész, két implementáció metódus-paritással):
 *
 *  - PostgresCoinStore : Supabase PostgreSQL service_role kulccsal (éles)
 *  - SqliteCoinStore   : helyi tartalék és teszt-tároló (node:sqlite)
 *
 * AZ ADATBÁZIS AZ AUTHORITY. A pénzmozgás-szerű két műveletet – jóváírás és
 * vásárlás – élesben a `0011` migráció két plpgsql függvénye végzi
 * (`award_coins`, `purchase_shop_item`): egy tranzakció, a felhasználóra vett
 * advisory lockkal. Ez a réteg NEM számolja újra az egyenleget, nem von le
 * coint külön UPDATE-tel, és nem implementálja újra az idempotenciát – csak
 * meghívja a függvényt és leképezi a válaszát.
 *
 * A HELYI SQLITE implementáció ugyanezt a szerződést teljesíti, ugyanazokkal a
 * megszorításokkal (`UNIQUE`, `CHECK`), egyetlen szinkron blokkban és valódi
 * tranzakcióban – a két háttér viselkedése így nem válik el.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  SHOP_SEED,
  type CoinAwardOutcome, type CoinAwardResult, type CoinBalance, type CoinPurchaseOutcome,
  type CoinTransactionRow, type CoinTransactionType, type Rarity, type ShopCategory, type ShopItem,
} from '../../shared/shop';

/** Egy jóváírás bemenete. Az összeg a SZERVER konfigurációjából jön, sosem a kliensből. */
export interface CoinAwardInput {
  userId: string;
  amount: number;
  type: CoinTransactionType;
  label: string;
  /** determinisztikus idempotencia-kulcs (lásd shared/shop.ts) */
  sourceKey: string;
}

/** Egy vásárlás nyers kimenete. A kudarc itt még nem hiba, csak kimenet. */
export interface CoinPurchaseOutput {
  outcome: CoinPurchaseOutcome;
  /** az egyenleg a művelet után; `not_found` / `inactive` / `expired` esetén null */
  balance: number | null;
  item: ShopItem | null;
}

/** Egy lap a tranzakciós naplóból, a lapozáshoz szükséges jelzéssel. */
export interface CoinTransactionPage {
  rows: CoinTransactionRow[];
  /** van-e még régebbi elem a kért limiten túl */
  hasMore: boolean;
}

export interface CoinStore {
  readonly kind: 'postgres' | 'sqlite';
  healthCheck(): Promise<string[]>;

  /**
   * A felhasználó egyenlege. OLVASÁS: ha még nincs sora, `0`-t ad és NEM ír.
   * Az egyenleg-sor létrehozása kizárólag a két RPC dolga (`on conflict do
   * nothing`), így olvasásból sosem keletkezik verseny vagy duplikált sor.
   */
  getBalance(userId: string): Promise<CoinBalance>;

  /** Egy lap a napló `created_at desc` sorrendjében, opcionális típus-szűréssel. */
  listTransactions(userId: string, limit: number, before?: string, types?: CoinTransactionType[]): Promise<CoinTransactionPage>;

  /** Jóváírás az `award_coins()` függvénnyel. Idempotens: a DB dönt. */
  award(input: CoinAwardInput): Promise<CoinAwardResult>;

  /** Vásárlás a `purchase_shop_item()` függvénnyel. Az árat a DB olvassa. */
  purchase(userId: string, itemKey: string, now: string): Promise<CoinPurchaseOutput>;

  /** Egy item a katalógusból, kulcs szerint (az ár forrása mindig ez). */
  getItemByKey(itemKey: string): Promise<ShopItem | null>;

  /** A felhasználó birtokában lévő item-kulcsok. */
  ownedItemKeys(userId: string): Promise<Set<string>>;

  /**
   * Az AKTÍV katalógus EGY lekérdezéssel. A lejárt időszakos itemeket a hívó
   * szűri a számított `itemExpired()`-del – a tárolt állapot nem avulhat el.
   */
  listItems(): Promise<ShopItem[]>;

  /** A felhasználó készlete az item adataival EGY lekérdezéssel (nincs N+1). */
  listInventory(userId: string): Promise<InventoryRow[]>;

  /**
   * A BIRTOKOLT itemek kategóriája felhasználónként: `userId → (itemKey → kategória)`.
   * Ez a felvétel (equip) AUTHORITY-ja: a kliens kulcsa csak akkor érvényes, ha
   * itt is szerepel, a slothoz tartozó kategóriával. Kötegelt – a ranglista
   * N felhasználójára is EGY lekérdezés.
   */
  ownedCategoriesMany(userIds: string[]): Promise<Map<string, Map<string, ShopCategory>>>;
}

/** Egy készlet-sor az item adataival. */
export interface InventoryRow {
  item: ShopItem;
  paidCoins: number;
  purchasedAt: string;
}

type Row = Record<string, any>;
const iso = (v: string | Date): string => new Date(v).toISOString();
const num = (v: unknown): number => Number(v ?? 0);

function toItem(r: Row): ShopItem {
  return {
    id: r.id,
    itemKey: r.item_key,
    category: r.category as ShopCategory,
    name: r.name,
    description: r.description ?? null,
    rarity: r.rarity as Rarity,
    priceCoins: num(r.price_coins),
    metadata: typeof r.metadata === 'string' ? safeJson(r.metadata) : (r.metadata ?? {}),
    isActive: r.is_active === true || r.is_active === 1,
    isLimited: r.is_limited === true || r.is_limited === 1,
    availableUntil: r.available_until ? iso(r.available_until) : null,
    sortOrder: num(r.sort_order),
  };
}

function toTransaction(r: Row): CoinTransactionRow {
  return {
    id: r.id,
    amount: num(r.amount),
    type: r.type as CoinTransactionType,
    label: r.label,
    sourceKey: r.source_key,
    balanceAfter: num(r.balance_after),
    createdAt: iso(r.created_at),
  };
}

/** A SQLite JSONB-t szövegként tárolja; hibás tartalom ne döntse el a listát. */
function safeJson(s: string): Record<string, unknown> {
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; }
}

const AWARD_OUTCOMES = new Set<string>(['awarded', 'already_awarded']);
const PURCHASE_OUTCOMES = new Set<string>(['purchased', 'already_owned', 'insufficient_coins', 'not_found', 'inactive', 'expired']);

// ============================================================================
// Supabase PostgreSQL (éles)
// ============================================================================

export class PostgresCoinStore implements CoinStore {
  readonly kind = 'postgres' as const;
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private fail(op: string, error: { message: string } | null): void {
    if (error) throw new Error(`[coins] ${op}: ${error.message}`);
  }

  async healthCheck(): Promise<string[]> {
    const missing: string[] = [];
    for (const table of ['user_coins', 'coin_transactions', 'shop_items', 'user_shop_items']) {
      const { error } = await this.db.from(table).select('*').limit(1);
      if (error) missing.push(`${table} (${error.message})`);
    }
    // A függvények LÉTÉT írás nélkül bizonyítjuk: szándékosan érvénytelen
    // összeg -> a függvény 22023-mal elutasít; ha nem is létezik, PGRST202 jön.
    const award = await this.db.rpc('award_coins', {
      p_user_id: '00000000-0000-0000-0000-000000000000',
      p_amount: 0, p_type: 'DAILY_TIPS', p_label: 'healthcheck', p_source_key: 'healthcheck',
    });
    if ((award.error as { code?: string } | null)?.code === 'PGRST202') {
      missing.push('award_coins() függvény (0011_coins_shop.sql)');
    }
    // Nem létező item kulcs: a függvény `not_found`-dal tér vissza, nem ír semmit.
    const purchase = await this.db.rpc('purchase_shop_item', {
      p_user_id: '00000000-0000-0000-0000-000000000000',
      p_item_key: '___healthcheck___', p_now: new Date(0).toISOString(),
    });
    if ((purchase.error as { code?: string } | null)?.code === 'PGRST202') {
      missing.push('purchase_shop_item() függvény (0011_coins_shop.sql)');
    }
    return missing;
  }

  async getBalance(userId: string): Promise<CoinBalance> {
    const { data, error } = await this.db.from('user_coins')
      .select('balance, updated_at').eq('user_id', userId).maybeSingle();
    this.fail('getBalance', error);
    return data ? { balance: num(data.balance), updatedAt: iso(data.updated_at) } : { balance: 0, updatedAt: null };
  }

  async listTransactions(userId: string, limit: number, before?: string, types?: CoinTransactionType[]): Promise<CoinTransactionPage> {
    // limit + 1 sort kérünk: a plusz egy mondja meg, hogy van-e még régebbi
    let qb = this.db.from('coin_transactions').select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);
    if (before) qb = qb.lt('created_at', before);
    if (types?.length) qb = qb.in('type', types);
    const { data, error } = await qb;
    this.fail('listTransactions', error);
    const all = (data ?? []).map(toTransaction);
    return { rows: all.slice(0, limit), hasMore: all.length > limit };
  }

  async award(input: CoinAwardInput): Promise<CoinAwardResult> {
    const { data, error } = await this.db.rpc('award_coins', {
      p_user_id: input.userId,
      p_amount: input.amount,
      p_type: input.type,
      p_label: input.label,
      p_source_key: input.sourceKey,
    });
    this.fail('award', error);
    const r = (data ?? {}) as { outcome?: string; balance?: number; amount?: number };
    if (!r.outcome || !AWARD_OUTCOMES.has(r.outcome)) {
      throw new Error(`[coins] award: váratlan válasz (${JSON.stringify(data)})`);
    }
    return { outcome: r.outcome as CoinAwardOutcome, balance: num(r.balance), amount: num(r.amount) };
  }

  async purchase(userId: string, itemKey: string, now: string): Promise<CoinPurchaseOutput> {
    const { data, error } = await this.db.rpc('purchase_shop_item', {
      p_user_id: userId, p_item_key: itemKey, p_now: now,
    });
    this.fail('purchase', error);
    const r = (data ?? {}) as { outcome?: string; balance?: number | null; item?: Row | null };
    if (!r.outcome || !PURCHASE_OUTCOMES.has(r.outcome)) {
      throw new Error(`[coins] purchase: váratlan válasz (${JSON.stringify(data)})`);
    }
    return {
      outcome: r.outcome as CoinPurchaseOutcome,
      balance: r.balance === null || r.balance === undefined ? null : num(r.balance),
      item: r.item ? toItem(r.item) : null,
    };
  }

  async getItemByKey(itemKey: string): Promise<ShopItem | null> {
    const { data, error } = await this.db.from('shop_items').select('*').eq('item_key', itemKey).maybeSingle();
    this.fail('getItemByKey', error);
    return data ? toItem(data) : null;
  }

  async ownedItemKeys(userId: string): Promise<Set<string>> {
    const { data, error } = await this.db.from('user_shop_items').select('item_id').eq('user_id', userId);
    this.fail('ownedItemKeys', error);
    const ids = (data ?? []).map((r: Row) => r.item_id as string);
    if (!ids.length) return new Set();
    const { data: items, error: itemErr } = await this.db.from('shop_items').select('item_key').in('id', ids);
    this.fail('ownedItemKeys/items', itemErr);
    return new Set((items ?? []).map((r: Row) => r.item_key as string));
  }

  async ownedCategoriesMany(userIds: string[]): Promise<Map<string, Map<string, ShopCategory>>> {
    const out = new Map<string, Map<string, ShopCategory>>();
    const unique = [...new Set(userIds)];
    if (!unique.length) return out;
    // Beágyazott erőforrás: EGY kérés adja a készletet és az item kulcsát/kategóriáját
    const { data, error } = await this.db.from('user_shop_items')
      .select('user_id, shop_items!inner(item_key, category)').in('user_id', unique);
    this.fail('ownedCategoriesMany', error);
    for (const r of (data ?? []) as Row[]) {
      const item = Array.isArray(r.shop_items) ? r.shop_items[0] : r.shop_items;
      if (!item) continue;
      const map = out.get(r.user_id) ?? new Map<string, ShopCategory>();
      map.set(item.item_key as string, item.category as ShopCategory);
      out.set(r.user_id, map);
    }
    return out;
  }

  async listItems(): Promise<ShopItem[]> {
    const { data, error } = await this.db.from('shop_items').select('*')
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('price_coins', { ascending: true });
    this.fail('listItems', error);
    return (data ?? []).map(toItem);
  }

  async listInventory(userId: string): Promise<InventoryRow[]> {
    // Beágyazott erőforrás: EGY kérés adja a készletet és az item adatait.
    // (Ugyanaz a minta, amit a progression tároló is használ.)
    const { data, error } = await this.db.from('user_shop_items')
      .select('paid_coins, purchased_at, shop_items!inner(*)')
      .eq('user_id', userId)
      .order('purchased_at', { ascending: false });
    this.fail('listInventory', error);
    return (data ?? []).map((r: Row) => {
      const item = Array.isArray(r.shop_items) ? r.shop_items[0] : r.shop_items;
      return { item: toItem(item), paidCoins: num(r.paid_coins), purchasedAt: iso(r.purchased_at) };
    });
  }
}

// ============================================================================
// Helyi SQLite (tartalék és teszt)
// ============================================================================

export class SqliteCoinStore implements CoinStore {
  readonly kind = 'sqlite' as const;

  constructor(private db: DatabaseSync) {
    // A séma a 0011 migráció megszorításait tükrözi: a negatív egyenleget, a
    // duplikált jutalmat és a dupla vásárlást itt is ADATBÁZIS zárja ki.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_coins (
        user_id TEXT PRIMARY KEY,
        balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coin_transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (amount <> 0 AND abs(amount) <= 1000000),
        type TEXT NOT NULL CHECK (length(type) BETWEEN 3 AND 48),
        label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
        source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 3 AND 200),
        balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
        created_at TEXT NOT NULL,
        UNIQUE (user_id, source_key)
      );
      CREATE INDEX IF NOT EXISTS idx_coin_tx_user ON coin_transactions(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_coin_tx_source ON coin_transactions(user_id, source_key);
      CREATE TABLE IF NOT EXISTS shop_items (
        id TEXT PRIMARY KEY,
        item_key TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL CHECK (category IN ('frame','name_color','name_effect','title','avatar','profile_background')),
        name TEXT NOT NULL,
        description TEXT,
        rarity TEXT NOT NULL CHECK (rarity IN ('common','uncommon','rare','epic','legendary')),
        price_coins INTEGER NOT NULL CHECK (price_coins >= 0 AND price_coins <= 1000000),
        metadata TEXT NOT NULL DEFAULT '{}',
        is_active INTEGER NOT NULL DEFAULT 1,
        is_limited INTEGER NOT NULL DEFAULT 0,
        available_until TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shop_items_category ON shop_items(category, sort_order, price_coins);
      CREATE TABLE IF NOT EXISTS user_shop_items (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        item_id TEXT NOT NULL REFERENCES shop_items(id),
        paid_coins INTEGER NOT NULL CHECK (paid_coins >= 0),
        purchased_at TEXT NOT NULL,
        UNIQUE (user_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_shop_items_user ON user_shop_items(user_id, purchased_at DESC);
    `);
    // A vetőmag UGYANAZZAL a záradékkal, mint a migráció: ismételt indítás nem
    // ír felül semmit, és nem hoz létre duplikátumot.
    const now = new Date().toISOString();
    for (const i of SHOP_SEED) {
      this.db.prepare(`INSERT INTO shop_items
        (id, item_key, category, name, description, rarity, price_coins, metadata, sort_order, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,0,?,?)
        ON CONFLICT (item_key) DO NOTHING`)
        .run(randomUUID(), i.itemKey, i.category, i.name, i.description, i.rarity, i.priceCoins,
          JSON.stringify(i.metadata ?? {}), now, now);
    }
  }

  async healthCheck(): Promise<string[]> { return []; }

  async getBalance(userId: string): Promise<CoinBalance> {
    const r = this.db.prepare('SELECT balance, updated_at FROM user_coins WHERE user_id = ?').get(userId) as Row | undefined;
    return r ? { balance: num(r.balance), updatedAt: iso(r.updated_at) } : { balance: 0, updatedAt: null };
  }

  async listTransactions(userId: string, limit: number, before?: string, types?: CoinTransactionType[]): Promise<CoinTransactionPage> {
    const where: string[] = ['user_id = ?'];
    const args: unknown[] = [userId];
    if (before) { where.push('created_at < ?'); args.push(before); }
    if (types?.length) { where.push(`type IN (${types.map(() => '?').join(',')})`); args.push(...types); }
    const rows = this.db.prepare(
      `SELECT * FROM coin_transactions WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(...args as never[], limit + 1) as Row[];
    const all = rows.map(toTransaction);
    return { rows: all.slice(0, limit), hasMore: all.length > limit };
  }

  /**
   * MIÉRT ATOMIKUS: a `node:sqlite` API szinkron, és a döntés és az írás között
   * NINCS await-pont, ezért az egyprocesszes Node eseményciklusa nem tud
   * közéfűzni másik kérést – ez a helyi megfelelője a PostgreSQL advisory
   * lockjának. Az írásokat ezen túl valódi tranzakció fogja össze, így hiba
   * esetén nem marad félkész állapot.
   */
  async award(input: CoinAwardInput): Promise<CoinAwardResult> {
    if (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > 1_000_000) {
      // Ugyanaz a határ, amit az award_coins() 22023-mal elutasít.
      throw new Error('[coins] award: a jutalom összege 1 és 1000000 közötti egész szám lehet');
    }
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT 1 FROM coin_transactions WHERE user_id = ? AND source_key = ?')
      .get(input.userId, input.sourceKey);
    if (existing) {
      const bal = this.db.prepare('SELECT balance FROM user_coins WHERE user_id = ?').get(input.userId) as Row | undefined;
      return { outcome: 'already_awarded', balance: bal ? num(bal.balance) : 0, amount: 0 };
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO user_coins (user_id, balance, created_at, updated_at) VALUES (?,0,?,?) ON CONFLICT (user_id) DO NOTHING')
        .run(input.userId, now, now);
      const balance = num((this.db.prepare('SELECT balance FROM user_coins WHERE user_id = ?').get(input.userId) as Row).balance);
      const next = balance + input.amount;
      this.db.prepare('UPDATE user_coins SET balance = ?, updated_at = ? WHERE user_id = ?').run(next, now, input.userId);
      this.db.prepare(`INSERT INTO coin_transactions
        (id, user_id, amount, type, label, source_key, balance_after, created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), input.userId, input.amount, input.type, input.label, input.sourceKey, next, now);
      this.db.exec('COMMIT');
      return { outcome: 'awarded', balance: next, amount: input.amount };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** A `purchase_shop_item()` lépései, ugyanabban a sorrendben. */
  async purchase(userId: string, itemKey: string, now: string): Promise<CoinPurchaseOutput> {
    const raw = this.db.prepare('SELECT * FROM shop_items WHERE item_key = ?').get(itemKey) as Row | undefined;
    if (!raw) return { outcome: 'not_found', balance: null, item: null };
    const item = toItem(raw);
    if (!item.isActive) return { outcome: 'inactive', balance: null, item: null };
    if (item.isLimited && item.availableUntil && new Date(item.availableUntil).getTime() <= new Date(now).getTime()) {
      return { outcome: 'expired', balance: null, item: null };
    }

    const owned = this.db.prepare('SELECT 1 FROM user_shop_items WHERE user_id = ? AND item_id = ?').get(userId, item.id);
    if (owned) {
      const bal = this.db.prepare('SELECT balance FROM user_coins WHERE user_id = ?').get(userId) as Row | undefined;
      return { outcome: 'already_owned', balance: bal ? num(bal.balance) : 0, item };
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO user_coins (user_id, balance, created_at, updated_at) VALUES (?,0,?,?) ON CONFLICT (user_id) DO NOTHING')
        .run(userId, now, now);
      const balance = num((this.db.prepare('SELECT balance FROM user_coins WHERE user_id = ?').get(userId) as Row).balance);
      if (balance < item.priceCoins) {
        this.db.exec('COMMIT');
        return { outcome: 'insufficient_coins', balance, item };
      }
      const next = balance - item.priceCoins;
      this.db.prepare('UPDATE user_coins SET balance = ?, updated_at = ? WHERE user_id = ?').run(next, now, userId);
      this.db.prepare('INSERT INTO user_shop_items (id, user_id, item_id, paid_coins, purchased_at) VALUES (?,?,?,?,?)')
        .run(randomUUID(), userId, item.id, item.priceCoins, now);
      this.db.prepare(`INSERT INTO coin_transactions
        (id, user_id, amount, type, label, source_key, balance_after, created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), userId, -item.priceCoins, 'SHOP_PURCHASE', item.name, `purchase:${item.itemKey}`, next, now);
      this.db.exec('COMMIT');
      return { outcome: 'purchased', balance: next, item };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async getItemByKey(itemKey: string): Promise<ShopItem | null> {
    const r = this.db.prepare('SELECT * FROM shop_items WHERE item_key = ?').get(itemKey) as Row | undefined;
    return r ? toItem(r) : null;
  }

  async ownedItemKeys(userId: string): Promise<Set<string>> {
    const rows = this.db.prepare(
      `SELECT s.item_key FROM user_shop_items u JOIN shop_items s ON s.id = u.item_id WHERE u.user_id = ?`,
    ).all(userId) as Row[];
    return new Set(rows.map((r) => r.item_key as string));
  }

  async ownedCategoriesMany(userIds: string[]): Promise<Map<string, Map<string, ShopCategory>>> {
    const out = new Map<string, Map<string, ShopCategory>>();
    const unique = [...new Set(userIds)];
    if (!unique.length) return out;
    const rows = this.db.prepare(
      `SELECT u.user_id, s.item_key, s.category FROM user_shop_items u
         JOIN shop_items s ON s.id = u.item_id
        WHERE u.user_id IN (${unique.map(() => '?').join(',')})`,
    ).all(...unique) as Row[];
    for (const r of rows) {
      const map = out.get(r.user_id as string) ?? new Map<string, ShopCategory>();
      map.set(r.item_key as string, r.category as ShopCategory);
      out.set(r.user_id as string, map);
    }
    return out;
  }

  async listItems(): Promise<ShopItem[]> {
    const rows = this.db.prepare(
      `SELECT * FROM shop_items WHERE is_active = 1 ORDER BY category, sort_order, price_coins`,
    ).all() as Row[];
    return rows.map(toItem);
  }

  async listInventory(userId: string): Promise<InventoryRow[]> {
    const rows = this.db.prepare(
      `SELECT u.paid_coins, u.purchased_at, s.*
         FROM user_shop_items u JOIN shop_items s ON s.id = u.item_id
        WHERE u.user_id = ? ORDER BY u.purchased_at DESC`,
    ).all(userId) as Row[];
    return rows.map((r) => ({ item: toItem(r), paidCoins: num(r.paid_coins), purchasedAt: iso(r.purchased_at) }));
  }
}
