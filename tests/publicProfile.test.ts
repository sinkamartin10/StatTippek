/**
 * NYILVÁNOS játékosprofil – `GET /api/profile/public/:displayName`.
 *
 * Valódi Express alkalmazás a VALÓDI `profileRouter` útvonallal, valódi
 * `ProgressionService`, `CompetitionService`, `CoinService` és valódi
 * `Sqlite*Store` tárolókkal. Az egyetlen szimulált elem a `res.locals.plan` –
 * ugyanaz a minta, mint a meglévő progression/competition/shop teszteknél.
 *
 * A hangsúly két dolgon van:
 *   1. ADATVÉDELEM – ami nem nyilvános, az semmilyen úton nem jut ki,
 *   2. EGYETLEN IGAZSÁG – a nyilvános profil ugyanazt mutatja, amit a
 *      meglévő progression-számítás, nem egy második, párhuzamos logikát.
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
import { shopRouter } from '../src/server/routes/coins';
import { InMemoryDisplayNameDirectory } from '../src/server/profile/displayNameDirectory';
import { SHOP_SEED } from '../src/shared/shop';
import { ACHIEVEMENTS, DEFAULT_SETTINGS, computeTipsterStats, levelFromXp } from '../src/shared/progression';
import {
  PUBLIC_COMPETITION_LIMIT, buildHighlights, ratio, toPublicProfile,
  type PublicProfileResponse, type PublicStatistics,
} from '../src/shared/publicProfile';
import { DISPLAY_NAME_MAX, isLookupSafeDisplayName } from '../src/shared/displayName';
import type { MatchDataProvider } from '../src/server/data/provider';
import type { League, Match, MatchResult, Team } from '../src/shared/types';

const PRO = '11111111-1111-1111-1111-111111111111';
const FREE = '33333333-3333-3333-3333-333333333333';
const OTHER = '22222222-2222-2222-2222-222222222222';
const PRO_NAME = 'Martin23';
const FREE_NAME = 'Ingyenes1';
const OTHER_NAME = 'Zsolti88';
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
  names: InMemoryDisplayNameDirectory;
  proUsers: Set<string>;
  /** tárolóhívások számlálója – az N+1 kimutatásához */
  calls: Map<string, number>;
}

/** Számláló burkoló: minden tárolóhívást megjegyez, de semmit nem változtat. */
function counting<T extends object>(target: T, calls: Map<string, number>): T {
  return new Proxy(target, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        const key = String(prop);
        calls.set(key, (calls.get(key) ?? 0) + 1);
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

async function startApp(): Promise<Harness> {
  const db = new DatabaseSync(':memory:');
  const competitions = new SqliteCompetitionStore(db);
  const realProgressionStore = new SqliteProgressionStore(db);
  const coinStore = new SqliteCoinStore(db);
  const proUsers = new Set([PRO]);
  const calls = new Map<string, number>();
  const progressionStore = counting(realProgressionStore, calls);
  const coins = new CoinService(coinStore);
  const progression = new ProgressionService(
    progressionStore,
    async (id) => proUsers.has(id),
    undefined,
    (ids) => coins.ownedCategoriesMany(ids),
  );
  const rewards = new CoinRewardService(coins, progressionStore);
  const names = new InMemoryDisplayNameDirectory();
  await names.set(PRO, PRO_NAME);
  await names.set(FREE, FREE_NAME);
  await names.set(OTHER, OTHER_NAME);
  const competitionSvc = new CompetitionService(competitions, new StubProvider(), names, progression, undefined, rewards);

  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    res.locals.plan = { enforced: true, user: id ? { id, email: 'titok@pelda.hu' } : null, pro: !!id && proUsers.has(id), admin: false };
    next();
  });
  app.use('/api/profile', profileRouter(names, progression));
  app.use('/api/shop', shopRouter(coins));

  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    db, coins, progression, progressionStore: realProgressionStore, competitions, competitionSvc, names, proUsers, calls,
  };
}

