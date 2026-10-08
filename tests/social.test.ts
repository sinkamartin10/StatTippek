/**
 * Social réteg – követés, játékos-keresés, Top Tipsterek, achievement-kiemelés.
 *
 * Valódi Express alkalmazás a VALÓDI `socialRouter` / `profileRouter` /
 * `progressionRouter` útvonalakkal, valódi `SocialService`, `ProgressionService`,
 * `CompetitionService` és valódi `Sqlite*Store` tárolókkal (a 0013 megfelelője
 * a helyi tárolóban). Az egyetlen szimulált elem a `res.locals.plan` – ugyanaz
 * a minta, mint a meglévő progression/battles/shop teszteknél.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { SqliteCompetitionStore } from '../src/server/competition/store';
import { CompetitionService } from '../src/server/competition/service';
import { SqliteProgressionStore } from '../src/server/progression/store';
import { ProgressionService } from '../src/server/progression/service';
import { SqliteFollowStore } from '../src/server/social/store';
import { SocialService } from '../src/server/social/service';
import { socialRouter } from '../src/server/routes/social';
import { profileRouter } from '../src/server/routes/profile';
import { progressionRouter } from '../src/server/routes/progression';
import { InMemoryDisplayNameDirectory } from '../src/server/profile/displayNameDirectory';
import {
  FOLLOW_PAGE_MAX, MIN_SETTLED_FOR_ACCURACY, SEARCH_LIMIT, TOP_LIST_SIZE, tierForRank,
} from '../src/shared/social';
import { DEFAULT_SETTINGS, MAX_SHOWCASE } from '../src/shared/progression';
import type { MatchDataProvider } from '../src/server/data/provider';
import type { League, Match, MatchResult, Team } from '../src/shared/types';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';
const FREE = '44444444-4444-4444-4444-444444444444';
const NONAME = '55555555-5555-5555-5555-555555555555';

const NAME = { [A]: 'Martin23', [B]: 'Marci13', [C]: 'Kolbasz', [FREE]: 'Ingyenes1' } as const;

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
  social: SocialService;
  progression: ProgressionService;
  progressionStore: SqliteProgressionStore;
  competitions: SqliteCompetitionStore;
  competitionSvc: CompetitionService;
  names: InMemoryDisplayNameDirectory;
  proUsers: Set<string>;
  calls: Map<string, number>;
}

/** Számláló burkoló az N+1 kimutatásához – semmit nem változtat. */
function counting<T extends object>(target: T, calls: Map<string, number>): T {
  return new Proxy(target, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        calls.set(String(prop), (calls.get(String(prop)) ?? 0) + 1);
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

async function startApp(): Promise<Harness> {
  const db = new DatabaseSync(':memory:');
  const realCompetitions = new SqliteCompetitionStore(db);
  const progressionStore = new SqliteProgressionStore(db);
  const follows = new SqliteFollowStore(db);
  const proUsers = new Set([A, B, C]);
  const calls = new Map<string, number>();
  const competitions = counting(realCompetitions, calls);

  const progression = new ProgressionService(progressionStore, async (id) => proUsers.has(id));
  const names = new InMemoryDisplayNameDirectory();
  for (const [id, n] of Object.entries(NAME)) await names.set(id, n);
  // NONAME szándékosan NEM kap nevet

  const social = new SocialService(
    follows, names, counting(progressionStore, calls), competitions,
    (ids) => progression.publicProfiles(ids),
  );
  const competitionSvc = new CompetitionService(realCompetitions, new StubProvider(), names, progression);

  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    res.locals.plan = { enforced: true, user: id ? { id, email: 'titok@pelda.hu' } : null, pro: !!id && proUsers.has(id), admin: false };
    next();
  });
  app.use('/api/social', socialRouter(social));
  app.use('/api/profile', profileRouter(names, progression, social));
  app.use('/api/progression', progressionRouter(progression));

  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    db, social, progression, progressionStore, competitions: realCompetitions, competitionSvc, names, proUsers, calls,
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

const follow = (user: string, name: string) => call('POST', `/api/social/follow/${encodeURIComponent(name)}`, user);
const unfollow = (user: string, name: string) => call('DELETE', `/api/social/follow/${encodeURIComponent(name)}`, user);
const status = (name: string, user?: string) => call('GET', `/api/social/follow/status/${encodeURIComponent(name)}`, user);
const search = (q: string, user?: string) => call('GET', `/api/social/players/search?q=${encodeURIComponent(q)}`, user);
const publicProfile = (name: string, user?: string) => call('GET', `/api/profile/public/${encodeURIComponent(name)}`, user);

let h: Harness;
let seq = 0;
beforeEach(async () => { h = await startApp(); });
afterEach(async () => { await h.close(); });

/** Verseny lezárt mérkőzésekkel és tippekkel – a statisztika alapja. */
async function seedCompetition(picks: { user: string; home: number; away: number }[], actual: [number, number], hoursAgo = 100, name?: string) {
  const n = ++seq;
  const c = await h.competitions.createCompetition({
    name: name ?? `Kupa ${n}`, leagueKey: 'eng-pl', leagueName: 'Premier League', provider: 'teszt',
    startsAt: new Date(Date.now() - (hoursAgo + 60) * 3600_000).toISOString(),
    endsAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(), status: 'active',
  });
  await h.competitions.upsertMatches(c.id, [{
    externalMatchId: `m-${n}`, homeTeam: 'Hazai', awayTeam: 'Vendég',
    kickoff: new Date(Date.now() - (hoursAgo + 10) * 3600_000).toISOString(),
    homeScore: actual[0], awayScore: actual[1], status: 'finished',
  }]);
  const [m] = await h.competitions.listMatches(c.id);
  for (const p of picks) await h.competitions.upsertPrediction(p.user, m.id, p.home, p.away);
  await h.competitionSvc.settle(c.id);
  return c;
}

/** `n` lezárt, HELYES tipp egy felhasználónak – a minimum mintaméret eléréséhez. */
async function seedCorrect(user: string, n: number) {
  for (let i = 0; i < n; i++) {
    await seedCompetition([{ user, home: 1, away: 0 }], [1, 0], 400 - i * 5);
  }
}

function deepKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) { for (const x of v) deepKeys(x, out); return out; }
  if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) { out.add(k); deepKeys(val, out); }
  return out;
}

