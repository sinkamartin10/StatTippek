/**
 * Coin + Customization Shop (5a szakasz) – katalógus, coin-konfiguráció,
 * SEED-PARITÁS, migráció-szerkezet és a két vásárlás/jutalmazás RPC szerződése.
 *
 * MIT BIZONYÍT ÉS MIT NEM:
 *
 *  1) A KATALÓGUS és a COIN-KONFIGURÁCIÓ tesztjei a valódi `src/shared/shop.ts`
 *     exportjait futtatják – ezek teljes értékű tesztek.
 *
 *  2) A SEED-PARITÁS a `0011_coins_shop.sql` fájl seed-blokkját TÉNYLEGESEN
 *     beolvassa és tokenizálja, majd mezőnként összehasonlítja a `SHOP_SEED`
 *     tömbbel. A TypeScript a source of truth; ha a kettő elválik, ez pirosodik.
 *
 *  3) A MIGRÁCIÓ-SZERKEZET tesztjei szöveges állítások a migráció fölött
 *     (tábla, megszorítás, RLS, policy, grant/revoke, advisory lock,
 *     `security invoker`, `set search_path`). Ezek regressziós védőhálók:
 *     azt bizonyítják, hogy a védelem BENNE VAN a migrációban – nem azt, hogy
 *     a PostgreSQL lefuttatta.
 *
 *  4) Az RPC-tesztek egy node:sqlite modellen futnak, amelynek a sémája a
 *     migráció megszorításaiból származik (UNIQUE, CHECK), a műveletek sorrendje
 *     pedig a plpgsql törzsét tükrözi, valódi tranzakcióban.
 *     EZ A SZERZŐDÉST bizonyítja (sorrend, atomicitás, idempotencia, a
 *     versenyhelyzet adatbázis-szintű kizárása), NEM a plpgsql törzs
 *     végrehajtását: a projektben nincs PostgreSQL runtime, a plpgsql kódot
 *     kizárólag a production migráció futtatja le, külön jóváhagyással.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type Db = InstanceType<typeof DatabaseSync>;

import {
  SHOP_SEED, SHOP_SEED_KEYS, SHOP_CATEGORIES, RARITIES, RARITY_ORDER,
  COIN_REWARDS, COIN_REWARD_LABEL, MAX_TRANSACTION_ABS, ITEM_KEY_PATTERN, isValidItemKey,
  predictionSourceKey, streakSourceKey, dailySourceKey, weeklySourceKey, competitionSourceKey,
  type Rarity, type ShopCategory,
} from '../src/shared/shop';

const MIGRATION = readFileSync(new URL('../supabase/migrations/0011_coins_shop.sql', import.meta.url), 'utf8');

// ============================================================================
// 1) KATALÓGUS
// ============================================================================

describe('Shop katalógus', () => {
  it('53 itemet tartalmaz (15 keret, 9 névszín, 6 effekt, 8 cím, 8 avatar, 7 háttér)', () => {
    expect(SHOP_SEED).toHaveLength(53);
  });

  it('minden item_key egyedi', () => {
    const keys = SHOP_SEED.map((i) => i.itemKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(SHOP_SEED_KEYS.size).toBe(53);
  });

  it('minden item_key megfelel a megengedett alaknak', () => {
    for (const i of SHOP_SEED) {
      expect(ITEM_KEY_PATTERN.test(i.itemKey), i.itemKey).toBe(true);
      expect(isValidItemKey(i.itemKey)).toBe(true);
    }
  });

  it('elutasítja az érvénytelen item_key-eket (a kliens csak kulcsot küldhet)', () => {
    for (const bad of ['', 'ab', 'Frame_Fire', 'frame fire', 'frame-fire', 'frame;drop', '../etc', '#ff0000', 'a'.repeat(65)]) {
      expect(isValidItemKey(bad), bad).toBe(false);
    }
    expect(isValidItemKey(null)).toBe(false);
    expect(isValidItemKey(42)).toBe(false);
  });

  it('minden kategória érvényes', () => {
    for (const i of SHOP_SEED) expect(SHOP_CATEGORIES).toContain(i.category);
  });

  it('minden rarity érvényes', () => {
    for (const i of SHOP_SEED) expect(RARITIES).toContain(i.rarity);
  });

  it('egyetlen ár sem negatív, és egyik sem lépi túl a tranzakciós határt', () => {
    for (const i of SHOP_SEED) {
      expect(i.priceCoins, i.itemKey).toBeGreaterThan(0);
      expect(i.priceCoins, i.itemKey).toBeLessThanOrEqual(MAX_TRANSACTION_ABS);
      expect(Number.isInteger(i.priceCoins), i.itemKey).toBe(true);
    }
  });

  it('minden itemnek van neve és leírása', () => {
    for (const i of SHOP_SEED) {
      expect(i.name.length, i.itemKey).toBeGreaterThan(0);
      expect(i.description.length, i.itemKey).toBeGreaterThan(0);
    }
  });

  it('a kategóriánkénti elemszám a jóváhagyott katalógust adja', () => {
    const byCategory = (c: ShopCategory) => SHOP_SEED.filter((i) => i.category === c).length;
    expect(byCategory('frame')).toBe(15);
    expect(byCategory('name_color')).toBe(9);
    expect(byCategory('name_effect')).toBe(6);
    expect(byCategory('title')).toBe(8);
    expect(byCategory('avatar')).toBe(8);
    expect(byCategory('profile_background')).toBe(7);
  });

  it('a ritkább item ÁTLAGOSAN drágább (a ritkaság és az ár nem mond ellent egymásnak)', () => {
    const avg = (r: Rarity) => {
      const items = SHOP_SEED.filter((i) => i.rarity === r);
      return items.length ? items.reduce((s, i) => s + i.priceCoins, 0) / items.length : 0;
    };
    const used = RARITIES.filter((r) => SHOP_SEED.some((i) => i.rarity === r));
    const sorted = [...used].sort((a, b) => RARITY_ORDER[a] - RARITY_ORDER[b]);
    for (let n = 1; n < sorted.length; n++) {
      expect(avg(sorted[n]), `${sorted[n]} > ${sorted[n - 1]}`).toBeGreaterThan(avg(sorted[n - 1]));
    }
  });

  it('a shop-címek NEM ütköznek a megszolgálható címekkel (D1)', () => {
    // A `Tipster`, `Analyst`, `Expert`, `Legend`, `Champion` kizárólag szintből
    // és achievementből szerezhető – a shop ezeket nem adhatja el.
    const earned = ['Rookie', 'Amateur', 'Tipster', 'Analyst', 'Expert', 'Master Tipster', 'Legend', 'Champion', 'Sharpshooter', 'On Fire'];
    const shopTitles = SHOP_SEED.filter((i) => i.category === 'title').map((i) => i.name);
    for (const t of shopTitles) expect(earned, t).not.toContain(t);
  });

  it('a shop-avatarok a MEGLÉVŐ avatar-rendszer slotját használják (nincs második rendszer)', () => {
    for (const i of SHOP_SEED.filter((x) => x.category === 'avatar')) {
      expect((i.metadata as Record<string, unknown>)?.avatarSlot, i.itemKey).toBe('accessory');
    }
  });
});

// ============================================================================
// 2) COIN REWARD KONFIGURÁCIÓ
// ============================================================================

describe('Coin reward konfiguráció', () => {
  it('minden reward-típushoz tartozik pozitív, egész összeg', () => {
    for (const [type, amount] of Object.entries(COIN_REWARDS)) {
      expect(Number.isInteger(amount), type).toBe(true);
      expect(amount, type).toBeGreaterThan(0);
      expect(amount, type).toBeLessThanOrEqual(MAX_TRANSACTION_ABS);
    }
  });

  it('minden reward-típushoz tartozik stabil, emberi olvasatú címke', () => {
    for (const type of Object.keys(COIN_REWARDS)) {
      expect(COIN_REWARD_LABEL[type as keyof typeof COIN_REWARDS], type).toBeTruthy();
    }
    // A kiadási oldal is címkézett – a napló sosem üres szöveget ír
    expect(COIN_REWARD_LABEL.SHOP_PURCHASE).toBeTruthy();
    expect(COIN_REWARD_LABEL.ADMIN_ADJUSTMENT).toBeTruthy();
  });

  it('a típuskulcsok hossza elfér a coin_transactions.type megszorításában', () => {
    for (const type of Object.keys(COIN_REWARD_LABEL)) {
      expect(type.length, type).toBeGreaterThanOrEqual(3);
      expect(type.length, type).toBeLessThanOrEqual(48);
    }
  });

  it('a különböző forrásokhoz KÜLÖNBÖZŐ idempotencia-kulcs tartozik (nincs ütközés)', () => {
    const keys = [
      predictionSourceKey('PREDICTION_SUBMITTED', 'p1'),
      predictionSourceKey('CORRECT_OUTCOME', 'p1'),
      predictionSourceKey('EXACT_SCORE', 'p1'),
      predictionSourceKey('PREDICTION_SUBMITTED', 'p2'),
      streakSourceKey(3),
      streakSourceKey(6),
      dailySourceKey('2026-10-07'),
      dailySourceKey('2026-10-08'),
      weeklySourceKey('2026-W41'),
      competitionSourceKey('c1', 'COMPETITION_TOP10'),
      competitionSourceKey('c1', 'COMPETITION_FIRST'),
      competitionSourceKey('c2', 'COMPETITION_TOP10'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('ugyanaz a forrás UGYANAZT a kulcsot adja (a jutalom nem duplikálható)', () => {
    expect(predictionSourceKey('EXACT_SCORE', 'p1')).toBe(predictionSourceKey('EXACT_SCORE', 'p1'));
    expect(dailySourceKey('2026-10-07')).toBe(dailySourceKey('2026-10-07'));
    expect(competitionSourceKey('c1', 'COMPETITION_FIRST')).toBe(competitionSourceKey('c1', 'COMPETITION_FIRST'));
  });

  it('a streak kulcsa SORSZÁM-alapú, nem tipp-alapú (a sorozat egyszer fizet)', () => {
    // Ha a kulcs a kiváltó tippből származna, ugyanaz a 3-as sorozat annyiszor
    // fizetne, ahányszor a kiértékelés újrafut. A sorszám ezt kizárja.
    expect(streakSourceKey(3)).toBe('streak:3');
    expect(streakSourceKey(3)).not.toBe(streakSourceKey(4));
  });

  it('minden kulcs elfér a coin_transactions.source_key megszorításában', () => {
    const keys = [
      predictionSourceKey('EXACT_SCORE', randomUUID()),
      streakSourceKey(99),
      dailySourceKey('2026-10-07'),
      weeklySourceKey('2026-W41'),
      competitionSourceKey(randomUUID(), 'COMPETITION_FIRST'),
    ];
    for (const k of keys) {
      expect(k.length, k).toBeGreaterThanOrEqual(3);
      expect(k.length, k).toBeLessThanOrEqual(200);
    }
  });

  it('a coin SEMMILYEN kompetitív előnyt nem ad: a konfiguráció csak coin-összegeket ismer', () => {
    // Védőháló a pay-to-win ellen: ha bárki XP-t, pontot vagy kvótát próbál a
    // coin-konfigurációba csempészni, ez a teszt pirosodik.
    for (const v of Object.values(COIN_REWARDS)) expect(typeof v).toBe('number');
    const forbidden = /xp|point|pont|quota|kvota|kvóta|slot/i;
    for (const key of Object.keys(COIN_REWARDS)) expect(forbidden.test(key), key).toBe(false);
  });
});

// ============================================================================
// 3) SEED-PARITÁS: SHOP_SEED  ===  0011_coins_shop.sql
// ============================================================================

/** SQL-sorok tokenizálása: idézőjel-tudatos, a '' escape-et is kezeli. */
function parseSeedRows(sql: string): string[][] {
  const start = sql.indexOf('insert into public.shop_items');
  expect(start, 'a seed insert megtalálható').toBeGreaterThan(-1);
  const end = sql.indexOf('on conflict (item_key) do nothing', start);
  expect(end, 'a seed on conflict záradéka megtalálható').toBeGreaterThan(start);
  const header = sql.indexOf('values', start);
  // A kommentek eltávolítása: zárójelet tartalmazhatnak, ami félrevinné a tokenizálást
  const block = sql.slice(header + 'values'.length, end)
    .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

  const rows: string[][] = [];
  let i = 0;
  while (i < block.length) {
    if (block[i] !== '(') { i++; continue; }
    i++;
    const vals: string[] = [];
    let cur = '';
    let inStr = false;
    let depth = 0;
    while (i < block.length) {
      const c = block[i];
      if (inStr) {
        if (c === "'") {
          if (block[i + 1] === "'") { cur += "'"; i += 2; continue; }
          inStr = false; i++; continue;
        }
        cur += c; i++; continue;
      }
      if (c === "'") { inStr = true; i++; continue; }
      if (c === '(') { depth++; cur += c; i++; continue; }
      if (c === ')') {
        if (depth === 0) { vals.push(cur.trim()); i++; break; }
        depth--; cur += c; i++; continue;
      }
      if (c === ',' && depth === 0) { vals.push(cur.trim()); cur = ''; i++; continue; }
      cur += c; i++;
    }
    rows.push(vals);
  }
  return rows;
}