async function call(method: string, path: string, user?: string, body?: unknown) {
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

/** A nyilvános profil lekérése név alapján (hitelesítés nélkül, ha nincs user). */
const getPublic = (name: string, user?: string) =>
  call('GET', `/api/profile/public/${encodeURIComponent(name)}`, user);

let h: Harness;
beforeEach(async () => { h = await startApp(); });
afterEach(async () => { await h.close(); });

// ---------------------------------------------------------------------------
// Adat-vetés
// ---------------------------------------------------------------------------

let seq = 0;

/** Egy verseny egy lezárt mérkőzéssel, tippekkel és kiértékeléssel. */
async function seedCompetition(opts: {
  name: string;
  hoursAgo: number;
  actual: [number, number];
  picks: { user: string; home: number; away: number }[];
  finish?: boolean;
}) {
  const n = ++seq;
  const c = await h.competitions.createCompetition({
    name: opts.name, leagueKey: 'eng-pl', leagueName: 'Premier League', provider: 'teszt',
    startsAt: new Date(Date.now() - (opts.hoursAgo + 60) * 3600_000).toISOString(),
    endsAt: new Date(Date.now() - opts.hoursAgo * 3600_000).toISOString(), status: 'active',
  });
  await h.competitions.upsertMatches(c.id, [{
    externalMatchId: `m-${n}`, homeTeam: 'Hazai', awayTeam: 'Vendég',
    kickoff: new Date(Date.now() - (opts.hoursAgo + 10) * 3600_000).toISOString(),
    homeScore: opts.actual[0], awayScore: opts.actual[1], status: 'finished',
  }]);
  const [m] = await h.competitions.listMatches(c.id);
  for (const p of opts.picks) await h.competitions.upsertPrediction(p.user, m.id, p.home, p.away);
  await h.competitionSvc.settle(c.id);
  if (opts.finish) await h.competitionSvc.finish(c.id);
  return c;
}

/** Egy verseny MÉG LE NEM JÁTSZOTT mérkőzéssel – „függőben” tipphez. */
async function seedPending(user: string, name = 'Függőben') {
  const n = ++seq;
  const c = await h.competitions.createCompetition({
    name, leagueKey: 'esp-ll', leagueName: 'La Liga', provider: 'teszt',
    startsAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    endsAt: new Date(Date.now() + 48 * 3600_000).toISOString(), status: 'active',
  });
  await h.competitions.upsertMatches(c.id, [{
    externalMatchId: `p-${n}`, homeTeam: 'Jövő', awayTeam: 'Ellen',
    kickoff: new Date(Date.now() + 24 * 3600_000).toISOString(),
    homeScore: null, awayScore: null, status: 'scheduled',
  }]);
  const [m] = await h.competitions.listMatches(c.id);
  await h.competitions.upsertPrediction(user, m.id, 1, 0);
  return c;
}

/** Vásárlás a valódi úton (coin jóváírás + HTTP vásárlás). */
async function buy(user: string, ...keys: string[]) {
  const total = keys.reduce((s, k) => s + PRICE(k), 0);
  await h.coins.awardCoins({ userId: user, type: 'ADMIN_ADJUSTMENT', amount: total, sourceKey: `adj:${user}:${keys.join('-')}` });
  for (const k of keys) {
    const r = await call('POST', '/api/shop/purchase', user, { itemKey: k });
    expect(r.status, `vásárlás: ${k}`).toBe(201);
  }
}

/** Egy „élettel teli” PRO profil: 3 verseny, pontos találat, sorozat, helyezés. */
async function seedRichPro() {
  await seedCompetition({ name: 'Régi kupa', hoursAgo: 300, actual: [2, 1], picks: [{ user: PRO, home: 2, away: 1 }, { user: OTHER, home: 0, away: 3 }] });
  await seedCompetition({ name: 'Középső kupa', hoursAgo: 200, actual: [1, 0], picks: [{ user: PRO, home: 3, away: 1 }, { user: OTHER, home: 1, away: 0 }] });
  await seedCompetition({ name: 'Friss kupa', hoursAgo: 100, actual: [0, 0], picks: [{ user: PRO, home: 0, away: 0 }, { user: OTHER, home: 2, away: 2 }], finish: true });
  await h.progression.syncUser(PRO);
}

// ---------------------------------------------------------------------------
// Segédek a vizsgálathoz
// ---------------------------------------------------------------------------

/** Minden kulcs a válaszfában (mélyen). */
function deepKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) { for (const x of v) deepKeys(x, out); return out; }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) { out.add(k); deepKeys(val, out); }
  }
  return out;
}

/** Minden szám a válaszfában – a NaN/Infinity kereséshez. */
function deepNumbers(v: unknown, out: number[] = []): number[] {
  if (typeof v === 'number') out.push(v);
  else if (Array.isArray(v)) for (const x of v) deepNumbers(x, out);
  else if (v && typeof v === 'object') for (const val of Object.values(v)) deepNumbers(val, out);
  return out;
}

/** Olyan kulcsok, amelyek SOHA nem szerepelhetnek nyilvános válaszban. */
const FORBIDDEN_KEYS = [
  'userId', 'user_id', 'uid', 'authId', 'auth_id',
  'email', 'emailAddress', 'password', 'token', 'accessToken', 'refreshToken',
  'coins', 'coinBalance', 'balance', 'paidCoins', 'paid_coins', 'transactions', 'coinTransactions',
  'purchases', 'purchaseHistory', 'inventory', 'ownedItems', 'priceCoins', 'price',
  'stripeCustomerId', 'stripe_customer_id', 'subscription', 'subscriptionStatus', 'plan', 'pro',
  'settings', 'profileSettings', 'showcase', 'ip', 'ipAddress',
  'trend', 'leagues', 'predictionId', 'homeTeam', 'awayTeam', 'kickoff',
  'predictedHome', 'predictedAway', 'submittedAt',
];

// ===========================================================================
// 1) Névfeloldás
// ===========================================================================

