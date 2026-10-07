/**
 * Shop kozmetikum FELVÉTELE – integráció és HTTP (5e).
 *
 * Valódi Express alkalmazás a VALÓDI `profileRouter` / `progressionRouter`
 * útvonalakkal, valódi `ProgressionService`, valódi `CoinService`, valódi
 * `SqliteProgressionStore` és `SqliteCoinStore` (a 0012 hat oszlopával).
 * Az egyetlen szimulált elem a `res.locals.plan` – ugyanaz a minta, amit a
 * meglévő progression/missions/competition tesztek használnak.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { SqliteCompetitionStore } from '../src/server/competition/store';
import { CompetitionService } from '../src/server/competition/service';
import { SqliteProgressionStore } from '../src/server/progression/store';
import { ProgressionService } from '../src/server/progression/service';
import { SqliteCoinStore } from '../src/server/coins/store';
import { CoinService } from '../src/server/coins/service';
import { CoinRewardService } from '../src/server/coins/rewards';
import { profileRouter } from '../src/server/routes/profile';
import { progressionRouter } from '../src/server/routes/progression';
import { shopRouter } from '../src/server/routes/coins';
import { InMemoryDisplayNameDirectory } from '../src/server/profile/displayNameDirectory';
import {
  CATEGORY_TO_SLOT, COIN_REWARDS, EMPTY_EQUIPS, PROFILE_SLOTS, SHOP_CATEGORIES, SHOP_SEED,
  type ProfileSlot,
} from '../src/shared/shop';
import { DEFAULT_SETTINGS } from '../src/shared/progression';
import type { MatchDataProvider } from '../src/server/data/provider';
import type { League, Match, MatchResult, Team } from '../src/shared/types';

const PRO = '11111111-1111-1111-1111-111111111111';
const FREE = '33333333-3333-3333-3333-333333333333';
const OTHER = '22222222-2222-2222-2222-222222222222';
const PRICE = (k: string) => SHOP_SEED.find((i) => i.itemKey === k)!.priceCoins;

class StubProvider implements MatchDataProvider {
  readonly name = 'teszt';
  readonly origin = 'live' as const;
  async getLeagues(): Promise<League[]> { return []; }
  async getTeams(): Promise<Team[]> { return []; }
  async getTeam(): Promise<Team | null> { return null; }
  async getMatches(): Promise<Match[]> { return []; }
  async getMatch(): Promise<Match | null> { return null; }
  async getResultsForAnalysis(): Promise<MatchResult[]> { return []; }
  async getTeamResults(): Promise<MatchResult[]> { return []; }
  async getLeagueResults(): Promise<MatchResult[]> { return []; }
  async getOdds(): Promise<null> { return null; }
}

interface Harness {
  url: string;
  close: () => Promise<void>;
  db: InstanceType<typeof DatabaseSync>;
  coins: CoinService;
  progression: ProgressionService;
  progressionStore: SqliteProgressionStore;
  competitions: SqliteCompetitionStore;
  competitionSvc: CompetitionService;
  rewards: CoinRewardService;
  proUsers: Set<string>;
}

async function startApp(): Promise<Harness> {
  const db = new DatabaseSync(':memory:');
  const competitions = new SqliteCompetitionStore(db);
  const progressionStore = new SqliteProgressionStore(db);
  const coinStore = new SqliteCoinStore(db);
  const proUsers = new Set([PRO]);
  const coins = new CoinService(coinStore);
  const progression = new ProgressionService(
    progressionStore,
    async (id) => proUsers.has(id),
    undefined,
    (ids) => coins.ownedCategoriesMany(ids),
  );
  const rewards = new CoinRewardService(coins, progressionStore);
  const names = new InMemoryDisplayNameDirectory();
  await names.set(PRO, 'Martin23');
  await names.set(FREE, 'Ingyenes1');
  await names.set(OTHER, 'Zsolti88');
  const competitionSvc = new CompetitionService(competitions, new StubProvider(), names, progression, undefined, rewards);

  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    res.locals.plan = { enforced: true, user: id ? { id, email: '' } : null, pro: !!id && proUsers.has(id), admin: false };
    next();
  });
  app.use('/api/profile', profileRouter(names, progression));
  app.use('/api/progression', progressionRouter(progression));
  app.use('/api/shop', shopRouter(coins));

  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    db, coins, progression, progressionStore, competitions, competitionSvc, rewards, proUsers,
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

/** Egyenleg + vásárlás a valódi úton. */
async function buy(user: string, ...keys: string[]) {
  const total = keys.reduce((s, k) => s + PRICE(k), 0);
  await h.coins.awardCoins({ userId: user, type: 'ADMIN_ADJUSTMENT', amount: total, sourceKey: `adj:${user}:${keys.join('-')}` });
  for (const k of keys) {
    const r = await call(h, 'POST', '/api/shop/purchase', user, { itemKey: k });
    expect(r.status, `vásárlás: ${k}`).toBe(201);
  }
}