// ===========================================================================
// 1) Játékos-keresés
// ===========================================================================

describe('Social – játékos-keresés', () => {
  it('S1. pontos névre talál', async () => {
    const r = await search('Martin23');
    expect(r.status).toBe(200);
    expect(r.body.players.map((p: any) => p.displayName)).toContain('Martin23');
  });

  it('S2. kis-nagybetűtől független', async () => {
    for (const q of ['martin', 'MARTIN', 'mArTiN']) {
      expect((await search(q)).body.players.map((p: any) => p.displayName), q).toContain('Martin23');
    }
  });

  it('S3. előtag-keresés működik', async () => {
    const r = await search('Mar');
    const found = r.body.players.map((p: any) => p.displayName).sort();
    expect(found).toEqual(['Marci13', 'Martin23']);
  });

  it('S4. NEM előtag-egyezés nem ad találatot (nincs tetszőleges részlet)', async () => {
    expect((await search('tin23')).body.players).toEqual([]);
  });

  it('S5. túl rövid keresőszóra nem indul lekérdezés', async () => {
    const before = h.calls.get('searchByName') ?? 0;
    expect((await search('M')).body.players).toEqual([]);
    expect(h.calls.get('searchByName') ?? 0).toBe(before);
  });

  it('S6. `%` joker nem ad találatot', async () => {
    for (const q of ['%', 'Ma%', '%%']) expect((await search(q)).body.players, q).toEqual([]);
  });

  it('S7. `_` joker nem hoz be idegen nevet', async () => {
    // `Marc_13` LIKE-ként megfogná a Marci13-at – a szerver előtag-egyezést követel
    expect((await search('Marc_')).body.players).toEqual([]);
  });

  it('S8. SQL-injekciós próbálkozás üres listát ad, nem hibát', async () => {
    for (const q of ["' OR 1=1 --", 'Martin23"; DROP TABLE profiles; --', "1' UNION SELECT 1 --"]) {
      const r = await search(q);
      expect(r.status, q).toBe(200);
      expect(r.body.players, q).toEqual([]);
    }
    expect(await h.names.get(A)).toBe('Martin23');
  });

  it('S9. ismeretlen névre üres lista', async () => {
    expect((await search('NincsIlyen')).body.players).toEqual([]);
  });

  it('S10. a találatszám kötött', async () => {
    for (let i = 0; i < SEARCH_LIMIT + 5; i++) {
      await h.names.set(`aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, `Teszt${i}`);
    }
    expect((await search('Teszt')).body.players.length).toBeLessThanOrEqual(SEARCH_LIMIT);
  });

  it('S11. a találat NEM tartalmaz privát mezőt', async () => {
    await seedCorrect(A, 2);
    const r = await search('Martin23');
    expect(r.raw).not.toContain(A);
    expect(r.raw).not.toContain('@');
    const keys = [...deepKeys(r.body)];
    for (const bad of ['userId', 'user_id', 'email', 'coins', 'balance', 'purchases', 'id']) {
      expect(keys, bad).not.toContain(bad);
    }
  });

  it('S12. a kártya kulcsai pontosan az engedélyezettek', async () => {
    const r = await search('Martin23');
    expect(Object.keys(r.body.players[0]).sort())
      .toEqual(['accuracy', 'avatar', 'borderKey', 'displayName', 'level', 'levelTier', 'titleKey']);
  });

  it('S13. név nélküli felhasználó nem jelenik meg', async () => {
    const all = (await search('Ma')).body.players.map((p: any) => p.displayName);
    expect(all).not.toContain('');
    expect((await search('NONAME')).body.players).toEqual([]);
    expect(NONAME).toBeTruthy();
  });

  it('S14. keresés bejelentkezés nélkül is működik (nyilvános adat)', async () => {
    expect((await search('Martin23')).status).toBe(200);
  });
});

// ===========================================================================
// 2) Követés
// ===========================================================================

describe('Social – követés', () => {
  it('S15. bejelentkezett felhasználó követhet', async () => {
    const r = await follow(A, 'Marci13');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ following: true, created: true });
  });

  it('S16. bejelentkezés nélkül 401', async () => {
    expect((await follow(undefined as never, 'Marci13')).status).toBe(401);
    expect((await unfollow(undefined as never, 'Marci13')).status).toBe(401);
    expect((await call('GET', '/api/social/following')).status).toBe(401);
    expect((await call('GET', '/api/social/followers')).status).toBe(401);
  });

  it('S17. önmagát nem követheti', async () => {
    const r = await follow(A, 'Martin23');
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('SELF_FOLLOW');
    expect((await h.social.status(A, 'Martin23')).followerCount).toBe(0);
  });

  it('S18. nem létező játékos → 404', async () => {
    const r = await follow(A, 'NincsIlyen99');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('PLAYER_NOT_FOUND');
  });

  it('S19. ismételt követés IDEMPOTENS (nem keletkezik második sor)', async () => {
    expect((await follow(A, 'Marci13')).body.created).toBe(true);
    const again = await follow(A, 'Marci13');
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect((await h.social.status(A, 'Marci13')).followerCount).toBe(1);
  });

  it('S20. követés megszüntetése, majd ismét (idempotens)', async () => {
    await follow(A, 'Marci13');
    expect((await unfollow(A, 'Marci13')).body).toEqual({ following: false, removed: true });
    const again = await unfollow(A, 'Marci13');
    expect(again.status).toBe(200);
    expect(again.body.removed).toBe(false);
  });

  it('S21. a követő MINDIG a hitelesített user – a törzs/útvonal nem authority', async () => {
    // A kérés törzsében küldött azonosítók hatástalanok
    await call('POST', '/api/social/follow/Marci13', A, {
      followerUserId: B, follower_user_id: B, userId: B, targetUserId: C,
    });
    const row = h.db.prepare('SELECT follower_user_id AS f, followed_user_id AS t FROM user_follows').get() as any;
    expect(row.f).toBe(A);
    expect(row.t).toBe(B); // Marci13 = B
  });

  it('S22. párhuzamos duplikált követés → pontosan egy sor', async () => {
    await Promise.all([follow(A, 'Marci13'), follow(A, 'Marci13'), follow(A, 'Marci13')]);
    const n = h.db.prepare('SELECT COUNT(*) AS n FROM user_follows').get() as { n: number };
    expect(Number(n.n)).toBe(1);
  });

  it('S23. az adatbázis is tiltja az önkövetést (végső garancia)', () => {
    expect(() => h.db.prepare(
      'INSERT INTO user_follows (follower_user_id, followed_user_id, created_at) VALUES (?, ?, ?)',
    ).run(A, A, new Date().toISOString())).toThrow();
  });

  it('S24. a számlálók helyesek mindkét irányban', async () => {
    await follow(A, 'Marci13');
    await follow(C, 'Marci13');
    await follow(A, 'Kolbasz');

    const marci = await status('Marci13', A);
    expect(marci.body.followerCount).toBe(2);
    expect(marci.body.followingCount).toBe(0);
    expect(marci.body.following).toBe(true);

    const martin = await status('Martin23', A);
    expect(martin.body.followingCount).toBe(2);
    expect(martin.body.followerCount).toBe(0);
    expect(martin.body.following).toBe(false); // saját magát nem követi
  });

  it('S25. az állapot bejelentkezés nélkül is olvasható, `following` ilyenkor false', async () => {
    await follow(A, 'Marci13');
    const r = await status('Marci13');
    expect(r.status).toBe(200);
    expect(r.body.followerCount).toBe(1);
    expect(r.body.following).toBe(false);
  });

  it('S26. a követés NEM ad XP-t, coint és nem érint pontozást', async () => {
    const xpBefore = await h.progressionStore.totalXp(A);
    await follow(A, 'Marci13');
    expect(await h.progressionStore.totalXp(A)).toBe(xpBefore);
    const tables = h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_coins'").get();
    expect(tables).toBeUndefined(); // a social teszt nem is hoz létre coin-táblát
  });
});

// ===========================================================================
// 3) Követettek / követők listája
// ===========================================================================

describe('Social – listák', () => {
  it('S27. a követettek listája a követett játékosokat adja', async () => {
    await follow(A, 'Marci13');
    await follow(A, 'Kolbasz');
    const r = await call('GET', '/api/social/following', A);
    expect(r.status).toBe(200);
    expect(r.body.players.map((p: any) => p.displayName).sort()).toEqual(['Kolbasz', 'Marci13']);
  });

  it('S28. a követők listája a követőket adja', async () => {
    await follow(A, 'Marci13');
    await follow(C, 'Marci13');
    const r = await call('GET', '/api/social/followers', B); // B = Marci13
    expect(r.body.players.map((p: any) => p.displayName).sort()).toEqual(['Kolbasz', 'Martin23']);
  });

  it('S29. a lista LAPOZOTT és a limit kötött', async () => {
    const r = await call('GET', `/api/social/following?limit=9999`, A);
    expect(r.status).toBe(200);
    expect(r.body.players.length).toBeLessThanOrEqual(FOLLOW_PAGE_MAX);
    expect(r.body).toHaveProperty('hasMore');
    expect(r.body).toHaveProperty('nextBefore');
  });

  it('S30. a lapozás nem ad vissza duplikált vagy kimaradó elemet', async () => {
    await follow(A, 'Marci13');
    await follow(A, 'Kolbasz');
    await follow(A, 'Ingyenes1');

    const p1 = await call('GET', '/api/social/following?limit=2', A);
    expect(p1.body.players).toHaveLength(2);
    expect(p1.body.hasMore).toBe(true);

    const p2 = await call('GET', `/api/social/following?limit=2&before=${encodeURIComponent(p1.body.nextBefore)}`, A);
    const all = [...p1.body.players, ...p2.body.players].map((p: any) => p.displayName);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(['Ingyenes1', 'Kolbasz', 'Marci13']);
  });

  it('S31. a lista nem ad ki privát mezőt', async () => {
    await follow(A, 'Marci13');
    const r = await call('GET', '/api/social/following', A);
    expect(r.raw).not.toContain(B);
    expect(r.raw).not.toContain('@');
    expect([...deepKeys(r.body)]).not.toContain('userId');
  });

  it('S32. a listák lekérdezésszáma FÜGGETLEN a követettek számától (nincs N+1)', async () => {
    await follow(A, 'Marci13');
    h.calls.clear();
    await call('GET', '/api/social/following', A);
    const one = [...h.calls.values()].reduce((a, b) => a + b, 0);

    await follow(A, 'Kolbasz');
    await follow(A, 'Ingyenes1');
    h.calls.clear();
    await call('GET', '/api/social/following', A);
    const three = [...h.calls.values()].reduce((a, b) => a + b, 0);

    expect(three).toBe(one);
    expect(h.calls.get('totalXpMany')).toBe(1);
    expect(h.calls.get('settledPredictionsMany')).toBe(1);
  });
});

// ===========================================================================
// 4) Nyilvános profil – social réteg
// ===========================================================================

describe('Social – nyilvános profil', () => {
  it('S33. a profil tartalmazza a követő-számlálókat', async () => {
    await follow(A, 'Marci13');
    await follow(C, 'Marci13');
    const r = await publicProfile('Marci13');
    expect(r.body.social.followerCount).toBe(2);
    expect(r.body.social.followingCount).toBe(0);
  });

  it('S34. `isFollowing` a NÉZŐ viszonyát mutatja', async () => {
    await follow(A, 'Marci13');
    expect((await publicProfile('Marci13', A)).body.social.isFollowing).toBe(true);
    expect((await publicProfile('Marci13', C)).body.social.isFollowing).toBe(false);
  });

  it('S35. kijelentkezve `isFollowing` mindig false, a számlálók láthatók', async () => {
    await follow(A, 'Marci13');
    const r = await publicProfile('Marci13');
    expect(r.body.social.isFollowing).toBe(false);
    expect(r.body.social.followerCount).toBe(1);
  });

  it('S36. a saját profilon `isFollowing` false (magát nem követi)', async () => {
    expect((await publicProfile('Martin23', A)).body.social.isFollowing).toBe(false);
  });

  it('S37. a social réteg NEM ad ki user_id-t vagy kapcsolat-listát', async () => {
    await follow(A, 'Marci13');
    const r = await publicProfile('Marci13', A);
    expect(r.raw).not.toContain(A);
    expect(r.raw).not.toContain(B);
    const keys = [...deepKeys(r.body)];
    for (const bad of ['followers', 'following', 'userId', 'user_id', 'email']) {
      expect(keys, bad).not.toContain(bad);
    }
  });
});

// ===========================================================================
// 5) Achievement-kiemelés
// ===========================================================================

describe('Social – achievement-kiemelés', () => {
  /** Feloldott achievementek biztosítása egy PRO felhasználónak. */
  async function unlockFor(user: string): Promise<string[]> {
    await seedCompetition([{ user, home: 1, away: 0 }], [1, 0]);
    await h.progression.syncUser(user);
    return (await h.progressionStore.listAchievements(user)).map((a) => a.key);
  }

  it('S38. FREE felhasználó IS menthet kiemelést', async () => {
    h.proUsers.add(FREE);
    const keys = await unlockFor(FREE);
    h.proUsers.delete(FREE); // a feloldás megvan, a csomag visszaáll FREE-re
    expect(keys.length).toBeGreaterThan(0);

    const r = await call('PUT', '/api/progression/showcase', FREE, { showcase: [keys[0]] });
    expect(r.status).toBe(200);
    expect(r.body.settings.showcase).toEqual([keys[0]]);
  });

  it('S39. PRO felhasználó is menthet kiemelést', async () => {
    const keys = await unlockFor(A);
    const r = await call('PUT', '/api/progression/showcase', A, { showcase: [keys[0]] });
    expect(r.status).toBe(200);
    expect(r.body.settings.showcase).toEqual([keys[0]]);
  });

  it('S40. a MEGSZOLGÁLT kozmetikumok PRO-kapuja VÁLTOZATLAN', async () => {
    const r = await call('PUT', '/api/progression/settings', FREE, { ...DEFAULT_SETTINGS, border: 'classic' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PRO_REQUIRED');
  });

  it('S41. a kiemelésen át NEM állítható keret vagy cím', async () => {
    h.proUsers.add(FREE);
    const keys = await unlockFor(FREE);
    h.proUsers.delete(FREE);

    // első mentés hozza létre a sort – innen mérjük a megszolgált mezőket
    await call('PUT', '/api/progression/showcase', FREE, { showcase: [] });
    const before = await h.progressionStore.getSettings(FREE);
    expect(before).not.toBeNull();

    await call('PUT', '/api/progression/showcase', FREE, {
      showcase: [keys[0]], border: 'legend', title: 'tier_master', avatar: { skin: 'dark' },
    });
    const after = await h.progressionStore.getSettings(FREE);
    expect(after!.border).toBe(before!.border);
    expect(after!.title).toBe(before!.title);
    expect(after!.avatar).toEqual(before!.avatar);
    expect(after!.showcase).toEqual([keys[0]]);
  });

  it('S42. legfeljebb 3 elem', async () => {
    const keys = await unlockFor(A);
    const many = [...keys, ...keys, ...keys].slice(0, MAX_SHOWCASE + 3);
    const r = await call('PUT', '/api/progression/showcase', A, { showcase: many });
    expect(r.body.settings.showcase.length).toBeLessThanOrEqual(MAX_SHOWCASE);
  });

  it('S43. duplikátum elutasítva', async () => {
    const keys = await unlockFor(A);
    const r = await call('PUT', '/api/progression/showcase', A, { showcase: [keys[0], keys[0]] });
    expect(r.body.settings.showcase).toEqual([keys[0]]);
    expect(r.body.rejected.some((x: string) => x.includes(keys[0]))).toBe(true);
  });

  it('S44. NEM birtokolt achievement elutasítva', async () => {
    await unlockFor(A);
    const r = await call('PUT', '/api/progression/showcase', A, { showcase: ['tier_master'] });
    expect(r.body.settings.showcase).toEqual([]);
    expect(r.body.rejected).toContain('showcase:tier_master');
  });

  it('S45. nem létező achievement elutasítva', async () => {
    await unlockFor(A);
    const r = await call('PUT', '/api/progression/showcase', A, { showcase: ['nincs_ilyen'] });
    expect(r.body.settings.showcase).toEqual([]);
  });

  it('S46. a kiemelés törölhető (üres lista)', async () => {
    const keys = await unlockFor(A);
    await call('PUT', '/api/progression/showcase', A, { showcase: [keys[0]] });
    const r = await call('PUT', '/api/progression/showcase', A, { showcase: [] });
    expect(r.body.settings.showcase).toEqual([]);
  });

  it('S47. bejelentkezés nélkül 401 – más kiemelését nem lehet állítani', async () => {
    expect((await call('PUT', '/api/progression/showcase', undefined, { showcase: [] })).status).toBe(401);
  });

  it('S48. a kiemelés megjelenik a nyilvános profilon', async () => {
    const keys = await unlockFor(A);
    await call('PUT', '/api/progression/showcase', A, { showcase: [keys[0]] });
    const r = await publicProfile('Martin23');
    expect(r.body.showcase).toHaveLength(1);
    expect(Object.keys(r.body.showcase[0]).sort())
      .toEqual(['category', 'description', 'icon', 'key', 'name', 'unlockedAt']);
  });
});

// ===========================================================================
// 6) Top Tipsterek
// ===========================================================================

describe('Social – Top Tipsterek', () => {
  it('S49. üres adatbázison nincs kategória (nem hamisítunk)', async () => {
    const r = await call('GET', '/api/social/top-tipsters');
    expect(r.status).toBe(200);
    expect(r.body.categories).toEqual([]);
    expect(r.body.poolSize).toBe(0);
  });

  it('S50. a pontosság-kategória MINIMUM mintaméretet követel', async () => {
    await seedCorrect(A, 2); // kevés minta
    const r = await call('GET', '/api/social/top-tipsters');
    const acc = r.body.categories.find((c: any) => c.key === 'accuracy');
    expect(acc).toBeUndefined();

    await seedCorrect(A, MIN_SETTLED_FOR_ACCURACY);
    const r2 = await call('GET', '/api/social/top-tipsters');
    expect(r2.body.categories.find((c: any) => c.key === 'accuracy')).toBeTruthy();
  });

  it('S51. a sorrend determinisztikus és a fokozat a helyezésből jön', async () => {
    await seedCorrect(A, MIN_SETTLED_FOR_ACCURACY + 2);
    const first = await call('GET', '/api/social/top-tipsters');
    const second = await call('GET', '/api/social/top-tipsters');
    expect(JSON.stringify(first.body)).toBe(JSON.stringify(second.body));

    for (const c of first.body.categories) {
      c.entries.forEach((e: any, i: number) => {
        expect(e.rank).toBe(i + 1);
        expect(e.tier).toBe(tierForRank(i + 1));
      });
    }
  });

  it('S52. a fokozat-leképezés pontosan dokumentált', () => {
    expect(tierForRank(1)).toBe('GOLD');
    expect(tierForRank(2)).toBe('SILVER');
    expect(tierForRank(3)).toBe('SILVER');
    expect(tierForRank(4)).toBe('BRONZE');
    expect(tierForRank(10)).toBe('BRONZE');
  });

  it('S53. a lista kategóriánként kötött hosszú', async () => {
    await seedCorrect(A, MIN_SETTLED_FOR_ACCURACY);
    const r = await call('GET', '/api/social/top-tipsters');
    for (const c of r.body.categories) expect(c.entries.length).toBeLessThanOrEqual(TOP_LIST_SIZE);
  });

  it('S54. nem ad ki user_id-t és privát mezőt', async () => {
    await seedCorrect(A, MIN_SETTLED_FOR_ACCURACY);
    const r = await call('GET', '/api/social/top-tipsters');
    expect(r.raw).not.toContain(A);
    expect(r.raw).not.toContain('@');
    const keys = [...deepKeys(r.body)];
    for (const bad of ['userId', 'user_id', 'email', 'coins', 'purchases']) expect(keys, bad).not.toContain(bad);
  });

  it('S55. a felhasználónkénti statisztika KÖTEGELT (nincs N+1)', async () => {
    await seedCorrect(A, 3);
    await seedCompetition([{ user: B, home: 1, away: 0 }, { user: C, home: 2, away: 2 }], [1, 0]);
    h.calls.clear();
    await call('GET', '/api/social/top-tipsters');
    expect(h.calls.get('totalXpMany')).toBe(1);
    expect(h.calls.get('settledPredictionsMany')).toBe(1);
    expect(h.calls.get('placementsMany')).toBe(1);
  });

  it('S56. bejelentkezés nélkül is elérhető (nyilvános felfedezés)', async () => {
    expect((await call('GET', '/api/social/top-tipsters')).status).toBe(200);
  });
});

// ===========================================================================
// 7) Frontend szerződés (nincs DOM-futtató – a forráson mérjük)
// ===========================================================================

describe('Social – frontend szerződés', () => {
  const read = (p: string) => readFileSync(p, 'utf8');
  const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

  const ACTIONS = 'src/client/components/ProfileActions.tsx';
  const PROFILE = 'src/client/pages/PublicProfile.tsx';
  const DISCOVER = 'src/client/pages/Discover.tsx';

  it('S57. a megosztás a KANONIKUS profilcímet használja', () => {
    expect(read(ACTIONS)).toContain('/jatekos/${encodeURIComponent(displayName)}');
  });

  it('S58. a megosztás sorrendje: natív → vágólap → kijelölhető cím', () => {
    const src = read(ACTIONS);
    expect(src).toContain('navigator.share');
    expect(src).toContain('navigator.clipboard.writeText');
    expect(src).toContain("setState('manual')");
    expect(src).toContain('Profil link kimásolva');
  });

  it('S59. a megosztás NEM hív backend végpontot és nem követ', () => {
    const c = code(ACTIONS);
    expect(c).not.toContain('/api/');
    for (const bad of ['track', 'analytics', 'beacon']) expect(c.toLowerCase(), bad).not.toContain(bad);
  });

  it('S60. a követés-gomb saját profilon nem jelenik meg', () => {
    expect(read(ACTIONS)).toContain('if (isMe) return null;');
  });

  it('S61. kijelentkezve a követés bejelentkezésre visz', () => {
    const src = read(ACTIONS);
    expect(src).toContain('if (configured && !loggedIn)');
    expect(src).toContain('to="/bejelentkezes"');
  });

  it('S62. a kliens SOSEM küld követő-azonosítót', () => {
    const c = code(ACTIONS) + code('src/client/lib/api.ts');
    expect(c).not.toContain('followerUserId');
    expect(c).not.toContain('follower_user_id');
  });

  it('S63. a kettős kattintás ellen `useRef` zár van (nem csak state)', () => {
    const src = read(ACTIONS);
    expect(src).toContain('const lock = useRef(false)');
    expect(src).toContain('if (lock.current) return;');
  });

  it('S64. a profil a MEGLÉVŐ ChallengeAction-t használja, nem duplikálja', () => {
    const src = read(PROFILE);
    expect(src).toContain('<ChallengeAction displayName={p.displayName} isMe={isMe} />');
    expect(code(PROFILE)).not.toContain('api.createBattle');
  });

  it('S65. a keresés csillapított és a minimumhosszt betartja', () => {
    const src = read(DISCOVER);
    expect(src).toContain('setTimeout(() => setQuery(term.trim()), 300)');
    expect(src).toContain('query.length < SEARCH_MIN_LENGTH ? null');
  });

  it('S66. a felfedezés nem számol saját rangsort – a szervertől kapja', () => {
    const c = code(DISCOVER);
    expect(c).toContain('api.topTipsters()');
    for (const bad of ['.sort(', 'computeStats', 'levelFromXp']) expect(c, bad).not.toContain(bad);
  });

  it('S67. a social listák a MEGLÉVŐ CosmeticProfile renderert használják', () => {
    expect(read('src/client/components/PlayerRow.tsx')).toContain('<CosmeticProfile');
  });

  it('S68. a navigáció NEM kapott új felső szintű gombot', () => {
    const src = read('src/client/components/Layout.tsx');
    const primary = src.slice(src.indexOf('const PRIMARY'), src.indexOf('const PLAY'));
    expect((primary.match(/to: '/g) ?? []).length).toBe(3);
    // az új oldalak a MEGLÉVŐ csoportokba kerültek
    expect(src).toContain("{ to: '/kovetes', label: 'Követés'");
    expect(src).toContain("{ to: '/felfedezes', label: 'Játékosok'");
  });
});