describe('Nyilvános profil – névfeloldás', () => {
  it('P1. létező játékos 200-cal és a TÁROLT írásmóddal válaszol', async () => {
    const r = await getPublic(PRO_NAME);
    expect(r.status).toBe(200);
    expect(r.body.displayName).toBe(PRO_NAME);
  });

  it('P2. a név kis-nagybetűtől független', async () => {
    for (const variant of ['martin23', 'MARTIN23', 'mArTiN23']) {
      const r = await getPublic(variant);
      expect(r.status, variant).toBe(200);
      expect(r.body.displayName, variant).toBe(PRO_NAME);
    }
  });

  it('P3. ismeretlen játékos 404 PLAYER_NOT_FOUND', async () => {
    const r = await getPublic('NincsIlyen99');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('PLAYER_NOT_FOUND');
  });

  it('P4. a 404 üzenet NEM árulja el, hogy a név alakilag hibás vagy nem létező', async () => {
    const unknown = await getPublic('NincsIlyen99');
    const invalid = await getPublic('a');
    expect(invalid.status).toBe(404);
    expect(invalid.body.error).toBe(unknown.body.error);
    expect(invalid.body.code).toBe(unknown.body.code);
  });

  it('P5. túl rövid név 404 (nem 500)', async () => {
    const r = await getPublic('ab');
    expect(r.status).toBe(404);
  });

  it('P6. túl hosszú név 404', async () => {
    const r = await getPublic('x'.repeat(DISPLAY_NAME_MAX + 5));
    expect(r.status).toBe(404);
  });

  it('P7. SQL-injekciós próbálkozás 404, és a tár érintetlen', async () => {
    const payloads = [
      "' OR 1=1 --", "Martin23'; DROP TABLE profiles; --", 'Martin23" OR "1"="1',
      'Martin23; SELECT * FROM user_coins', "1' UNION SELECT display_name FROM profiles --",
    ];
    for (const p of payloads) {
      const r = await getPublic(p);
      expect(r.status, p).toBe(404);
      expect(r.raw, p).not.toContain('SQL');
      expect(r.raw, p).not.toContain('syntax');
    }
    expect(await h.names.get(PRO)).toBe(PRO_NAME);
  });

  it('P8. LIKE-minta nem szivárog ki: a `%` nem ad találatot', async () => {
    for (const p of ['%', 'Mar%', '%artin23', '%%%']) {
      const r = await getPublic(p);
      expect(r.status, p).toBe(404);
    }
  });

  it('P9. az `_` LIKE-joker sem ad idegen találatot', async () => {
    // `Martin2_` LIKE-ként megfogná a Martin23-at – a szerver pontos egyezést követel
    const r = await getPublic('Martin2_');
    expect(r.status).toBe(404);
  });

  it('P10. a láthatatlan karakterekkel „feldíszített” név is feloldódik', async () => {
    const r = await getPublic('Martin23​');
    expect(r.status).toBe(200);
    expect(r.body.displayName).toBe(PRO_NAME);
  });

  it('P11. szóközt, pontot és kötőjelet tartalmazó név feloldható', async () => {
    await h.names.set(OTHER, 'Nagy Pal.jr-1');
    const r = await getPublic('Nagy Pal.jr-1');
    expect(r.status).toBe(200);
    expect(r.body.displayName).toBe('Nagy Pal.jr-1');
  });

  it('P12. az `isLookupSafeDisplayName` a tiltólistát NEM alkalmazza (régi nevek megtalálhatók)', () => {
    expect(isLookupSafeDisplayName('Martin23')).toBe(true);
    expect(isLookupSafeDisplayName('%')).toBe(false);
    expect(isLookupSafeDisplayName('ab')).toBe(false);
    expect(isLookupSafeDisplayName('x'.repeat(DISPLAY_NAME_MAX + 1))).toBe(false);
  });

  it('P13. a név nélküli felhasználó nem elérhető', async () => {
    const r = await getPublic('Senki1234');
    expect(r.status).toBe(404);
  });

  it('P14. a visszirányú keresés a tárolóban is pontos egyezést ad', async () => {
    expect((await h.names.findByName('MARTIN23'))?.userId).toBe(PRO);
    expect(await h.names.findByName('Martin2_')).toBeNull();
    expect(await h.names.findByName('%')).toBeNull();
  });
});

// ===========================================================================
// 2) Adatvédelem
// ===========================================================================