/** Kulcs szerint rendezett, mély JSON – a metadata összehasonlításához. */
function canonical(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, norm(val)]),
      );
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

describe('Seed-paritás – a TypeScript SHOP_SEED a source of truth', () => {
  const COLUMNS = ['item_key', 'category', 'name', 'description', 'rarity', 'price_coins', 'metadata', 'sort_order'];
  const rows = parseSeedRows(MIGRATION);

  it('a migráció oszloplistája pontosan a várt sorrendben van', () => {
    const declared = MIGRATION.slice(MIGRATION.indexOf('insert into public.shop_items'))
      .match(/insert into public\.shop_items \(([^)]+)\)/);
    expect(declared).toBeTruthy();
    expect(declared![1].split(',').map((s) => s.trim())).toEqual(COLUMNS);
  });

  it('minden SQL-sor pontosan 8 értéket tartalmaz', () => {
    for (const r of rows) expect(r.length, r[0]).toBe(COLUMNS.length);
  });

  it('az SQL seed elemszáma megegyezik a SHOP_SEED elemszámával', () => {
    expect(rows).toHaveLength(SHOP_SEED.length);
    expect(rows).toHaveLength(53);
  });

  it('az item_key halmazok azonosak (nincs se hiányzó, se extra item)', () => {
    const sqlKeys = rows.map((r) => r[0]).sort();
    const tsKeys = SHOP_SEED.map((i) => i.itemKey).sort();
    expect(sqlKeys).toEqual(tsKeys);
    expect(new Set(sqlKeys).size).toBe(sqlKeys.length);
  });

  it('MEZŐNKÉNT azonos: category, name, description, rarity, price_coins, metadata', () => {
    const sqlByKey = new Map(rows.map((r) => [r[0], r]));
    for (const item of SHOP_SEED) {
      const r = sqlByKey.get(item.itemKey);
      expect(r, `${item.itemKey} szerepel az SQL seedben`).toBeTruthy();
      expect(r![1], `${item.itemKey}.category`).toBe(item.category);
      expect(r![2], `${item.itemKey}.name`).toBe(item.name);
      expect(r![3], `${item.itemKey}.description`).toBe(item.description);
      expect(r![4], `${item.itemKey}.rarity`).toBe(item.rarity);
      expect(Number(r![5]), `${item.itemKey}.price_coins`).toBe(item.priceCoins);
      expect(canonical(JSON.parse(r![6])), `${item.itemKey}.metadata`).toBe(canonical(item.metadata ?? {}));
    }
  });

  it('a sort_order minden sorban egész szám, és kategórián belül egyedi', () => {
    const perCategory = new Map<string, number[]>();
    for (const r of rows) {
      const order = Number(r[7]);
      expect(Number.isInteger(order), r[0]).toBe(true);
      const list = perCategory.get(r[1]) ?? [];
      list.push(order);
      perCategory.set(r[1], list);
    }
    for (const [category, list] of perCategory) {
      expect(new Set(list).size, `${category} sort_order egyedi`).toBe(list.length);
    }
  });

  it('egyetlen seed-item sem időszakos: is_limited és available_until nincs megadva (default false/null)', () => {
    // A seed-insert nem adja meg ezt a két oszlopot, tehát mindkettő a
    // defaultot kapja (false, null) – ez illeszkedik a SHOP_SEED-hez, ahol
    // nincs isLimited/availableUntil mező.
    const insertBlock = MIGRATION.slice(MIGRATION.indexOf('insert into public.shop_items'));
    expect(insertBlock).not.toContain('is_limited');
    expect(insertBlock).not.toContain('available_until');
    for (const item of SHOP_SEED) {
      expect('isLimited' in item, item.itemKey).toBe(false);
      expect('availableUntil' in item, item.itemKey).toBe(false);
    }
  });

  it('az SQL seed is érvényes kategóriát, rarityt és nem negatív árat használ', () => {
    for (const r of rows) {
      expect(SHOP_CATEGORIES as string[], r[0]).toContain(r[1]);
      expect(RARITIES as string[], r[0]).toContain(r[4]);
      expect(Number(r[5]), r[0]).toBeGreaterThanOrEqual(0);
      expect(ITEM_KEY_PATTERN.test(r[0]), r[0]).toBe(true);
    }
  });
});