const equip = (user: string, slot: string, itemKey: string | null) =>
  call(h, 'PUT', '/api/profile/customization', user, { slot, itemKey });

const settingsRow = (user: string) =>
  h.db.prepare('SELECT * FROM user_profile_settings WHERE user_id = ?').get(user) as any;

// ===========================================================================
// Séma (a 0012 megfelelője a helyi tárolóban)
// ===========================================================================

describe('Equip – tárolás', () => {
  it('F1. a hat shop-oszlop létezik, és NULL-lal indul', async () => {
    await h.progression.equipShopItem(FREE, 'frame', null); // sor létrehozása
    const row = settingsRow(FREE);
    for (const col of ['shop_frame_key', 'shop_name_color_key', 'shop_name_effect_key',
      'shop_title_key', 'shop_avatar_key', 'shop_profile_background_key']) {
      expect(row, col).toHaveProperty(col);
      expect(row[col], col).toBeNull();
    }
  });

  it('F2. a megszolgált mezők érintetlenek, ha csak shop-equip íródik', async () => {
    h.proUsers.add(FREE);
    await h.progression.saveSettings(FREE, { border: 'classic', title: 'tier_rookie', showcase: [], avatar: { ...DEFAULT_SETTINGS.avatar, hairColor: 'black' } });
    const before = settingsRow(FREE);
    h.proUsers.delete(FREE);

    await buy(FREE, 'frame_fire');
    await equip(FREE, 'frame', 'frame_fire');

    const after = settingsRow(FREE);
    expect(after.border_key, 'megszolgált keret').toBe(before.border_key);
    expect(after.title_key, 'megszolgált cím').toBe(before.title_key);
    expect(after.avatar, 'avatar-kompozíció').toBe(before.avatar);
    expect(after.showcase).toBe(before.showcase);
    expect(after.shop_frame_key).toBe('frame_fire');
  });
});

// ===========================================================================
// Birtoklás
// ===========================================================================

describe('Equip – birtoklás az authority', () => {
  it('F3. BIRTOKOLT item felvehető', async () => {
    await buy(FREE, 'frame_fire');
    const r = await equip(FREE, 'frame', 'frame_fire');
    expect(r.status).toBe(200);
    expect(r.body.shop.frame).toBe('frame_fire');
    expect(settingsRow(FREE).shop_frame_key).toBe('frame_fire');
  });

  it('F4. NEM birtokolt item elutasítva (403), és a profil nem változik', async () => {
    const r = await equip(FREE, 'frame', 'frame_fire');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('ITEM_NOT_OWNED');
    expect(settingsRow(FREE)).toBeUndefined();
  });

  it('F5. kitalált kulcs elutasítva, a profil nem változik', async () => {
    await buy(FREE, 'frame_fire');
    await equip(FREE, 'frame', 'frame_fire');
    for (const bad of ['sajat_legendary_frame', 'frame_animated_diamond']) {
      const r = await equip(FREE, 'frame', bad);
      expect(r.status, bad).toBe(403);
    }
    expect(settingsRow(FREE).shop_frame_key, 'a korábbi felvétel megmaradt').toBe('frame_fire');
  });

  it('F6. alaki szemét elutasítva (400)', async () => {
    for (const bad of ['', 'ab', 'BAD KEY', "f'; drop table user_profile_settings; --", 'a'.repeat(65), 42, {}]) {
      const r = await equip(FREE, 'frame', bad as never);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.code).toBe('INVALID_ITEM_KEY');
    }
  });

  it('F7. MÁS felhasználó itemje nem vehető fel', async () => {
    await buy(OTHER, 'frame_fire');
    const r = await equip(FREE, 'frame', 'frame_fire');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('ITEM_NOT_OWNED');
    expect(settingsRow(FREE)).toBeUndefined();
  });
});