describe('Nyilvános profil – adatvédelem', () => {
  it('P15. a válasz EGYETLEN tiltott kulcsot sem tartalmaz (mélyen)', async () => {
    await seedRichPro();
    await buy(PRO, 'frame_fire');
    await call('PUT', '/api/profile/customization', PRO, { slot: 'frame', itemKey: 'frame_fire' });

    const r = await getPublic(PRO_NAME);
    const keys = deepKeys(r.body);
    for (const bad of FORBIDDEN_KEYS) expect([...keys], bad).not.toContain(bad);
  });

  it('P16. a user_id nem szerepel a nyers válaszban', async () => {
    await seedRichPro();
    const r = await getPublic(PRO_NAME);
    expect(r.raw).not.toContain(PRO);
    expect(r.raw).not.toContain(FREE);
  });

  it('P17. e-mail nem szerepel a válaszban', async () => {
    const r = await getPublic(PRO_NAME, PRO);
    expect(r.raw).not.toContain('@');
  });

  it('P18. a coin-egyenleg és a coin-előzmény nem jut ki', async () => {
    await buy(PRO, 'frame_fire');
    await h.coins.awardCoins({ userId: PRO, type: 'ADMIN_ADJUSTMENT', amount: 999_123, sourceKey: 'adj:titok' });
    const r = await getPublic(PRO_NAME);
    expect(r.raw).not.toContain('999123');
    expect(r.raw).not.toContain('999_123');
    expect([...deepKeys(r.body)]).not.toContain('balance');
  });

  it('P19. a vásárlási előzmény és a készlet nem jut ki', async () => {
    await buy(PRO, 'frame_fire', 'name_gold');
    const r = await getPublic(PRO_NAME);
    // a MEG NEM VISELT `name_gold` sehol nem jelenik meg
    expect(r.raw).not.toContain('name_gold');
    expect([...deepKeys(r.body)]).not.toContain('inventory');
  });

  it('P20. az ár soha nem jelenik meg', async () => {
    await buy(PRO, 'frame_fire');
    await call('PUT', '/api/profile/customization', PRO, { slot: 'frame', itemKey: 'frame_fire' });
    const r = await getPublic(PRO_NAME);
    expect(r.raw).not.toContain(String(PRICE('frame_fire')));
    expect([...deepKeys(r.body)]).not.toContain('priceCoins');
  });

  it('P21. egyedi tipp részletei nem jutnak ki (csapat, kezdés, tippelt gólszám)', async () => {
    await seedRichPro();
    const r = await getPublic(PRO_NAME);
    expect(r.raw).not.toContain('Hazai');
    expect(r.raw).not.toContain('Vendég');
    const keys = [...deepKeys(r.body)];
    for (const bad of ['homeTeam', 'awayTeam', 'kickoff', 'predictedHome', 'predictedAway', 'predictionId']) {
      expect(keys, bad).not.toContain(bad);
    }
  });

  it('P22. a `trend` és a `leagues` (tipp-szintű bontás) nem kerül a válaszba', async () => {
    await seedRichPro();
    const r = await getPublic(PRO_NAME);
    const keys = [...deepKeys(r.body)];
    expect(keys).not.toContain('trend');
    expect(keys).not.toContain('leagues');
    // a ligánkénti bontás a saját statisztikában VAN – itt szándékosan nincs
    const own = await h.progression.tipsterStats(PRO);
    expect(own.leagues.length).toBeGreaterThan(0);
  });

  it('P23. az előfizetés / PRO állapot nem derül ki a válaszból', async () => {
    const keys = [...deepKeys((await getPublic(PRO_NAME)).body)];
    for (const bad of ['pro', 'plan', 'subscription', 'subscriptionStatus', 'stripeCustomerId']) {
      expect(keys, bad).not.toContain(bad);
    }
  });

  it('P24. a privát profil-beállítás (showcase, settings) nem jut ki', async () => {
    await h.progression.saveSettings(PRO, { ...DEFAULT_SETTINGS, showcase: [] });
    const keys = [...deepKeys((await getPublic(PRO_NAME)).body)];
    expect(keys).not.toContain('settings');
    expect(keys).not.toContain('showcase');
  });

  it('P25. a kérő FÉL adatai nem szivárognak a válaszba', async () => {
    await seedRichPro();
    const anon = await getPublic(PRO_NAME);
    const asFree = await getPublic(PRO_NAME, FREE);
    expect(asFree.body).toEqual(anon.body);
  });

  it('P26. a felső szintű kulcsok PONTOSAN az engedélyezett halmazt adják', async () => {
    await seedRichPro();
    const r = await getPublic(PRO_NAME);
    expect(Object.keys(r.body).sort()).toEqual(
      ['achievements', 'competitions', 'cosmetics', 'displayName', 'highlights', 'progression', 'statistics'],
    );
  });

  it('P27. a `progression` blokk kulcsai pontosan az engedélyezettek', async () => {
    const r = await getPublic(PRO_NAME);
    expect(Object.keys(r.body.progression).sort()).toEqual(
      ['level', 'levelTier', 'progress', 'xp', 'xpForNextLevel', 'xpIntoLevel'],
    );
  });

  it('P28. a `cosmetics` blokk kulcsai pontosan az engedélyezettek', async () => {
    const r = await getPublic(PRO_NAME);
    expect(Object.keys(r.body.cosmetics).sort()).toEqual(['avatar', 'borderKey', 'shop', 'titleKey']);
  });

  it('P29. a `statistics` blokk kulcsai pontosan az engedélyezettek', async () => {
    const r = await getPublic(PRO_NAME);
    expect(Object.keys(r.body.statistics).sort()).toEqual([
      'accuracy', 'bestPlacement', 'bestStreak', 'competitionPodiums', 'competitionWins', 'competitions',
      'correctPredictions', 'currentStreak', 'distinctLeagues', 'exactHitRate', 'exactScores',
      'settledPredictions', 'totalPredictions',
    ]);
  });

  it('P30. a verseny- és achievement-elemek kulcsai pontosan az engedélyezettek', async () => {
    await seedRichPro();
    const r = await getPublic(PRO_NAME);
    expect(r.body.competitions.length).toBeGreaterThan(0);
    for (const c of r.body.competitions) {
      expect(Object.keys(c).sort()).toEqual(['competitionId', 'exactHits', 'name', 'placement', 'points', 'predictions']);
    }
    expect(r.body.achievements.length).toBeGreaterThan(0);
    for (const a of r.body.achievements) {
      expect(Object.keys(a).sort()).toEqual(['category', 'description', 'icon', 'key', 'name', 'unlockedAt']);
    }
  });

  it('P31. a kiemelések kulcsai pontosan az engedélyezettek', async () => {
    await seedRichPro();
    const r = await getPublic(PRO_NAME);
    for (const hl of r.body.highlights) expect(Object.keys(hl).sort()).toEqual(['kind', 'label', 'value']);
  });
});

// ===========================================================================
// 3) Szint és XP – a MEGLÉVŐ rendszerből
// ===========================================================================

describe('Nyilvános profil – szint és XP', () => {
  it('P32. a szint és az XP megegyezik a meglévő progression-számítással', async () => {
    await seedRichPro();
    const xp = await h.progressionStore.totalXp(PRO);
    const level = levelFromXp(xp);
    const r = await getPublic(PRO_NAME);
    expect(r.body.progression.xp).toBe(xp);
    expect(r.body.progression.level).toBe(level.level);
    expect(r.body.progression.levelTier).toBe(level.tier);
    expect(r.body.progression.xpIntoLevel).toBe(level.xpIntoLevel);
    expect(r.body.progression.xpForNextLevel).toBe(level.xpForNextLevel);
  });

  it('P33. a PRO játékosnak a tippjeiből valóban van XP-je', async () => {
    await seedRichPro();
    expect((await getPublic(PRO_NAME)).body.progression.xp).toBeGreaterThan(0);
  });

  it('P34. FREE játékos XP-je 0 és a szintje 1 (a meglévő PRO-kapu változatlan)', async () => {
    await seedCompetition({ name: 'Ingyen kupa', hoursAgo: 50, actual: [1, 1], picks: [{ user: FREE, home: 1, away: 1 }] });
    await h.progression.syncUser(FREE);
    const r = await getPublic(FREE_NAME);
    expect(r.body.progression.xp).toBe(0);
    expect(r.body.progression.level).toBe(1);
  });

  it('P35. a haladás 0 és 1 közé esik', async () => {
    await seedRichPro();
    const p = (await getPublic(PRO_NAME)).body.progression;
    expect(p.progress).toBeGreaterThanOrEqual(0);
    expect(p.progress).toBeLessThanOrEqual(1);
  });

  it('P36. az XP-eseménynapló nem jut ki', async () => {
    await seedRichPro();
    const r = await getPublic(PRO_NAME);
    const keys = [...deepKeys(r.body)];
    for (const bad of ['events', 'sourceKey', 'source_key', 'progressionEvents']) expect(keys, bad).not.toContain(bad);
  });
});