// ============================================================================
// 4) MIGRÁCIÓ-SZERKEZET
//    Szöveges állítások: a védelem BENNE VAN a migrációban.
// ============================================================================

describe('0011_coins_shop.sql – szerkezet és védelem', () => {
  it('létrehozza mind a négy táblát, újrafuttathatóan', () => {
    for (const t of ['user_coins', 'coin_transactions', 'shop_items', 'user_shop_items']) {
      expect(MIGRATION, t).toContain(`create table if not exists public.${t}`);
    }
  });

  it('egyetlen meglévő migráció objektumát sem módosítja vagy törli', () => {
    // Semmilyen destruktív művelet: táblát, oszlopot, indexet nem dobunk el.
    // (A `drop trigger if exists` / `drop policy if exists` kizárólag a SAJÁT,
    // ebben a migrációban létrehozott objektumokra megy.)
    expect(MIGRATION).not.toMatch(/drop\s+table/i);
    expect(MIGRATION).not.toMatch(/drop\s+column/i);
    expect(MIGRATION).not.toMatch(/drop\s+index/i);
    expect(MIGRATION).not.toMatch(/\btruncate\b/i);
    expect(MIGRATION).not.toMatch(/\bdelete\s+from\b/i);
    expect(MIGRATION).not.toMatch(/alter\s+table\s+public\.(profiles|predictions|slips|competition_|user_predictions|progression_events|user_achievements|user_profile_settings|mission_claims|battles|battle_|notifications)/i);
    for (const policyDrop of MIGRATION.match(/drop policy if exists[\s\S]*?on public\.(\w+);/g) ?? []) {
      expect(policyDrop).toMatch(/on public\.(user_coins|coin_transactions|shop_items|user_shop_items);/);
    }
  });

  it('a negatív egyenleget adatbázis-szintű CHECK zárja ki', () => {
    expect(MIGRATION).toContain('balance    bigint not null default 0 check (balance >= 0)');
    expect(MIGRATION).toContain('balance_after bigint not null check (balance_after >= 0)');
  });

  it('a jutalom idempotenciáját a (user_id, source_key) EGYEDISÉG védi', () => {
    expect(MIGRATION).toContain('constraint coin_transactions_unique_source unique (user_id, source_key)');
  });

  it('a dupla vásárlást a (user_id, item_id) EGYEDISÉG védi', () => {
    expect(MIGRATION).toContain('constraint user_shop_items_unique unique (user_id, item_id)');
  });

  it('a 0 összegű és a határon túli tranzakciót CHECK zárja ki', () => {
    expect(MIGRATION).toContain('check (amount <> 0 and abs(amount) <= 1000000)');
  });

  it('az item_key alakját és a kategória/rarity értékkészletét CHECK kényszeríti', () => {
    expect(MIGRATION).toContain("item_key        text not null unique check (item_key ~ '^[a-z0-9_]{3,64}$')");
    for (const c of SHOP_CATEGORIES) expect(MIGRATION, c).toContain(`'${c}'`);
    for (const r of RARITIES) expect(MIGRATION, r).toContain(`'${r}'`);
    expect(MIGRATION).toContain('check (price_coins >= 0 and price_coins <= 1000000)');
  });

  it('a tulajdonos utólag nem írható át (ownership protection)', () => {
    expect(MIGRATION).toContain('protect_user_coins_owner');
    expect(MIGRATION).toContain('protect_user_shop_items_owner');
    expect(MIGRATION).toContain('public.protect_owner_column()');
  });

  it('mind a négy táblán be van kapcsolva az RLS', () => {
    for (const t of ['user_coins', 'coin_transactions', 'shop_items', 'user_shop_items']) {
      expect(MIGRATION, t).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security`));
    }
  });

  it('CSAK SELECT policy van – a kliens nem tud írni (nem adhat magának coint vagy itemet)', () => {
    const policies = MIGRATION.match(/create policy[\s\S]*?using \([^;]*\);/g) ?? [];
    expect(policies.length).toBe(4);
    for (const p of policies) {
      expect(p).toMatch(/for select/);
      expect(p).not.toMatch(/for (insert|update|delete|all)\b/);
    }
    expect(MIGRATION).not.toMatch(/with check/i);
  });

  it('a saját sorokra szűkítő policy-k az auth.uid()-ot használják', () => {
    for (const t of ['user_coins', 'coin_transactions', 'user_shop_items']) {
      const block = MIGRATION.slice(MIGRATION.indexOf(`on public.${t} for select`));
      expect(block.slice(0, 200), t).toContain('(select auth.uid()) = user_id');
    }
    // A katalógus nyilvános, de csak az aktív itemek láthatók
    expect(MIGRATION).toMatch(/on public\.shop_items for select to authenticated\s+using \(is_active\);/);
  });

  it('az anon/authenticated szerepkör minden jogot visszavon, és csak SELECT-et kap', () => {
    expect(MIGRATION).toMatch(/revoke all on public\.user_coins, public\.coin_transactions, public\.shop_items, public\.user_shop_items\s*from anon, authenticated;/);
    expect(MIGRATION).toMatch(/grant select on public\.user_coins, public\.coin_transactions, public\.shop_items, public\.user_shop_items\s*to authenticated;/);
    expect(MIGRATION).not.toMatch(/grant (insert|update|delete|all)[\s\S]{0,120}to (anon|authenticated)/i);
  });

  it('mindkét RPC atomikus, és a VÁSÁRLÓRA vett advisory lockkal sorosít', () => {
    for (const fn of ['purchase_shop_item', 'award_coins']) {
      const body = MIGRATION.slice(MIGRATION.indexOf(`create or replace function public.${fn}`));
      const src = body.slice(0, body.indexOf('$$;'));
      expect(src, `${fn}: advisory lock`).toContain('pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0))');
      expect(src, `${fn}: security invoker`).toContain('security invoker');
      expect(src, `${fn}: search_path`).toContain("set search_path = ''");
    }
  });

  it('a vásárlás sorrendje: egyenleg-ellenőrzés → levonás → készlet → tranzakció', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.purchase_shop_item'));
    const src = fn.slice(0, fn.indexOf('$$;'));
    const iLock = src.indexOf('pg_advisory_xact_lock');
    const iCheck = src.indexOf('v_balance < v_item.price_coins');
    const iDebit = src.indexOf('update public.user_coins set balance = v_new');
    const iInv = src.indexOf('insert into public.user_shop_items');
    const iTx = src.indexOf('insert into public.coin_transactions');
    for (const [name, idx] of [['lock', iLock], ['check', iCheck], ['debit', iDebit], ['inventory', iInv], ['transaction', iTx]] as const) {
      expect(idx, name).toBeGreaterThan(-1);
    }
    expect(iLock).toBeLessThan(iCheck);
    expect(iCheck).toBeLessThan(iDebit);
    expect(iDebit).toBeLessThan(iInv);
    expect(iInv).toBeLessThan(iTx);
  });

  it('az ÁR a shop_items táblából jön, nem a hívótól', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.purchase_shop_item'));
    const signature = fn.slice(0, fn.indexOf(')'));
    expect(signature).toContain('p_user_id  uuid');
    expect(signature).toContain('p_item_key text');
    // Nincs ár-, ritkaság- vagy összeg-paraméter a vásárlásban
    expect(signature).not.toMatch(/price|amount|coins|rarity/i);
    expect(fn.slice(0, fn.indexOf('$$;'))).toContain('v_item.price_coins');
  });

  it('mindkét RPC-t KIZÁRÓLAG a service_role hívhatja', () => {
    expect(MIGRATION).toContain('revoke all on function public.purchase_shop_item(uuid, text, timestamptz) from public, anon, authenticated;');
    expect(MIGRATION).toContain('grant execute on function public.purchase_shop_item(uuid, text, timestamptz) to service_role;');
    expect(MIGRATION).toContain('revoke all on function public.award_coins(uuid, bigint, text, text, text) from public, anon, authenticated;');
    expect(MIGRATION).toContain('grant execute on function public.award_coins(uuid, bigint, text, text, text) to service_role;');
    // Egyik RPC sem kapott execute jogot a kliens szerepköröknek
    expect(MIGRATION).not.toMatch(/grant execute[\s\S]{0,120}to (anon|authenticated)/i);
  });

  it('a seed újrafuttatása nem ír felül admin által módosított sort', () => {
    expect(MIGRATION).toContain('on conflict (item_key) do nothing');
    expect(MIGRATION).not.toMatch(/on conflict[\s\S]{0,60}do update/i);
  });

  it('a jutalmazás összege szerveroldali, és a határokat a függvény ellenőrzi', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.award_coins'));
    const src = fn.slice(0, fn.indexOf('$$;'));
    expect(src).toContain('p_amount <= 0 or p_amount > 1000000');
  });

  it('a migráció nem nyúl a Stripe-hoz, az XP-hez, a Tippverseny-pontozáshoz és a FREE kvótához', () => {
    // A kommenteket leszedjük: a kódnak kell izoláltnak lennie, nem a prózának
    // (a fejléc-komment maga MEGNEVEZI ezeket a rendszereket, épp azért, hogy
    // rögzítse: nem nyúlunk hozzájuk).
    const code = MIGRATION.replace(/--.*/g, '');
    expect(code).not.toMatch(/stripe|subscription|billing/i);
    expect(code).not.toMatch(/progression_events|user_achievements|mission_claims/i);
    expect(code).not.toMatch(/user_predictions|competition_rounds|competition_matches|competition_rewards/i);
  });
});

// ============================================================================
// 5) AZ RPC-k SZERZŐDÉSE – futtatható node:sqlite modell
// ============================================================================

type Outcome = 'purchased' | 'already_owned' | 'insufficient_coins' | 'not_found' | 'inactive' | 'expired';

/**
 * A migráció megszorításaiból származtatott séma. A UNIQUE és a CHECK
 * ugyanaz, mint PostgreSQL-ben – ezért a dupla vásárlás és a negatív egyenleg
 * elleni védelmet VALÓDI adatbázis-megszorítás bizonyítja, nem alkalmazáskód.
 */
function createDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE user_coins (
      user_id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE coin_transactions (
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
    CREATE TABLE shop_items (
      id TEXT PRIMARY KEY,
      item_key TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      rarity TEXT NOT NULL,
      price_coins INTEGER NOT NULL CHECK (price_coins >= 0 AND price_coins <= 1000000),
      metadata TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      is_limited INTEGER NOT NULL DEFAULT 0,
      available_until TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE user_shop_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL REFERENCES shop_items(id),
      paid_coins INTEGER NOT NULL CHECK (paid_coins >= 0),
      purchased_at TEXT NOT NULL,
      UNIQUE (user_id, item_id)
    );
  `);
  return db;
}

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

describe('Shop RPC-szerződés (node:sqlite modell)', () => {
  let db: Db;

  /** A SHOP_SEED beszúrása UGYANAZZAL az `on conflict do nothing` záradékkal. */
  function seed(): number {
    let inserted = 0;
    for (const i of SHOP_SEED) {
      const r = db.prepare(`INSERT INTO shop_items (id, item_key, category, name, description, rarity, price_coins, metadata, sort_order)
        VALUES (?,?,?,?,?,?,?,?,0) ON CONFLICT (item_key) DO NOTHING`)
        .run(randomUUID(), i.itemKey, i.category, i.name, i.description, i.rarity, i.priceCoins, JSON.stringify(i.metadata ?? {}));
      inserted += Number(r.changes);
    }
    return inserted;
  }

  /** A `purchase_shop_item()` törzsének lépései, valódi tranzakcióban. */
  function purchase(userId: string, itemKey: string, now = new Date().toISOString()): { outcome: Outcome; balance: number | null } {
    const item = db.prepare('SELECT * FROM shop_items WHERE item_key = ?').get(itemKey) as any;
    if (!item) return { outcome: 'not_found', balance: null };
    if (!item.is_active) return { outcome: 'inactive', balance: null };
    if (item.is_limited && item.available_until && item.available_until <= now) return { outcome: 'expired', balance: null };

    db.exec('BEGIN IMMEDIATE');
    try {
      const owned = db.prepare('SELECT 1 FROM user_shop_items WHERE user_id = ? AND item_id = ?').get(userId, item.id);
      if (owned) {
        const bal = db.prepare('SELECT balance FROM user_coins WHERE user_id = ?').get(userId) as any;
        db.exec('COMMIT');
        return { outcome: 'already_owned', balance: bal ? Number(bal.balance) : 0 };
      }
      db.prepare('INSERT INTO user_coins (user_id, balance, created_at, updated_at) VALUES (?,0,?,?) ON CONFLICT (user_id) DO NOTHING')
        .run(userId, now, now);
      const balance = Number((db.prepare('SELECT balance FROM user_coins WHERE user_id = ?').get(userId) as any).balance);
      if (balance < Number(item.price_coins)) {
        db.exec('COMMIT');
        return { outcome: 'insufficient_coins', balance };
      }
      const next = balance - Number(item.price_coins);
      db.prepare('UPDATE user_coins SET balance = ?, updated_at = ? WHERE user_id = ?').run(next, now, userId);
      db.prepare('INSERT INTO user_shop_items (id, user_id, item_id, paid_coins, purchased_at) VALUES (?,?,?,?,?)')
        .run(randomUUID(), userId, item.id, Number(item.price_coins), now);
      db.prepare(`INSERT INTO coin_transactions (id, user_id, amount, type, label, source_key, balance_after, created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), userId, -Number(item.price_coins), 'SHOP_PURCHASE', item.name, `purchase:${item.item_key}`, next, now);
      db.exec('COMMIT');
      return { outcome: 'purchased', balance: next };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Az `award_coins()` törzsének lépései. */
  function award(userId: string, amount: number, type: string, label: string, sourceKey: string): { outcome: 'awarded' | 'already_awarded'; balance: number; amount: number } {
    if (!userId || !sourceKey) throw new Error('A felhasználó és a forráskulcs kötelező.');
    if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000) {
      throw new Error('A jutalom összege 1 és 1000000 közötti egész szám lehet.');
    }
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT 1 FROM coin_transactions WHERE user_id = ? AND source_key = ?').get(userId, sourceKey);
      if (existing) {
        const bal = db.prepare('SELECT balance FROM user_coins WHERE user_id = ?').get(userId) as any;
        db.exec('COMMIT');
        return { outcome: 'already_awarded', balance: bal ? Number(bal.balance) : 0, amount: 0 };
      }
      db.prepare('INSERT INTO user_coins (user_id, balance, created_at, updated_at) VALUES (?,0,?,?) ON CONFLICT (user_id) DO NOTHING')
        .run(userId, now, now);
      const balance = Number((db.prepare('SELECT balance FROM user_coins WHERE user_id = ?').get(userId) as any).balance);
      const next = balance + amount;
      db.prepare('UPDATE user_coins SET balance = ?, updated_at = ? WHERE user_id = ?').run(next, now, userId);
      db.prepare(`INSERT INTO coin_transactions (id, user_id, amount, type, label, source_key, balance_after, created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), userId, amount, type, label, sourceKey, next, now);
      db.exec('COMMIT');
      return { outcome: 'awarded', balance: next, amount };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  const balanceOf = (u: string) => {
    const r = db.prepare('SELECT balance FROM user_coins WHERE user_id = ?').get(u) as any;
    return r ? Number(r.balance) : 0;
  };
  const inventoryCount = (u: string) => Number((db.prepare('SELECT COUNT(*) AS n FROM user_shop_items WHERE user_id = ?').get(u) as any).n);
  const txCount = (u: string) => Number((db.prepare('SELECT COUNT(*) AS n FROM coin_transactions WHERE user_id = ?').get(u) as any).n);
  const itemCount = () => Number((db.prepare('SELECT COUNT(*) AS n FROM shop_items').get() as any).n);

  beforeEach(() => {
    db = createDb();
    seed();
  });

  // --- SEED a modellben -----------------------------------------------------

  it('a seed pontosan 53 itemet hoz létre', () => {
    expect(itemCount()).toBe(53);
  });

  it('a seed árai, kategóriái és ritkaságai megfelelnek a SHOP_SEED-nek', () => {
    for (const i of SHOP_SEED) {
      const row = db.prepare('SELECT price_coins, category, rarity, name FROM shop_items WHERE item_key = ?').get(i.itemKey) as any;
      expect(row, i.itemKey).toBeTruthy();
      expect(Number(row.price_coins), i.itemKey).toBe(i.priceCoins);
      expect(row.category, i.itemKey).toBe(i.category);
      expect(row.rarity, i.itemKey).toBe(i.rarity);
      expect(row.name, i.itemKey).toBe(i.name);
    }
  });

  it('a seed MÁSODSZORI futtatása nem hoz létre duplikátumot', () => {
    expect(seed()).toBe(0);
    expect(itemCount()).toBe(53);
  });

  it('a seed újrafuttatása nem írja felül az admin által módosított árat', () => {
    db.prepare("UPDATE shop_items SET price_coins = 1 WHERE item_key = 'frame_fire'").run();
    seed();
    const row = db.prepare("SELECT price_coins FROM shop_items WHERE item_key = 'frame_fire'").get() as any;
    expect(Number(row.price_coins)).toBe(1);
  });

  // --- 1) elegendő coin → sikeres vásárlás ---------------------------------

  it('1) elegendő coin → sikeres vásárlás', () => {
    award(USER_A, 3000, 'COMPETITION_TOP10', 'Top 10', 'competition:c1:competition_top10');
    const r = purchase(USER_A, 'frame_fire'); // 2500
    expect(r.outcome).toBe('purchased');
    expect(r.balance).toBe(500);
    expect(balanceOf(USER_A)).toBe(500);
    expect(inventoryCount(USER_A)).toBe(1);
  });

  // --- 2) kevés coin → sikertelen -----------------------------------------

  it('2) kevés coin → sikertelen vásárlás, és SEMMI nem változik', () => {
    award(USER_A, 100, 'DAILY_TIPS', 'Napi tippek', 'daily:2026-10-07');
    const r = purchase(USER_A, 'frame_fire');
    expect(r.outcome).toBe('insufficient_coins');
    expect(balanceOf(USER_A)).toBe(100);
    expect(inventoryCount(USER_A)).toBe(0);
    expect(txCount(USER_A)).toBe(1); // csak a jóváírás
  });

  it('2b) nulla egyenleggel sem lehet vásárolni', () => {
    const r = purchase(USER_A, 'name_green'); // 300
    expect(r.outcome).toBe('insufficient_coins');
    expect(balanceOf(USER_A)).toBe(0);
    expect(inventoryCount(USER_A)).toBe(0);
    expect(txCount(USER_A)).toBe(0);
  });

  it('2c) a pontosan elegendő egyenleg még elég (nincs off-by-one)', () => {
    award(USER_A, 2500, 'COMPETITION_TOP10', 'Top 10', 'competition:c1:competition_top10');
    expect(purchase(USER_A, 'frame_fire').outcome).toBe('purchased');
    expect(balanceOf(USER_A)).toBe(0);
  });

  // --- 3) ugyanaz az item kétszer -----------------------------------------

  it('3) ugyanaz az item kétszer → a második vásárlás nem megy végbe', () => {
    award(USER_A, 10000, 'COMPETITION_FIRST', 'Verseny győzelem', 'competition:c1:competition_first');
    expect(purchase(USER_A, 'frame_fire').outcome).toBe('purchased');
    const after = balanceOf(USER_A);

    const second = purchase(USER_A, 'frame_fire');
    expect(second.outcome).toBe('already_owned');
    expect(balanceOf(USER_A)).toBe(after);     // NEM vontunk le újra
    expect(inventoryCount(USER_A)).toBe(1);    // nincs duplikált készlet-sor
    expect(txCount(USER_A)).toBe(2);           // 1 jóváírás + 1 vásárlás
  });

  // --- 4) párhuzamos vásárlás ---------------------------------------------

  it('4) párhuzamos (interleaved) vásárlás → csak EGY sikeres, az egyenleg nem megy negatívba', () => {
    // A két kérés UGYANAZT az egyenleget olvassa (ezt zárja ki élesben az
    // advisory lock). Itt szándékosan a lock NÉLKÜLI esetet modellezzük, hogy
    // bizonyítsuk: a végső védelem adatbázis-szintű, nem alkalmazáskód.
    award(USER_A, 2500, 'COMPETITION_TOP10', 'Top 10', 'competition:c1:competition_top10');
    const item = db.prepare("SELECT * FROM shop_items WHERE item_key = 'frame_fire'").get() as any;
    const stale = balanceOf(USER_A); // mindkét „szál" ezt látja: 2500
    const now = new Date().toISOString();

    // Első szál commitol
    expect(purchase(USER_A, 'frame_fire').outcome).toBe('purchased');

    // Második szál a RÉGI egyenleggel próbál írni
    let blocked = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE user_coins SET balance = ? WHERE user_id = ?').run(stale - Number(item.price_coins), USER_A);
      db.prepare('INSERT INTO user_shop_items (id, user_id, item_id, paid_coins, purchased_at) VALUES (?,?,?,?,?)')
        .run(randomUUID(), USER_A, item.id, Number(item.price_coins), now);
      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
      blocked = true;
    }

    expect(blocked, 'a (user_id, item_id) egyediség megállította a második írást').toBe(true);
    expect(inventoryCount(USER_A)).toBe(1);
    expect(balanceOf(USER_A)).toBe(0);
    expect(txCount(USER_A)).toBe(2);
  });

  it('4b) két KÜLÖNBÖZŐ item egymás utáni vásárlása nem mehet az egyenlegen túl', () => {
    award(USER_A, 2800, 'COMPETITION_TOP10', 'Top 10', 'competition:c1:competition_top10');
    expect(purchase(USER_A, 'frame_fire').outcome).toBe('purchased'); // -2500 → 300
    expect(purchase(USER_A, 'name_green').outcome).toBe('purchased'); // -300  → 0
    expect(balanceOf(USER_A)).toBe(0);
    expect(inventoryCount(USER_A)).toBe(2);
    expect(purchase(USER_A, 'name_blue').outcome).toBe('insufficient_coins');
  });

  it('4c) a negatív egyenleget adatbázis-szintű CHECK zárja ki', () => {
    award(USER_A, 100, 'DAILY_TIPS', 'Napi tippek', 'daily:2026-10-07');
    expect(() => db.prepare('UPDATE user_coins SET balance = -1 WHERE user_id = ?').run(USER_A)).toThrow();
    expect(balanceOf(USER_A)).toBe(100);
  });

  // --- 5) a levonás és a készlet együtt történik --------------------------

  it('5) a coin levonás és a készlet létrehozása EGYÜTT történik', () => {
    award(USER_A, 5000, 'COMPETITION_FIRST', 'Verseny győzelem', 'competition:c1:competition_first');
    purchase(USER_A, 'frame_fire');

    expect(balanceOf(USER_A)).toBe(2500);
    expect(inventoryCount(USER_A)).toBe(1);
    const tx = db.prepare("SELECT * FROM coin_transactions WHERE user_id = ? AND type = 'SHOP_PURCHASE'").get(USER_A) as any;
    expect(Number(tx.amount)).toBe(-2500);           // a terhelés negatív
    expect(Number(tx.balance_after)).toBe(2500);     // és az egyenleggel konzisztens
    const inv = db.prepare('SELECT * FROM user_shop_items WHERE user_id = ?').get(USER_A) as any;
    expect(Number(inv.paid_coins)).toBe(2500);       // a fizetett ár rögzített
  });

  it('5b) az ár későbbi változása nem írja át a már megfizetett összeget', () => {
    award(USER_A, 5000, 'COMPETITION_FIRST', 'Verseny győzelem', 'competition:c1:competition_first');
    purchase(USER_A, 'frame_fire');
    db.prepare("UPDATE shop_items SET price_coins = 9999 WHERE item_key = 'frame_fire'").run();
    const inv = db.prepare('SELECT paid_coins FROM user_shop_items WHERE user_id = ?').get(USER_A) as any;
    expect(Number(inv.paid_coins)).toBe(2500);
  });

  // --- 6) sikertelen vásárlás után nincs félkész állapot ------------------

  it('6) megszakadó vásárlás után NEM marad félkész állapot (atomicitás)', () => {
    award(USER_A, 5000, 'COMPETITION_FIRST', 'Verseny győzelem', 'competition:c1:competition_first');
    const item = db.prepare("SELECT * FROM shop_items WHERE item_key = 'frame_fire'").get() as any;
    const now = new Date().toISOString();

    // A tranzakció-naplózás (az utolsó lépés) szándékosan elhasal: a
    // source_key túl hosszú a CHECK-hez. A levonásnak és a készlet-sornak
    // VISSZA kell fordulnia.
    let threw = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE user_coins SET balance = ? WHERE user_id = ?').run(2500, USER_A);
      db.prepare('INSERT INTO user_shop_items (id, user_id, item_id, paid_coins, purchased_at) VALUES (?,?,?,?,?)')
        .run(randomUUID(), USER_A, item.id, 2500, now);
      db.prepare(`INSERT INTO coin_transactions (id, user_id, amount, type, label, source_key, balance_after, created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), USER_A, -2500, 'SHOP_PURCHASE', item.name, 'x'.repeat(201), 2500, now);
      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
      threw = true;
    }

    expect(threw).toBe(true);
    expect(balanceOf(USER_A)).toBe(5000);   // a levonás visszafordult
    expect(inventoryCount(USER_A)).toBe(0); // a készlet-sor visszafordult
    expect(txCount(USER_A)).toBe(1);        // csak az eredeti jóváírás maradt
  });

  it('6b) nem létező, inaktív és lejárt item nem vásárolható, és nem von le coint', () => {
    award(USER_A, 5000, 'COMPETITION_FIRST', 'Verseny győzelem', 'competition:c1:competition_first');

    expect(purchase(USER_A, 'nincs_ilyen_item').outcome).toBe('not_found');

    db.prepare("UPDATE shop_items SET is_active = 0 WHERE item_key = 'frame_fire'").run();
    expect(purchase(USER_A, 'frame_fire').outcome).toBe('inactive');

    db.prepare("UPDATE shop_items SET is_limited = 1, available_until = '2020-01-01T00:00:00.000Z' WHERE item_key = 'name_green'").run();
    expect(purchase(USER_A, 'name_green').outcome).toBe('expired');

    expect(balanceOf(USER_A)).toBe(5000);
    expect(inventoryCount(USER_A)).toBe(0);
  });

  it('6c) a MÁR MEGVETT item a készletben marad, ha később lejár vagy kivonják', () => {
    award(USER_A, 5000, 'COMPETITION_FIRST', 'Verseny győzelem', 'competition:c1:competition_first');
    purchase(USER_A, 'frame_fire');
    db.prepare("UPDATE shop_items SET is_active = 0, is_limited = 1, available_until = '2020-01-01T00:00:00.000Z' WHERE item_key = 'frame_fire'").run();
    expect(inventoryCount(USER_A)).toBe(1);
  });

  // --- 7) jogosulatlan hívó ----------------------------------------------

  it('7) jogosulatlan hívó nem hívhatja a vásárlást (szerkezeti bizonyíték)', () => {
    // A plpgsql törzs futtatásához nincs PostgreSQL runtime, ezért a
    // jogosultságot a migráció GRANT/REVOKE záradékain bizonyítjuk:
    // a kliens szerepköröknek nincs execute joguk, és a táblákra sincs
    // írási policy-juk – a vásárlás kizárólag service_role-lal lehetséges.
    expect(MIGRATION).toContain('revoke all on function public.purchase_shop_item(uuid, text, timestamptz) from public, anon, authenticated;');
    expect(MIGRATION).toContain('grant execute on function public.purchase_shop_item(uuid, text, timestamptz) to service_role;');
    expect(MIGRATION).not.toMatch(/grant execute[\s\S]{0,120}to (anon|authenticated)/i);
    const policies = MIGRATION.match(/create policy[\s\S]*?using \([^;]*\);/g) ?? [];
    for (const p of policies) expect(p).toMatch(/for select/);
  });

  it('7b) a user_id sosem a kérésből jön: a vásárlás más felhasználó készletét nem érinti', () => {
    award(USER_A, 5000, 'COMPETITION_FIRST', 'Verseny győzelem', 'competition:c1:competition_first');
    award(USER_B, 5000, 'COMPETITION_FIRST', 'Verseny győzelem', 'competition:c1:competition_first');
    purchase(USER_A, 'frame_fire');
    expect(balanceOf(USER_B)).toBe(5000);
    expect(inventoryCount(USER_B)).toBe(0);
    expect(inventoryCount(USER_A)).toBe(1);
  });

  // --- award_coins -------------------------------------------------------

  it('award 1) a jóváírás működik, és az egyenleg a napló összegével egyezik', () => {
    expect(award(USER_A, COIN_REWARDS.EXACT_SCORE, 'EXACT_SCORE', 'Pontos eredmény', predictionSourceKey('EXACT_SCORE', 'p1')).outcome).toBe('awarded');
    expect(balanceOf(USER_A)).toBe(COIN_REWARDS.EXACT_SCORE);
    const sum = Number((db.prepare('SELECT SUM(amount) AS s FROM coin_transactions WHERE user_id = ?').get(USER_A) as any).s);
    expect(sum).toBe(balanceOf(USER_A));
  });

  it('award 2) ugyanaz a source_key MÁSODSZOR nem ír jóvá újabb coint', () => {
    const key = predictionSourceKey('EXACT_SCORE', 'p1');
    award(USER_A, 150, 'EXACT_SCORE', 'Pontos eredmény', key);
    const second = award(USER_A, 150, 'EXACT_SCORE', 'Pontos eredmény', key);
    expect(second.outcome).toBe('already_awarded');
    expect(second.amount).toBe(0);
    expect(balanceOf(USER_A)).toBe(150);
    expect(txCount(USER_A)).toBe(1);
  });

  it('award 2b) az idempotenciát ADATBÁZIS-szintű egyediség védi, nem előzetes ellenőrzés', () => {
    const key = dailySourceKey('2026-10-07');
    award(USER_A, 20, 'DAILY_TIPS', 'Napi tippek', key);
    expect(() => db.prepare(`INSERT INTO coin_transactions (id, user_id, amount, type, label, source_key, balance_after, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), USER_A, 20, 'DAILY_TIPS', 'Napi tippek', key, 40, new Date().toISOString())).toThrow();
    expect(txCount(USER_A)).toBe(1);
  });

  it('award 3) KÜLÖN source_key külön jutalmat ad', () => {
    award(USER_A, 10, 'PREDICTION_SUBMITTED', 'Tipp leadása', predictionSourceKey('PREDICTION_SUBMITTED', 'p1'));
    award(USER_A, 10, 'PREDICTION_SUBMITTED', 'Tipp leadása', predictionSourceKey('PREDICTION_SUBMITTED', 'p2'));
    award(USER_A, 75, 'CORRECT_OUTCOME', 'Helyes kimenet', predictionSourceKey('CORRECT_OUTCOME', 'p1'));
    expect(balanceOf(USER_A)).toBe(95);
    expect(txCount(USER_A)).toBe(3);
  });

  it('award 3b) ugyanaz a forráskulcs KÜLÖN felhasználónál külön jutalom', () => {
    const key = dailySourceKey('2026-10-07');
    award(USER_A, 20, 'DAILY_TIPS', 'Napi tippek', key);
    award(USER_B, 20, 'DAILY_TIPS', 'Napi tippek', key);
    expect(balanceOf(USER_A)).toBe(20);
    expect(balanceOf(USER_B)).toBe(20);
  });

  it('award 4) negatív, nulla, törtszámú és határon túli jutalom nem lehetséges', () => {
    for (const bad of [0, -1, -1000, 1.5, 1_000_001, Number.NaN]) {
      expect(() => award(USER_A, bad, 'DAILY_TIPS', 'Napi tippek', `daily:bad-${bad}`), String(bad)).toThrow();
    }
    expect(balanceOf(USER_A)).toBe(0);
    expect(txCount(USER_A)).toBe(0);
  });

  it('award 4b) forráskulcs nélkül nem lehet jóváírni', () => {
    expect(() => award(USER_A, 100, 'DAILY_TIPS', 'Napi tippek', '')).toThrow();
    expect(txCount(USER_A)).toBe(0);
  });

  it('award 5) jogosulatlan hívó nem hívhatja a jutalmazást (szerkezeti bizonyíték)', () => {
    expect(MIGRATION).toContain('revoke all on function public.award_coins(uuid, bigint, text, text, text) from public, anon, authenticated;');
    expect(MIGRATION).toContain('grant execute on function public.award_coins(uuid, bigint, text, text, text) to service_role;');
    // A kliens a táblákra is csak SELECT-et kap – nem tud magának coint írni
    expect(MIGRATION).toMatch(/grant select on public\.user_coins/);
    expect(MIGRATION).not.toMatch(/grant (insert|update|delete)[\s\S]{0,120}to authenticated/i);
  });

  it('a teljes életciklus konzisztens: a napló összege MINDIG az egyenleg', () => {
    award(USER_A, 150, 'EXACT_SCORE', 'Pontos eredmény', predictionSourceKey('EXACT_SCORE', 'p1'));
    award(USER_A, 75, 'CORRECT_OUTCOME', 'Helyes kimenet', predictionSourceKey('CORRECT_OUTCOME', 'p2'));
    award(USER_A, 1500, 'COMPETITION_FIRST', 'Verseny győzelem', competitionSourceKey('c1', 'COMPETITION_FIRST'));
    // 150 + 75 + 1500 = 1725 coin, ebbol harom 300-as item fer bele (900),
    // a koztes heti jutalommal egyutt. Draga itemet szandekosan nem vesz:
    // a lifecycle az invariansrol szol, nem a vasarloerorol.
    expect(purchase(USER_A, 'name_green').outcome).toBe('purchased');
    expect(purchase(USER_A, 'name_blue').outcome).toBe('purchased');
    award(USER_A, 250, 'WEEKLY_TIPS', 'Heti tippek', weeklySourceKey('2026-W41'));
    expect(purchase(USER_A, 'name_purple').outcome).toBe('purchased');

    const sum = Number((db.prepare('SELECT SUM(amount) AS s FROM coin_transactions WHERE user_id = ?').get(USER_A) as any).s);
    expect(sum).toBe(balanceOf(USER_A));
    expect(balanceOf(USER_A)).toBeGreaterThanOrEqual(0);
    expect(inventoryCount(USER_A)).toBe(3);
  });
});