// ===========================================================================
// Slot / kategória – teljes 6×6 keresztpróba
// ===========================================================================

describe('Equip – slot és kategória', () => {
  it('F8. érvénytelen slot elutasítva (400)', async () => {
    await buy(FREE, 'frame_fire');
    for (const slot of ['background', 'border', 'Frame', '', 'showcase', 42, null]) {
      const r = await equip(FREE, slot as never, 'frame_fire');
      expect(r.status, String(slot)).toBe(400);
      expect(r.body.code).toBe('INVALID_SLOT');
    }
  });

  it('F9. TELJES 6×6 keresztpróba: csak az egyező kategória/slot páros megy át', async () => {
    const samples = SHOP_CATEGORIES.map((c) => SHOP_SEED.find((i) => i.category === c)!);
    await buy(FREE, ...samples.map((i) => i.itemKey));

    for (const item of samples) {
      for (const slot of PROFILE_SLOTS) {
        const r = await equip(FREE, slot, item.itemKey);
        const shouldPass = CATEGORY_TO_SLOT[item.category] === slot;
        expect(r.status, `${item.itemKey} → ${slot}`).toBe(shouldPass ? 200 : 422);
        if (!shouldPass) expect(r.body.code).toBe('SLOT_CATEGORY_MISMATCH');
      }
    }
    // a végállapot: minden item a saját slotjában
    const row = settingsRow(FREE);
    expect(row.shop_frame_key).toBe(samples.find((i) => i.category === 'frame')!.itemKey);
    expect(row.shop_title_key).toBe(samples.find((i) => i.category === 'title')!.itemKey);
    expect(row.shop_profile_background_key).toBe(samples.find((i) => i.category === 'profile_background')!.itemKey);
  });

  it('F10. címet nem lehet keret-slotba, keretet cím-slotba', async () => {
    await buy(FREE, 'title_predictor', 'frame_fire');
    expect((await equip(FREE, 'frame', 'title_predictor')).status).toBe(422);
    expect((await equip(FREE, 'title', 'frame_fire')).status).toBe(422);
    const row = settingsRow(FREE);
    expect(row).toBeUndefined();
  });

  it('F11. a kliens által küldött kategória/ritkaság/ár hatástalan', async () => {
    await buy(FREE, 'title_predictor');
    const r = await call(h, 'PUT', '/api/profile/customization', FREE, {
      slot: 'frame', itemKey: 'title_predictor',
      category: 'frame', rarity: 'legendary', priceCoins: 0, metadata: { color: '#fff' }, name: 'Hamis',
    });
    expect(r.status, 'a kategória a KÉSZLETBŐL jön').toBe(422);
  });
});

// ===========================================================================
// Levétel
// ===========================================================================

describe('Equip – levétel', () => {
  it('F12. `itemKey: null` leveszi, a készlet megmarad', async () => {
    await buy(FREE, 'frame_fire');
    await equip(FREE, 'frame', 'frame_fire');
    const r = await equip(FREE, 'frame', null);
    expect(r.status).toBe(200);
    expect(r.body.shop.frame).toBeNull();
    expect(settingsRow(FREE).shop_frame_key).toBeNull();
    // a készlet és az egyenleg érintetlen
    const inv = await call(h, 'GET', '/api/shop/inventory', FREE);
    expect(inv.body.items).toHaveLength(1);
  });

  it('F13. a levétel nem ad és nem von le coint, és nem naplóz', async () => {
    await buy(FREE, 'frame_fire');
    await equip(FREE, 'frame', 'frame_fire');
    const balance = (await h.coins.getBalance(FREE)).balance;
    const txCount = (await h.coins.getHistory(FREE, { limit: 100 })).transactions.length;

    await equip(FREE, 'frame', null);
    await equip(FREE, 'frame', 'frame_fire');
    await equip(FREE, 'frame', null);

    expect((await h.coins.getBalance(FREE)).balance).toBe(balance);
    expect((await h.coins.getHistory(FREE, { limit: 100 })).transactions).toHaveLength(txCount);
  });

  it('F14. a levétel csak a kért slotot érinti', async () => {
    await buy(FREE, 'frame_fire', 'name_gold');
    await equip(FREE, 'frame', 'frame_fire');
    await equip(FREE, 'nameColor', 'name_gold');
    await equip(FREE, 'frame', null);
    const row = settingsRow(FREE);
    expect(row.shop_frame_key).toBeNull();
    expect(row.shop_name_color_key).toBe('name_gold');
  });
});