// ===========================================================================
// 4) Achievementek
// ===========================================================================

describe('Nyilvános profil – achievementek', () => {
  it('P37. csak a FELOLDOTT achievementek jelennek meg', async () => {
    await seedRichPro();
    const unlocked = new Set((await h.progressionStore.listAchievements(PRO)).map((a) => a.key));
    expect(unlocked.size).toBeGreaterThan(0);
    const r = await getPublic(PRO_NAME);
    expect(r.body.achievements.map((a: any) => a.key).sort()).toEqual([...unlocked].sort());
  });

  it('P38. a feloldatlan achievementek NEM jelennek meg', async () => {
    await seedRichPro();
    const r = await getPublic(PRO_NAME);
    expect(r.body.achievements.length).toBeLessThan(ACHIEVEMENTS.length);
    for (const a of r.body.achievements) expect(a).not.toHaveProperty('unlocked');
  });

  it('P39. a megjelenítési adat a MEGLÉVŐ katalógusból jön (nincs duplikált definíció)', async () => {
    await seedRichPro();
    const r = await getPublic(PRO_NAME);
    for (const a of r.body.achievements) {
      const src = ACHIEVEMENTS.find((x) => x.key === a.key)!;
      expect(src, a.key).toBeTruthy();
      expect(a.name).toBe(src.name);
      expect(a.description).toBe(src.description);
      expect(a.icon).toBe(src.icon);
      expect(a.category).toBe(src.category);
    }
  });

  it('P40. a feloldás időpontja ISO szöveg', async () => {
    await seedRichPro();
    for (const a of (await getPublic(PRO_NAME)).body.achievements) {
      expect(typeof a.unlockedAt === 'string' || a.unlockedAt === null).toBe(true);
      if (a.unlockedAt) expect(Number.isNaN(Date.parse(a.unlockedAt))).toBe(false);
    }
  });

  it('P41. új játékosnál üres a lista (nem hiba)', async () => {
    const r = await getPublic(OTHER_NAME);
    expect(r.status).toBe(200);
    expect(r.body.achievements).toEqual([]);
  });
});

// ===========================================================================
// 5) Statisztika
// ===========================================================================

describe('Nyilvános profil – statisztika', () => {
  it('P42. az értékek megegyeznek a meglévő `computeTipsterStats` eredményével', async () => {
    await seedRichPro();
    await seedPending(PRO);
    const rows = await h.progressionStore.allPredictions(PRO);
    const placements = await h.progressionStore.placements(PRO);
    const xp = await h.progressionStore.totalXp(PRO);
    const own = computeTipsterStats(rows, placements, xp);

    const s: PublicStatistics = (await getPublic(PRO_NAME)).body.statistics;
    expect(s.totalPredictions).toBe(own.totalPredictions);
    expect(s.settledPredictions).toBe(own.settledPredictions);
    expect(s.correctPredictions).toBe(own.correctPredictions);
    expect(s.exactScores).toBe(own.exactScores);
    expect(s.accuracy).toBeCloseTo(own.accuracy!, 10);
    expect(s.bestStreak).toBe(own.bestStreak);
    expect(s.currentStreak).toBe(own.currentStreak);
    expect(s.distinctLeagues).toBe(own.distinctLeagues);
    expect(s.competitionWins).toBe(own.competitionWins);
    expect(s.competitionPodiums).toBe(own.competitionPodiums);
  });

  it('P43. a függőben lévő tipp beleszámít az összesbe, de nem a lezártakba', async () => {
    await seedCompetition({ name: 'Lezárt', hoursAgo: 40, actual: [2, 0], picks: [{ user: PRO, home: 2, away: 0 }] });
    await seedPending(PRO);
    const s = (await getPublic(PRO_NAME)).body.statistics;
    expect(s.totalPredictions).toBe(2);
    expect(s.settledPredictions).toBe(1);
  });

  it('P44. `accuracy` null, ha még nincs lezárt tipp (sosem NaN)', async () => {
    await seedPending(OTHER);
    const s = (await getPublic(OTHER_NAME)).body.statistics;
    expect(s.settledPredictions).toBe(0);
    expect(s.accuracy).toBeNull();
  });

  it('P45. `exactHitRate` null, ha egyetlen tipp sincs (nulla osztó)', async () => {
    const s = (await getPublic(OTHER_NAME)).body.statistics;
    expect(s.totalPredictions).toBe(0);
    expect(s.exactHitRate).toBeNull();
  });

  it('P46. `exactHitRate` helyesen számol, ha van tipp', async () => {
    await seedCompetition({ name: 'A', hoursAgo: 60, actual: [1, 1], picks: [{ user: PRO, home: 1, away: 1 }] });
    await seedCompetition({ name: 'B', hoursAgo: 50, actual: [1, 1], picks: [{ user: PRO, home: 3, away: 0 }] });
    const s = (await getPublic(PRO_NAME)).body.statistics;
    expect(s.totalPredictions).toBe(2);
    expect(s.exactScores).toBe(1);
    expect(s.exactHitRate).toBeCloseTo(0.5, 10);
  });

  it('P47. a válaszban NINCS NaN és NINCS Infinity', async () => {
    await seedRichPro();
    await seedPending(PRO);
    const r = await getPublic(PRO_NAME);
    for (const n of deepNumbers(r.body)) {
      expect(Number.isFinite(n), `szám: ${n}`).toBe(true);
    }
    expect(r.raw).not.toContain('NaN');
    expect(r.raw).not.toContain('Infinity');
  });

  it('P48. a `ratio()` nulla osztónál null-t ad, nem NaN-t', () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(3, 0)).toBeNull();
    expect(ratio(1, 4)).toBeCloseTo(0.25, 10);
    expect(ratio(Number.NaN, 5)).toBeNull();
    expect(ratio(1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('P49. teljesen új játékos is 200-at kap, nullás statisztikával', async () => {
    const r = await getPublic(OTHER_NAME);
    expect(r.status).toBe(200);
    expect(r.body.statistics.totalPredictions).toBe(0);
    expect(r.body.statistics.competitions).toBe(0);
    expect(r.body.statistics.bestPlacement).toBeNull();
    expect(r.body.highlights).toEqual([]);
  });
});

// ===========================================================================
// 6) Verseny-előzmény
// ===========================================================================

describe('Nyilvános profil – verseny-előzmény', () => {
  it('P50. a versenyenkénti összesítés helyes (pont, tipp, pontos találat)', async () => {
    const c = await seedCompetition({ name: 'Összesítő', hoursAgo: 30, actual: [2, 1], picks: [{ user: PRO, home: 2, away: 1 }] });
    const entry = (await getPublic(PRO_NAME)).body.competitions.find((x: any) => x.competitionId === c.id);
    expect(entry).toBeTruthy();
    expect(entry.name).toBe('Összesítő');
    expect(entry.points).toBe(5);
    expect(entry.predictions).toBe(1);
    expect(entry.exactHits).toBe(1);
  });

  it('P51. a legfrissebb verseny van elöl', async () => {
    await seedRichPro();
    const names = (await getPublic(PRO_NAME)).body.competitions.map((c: any) => c.name);
    expect(names).toEqual(['Friss kupa', 'Középső kupa', 'Régi kupa']);
  });

  it('P52. a lista a `PUBLIC_COMPETITION_LIMIT`-nél nem lehet hosszabb', async () => {
    for (let i = 0; i < PUBLIC_COMPETITION_LIMIT + 3; i++) {
      await seedCompetition({ name: `Kupa ${i}`, hoursAgo: 500 - i * 10, actual: [1, 0], picks: [{ user: PRO, home: 1, away: 0 }] });
    }
    const r = await getPublic(PRO_NAME);
    expect(r.body.competitions.length).toBe(PUBLIC_COMPETITION_LIMIT);
    expect(r.body.statistics.competitions).toBe(PUBLIC_COMPETITION_LIMIT);
  });

  it('P53. a rögzített helyezés megjelenik, és ebből lesz a legjobb helyezés', async () => {
    await seedRichPro();
    const r = await getPublic(PRO_NAME);
    const finished = r.body.competitions.find((c: any) => c.name === 'Friss kupa');
    expect(finished.placement).toBe(1);
    expect(r.body.statistics.bestPlacement).toBe(1);
  });

  it('P54. helyezés nélküli versenynél a `placement` null (nem kitalált érték)', async () => {
    await seedRichPro();
    const r = await getPublic(PRO_NAME);
    expect(r.body.competitions.find((c: any) => c.name === 'Régi kupa').placement).toBeNull();
  });

  it('P55. a verseny-előzmény nem hoz több tárolóhívást több versenynél (nincs N+1)', async () => {
    // 1 verseny
    await seedCompetition({ name: 'Egy', hoursAgo: 90, actual: [1, 0], picks: [{ user: PRO, home: 1, away: 0 }] });
    h.calls.clear();
    await getPublic(PRO_NAME);
    const withOne = [...h.calls.values()].reduce((a, b) => a + b, 0);

    // még 5 verseny
    for (let i = 0; i < 5; i++) {
      await seedCompetition({ name: `Több ${i}`, hoursAgo: 80 - i * 5, actual: [1, 0], picks: [{ user: PRO, home: 1, away: 0 }] });
    }
    h.calls.clear();
    await getPublic(PRO_NAME);
    const withSix = [...h.calls.values()].reduce((a, b) => a + b, 0);

    expect(withSix).toBe(withOne);
    expect(h.calls.get('allPredictions')).toBe(1);
  });
});

// ===========================================================================
// 7) Kiemelések
// ===========================================================================

describe('Nyilvános profil – kiemelések', () => {
  it('P56. a győzelem és a dobogó egymást kizárja (nem duplázunk)', () => {
    const base: PublicStatistics = {
      totalPredictions: 0, settledPredictions: 0, correctPredictions: 0, exactScores: 0,
      accuracy: null, exactHitRate: null, bestStreak: 0, currentStreak: 0, distinctLeagues: 0,
      competitions: 0, competitionWins: 1, competitionPodiums: 2, bestPlacement: 1,
    };
    const kinds = buildHighlights(base, 1, 'Újonc').map((x) => x.kind);
    expect(kinds).toContain('win');
    expect(kinds).not.toContain('podium');

    const onlyPodium = buildHighlights({ ...base, competitionWins: 0 }, 1, 'Újonc').map((x) => x.kind);
    expect(onlyPodium).toContain('podium');
    expect(onlyPodium).not.toContain('win');
  });

  it('P57. a találati arány csak elegendő lezárt tippnél kerül kiemelésre', () => {
    const s: PublicStatistics = {
      totalPredictions: 9, settledPredictions: 9, correctPredictions: 9, exactScores: 0,
      accuracy: 1, exactHitRate: 0, bestStreak: 0, currentStreak: 0, distinctLeagues: 1,
      competitions: 1, competitionWins: 0, competitionPodiums: 0, bestPlacement: null,
    };
    expect(buildHighlights(s, 1, '').map((x) => x.kind)).not.toContain('accuracy');
    expect(buildHighlights({ ...s, settledPredictions: 10 }, 1, '').map((x) => x.kind)).toContain('accuracy');
  });

  it('P58. a kiemelések valódi adatból származnak (üres profilnál nincs kiemelés)', async () => {
    expect((await getPublic(OTHER_NAME)).body.highlights).toEqual([]);
  });

  it('P59. a sorozat csak 3-tól kerül kiemelésre', () => {
    const s: PublicStatistics = {
      totalPredictions: 3, settledPredictions: 3, correctPredictions: 2, exactScores: 0,
      accuracy: 0.6, exactHitRate: 0, bestStreak: 2, currentStreak: 0, distinctLeagues: 1,
      competitions: 1, competitionWins: 0, competitionPodiums: 0, bestPlacement: null,
    };
    expect(buildHighlights(s, 1, '').map((x) => x.kind)).not.toContain('streak');
    expect(buildHighlights({ ...s, bestStreak: 3 }, 1, '').map((x) => x.kind)).toContain('streak');
  });
});

// ===========================================================================
// 8) Kozmetikumok
// ===========================================================================

describe('Nyilvános profil – kozmetikumok', () => {
  it('P60. csak a FELVETT shop-kozmetikum látszik, a többi birtokolt nem', async () => {
    await buy(PRO, 'frame_fire', 'name_gold');
    await call('PUT', '/api/profile/customization', PRO, { slot: 'frame', itemKey: 'frame_fire' });
    const r = await getPublic(PRO_NAME);
    expect(r.body.cosmetics.shop.frame).toBe('frame_fire');
    expect(r.body.cosmetics.shop.nameColor ?? null).toBeNull();
  });

  it('P61. FREE játékos felvett shop-kozmetikuma is nyilvánosan látszik', async () => {
    await buy(FREE, 'frame_fire');
    await call('PUT', '/api/profile/customization', FREE, { slot: 'frame', itemKey: 'frame_fire' });
    expect((await getPublic(FREE_NAME)).body.cosmetics.shop.frame).toBe('frame_fire');
  });

  it('P62. FREE játékos MEGSZOLGÁLT kozmetikuma az alapértelmezés marad (PRO-kapu él)', async () => {
    await buy(FREE, 'frame_fire');
    await call('PUT', '/api/profile/customization', FREE, { slot: 'frame', itemKey: 'frame_fire' });
    const c = (await getPublic(FREE_NAME)).body.cosmetics;
    expect(c.borderKey).toBe(DEFAULT_SETTINGS.border);
    expect(c.titleKey).toBe(DEFAULT_SETTINGS.title);
  });

  it('P63. PRO játékos megszolgált kerete és címe megjelenik', async () => {
    await seedRichPro();
    await h.progression.saveSettings(PRO, { ...DEFAULT_SETTINGS, border: 'classic', title: 'tier_rookie' });
    const c = (await getPublic(PRO_NAME)).body.cosmetics;
    expect(c.borderKey).toBe('classic');
    expect(c.titleKey).toBe('tier_rookie');
  });

  it('P64. a kozmetikum ugyanaz, mint amit a ranglista-réteg ad (egyetlen igazság)', async () => {
    await buy(PRO, 'frame_fire');
    await call('PUT', '/api/profile/customization', PRO, { slot: 'frame', itemKey: 'frame_fire' });
    const fromLeaderboard = (await h.progression.publicProfiles([PRO])).get(PRO)!;
    const fromPublic = (await getPublic(PRO_NAME)).body.cosmetics;
    expect(fromPublic.borderKey).toBe(fromLeaderboard.borderKey);
    expect(fromPublic.titleKey).toBe(fromLeaderboard.titleKey);
    expect(fromPublic.shop.frame).toBe(fromLeaderboard.shop!.frame);
  });

  it('P65. a már NEM birtokolt kulcs nem jelenik meg (a birtoklás az authority)', async () => {
    await buy(PRO, 'frame_fire');
    await call('PUT', '/api/profile/customization', PRO, { slot: 'frame', itemKey: 'frame_fire' });
    // a készletből közvetlenül eltüntetjük – a tárolt választás nem authority
    h.db.prepare('DELETE FROM user_shop_items WHERE user_id = ?').run(PRO);
    expect((await getPublic(PRO_NAME)).body.cosmetics.shop.frame ?? null).toBeNull();
  });

  it('P66. az avatar-kompozíció objektum (nem nyers DB-érték)', async () => {
    const r = await getPublic(OTHER_NAME);
    expect(typeof r.body.cosmetics.avatar).toBe('object');
    expect(Array.isArray(r.body.cosmetics.avatar)).toBe(false);
  });
});

// ===========================================================================
// 9) Hozzáférés és hatásmentesség
// ===========================================================================

describe('Nyilvános profil – hozzáférés és hatásmentesség', () => {
  it('P67. hitelesítés NÉLKÜL is elérhető (FREE és PRO játékos egyaránt)', async () => {
    expect((await getPublic(PRO_NAME)).status).toBe(200);
    expect((await getPublic(FREE_NAME)).status).toBe(200);
  });

  it('P68. a GET semmit nem módosít: coin, készlet, beállítás és XP változatlan', async () => {
    await seedRichPro();
    await buy(PRO, 'frame_fire');
    const before = {
      balance: await h.coins.getBalance(PRO),
      xp: await h.progressionStore.totalXp(PRO),
      equips: await h.progression.shopCustomization(PRO),
      achievements: (await h.progressionStore.listAchievements(PRO)).length,
    };
    await getPublic(PRO_NAME);
    await getPublic(PRO_NAME, FREE);
    expect(await h.coins.getBalance(PRO)).toEqual(before.balance);
    expect(await h.progressionStore.totalXp(PRO)).toBe(before.xp);
    expect(await h.progression.shopCustomization(PRO)).toEqual(before.equips);
    expect((await h.progressionStore.listAchievements(PRO)).length).toBe(before.achievements);
  });

  it('P69. a saját profil-végpontok továbbra is hitelesítést kérnek', async () => {
    expect((await call('GET', '/api/profile/me')).status).toBe(401);
    expect((await call('GET', '/api/profile/customization')).status).toBe(401);
  });

  it('P70. a nyilvános útvonal nem írja felül a `/me` útvonalat', async () => {
    const me = await call('GET', '/api/profile/me', PRO);
    expect(me.status).toBe(200);
    expect(me.body.displayName).toBe(PRO_NAME);
  });
});

// ===========================================================================
// 10) A szerializáló önmagában
// ===========================================================================

describe('toPublicProfile – engedélyező lista', () => {
  const stats = {
    level: 4, levelTier: 'Haladó', totalXp: 1200, xpIntoLevel: 200, xpForNextLevel: 500, progress: 0.4,
    totalPredictions: 20, settledPredictions: 18, correctPredictions: 12, exactScores: 4,
    accuracy: 12 / 18, bestStreak: 5, currentStreak: 2, distinctLeagues: 3,
    competitionWins: 1, competitionPodiums: 2,
  };

  it('P71. a bemenet extra mezői NEM jutnak a kimenetbe', () => {
    const out = toPublicProfile({
      displayName: 'Teszt1',
      stats: { ...stats, userId: 'titkos', email: 'a@b.hu', coins: 500 } as any,
      cosmetics: { avatar: {}, borderKey: 'classic', titleKey: 'none', shop: {} },
      achievements: [],
      competitions: [],
    });
    const raw = JSON.stringify(out);
    expect(raw).not.toContain('titkos');
    expect(raw).not.toContain('a@b.hu');
    expect([...deepKeys(out)]).not.toContain('coins');
  });

  it('P72. az achievement-elemek extra mezői is kiesnek', () => {
    const out = toPublicProfile({
      displayName: 'Teszt1', stats,
      cosmetics: { avatar: {}, borderKey: 'classic', titleKey: 'none' },
      achievements: [{ key: 'k', name: 'N', description: 'D', icon: '🏅', category: 'c', unlockedAt: null, secret: 'x' } as any],
      competitions: [],
    });
    expect(Object.keys(out.achievements[0]).sort()).toEqual(['category', 'description', 'icon', 'key', 'name', 'unlockedAt']);
  });

  it('P73. a verseny-elemek extra mezői is kiesnek', () => {
    const out = toPublicProfile({
      displayName: 'Teszt1', stats,
      cosmetics: { avatar: {}, borderKey: 'classic', titleKey: 'none' },
      achievements: [],
      competitions: [{ competitionId: 'c1', name: 'K', points: 5, predictions: 1, exactHits: 1, placement: 2, userId: 'titkos' } as any],
    });
    expect(Object.keys(out.competitions[0]).sort()).toEqual(['competitionId', 'exactHits', 'name', 'placement', 'points', 'predictions']);
    expect(JSON.stringify(out)).not.toContain('titkos');
  });

  it('P74. a hibás számok nem rontják el a kimenetet', () => {
    const out = toPublicProfile({
      displayName: 'Teszt1',
      stats: { ...stats, totalPredictions: Number.NaN, exactScores: Number.POSITIVE_INFINITY, progress: 5, level: -2 },
      cosmetics: { avatar: {}, borderKey: 'classic', titleKey: 'none' },
      achievements: [], competitions: [],
    });
    expect(out.statistics.totalPredictions).toBe(0);
    expect(out.statistics.exactScores).toBe(0);
    expect(out.statistics.exactHitRate).toBeNull();
    expect(out.progression.progress).toBe(1);
    expect(out.progression.level).toBe(1);
    for (const n of deepNumbers(out)) expect(Number.isFinite(n)).toBe(true);
  });

  it('P75. a legjobb helyezés a legkisebb ismert helyezés', () => {
    const out = toPublicProfile({
      displayName: 'Teszt1', stats,
      cosmetics: { avatar: {}, borderKey: 'classic', titleKey: 'none' },
      achievements: [],
      competitions: [
        { competitionId: 'a', name: 'A', points: 1, predictions: 1, exactHits: 0, placement: 3 },
        { competitionId: 'b', name: 'B', points: 1, predictions: 1, exactHits: 0, placement: null },
        { competitionId: 'c', name: 'C', points: 1, predictions: 1, exactHits: 0, placement: 2 },
      ],
    });
    expect(out.statistics.bestPlacement).toBe(2);
  });

  it('P76. a verseny-lista a kimenetben is korlátozott', () => {
    const many = Array.from({ length: PUBLIC_COMPETITION_LIMIT + 5 }, (_, i) => ({
      competitionId: `c${i}`, name: `K${i}`, points: 1, predictions: 1, exactHits: 0, placement: null,
    }));
    const out: PublicProfileResponse = toPublicProfile({
      displayName: 'Teszt1', stats,
      cosmetics: { avatar: {}, borderKey: 'classic', titleKey: 'none' },
      achievements: [], competitions: many,
    });
    expect(out.competitions.length).toBe(PUBLIC_COMPETITION_LIMIT);
    expect(out.statistics.competitions).toBe(many.length);
  });
});