// ===========================================================================
// Vásárlás ≠ felvétel
// ===========================================================================

describe('Equip – a vásárlás és a felvétel KÜLÖN művelet', () => {
  it('F15. a vásárlás az egyenleget és a készletet módosítja, a profilt NEM', async () => {
    await h.coins.awardCoins({ userId: FREE, type: 'ADMIN_ADJUSTMENT', amount: 5000, sourceKey: 'adj:f15' });
    const r = await call(h, 'POST', '/api/shop/purchase', FREE, { itemKey: 'frame_fire' });
    expect(r.status).toBe(201);
    expect((await h.coins.getBalance(FREE)).balance).toBe(5000 - PRICE('frame_fire'));
    expect((await h.coins.ownedItemKeys(FREE)).size).toBe(1);
    expect(settingsRow(FREE), 'a profil még nem változott').toBeUndefined();
  });

  it('F16. a felvétel CSAK a profilt módosítja', async () => {
    await buy(FREE, 'frame_fire');
    const balance = (await h.coins.getBalance(FREE)).balance;
    const inv = (await h.coins.ownedItemKeys(FREE)).size;
    const txCount = (await h.coins.getHistory(FREE, { limit: 100 })).transactions.length;

    await equip(FREE, 'frame', 'frame_fire');

    expect((await h.coins.getBalance(FREE)).balance, 'coin nem változott').toBe(balance);
    expect((await h.coins.ownedItemKeys(FREE)).size, 'készlet nem változott').toBe(inv);
    expect((await h.coins.getHistory(FREE, { limit: 100 })).transactions, 'nincs új tranzakció').toHaveLength(txCount);
    expect(settingsRow(FREE).shop_frame_key).toBe('frame_fire');
  });

  it('F17. elutasított felvétel után SEMMI nem változik', async () => {
    await h.coins.awardCoins({ userId: FREE, type: 'ADMIN_ADJUSTMENT', amount: 5000, sourceKey: 'adj:f17' });
    const r = await equip(FREE, 'frame', 'frame_dragon');
    expect(r.status).toBe(403);
    expect((await h.coins.getBalance(FREE)).balance).toBe(5000);
    expect((await h.coins.ownedItemKeys(FREE)).size).toBe(0);
    expect(settingsRow(FREE)).toBeUndefined();
  });
});

// ===========================================================================
// Shop cím ≠ megszolgált cím, shop keret ≠ megszolgált border
// ===========================================================================

describe('Equip – a két rendszer külön', () => {
  it('F18. shop GOAT cím: `shop_title_key` változik, a `title_key` NEM', async () => {
    h.proUsers.add(FREE);
    await h.progression.saveSettings(FREE, { border: 'classic', title: 'tier_rookie', showcase: [], avatar: DEFAULT_SETTINGS.avatar });
    h.proUsers.delete(FREE);

    await buy(FREE, 'title_goat');
    expect((await h.coins.ownedItemKeys(FREE)).has('title_goat')).toBe(true);
    const r = await equip(FREE, 'title', 'title_goat');
    expect(r.status).toBe(200);

    const row = settingsRow(FREE);
    expect(row.shop_title_key).toBe('title_goat');
    expect(row.title_key, 'a megszolgált cím változatlan').toBe('tier_rookie');
  });

  it('F19. a shop GOAT nem ad achievementet, XP-t, PRO státuszt és versenypontot', async () => {
    await buy(FREE, 'title_goat');
    await equip(FREE, 'title', 'title_goat');
    expect(await h.progressionStore.totalXp(FREE), 'nincs XP').toBe(0);
    expect(await h.progressionStore.listAchievements(FREE), 'nincs achievement').toEqual([]);
    const me = await call(h, 'GET', '/api/progression/me', FREE);
    expect(me.body.pro, 'nem lett PRO').toBe(false);
    expect(me.body.xp).toBe(0);
  });

  it('F20. shop keret: `shop_frame_key` változik, a `border_key` NEM', async () => {
    h.proUsers.add(FREE);
    await h.progression.saveSettings(FREE, { border: 'classic', title: 'none', showcase: [], avatar: DEFAULT_SETTINGS.avatar });
    h.proUsers.delete(FREE);

    await buy(FREE, 'frame_fire');
    await equip(FREE, 'frame', 'frame_fire');

    const row = settingsRow(FREE);
    expect(row.shop_frame_key).toBe('frame_fire');
    expect(row.border_key, 'a megszolgált keret változatlan').toBe('classic');
  });

  it('F21. a megszolgált testreszabás NEM írja felül a shop-equipeket', async () => {
    await buy(PRO, 'frame_fire', 'bg_galaxy');
    await equip(PRO, 'frame', 'frame_fire');
    await equip(PRO, 'profileBackground', 'bg_galaxy');

    await h.progression.saveSettings(PRO, { border: 'classic', title: 'none', showcase: [], avatar: DEFAULT_SETTINGS.avatar });

    const row = settingsRow(PRO);
    expect(row.shop_frame_key).toBe('frame_fire');
    expect(row.shop_profile_background_key).toBe('bg_galaxy');
  });

  it('F22. a shop item NEM kerülhet a megszolgált slotba a `/progression/settings`-en', async () => {
    await buy(PRO, 'frame_fire', 'title_goat');
    const r = await call(h, 'PUT', '/api/progression/settings', PRO, { border: 'frame_fire', title: 'title_goat' });
    expect(r.status).toBe(200);
    expect(r.body.settings.border).toBe(DEFAULT_SETTINGS.border);
    expect(r.body.settings.title).toBe(DEFAULT_SETTINGS.title);
    expect(r.body.rejected).toContain('border:frame_fire');
    expect(r.body.rejected).toContain('title:title_goat');
  });
});

// ===========================================================================
// Profil-háttér ≠ avatar háttér
// ===========================================================================

describe('Equip – profil-háttér és avatar háttér szétválasztása', () => {
  it('F23. a profil-háttér felvétele NEM írja át az avatar hátterét', async () => {
    h.proUsers.add(FREE);
    await h.progression.saveSettings(FREE, { border: 'classic', title: 'none', showcase: [], avatar: { ...DEFAULT_SETTINGS.avatar, background: 'solid' } });
    h.proUsers.delete(FREE);

    await buy(FREE, 'bg_galaxy');
    await equip(FREE, 'profileBackground', 'bg_galaxy');

    const row = settingsRow(FREE);
    expect(row.shop_profile_background_key).toBe('bg_galaxy');
    expect(JSON.parse(row.avatar).background, 'az avatar háttere változatlan').toBe('solid');
  });

  it('F24. az avatar hátterének módosítása NEM írja át a profil-hátteret', async () => {
    await buy(PRO, 'bg_galaxy');
    await equip(PRO, 'profileBackground', 'bg_galaxy');

    // `rays` szint 5-től; adunk hozzá elég XP-t a feloldáshoz
    await h.progressionStore.claimEvent(PRO, 'prediction', 'xp-boost', 2000);
    const r = await call(h, 'PUT', '/api/progression/settings', PRO, {
      border: 'classic', title: 'none', avatar: { ...DEFAULT_SETTINGS.avatar, background: 'rays' },
    });
    expect(r.status).toBe(200);
    expect(r.body.settings.avatar.background).toBe('rays');

    const row = settingsRow(PRO);
    expect(row.shop_profile_background_key, 'a profil-háttér változatlan').toBe('bg_galaxy');
    expect(JSON.parse(row.avatar).background).toBe('rays');
  });

  it('F25. a kettő egyszerre is létezhet, egymástól függetlenül', async () => {
    await buy(PRO, 'bg_fire');
    await equip(PRO, 'profileBackground', 'bg_fire');
    const me = await call(h, 'GET', '/api/progression/me', PRO);
    expect(me.body.shop.profileBackground).toBe('bg_fire');
    expect(me.body.settings.avatar.background).toBe('solid');
  });
});

// ===========================================================================
// Avatar
// ===========================================================================

describe('Equip – shop avatar', () => {
  it('F26. shop avatar felvehető, és nem bántja az avatar-kompozíciót', async () => {
    await buy(FREE, 'avatar_brain');
    const r = await equip(FREE, 'avatar', 'avatar_brain');
    expect(r.status).toBe(200);
    expect(r.body.shop.avatar).toBe('avatar_brain');
    const row = settingsRow(FREE);
    // az avatar jsonb a megszolgált kompozíció marad (üres / alapértelmezett)
    expect(row.shop_avatar_key).toBe('avatar_brain');
    expect(JSON.parse(row.avatar)).toEqual({});
  });

  it('F27. a shop avatar lecserélhető egy másikra (slotonként egy)', async () => {
    await buy(FREE, 'avatar_brain', 'avatar_goat');
    await equip(FREE, 'avatar', 'avatar_brain');
    await equip(FREE, 'avatar', 'avatar_goat');
    expect(settingsRow(FREE).shop_avatar_key).toBe('avatar_goat');
  });

  it('F28. levétel után az avatar-kompozíció a megszolgált alapértelmezésre esik vissza', async () => {
    await buy(FREE, 'avatar_brain');
    await equip(FREE, 'avatar', 'avatar_brain');
    await equip(FREE, 'avatar', null);
    expect(settingsRow(FREE).shop_avatar_key).toBeNull();
    const me = await call(h, 'GET', '/api/progression/me', FREE);
    expect(me.body.shop.avatar).toBeNull();
    expect(me.body.settings.avatar.accessory, 'a megszolgált kiegészítő változatlan').toBe(DEFAULT_SETTINGS.avatar.accessory);
  });

  it('F29. a MEGSZOLGÁLT avatar-kiegészítő továbbra is működik, shop item nélkül', async () => {
    await h.progressionStore.unlockAchievement(PRO, 'sharpshooter');
    const r = await call(h, 'PUT', '/api/progression/settings', PRO, {
      border: 'classic', title: 'none', avatar: { ...DEFAULT_SETTINGS.avatar, accessory: 'shades' },
    });
    expect(r.status).toBe(200);
    expect(r.body.settings.avatar.accessory).toBe('shades');
  });
});

// ===========================================================================
// FREE felhasználó teljes folyama
// ===========================================================================

describe('Equip – FREE felhasználó teljes folyama', () => {
  it('F30. FREE: coin → vásárlás → készlet → felvétel → profil → ranglista', async () => {
    // 1) coin reward a valódi hookon
    await h.rewards.onPredictionSubmitted(FREE, 'pred-free-1');
    await h.coins.awardReward(FREE, 'COMPETITION_FIRST', 'competition:cfree:competition_first');
    const earned = COIN_REWARDS.PREDICTION_SUBMITTED + COIN_REWARDS.COMPETITION_FIRST;
    expect((await h.coins.getBalance(FREE)).balance).toBe(earned);

    // 2) vásárlás – a megszerzett 1510 coinból a 1500-as arany névszín fér bele
    expect(earned).toBeGreaterThanOrEqual(PRICE('name_gold'));
    const buyRes = await call(h, 'POST', '/api/shop/purchase', FREE, { itemKey: 'name_gold' });
    expect(buyRes.status).toBe(201);
    expect(buyRes.body.paidCoins).toBe(PRICE('name_gold'));

    // 3) készlet
    const inv = await call(h, 'GET', '/api/shop/inventory', FREE);
    expect(inv.body.items.map((i: any) => i.item.itemKey)).toEqual(['name_gold']);

    // 4) felvétel
    const eq = await equip(FREE, 'nameColor', 'name_gold');
    expect(eq.status, 'FREE felhasználó is felveheti').toBe(200);

    // 5) profil-válasz
    const me = await call(h, 'GET', '/api/progression/me', FREE);
    expect(me.body.pro).toBe(false);
    expect(me.body.shop.nameColor).toBe('name_gold');
    const custom = await call(h, 'GET', '/api/profile/customization', FREE);
    expect(custom.body.shop.nameColor).toBe('name_gold');

    // 6) ranglista-profil
    const profiles = await h.progression.publicProfiles([FREE]);
    expect(profiles.get(FREE)!.shop?.nameColor).toBe('name_gold');
  });

  it('F31. FREE felhasználó NEM kerülheti meg a megszolgált PRO-kaput', async () => {
    const r = await call(h, 'PUT', '/api/progression/settings', FREE, { border: 'legend', title: 'tier_legend' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PRO_REQUIRED');
    expect(settingsRow(FREE)).toBeUndefined();
  });

  it('F32. FREE ranglista-profilja a MEGSZOLGÁLT mezőkben alapértelmezett marad', async () => {
    await buy(FREE, 'frame_fire');
    await equip(FREE, 'frame', 'frame_fire');
    const p = (await h.progression.publicProfiles([FREE])).get(FREE)!;
    expect(p.borderKey, 'megszolgált keret: alapértelmezés').toBe(DEFAULT_SETTINGS.border);
    expect(p.titleKey, 'megszolgált cím: alapértelmezés').toBe(DEFAULT_SETTINGS.title);
    expect(p.avatar).toEqual(DEFAULT_SETTINGS.avatar);
    expect(p.shop?.frame, 'a shop-réteg viszont látszik').toBe('frame_fire');
  });

  it('F33. a nem birtokolt kulcs nem jelenik meg a ranglista shop-rétegében', async () => {
    await buy(FREE, 'frame_fire');
    await equip(FREE, 'frame', 'frame_fire');
    // a készlet-rekord eltűnik (pl. adminisztratív korrekció) → a réteg sem mutatja
    h.db.prepare('DELETE FROM user_shop_items WHERE user_id = ?').run(FREE);
    const p = (await h.progression.publicProfiles([FREE])).get(FREE)!;
    expect(p.shop).toBeUndefined();
    // és a saját profil-olvasás sem
    expect((await h.progression.shopCustomization(FREE)).frame).toBeNull();
  });
});

// ===========================================================================
// Ranglista
// ===========================================================================

describe('Equip – ranglista', () => {
  it('F34. a PRO megszolgált ÉS shop kozmetikuma egyszerre látszik', async () => {
    await h.progression.saveSettings(PRO, { border: 'classic', title: 'none', showcase: [], avatar: DEFAULT_SETTINGS.avatar });
    await buy(PRO, 'frame_fire', 'title_goat');
    await equip(PRO, 'frame', 'frame_fire');
    await equip(PRO, 'title', 'title_goat');

    const p = (await h.progression.publicProfiles([PRO])).get(PRO)!;
    expect(p.borderKey, 'megszolgált').toBe('classic');
    expect(p.shop?.frame, 'shop').toBe('frame_fire');
    expect(p.shop?.title).toBe('title_goat');
  });

  it('F35. a korábbi ranglista-válaszalak változatlan: `shop` csak akkor van, ha van mit mutatni', async () => {
    const p = (await h.progression.publicProfiles([OTHER])).get(OTHER)!;
    expect(p).toEqual({ avatar: DEFAULT_SETTINGS.avatar, borderKey: DEFAULT_SETTINGS.border, titleKey: DEFAULT_SETTINGS.title });
    expect('shop' in p).toBe(false);
  });

  it('F36. a ranglista nem fed fel idegen shop-kozmetikumot', async () => {
    await buy(PRO, 'frame_fire');
    await equip(PRO, 'frame', 'frame_fire');
    const map = await h.progression.publicProfiles([PRO, FREE, OTHER]);
    expect(map.get(PRO)!.shop?.frame).toBe('frame_fire');
    expect(map.get(FREE)!.shop).toBeUndefined();
    expect(map.get(OTHER)!.shop).toBeUndefined();
  });

  it('F37. a ranglista-sorrend és a pontszám változatlan a shop-kozmetikumtól', async () => {
    const c = await h.competitions.createCompetition({
      name: 'Sorrend', leagueKey: 'eng-pl', leagueName: 'eng-pl', provider: 'teszt',
      startsAt: new Date(Date.now() - 200 * 3600_000).toISOString(),
      endsAt: new Date(Date.now() - 100 * 3600_000).toISOString(), status: 'active',
    });
    await h.competitions.upsertMatches(c.id, [{
      externalMatchId: 'r1', homeTeam: 'H', awayTeam: 'A',
      kickoff: new Date(Date.now() - 150 * 3600_000).toISOString(),
      homeScore: 2, awayScore: 1, status: 'finished',
    }]);
    const [m] = await h.competitions.listMatches(c.id);
    await h.competitions.upsertPrediction(PRO, m.id, 2, 1);   // 5 pont
    await h.competitions.upsertPrediction(FREE, m.id, 3, 1);  // 3 pont
    await h.competitionSvc.settle(c.id);

    await buy(FREE, 'frame_animated_diamond');
    await equip(FREE, 'frame', 'frame_animated_diamond');

    const rows = await h.competitionSvc.leaderboard(c.id, null);
    expect(rows[0].points).toBe(5);
    expect(rows[1].points).toBe(3);
    expect(rows[0].displayName).toBe('Martin23');
  });
});

// ===========================================================================
// Biztonság
// ===========================================================================

describe('Equip – biztonság', () => {
  it('F38. hitelesítés nélkül 401', async () => {
    const put = await call(h, 'PUT', '/api/profile/customization', undefined, { slot: 'frame', itemKey: 'frame_fire' });
    expect(put.status).toBe(401);
    const get = await call(h, 'GET', '/api/profile/customization');
    expect(get.status).toBe(401);
  });

  it('F39. a kérésben küldött userId / targetUserId / ownerId / recipient hatástalan', async () => {
    await buy(FREE, 'frame_fire');
    await buy(OTHER, 'name_gold');
    const r = await call(h, 'PUT', '/api/profile/customization', FREE, {
      slot: 'frame', itemKey: 'frame_fire',
      userId: OTHER, user_id: OTHER, targetUserId: OTHER, ownerId: OTHER, recipient: OTHER,
    });
    expect(r.status).toBe(200);
    expect(settingsRow(FREE).shop_frame_key).toBe('frame_fire');
    expect(settingsRow(OTHER), 'a másik profil nem jött létre').toBeUndefined();
  });

  it('F40. MÁS felhasználó felvételét nem lehet lekérni', async () => {
    await buy(OTHER, 'frame_fire');
    await equip(OTHER, 'frame', 'frame_fire');
    for (const qs of ['?userId=' + OTHER, '?targetUserId=' + OTHER, '?ownerId=' + OTHER]) {
      const r = await call(h, 'GET', `/api/profile/customization${qs}`, FREE);
      expect(r.body.shop, qs).toEqual({ ...EMPTY_EQUIPS });
    }
  });

  it('F41. a slot nem választható szabadon a kategóriához', async () => {
    const samples = SHOP_CATEGORIES.map((c) => SHOP_SEED.find((i) => i.category === c)!);
    await buy(FREE, ...samples.map((i) => i.itemKey));
    let mismatches = 0;
    for (const item of samples) {
      for (const slot of PROFILE_SLOTS) {
        if (CATEGORY_TO_SLOT[item.category] === slot) continue;
        const r = await equip(FREE, slot, item.itemKey);
        expect(r.status).toBe(422);
        mismatches++;
      }
    }
    expect(mismatches, '6 kategória × 5 rossz slot').toBe(30);
  });

  it('F42. a felvétel nem hoz létre coin-tranzakciót semmilyen esetben', async () => {
    await buy(FREE, 'frame_fire');
    const before = (await h.coins.getHistory(FREE, { limit: 100 })).transactions.length;
    await equip(FREE, 'frame', 'frame_fire');
    await equip(FREE, 'frame', null);
    await equip(FREE, 'title', 'frame_fire');          // elutasított
    await equip(FREE, 'frame', 'frame_animated_diamond'); // nem birtokolt
    expect((await h.coins.getHistory(FREE, { limit: 100 })).transactions).toHaveLength(before);
  });
});
