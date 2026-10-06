/**
 * Tipster Progression – XP, szintek, achievementek, kozmetikumok.
 *
 * A HTTP-szintű teszteknél valódi Express alkalmazást indítunk a VALÓDI routerrel.
 * Az egyetlen szimulált elem a `res.locals.plan` (élesben az attachPlan tölti ki a tokenből)
 * és a PRO-ellenőrzés forrása (élesben a profiles tábla + Stripe állapot).
 *
 * Az XP jóváírását a VALÓDI CompetitionService.settle() / finish() váltja ki – vagyis
 * ugyanaz az út fut le, mint élesben.
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
import { progressionRouter } from '../src/server/routes/progression';
import { InMemoryDisplayNameDirectory } from '../src/server/profile/displayNameDirectory';
import {
  LEVEL_BASE_XP, LEVEL_STEP_XP, XP_CORRECT_OUTCOME, XP_EXACT_MILESTONE_BONUS, XP_EXACT_SCORE, XP_STREAK_BONUS,
  DEFAULT_SETTINGS,
  computeStats, levelFromXp, sanitizeSettings, streakBonusPredictionIds, tierForLevel, xpForPredictionPoints,
  type ProgressionStats,
} from '../src/shared/progression';
import type { MatchDataProvider } from '../src/server/data/provider';
import type { League, Match, MatchResult, Team } from '../src/shared/types';

const PRO_USER = '11111111-1111-1111-1111-111111111111';
const PRO_USER_B = '22222222-2222-2222-2222-222222222222';
const PRO_USER_C = '44444444-4444-4444-4444-444444444444';
const FREE_USER = '33333333-3333-3333-3333-333333333333';

const hours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();

/** Minimális provider – a progression tesztek nem hívnak külső adatforrást. */
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
  competitions: SqliteCompetitionStore;
  progressionStore: SqliteProgressionStore;
  competitionSvc: CompetitionService;
  progression: ProgressionService;
  proUsers: Set<string>;
  names: InMemoryDisplayNameDirectory;
}

async function startApp(): Promise<Harness> {
  const db = new DatabaseSync(':memory:');
  const competitions = new SqliteCompetitionStore(db);
  const progressionStore = new SqliteProgressionStore(db);
  const proUsers = new Set([PRO_USER, PRO_USER_B]);
  // Élesben ez a profiles tábla + Stripe állapot; itt ugyanaz a szerződés
  const progression = new ProgressionService(progressionStore, async (id) => proUsers.has(id));
  // A Tippverseny részvételi feltétele a megjelenítési név – a meglévő rendszert használjuk
  const names = new InMemoryDisplayNameDirectory();
  await names.set(PRO_USER, 'Martin23');
  await names.set(PRO_USER_B, 'Zsolti88');
  await names.set(PRO_USER_C, 'Kata7');
  await names.set(FREE_USER, 'Ingyenes1');
  const competitionSvc = new CompetitionService(competitions, new StubProvider(), names, progression);

  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    res.locals.plan = { enforced: true, user: id ? { id, email: '' } : null, pro: !!id && proUsers.has(id), admin: false };
    next();
  });
  app.use('/api/progression', progressionRouter(progression));

  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    competitions, progressionStore, competitionSvc, progression, proUsers, names,
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

/**
 * Verseny létrehozása adott eredményekkel és egy felhasználó tippjeivel, majd kiértékelés
 * a VALÓDI settle() úton (ez váltja ki a progression szinkront).
 * A `rounds` elemei: [tippHazai, tippVendég, valósHazai, valósVendég]
 */
async function playCompetition(
  h: Harness,
  userId: string,
  rounds: [number, number, number, number][],
  leagueKey = 'eng-pl',
  offsetHours = -100,
) {
  const c = await h.competitions.createCompetition({
    name: `Teszt ${leagueKey} ${Math.random()}`, leagueKey, leagueName: leagueKey, provider: 'teszt',
    startsAt: hours(offsetHours - 1), endsAt: hours(offsetHours + rounds.length + 1), status: 'active',
  });
  await h.competitions.upsertMatches(c.id, rounds.map((r, i) => ({
    externalMatchId: `m${i}`, homeTeam: `H${i}`, awayTeam: `A${i}`,
    kickoff: hours(offsetHours + i), homeScore: r[2], awayScore: r[3], status: 'finished' as const,
  })));
  const matches = await h.competitions.listMatches(c.id);
  for (let i = 0; i < rounds.length; i++) {
    await h.competitions.upsertPrediction(userId, matches[i].id, rounds[i][0], rounds[i][1]);
  }
  await h.competitionSvc.settle(c.id);
  return c;
}

const EXACT: [number, number, number, number] = [2, 1, 2, 1];
const CORRECT: [number, number, number, number] = [2, 0, 1, 0];
const WRONG: [number, number, number, number] = [2, 1, 0, 3];

let h: Harness;
beforeEach(async () => { h = await startApp(); });
afterEach(async () => { await h.close(); });

// ===========================================================================
// Tiszta logika: XP, szint, sorozat
// ===========================================================================

describe('Progression – XP és szint képletek', () => {
  it('XP a verseny pontszámából: 5 → 50, 3 → 25, 0 → 0', () => {
    expect(xpForPredictionPoints(5)).toBe(XP_EXACT_SCORE);
    expect(xpForPredictionPoints(3)).toBe(XP_CORRECT_OUTCOME);
    expect(xpForPredictionPoints(0)).toBe(0);
    expect(xpForPredictionPoints(null)).toBe(0);
    // a pontos eredmény NEM kapja meg ráadásként a +25-öt
    expect(XP_EXACT_SCORE).toBe(50);
  });

  it('P8. a szintszámítás helyes és a fokozat is stimmel', () => {
    expect(levelFromXp(0)).toMatchObject({ level: 1, xpIntoLevel: 0, xpForNextLevel: LEVEL_BASE_XP });
    expect(levelFromXp(LEVEL_BASE_XP - 1).level).toBe(1);
    expect(levelFromXp(LEVEL_BASE_XP)).toMatchObject({ level: 2, xpIntoLevel: 0 });
    expect(levelFromXp(LEVEL_BASE_XP + LEVEL_BASE_XP + LEVEL_STEP_XP).level).toBe(3);
    expect(levelFromXp(50).progress).toBeCloseTo(50 / LEVEL_BASE_XP, 5);
    expect(tierForLevel(1)).toBe('Rookie');
    expect(tierForLevel(5)).toBe('Amateur');
    expect(tierForLevel(10)).toBe('Tipster');
    expect(tierForLevel(20)).toBe('Analyst');
    expect(tierForLevel(30)).toBe('Expert');
    expect(tierForLevel(50)).toBe('Master Tipster');
    expect(tierForLevel(100)).toBe('Legend');
  });

  it('P9. a sorozat számítása helyes, és a bónusz sorozatonként egyszer jár', () => {
    const p = (id: string, points: number, i: number) => ({ predictionId: id, points, kickoff: hours(i), leagueKey: 'eng-pl' });
    // 6 helyes egymás után → a bónusz CSAK az 5.-nél
    const six = [1, 2, 3, 4, 5, 6].map((i) => p(`p${i}`, 3, i));
    expect(streakBonusPredictionIds(six)).toEqual(['p5']);
    // megszakad, majd új sorozat éri el az 5-öt → két bónusz, külön kulccsal
    const broken = [...[1, 2, 3, 4, 5].map((i) => p(`a${i}`, 3, i)), p('x', 0, 6), ...[1, 2, 3, 4, 5].map((i) => p(`b${i}`, 5, i + 6))];
    expect(streakBonusPredictionIds(broken)).toEqual(['a5', 'b5']);
    // 4 helyes → nincs bónusz
    expect(streakBonusPredictionIds([1, 2, 3, 4].map((i) => p(`c${i}`, 3, i)))).toEqual([]);

    const stats = computeStats(broken, [], 0);
    expect(stats.correctPredictions).toBe(10);
    expect(stats.exactScores).toBe(5);
    expect(stats.bestStreak).toBe(5);
    expect(stats.currentStreak).toBe(5);
  });
});

// ===========================================================================
// XP jóváírás a valódi kiértékelési úton
// ===========================================================================

describe('Progression – XP jóváírás', () => {
  it('P3. PRO felhasználó XP-t kap helyes tippért', async () => {
    await playCompetition(h, PRO_USER, [CORRECT]);
    expect(await h.progressionStore.totalXp(PRO_USER)).toBe(XP_CORRECT_OUTCOME);
  });

  it('P4. pontos eredmény 50 XP-t ad (nem 75-öt)', async () => {
    await playCompetition(h, PRO_USER, [EXACT]);
    expect(await h.progressionStore.totalXp(PRO_USER)).toBe(XP_EXACT_SCORE);
  });

  it('P5. rossz tippért nem jár XP', async () => {
    await playCompetition(h, PRO_USER, [WRONG]);
    expect(await h.progressionStore.totalXp(PRO_USER)).toBe(0);
  });

  it('P6. ugyanaz a tipp nem ad XP-t kétszer (ismételt kiértékelés)', async () => {
    const c = await playCompetition(h, PRO_USER, [EXACT, CORRECT]);
    const after1 = await h.progressionStore.totalXp(PRO_USER);
    await h.competitionSvc.settle(c.id);
    await h.competitionSvc.settle(c.id);
    await h.progression.syncUser(PRO_USER);
    expect(await h.progressionStore.totalXp(PRO_USER)).toBe(after1);
    expect(after1).toBe(XP_EXACT_SCORE + XP_CORRECT_OUTCOME);
  });

  it('P1. FREE felhasználó nem kap XP-t', async () => {
    await playCompetition(h, FREE_USER, [EXACT, EXACT, CORRECT]);
    expect(await h.progressionStore.totalXp(FREE_USER)).toBe(0);
    const r = await h.progression.syncUser(FREE_USER);
    expect(r.awardedXp).toBe(0);
    expect(r.totalXp).toBe(0);
  });

  it('P2. FREE felhasználó nem oldhat fel achievementet', async () => {
    await playCompetition(h, FREE_USER, [EXACT, EXACT, EXACT]);
    expect(await h.progressionStore.listAchievements(FREE_USER)).toEqual([]);
  });

  it('5 helyes tipp után egyszeri +100 XP sorozat-bónusz jár', async () => {
    await playCompetition(h, PRO_USER, [CORRECT, CORRECT, CORRECT, CORRECT, CORRECT]);
    expect(await h.progressionStore.totalXp(PRO_USER)).toBe(5 * XP_CORRECT_OUTCOME + XP_STREAK_BONUS);
    // a 6. helyes tipp már nem ad újabb sorozat-bónuszt
    await playCompetition(h, PRO_USER, [CORRECT], 'esp-ll', -50);
    expect(await h.progressionStore.totalXp(PRO_USER)).toBe(6 * XP_CORRECT_OUTCOME + XP_STREAK_BONUS);
  });

  it('a 10. pontos eredmény +50 és egyszeri +250 mérföldkő bónuszt ad', async () => {
    await playCompetition(h, PRO_USER, Array.from({ length: 9 }, () => EXACT));
    const after9 = await h.progressionStore.totalXp(PRO_USER);
    expect(after9).toBe(9 * XP_EXACT_SCORE + XP_STREAK_BONUS); // az 5. helyes tipp bónusza is benne van

    await playCompetition(h, PRO_USER, [EXACT], 'esp-ll', -50);
    const after10 = await h.progressionStore.totalXp(PRO_USER);
    expect(after10 - after9).toBe(XP_EXACT_SCORE + XP_EXACT_MILESTONE_BONUS); // 50 + 250

    // a mérföldkő csak egyszer jár
    await playCompetition(h, PRO_USER, [EXACT], 'ita-sa', -40);
    expect(await h.progressionStore.totalXp(PRO_USER)).toBe(after10 + XP_EXACT_SCORE);
  });

  it('a verseny lezárása helyezési XP-t ad, és az ismételt lezárás nem duplázza', async () => {
    const c = await playCompetition(h, PRO_USER, [EXACT, EXACT]);
    await playCompetition(h, PRO_USER_B, [WRONG], 'eng-pl', -90);
    const before = await h.progressionStore.totalXp(PRO_USER);

    await h.competitionSvc.finish(c.id);
    const after = await h.progressionStore.totalXp(PRO_USER);
    expect(after - before).toBe(1000); // 1. hely

    await h.competitionSvc.finish(c.id);
    expect(await h.progressionStore.totalXp(PRO_USER)).toBe(after); // nincs dupla jutalom
  });
});

// ===========================================================================
// Achievementek
// ===========================================================================

describe('Progression – achievementek', () => {
  it('P7. egy achievement csak egyszer oldható fel', async () => {
    await playCompetition(h, PRO_USER, [EXACT, CORRECT]);
    const first = await h.progressionStore.listAchievements(PRO_USER);
    expect(first.map((a) => a.key).sort()).toEqual(['bullseye', 'first_hit']);
    expect(first[0].unlockedAt).toBeTruthy();

    await h.progression.syncUser(PRO_USER);
    await h.progression.syncUser(PRO_USER);
    const second = await h.progressionStore.listAchievements(PRO_USER);
    expect(second).toHaveLength(2);
    expect(second[0].unlockedAt).toBe(first[0].unlockedAt); // az időbélyeg sem íródik felül
    // közvetlen ismételt feloldás sem hoz létre újabb sort
    expect(await h.progressionStore.unlockAchievement(PRO_USER, 'first_hit')).toBe(false);
  });

  it('a sorozat- és verseny-achievementek a megfelelő pillanatban nyílnak', async () => {
    const c = await playCompetition(h, PRO_USER, [CORRECT, CORRECT, CORRECT, CORRECT, CORRECT]);
    expect((await h.progressionStore.listAchievements(PRO_USER)).map((a) => a.key)).toContain('on_fire');
    await h.competitionSvc.finish(c.id);
    expect((await h.progressionStore.listAchievements(PRO_USER)).map((a) => a.key)).toContain('champion');
  });
});

// ===========================================================================
// Testreszabás – feloldás ellenőrzése
// ===========================================================================

describe('Progression – kozmetikumok és beállítások', () => {
  const statsWith = (patch: Partial<ProgressionStats>): ProgressionStats => ({ ...computeStats([], [], 0), ...patch });

  it('P10 + P12. zárolt keret és cím nem választható', () => {
    const stats = statsWith({ level: 1, exactScores: 0 });
    const { settings, rejected } = sanitizeSettings(
      { border: 'legend', title: 'champion', avatar: { hair: 'mohawk' } as any, showcase: [] },
      stats, new Set(),
    );
    expect(settings.border).toBe('classic');  // alapértelmezésre esik vissza
    expect(settings.title).toBe('none');
    expect(settings.avatar.hair).toBe('short');
    expect(rejected).toEqual(expect.arrayContaining(['border:legend', 'title:champion', 'avatar.hair:mohawk']));
  });

  it('P11. feloldott kozmetikum választható', () => {
    const stats = statsWith({ level: 20, exactScores: 12, competitionsWon: 1 });
    const unlocked = new Set(['champion', 'sharpshooter']);
    const { settings, rejected } = sanitizeSettings(
      { border: 'goal_hunter', title: 'champion', avatar: { hair: 'mohawk', shirtColor: 'purple', accessory: 'captain' } as any },
      stats, unlocked,
    );
    expect(settings.border).toBe('goal_hunter');
    expect(settings.title).toBe('champion');
    expect(settings.avatar.hair).toBe('mohawk');
    expect(settings.avatar.shirtColor).toBe('purple');
    expect(settings.avatar.accessory).toBe('captain');
    expect(rejected).toEqual([]);
  });

  it('P13. a kiemelés legfeljebb 3 achievement, és csak feloldott', () => {
    const stats = statsWith({ level: 10 });
    const unlocked = new Set(['first_hit', 'bullseye', 'on_fire', 'tipster']);
    const { settings, rejected } = sanitizeSettings(
      { showcase: ['first_hit', 'bullseye', 'on_fire', 'tipster', 'champion', 'nem_letezik', 'first_hit'] },
      stats, unlocked,
    );
    expect(settings.showcase).toEqual(['first_hit', 'bullseye', 'on_fire']);
    expect(rejected).toEqual(expect.arrayContaining(['showcase:tipster', 'showcase:champion', 'showcase:nem_letezik']));
  });
});

// ===========================================================================
// API biztonság
// ===========================================================================

describe('Progression – API biztonság', () => {
  it('bejelentkezés nélkül nem olvasható és nem menthető', async () => {
    expect((await call(h, 'GET', '/api/progression/me')).status).toBe(401);
    expect((await call(h, 'PUT', '/api/progression/settings', undefined, { border: 'classic' })).status).toBe(401);
  });

  it('FREE felhasználó látja a rendszert, de nem menthet testreszabást', async () => {
    const me = await call(h, 'GET', '/api/progression/me', FREE_USER);
    expect(me.status).toBe(200);
    expect(me.body.pro).toBe(false);
    expect(me.body.achievements.length).toBeGreaterThan(0); // a katalógus látható (bemutatás)
    expect(me.body.achievements.every((a: any) => a.unlocked === false)).toBe(true);

    const save = await call(h, 'PUT', '/api/progression/settings', FREE_USER, { border: 'classic' });
    expect(save.status).toBe(403);
    expect(save.body.code).toBe('PRO_REQUIRED');
  });

  it('P15 + P16. a kliens által küldött XP, szint és achievement figyelmen kívül marad', async () => {
    await playCompetition(h, PRO_USER, [CORRECT]);
    const save = await call(h, 'PUT', '/api/progression/settings', PRO_USER, {
      border: 'classic',
      xp: 999999, level: 99, totalXp: 999999,
      achievements: ['legend', 'champion'], unlockedAchievements: ['legend'],
      stats: { exactScores: 999 }, showcase: ['legend'],
    });
    expect(save.status).toBe(200);
    const me = await call(h, 'GET', '/api/progression/me', PRO_USER);
    expect(me.body.xp).toBe(XP_CORRECT_OUTCOME);  // nem 999999
    expect(me.body.level).toBe(1);
    expect(me.body.stats.exactScores).toBe(0);
    expect(me.body.achievements.find((a: any) => a.key === 'legend').unlocked).toBe(false);
    expect(me.body.settings.showcase).toEqual([]); // a fel nem oldott achievement nem kerül a kiemelésbe
    expect(await h.progressionStore.listAchievements(PRO_USER)).toHaveLength(1); // csak a first_hit
  });

  it('P14. más felhasználó progression adatai nem módosíthatók', async () => {
    await playCompetition(h, PRO_USER_B, [EXACT]);
    const beforeB = await h.progressionStore.totalXp(PRO_USER_B);
    const settingsBefore = await h.progressionStore.getSettings(PRO_USER_B);

    // a törzsben küldött user_id-t sosem olvassuk: a mentés a hitelesített userhez megy
    const save = await call(h, 'PUT', '/api/progression/settings', PRO_USER, {
      user_id: PRO_USER_B, userId: PRO_USER_B, border: 'classic', title: 'tier_rookie',
    });
    expect(save.status).toBe(200);

    expect(await h.progressionStore.totalXp(PRO_USER_B)).toBe(beforeB);
    expect(await h.progressionStore.getSettings(PRO_USER_B)).toEqual(settingsBefore);
    expect((await h.progressionStore.getSettings(PRO_USER))?.title).toBe('tier_rookie');
  });

  it('a /me válasz a szerver által számolt értékeket adja vissza', async () => {
    await playCompetition(h, PRO_USER, [EXACT, EXACT, CORRECT]);
    const me = await call(h, 'GET', '/api/progression/me', PRO_USER);
    expect(me.body.pro).toBe(true);
    expect(me.body.xp).toBe(2 * XP_EXACT_SCORE + XP_CORRECT_OUTCOME);
    expect(me.body.level).toBe(levelFromXp(me.body.xp).level);
    expect(me.body.levelTier).toBe(tierForLevel(me.body.level));
    expect(me.body.stats.exactScores).toBe(2);
    expect(me.body.stats.correctPredictions).toBe(3);
    expect(me.body.catalog.maxShowcase).toBe(3);
    expect(me.body.catalog.borders.find((b: any) => b.key === 'legend').unlocked).toBe(false);
    expect(me.body.catalog.borders.find((b: any) => b.key === 'classic').unlocked).toBe(true);
  });
});

// ===========================================================================
// Kiegészítő auditesetek: időzítés, sorozat-nullázás, helyezések, párhuzamosság
// ===========================================================================

describe('Progression – XP időzítése és a sorozat nullázása', () => {
  it('a tipp leadása önmagában 0 XP-t ad (csak a kiértékelés után jár XP)', async () => {
    const c = await h.competitions.createCompetition({
      name: 'Jövőbeli', leagueKey: 'eng-pl', leagueName: 'PL', provider: 'teszt',
      startsAt: hours(-1), endsAt: hours(48), status: 'active',
    });
    await h.competitions.upsertMatches(c.id, [{
      externalMatchId: 'future', homeTeam: 'H', awayTeam: 'A', kickoff: hours(5),
      homeScore: null, awayScore: null, status: 'scheduled',
    }]);
    const [m] = await h.competitions.listMatches(c.id);
    await h.competitionSvc.submitPrediction(c.id, PRO_USER, m.id, 2, 1);

    await h.competitionSvc.settle(c.id);
    await h.progression.syncUser(PRO_USER);
    expect(await h.progressionStore.totalXp(PRO_USER)).toBe(0);
    expect(await h.progressionStore.listAchievements(PRO_USER)).toEqual([]);
  });

  it('a rossz tipp lenullázza a sorozatot, és a bónusz csak új ötösnél jár újra', async () => {
    // 4 helyes → rossz → 5 helyes: a bónusz csak a második futam 5. tippjénél
    await playCompetition(h, PRO_USER, [CORRECT, CORRECT, CORRECT, CORRECT, WRONG, CORRECT, CORRECT, CORRECT, CORRECT, CORRECT]);
    const stats = (await call(h, 'GET', '/api/progression/me', PRO_USER)).body.stats;
    expect(stats.correctPredictions).toBe(9);
    expect(stats.bestStreak).toBe(5);
    expect(stats.currentStreak).toBe(5);
    // 9 helyes tipp + pontosan EGY sorozatbónusz
    expect(await h.progressionStore.totalXp(PRO_USER)).toBe(9 * XP_CORRECT_OUTCOME + XP_STREAK_BONUS);
  });
});

describe('Progression – helyezési XP mindhárom dobogós helyre', () => {
  it('1. hely +1000, 2. hely +750, 3. hely +500 – egyszer', async () => {
    const c = await h.competitions.createCompetition({
      name: 'Dobogó', leagueKey: 'eng-pl', leagueName: 'PL', provider: 'teszt',
      startsAt: hours(-100), endsAt: hours(-10), status: 'active',
    });
    await h.competitions.upsertMatches(c.id, [0, 1, 2].map((i) => ({
      externalMatchId: `d${i}`, homeTeam: `H${i}`, awayTeam: `A${i}`,
      kickoff: hours(-90 + i), homeScore: 2, awayScore: 1, status: 'finished' as const,
    })));
    const ms = await h.competitions.listMatches(c.id);
    // A: 3 pontos (15 pont) · B: 2 pontos (10) · C: 1 pontos (5)
    await h.competitions.upsertPrediction(PRO_USER, ms[0].id, 2, 1);
    await h.competitions.upsertPrediction(PRO_USER, ms[1].id, 2, 1);
    await h.competitions.upsertPrediction(PRO_USER, ms[2].id, 2, 1);
    await h.competitions.upsertPrediction(PRO_USER_B, ms[0].id, 2, 1);
    await h.competitions.upsertPrediction(PRO_USER_B, ms[1].id, 2, 1);
    await h.competitions.upsertPrediction(PRO_USER_C, ms[0].id, 2, 1);
    h.proUsers.add(PRO_USER_C);
    await h.competitionSvc.settle(c.id);

    const before = {
      a: await h.progressionStore.totalXp(PRO_USER),
      b: await h.progressionStore.totalXp(PRO_USER_B),
      c: await h.progressionStore.totalXp(PRO_USER_C),
    };
    await h.competitionSvc.finish(c.id);
    expect(await h.progressionStore.totalXp(PRO_USER) - before.a).toBe(1000);
    expect(await h.progressionStore.totalXp(PRO_USER_B) - before.b).toBe(750);
    expect(await h.progressionStore.totalXp(PRO_USER_C) - before.c).toBe(500);

    // a lezárás ismétlése egyiknél sem ad újra XP-t
    await h.competitionSvc.finish(c.id);
    await h.competitionSvc.finish(c.id);
    expect(await h.progressionStore.totalXp(PRO_USER) - before.a).toBe(1000);
    expect(await h.progressionStore.totalXp(PRO_USER_B) - before.b).toBe(750);
    expect(await h.progressionStore.totalXp(PRO_USER_C) - before.c).toBe(500);

    // és a megfelelő eredmények nyíltak meg
    const keys = async (u: string) => (await h.progressionStore.listAchievements(u)).map((a) => a.key);
    expect(await keys(PRO_USER)).toContain('champion');
    expect(await keys(PRO_USER_B)).toContain('runner_up');
    expect(await keys(PRO_USER_C)).toContain('podium');
  });
});

describe('Progression – párhuzamos feldolgozás', () => {
  it('párhuzamos XP-jóváírás nem ad dupla XP-t', async () => {
    const c = await playCompetition(h, PRO_USER, [EXACT, CORRECT, EXACT]);
    const expected = await h.progressionStore.totalXp(PRO_USER);

    // ugyanaz a kiértékelés és szinkron egyszerre, többször
    await Promise.all([
      h.competitionSvc.settle(c.id), h.competitionSvc.settle(c.id),
      h.progression.syncUser(PRO_USER), h.progression.syncUser(PRO_USER), h.progression.syncUser(PRO_USER),
    ]);
    expect(await h.progressionStore.totalXp(PRO_USER)).toBe(expected);
  });

  it('párhuzamos eredmény-feloldás nem hoz létre duplikátumot', async () => {
    await playCompetition(h, PRO_USER, [EXACT]);
    await Promise.all([
      h.progressionStore.unlockAchievement(PRO_USER, 'first_hit'),
      h.progressionStore.unlockAchievement(PRO_USER, 'first_hit'),
      h.progression.syncUser(PRO_USER),
      h.progression.syncUser(PRO_USER),
    ]);
    const all = await h.progressionStore.listAchievements(PRO_USER);
    expect(all.filter((a) => a.key === 'first_hit')).toHaveLength(1);
    expect(new Set(all.map((a) => a.key)).size).toBe(all.length);
  });

  it('párhuzamos helyezési jutalom nem duplázódik', async () => {
    const c = await playCompetition(h, PRO_USER, [EXACT]);
    const before = await h.progressionStore.totalXp(PRO_USER);
    await Promise.all([
      h.progression.awardPlacement(PRO_USER, c.id, 1),
      h.progression.awardPlacement(PRO_USER, c.id, 1),
      h.progression.awardPlacement(PRO_USER, c.id, 1),
    ]);
    expect(await h.progressionStore.totalXp(PRO_USER) - before).toBe(1000);
  });
});

describe('Progression – eredmények feloldásának kiváltói', () => {
  it('az első helyes tipp és az első pontos eredmény a megfelelő eredményt oldja fel', async () => {
    await playCompetition(h, PRO_USER, [CORRECT]);
    expect((await h.progressionStore.listAchievements(PRO_USER)).map((a) => a.key)).toEqual(['first_hit']);
    await playCompetition(h, PRO_USER, [EXACT], 'esp-ll', -50);
    expect((await h.progressionStore.listAchievements(PRO_USER)).map((a) => a.key).sort()).toEqual(['bullseye', 'first_hit']);
  });

  it('FREE felhasználó nem hozhat létre progression eseményt a kiértékelésen keresztül sem', async () => {
    await playCompetition(h, FREE_USER, [EXACT, EXACT, EXACT, EXACT, EXACT]);
    expect(await h.progressionStore.totalXp(FREE_USER)).toBe(0);
    expect(await h.progressionStore.listAchievements(FREE_USER)).toEqual([]);
    const me = await call(h, 'GET', '/api/progression/me', FREE_USER);
    expect(me.body.xp).toBe(0);
    expect(me.body.level).toBe(1);
  });
});

// ===========================================================================
// Audit: utólagos eredménymódosítás nem okozhat dupla XP-t
// ===========================================================================

describe('Progression – utólagos eredménymódosítás', () => {
  it('egy meccs eredményének javítása sem ad második sorozatbónuszt', async () => {
    // 6 helyes tipp → pontosan EGY sorozatbónusz
    const c = await h.competitions.createCompetition({
      name: 'Javítás', leagueKey: 'eng-pl', leagueName: 'PL', provider: 'teszt',
      startsAt: hours(-100), endsAt: hours(-10), status: 'active',
    });
    await h.competitions.upsertMatches(c.id, [0, 1, 2, 3, 4, 5].map((i) => ({
      externalMatchId: `r${i}`, homeTeam: `H${i}`, awayTeam: `A${i}`,
      kickoff: hours(-90 + i), homeScore: 1, awayScore: 0, status: 'finished' as const,
    })));
    const ms = await h.competitions.listMatches(c.id);
    for (const m of ms) await h.competitions.upsertPrediction(PRO_USER, m.id, 2, 0); // mind helyes kimenetel
    await h.competitionSvc.settle(c.id);

    const afterFirst = await h.progressionStore.totalXp(PRO_USER);
    expect(afterFirst).toBe(6 * XP_CORRECT_OUTCOME + XP_STREAK_BONUS);

    // Az ELSŐ mérkőzés eredménye utólag módosul: a tipp rossz lesz → a sorozat átrendeződik
    await h.competitions.upsertMatches(c.id, [{
      externalMatchId: 'r0', homeTeam: 'H0', awayTeam: 'A0',
      kickoff: hours(-90), homeScore: 0, awayScore: 3, status: 'finished' as const,
    }]);
    await h.competitionSvc.settle(c.id);
    await h.progression.syncUser(PRO_USER);

    // Továbbra is pontosan EGY sorozatbónusz van jóváírva (a már megadott XP-t nem vonjuk vissza)
    const events = await h.progressionStore.listAchievements(PRO_USER); // csak hogy a hívás ne dőljön el
    expect(events).toBeTruthy();
    const xp = await h.progressionStore.totalXp(PRO_USER);
    const streakBonuses = (xp - afterFirst) / XP_STREAK_BONUS;
    expect(streakBonuses).toBeLessThanOrEqual(0); // NEM keletkezett újabb bónusz
    expect(xp).toBe(afterFirst); // a tippenkénti XP sem íródik felül és nem duplázódik
  });
});

// ===========================================================================
// Ranglista-profilok: avatar + keret + cím, szerveroldali validációval
// ===========================================================================

describe('Ranglista – profil megjelenítés', () => {
  it('PRO felhasználó beállított profilja megjelenik a ranglistán', async () => {
    const c = await playCompetition(h, PRO_USER, [EXACT, EXACT]);
    // feloldott elemek: Mesterlövész keret 5 pontos eredménytől, cím a szinttől
    await h.progression.saveSettings(PRO_USER, {
      avatar: { skin: 'deep', hair: 'curly', hairColor: 'blonde', shirt: 'stripes', shirtColor: 'red', accessory: 'headband', background: 'solid' },
      border: 'classic',
      title: 'tier_rookie',
    });

    const lb = await h.competitionSvc.leaderboard(c.id, null);
    const me = lb.find((r) => r.displayName === 'Martin23')!;
    expect(me.profile).toBeDefined();
    expect(me.profile!.avatar.skin).toBe('deep');
    expect(me.profile!.avatar.hair).toBe('curly');
    expect(me.profile!.avatar.shirtColor).toBe('red');
    expect(me.profile!.borderKey).toBe('classic');
    expect(me.profile!.titleKey).toBe('tier_rookie');
    // a pontszám és a sorrend változatlan marad
    expect(me.points).toBe(10);
    expect(me.rank).toBe(1);
  });

  it('a beállítás módosítása azonnal látszik a következő lekérésnél (nincs gyorsítótár)', async () => {
    const c = await playCompetition(h, PRO_USER, [EXACT]);
    await h.progression.saveSettings(PRO_USER, { border: 'classic', title: 'none' });
    expect((await h.competitionSvc.leaderboard(c.id, null))[0].profile!.borderKey).toBe('classic');

    await h.progression.saveSettings(PRO_USER, { border: 'none', title: 'tier_rookie' });
    const after = await h.competitionSvc.leaderboard(c.id, null);
    expect(after[0].profile!.borderKey).toBe('none');
    expect(after[0].profile!.titleKey).toBe('tier_rookie');
  });

  it('FREE felhasználó mindig az alapértelmezett megjelenést kapja', async () => {
    // A felhasználó PRO-ként beállít valamit, majd lejár az előfizetése
    const c = await playCompetition(h, PRO_USER, [EXACT]);
    await h.progression.saveSettings(PRO_USER, { border: 'classic', title: 'tier_rookie' });
    h.proUsers.delete(PRO_USER);

    const lb = await h.competitionSvc.leaderboard(c.id, null);
    expect(lb[0].profile).toEqual({ avatar: DEFAULT_SETTINGS.avatar, borderKey: DEFAULT_SETTINGS.border, titleKey: DEFAULT_SETTINGS.title });
  });

  it('a tárolóban lévő ZÁROLT vagy ismeretlen kozmetikum nem jelenik meg', async () => {
    const c = await playCompetition(h, PRO_USER, [CORRECT]); // 1 helyes tipp → semmi nincs feloldva
    // az API-t megkerülve, közvetlenül a tárolóba írunk érvénytelen/zárolt kulcsokat
    await h.progressionStore.saveSettings(PRO_USER, {
      avatar: { ...DEFAULT_SETTINGS.avatar, hair: 'mohawk', shirtColor: 'gold', accessory: 'captain' },
      border: 'legend',
      title: 'champion',
      showcase: [],
    });

    const lb = await h.competitionSvc.leaderboard(c.id, null);
    const p = lb[0].profile!;
    expect(p.borderKey).toBe(DEFAULT_SETTINGS.border);   // legend (Lv50) nincs feloldva
    expect(p.titleKey).toBe(DEFAULT_SETTINGS.title);     // champion achievement nincs meg
    expect(p.avatar.hair).toBe(DEFAULT_SETTINGS.avatar.hair);             // mohawk = Lv10
    expect(p.avatar.shirtColor).toBe(DEFAULT_SETTINGS.avatar.shirtColor); // gold = Lv30
    expect(p.avatar.accessory).toBe(DEFAULT_SETTINGS.avatar.accessory);   // captain = Bajnok
  });

  it('a ranglista továbbra sem tartalmaz e-mailt, user_id-t vagy előfizetési adatot', async () => {
    const c = await playCompetition(h, PRO_USER, [EXACT]);
    await playCompetition(h, PRO_USER_B, [CORRECT], 'esp-ll', -60);
    await h.progression.saveSettings(PRO_USER, { border: 'classic', title: 'tier_rookie' });

    const lb = await h.competitionSvc.leaderboard(c.id, null);
    const raw = JSON.stringify(lb);
    expect(raw).not.toContain('@');
    expect(raw).not.toContain(PRO_USER);
    expect(raw).not.toContain('subscription');
    expect(raw).not.toContain('"xp"');
    expect(Object.keys(lb[0]).sort()).toEqual(['displayName', 'exactHits', 'isMe', 'points', 'predictions', 'profile', 'rank']);
    expect(Object.keys(lb[0].profile!).sort()).toEqual(['avatar', 'borderKey', 'titleKey']);
  });

  it('nincs N+1: a lekérdezések száma független a résztvevők számától', async () => {
    // számláló burkolat a tárolóra
    const calls: Record<string, number> = {};
    const counted = new Proxy(h.progressionStore, {
      get(target, prop: string) {
        const v = (target as any)[prop];
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => { calls[prop] = (calls[prop] ?? 0) + 1; return v.apply(target, args); };
      },
    }) as typeof h.progressionStore;

    const progression = new ProgressionService(counted, async (id) => h.proUsers.has(id));
    const svc = new CompetitionService(h.competitions, new StubProvider(), h.names, progression);

    // három résztvevő ugyanazon a versenyen
    const c = await h.competitions.createCompetition({
      name: 'N+1', leagueKey: 'eng-pl', leagueName: 'PL', provider: 'teszt',
      startsAt: hours(-100), endsAt: hours(-10), status: 'active',
    });
    await h.competitions.upsertMatches(c.id, [{
      externalMatchId: 'n1', homeTeam: 'H', awayTeam: 'A', kickoff: hours(-90),
      homeScore: 2, awayScore: 1, status: 'finished' as const,
    }]);
    const [m] = await h.competitions.listMatches(c.id);
    for (const u of [PRO_USER, PRO_USER_B, PRO_USER_C]) await h.competitions.upsertPrediction(u, m.id, 2, 1);
    h.proUsers.add(PRO_USER_C);

    Object.keys(calls).forEach((k) => delete calls[k]);
    await svc.leaderboard(c.id, null);

    // a kötegelt metódusok PONTOSAN egyszer futnak, a per-user változatok egyszer sem
    for (const batch of ['getSettingsMany', 'listAchievementsMany', 'totalXpMany', 'settledPredictionsMany', 'placementsMany']) {
      expect(calls[batch] ?? 0, batch).toBe(1);
    }
    for (const single of ['getSettings', 'listAchievements', 'totalXp', 'settledPredictions', 'placements']) {
      expect(calls[single] ?? 0, single).toBe(0);
    }
  });
});

// ===========================================================================
// Személyes statisztika és tipp-előzmény (GET /stats, GET /history)
// ===========================================================================

describe('Tipster statisztika és előzmény', () => {
  it('S2 + S4. hitelesítés nélkül mindkét végpont 401', async () => {
    expect((await call(h, 'GET', '/api/progression/stats')).status).toBe(401);
    expect((await call(h, 'GET', '/api/progression/history')).status).toBe(401);
  });

  it('S7. üres előzmény és üres statisztika nem borul fel', async () => {
    const stats = await call(h, 'GET', '/api/progression/stats', PRO_USER);
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({
      totalPredictions: 0, settledPredictions: 0, correctPredictions: 0, wrongPredictions: 0,
      pendingPredictions: 0, exactScores: 0, accuracy: null, currentStreak: 0, bestStreak: 0,
      totalXp: 0, level: 1, competitionWins: 0, distinctLeagues: 0,
    });
    expect(stats.body.leagues).toEqual([]);
    expect(stats.body.trend).toEqual([]);

    const hist = await call(h, 'GET', '/api/progression/history', PRO_USER);
    expect(hist.status).toBe(200);
    expect(hist.body).toEqual({ entries: [], total: 0, limit: 50 });
  });

  it('S1 + S9 + S10 + S11 + S13. saját statisztika: pontosság, pontos találat, sorozat, XP', async () => {
    await playCompetition(h, PRO_USER, [EXACT, CORRECT, WRONG, CORRECT, EXACT]);
    const s = (await call(h, 'GET', '/api/progression/stats', PRO_USER)).body;

    expect(s.totalPredictions).toBe(5);
    expect(s.settledPredictions).toBe(5);
    expect(s.correctPredictions).toBe(4);      // 2 exact + 2 correct
    expect(s.wrongPredictions).toBe(1);
    expect(s.pendingPredictions).toBe(0);
    expect(s.exactScores).toBe(2);
    expect(s.accuracy).toBeCloseTo(4 / 5, 6);  // 80%
    expect(s.bestStreak).toBe(2);              // a rossz tipp megszakítja
    expect(s.currentStreak).toBe(2);
    // XP: 50 + 25 + 0 + 25 + 50 = 150 (sorozatbónusz nincs, mert nincs 5-ös sorozat)
    expect(s.totalXp).toBe(2 * XP_EXACT_SCORE + 2 * XP_CORRECT_OUTCOME);
    expect(s.level).toBe(levelFromXp(s.totalXp).level);
    expect(s.levelTier).toBe(tierForLevel(s.level));
  });

  it('S8. a még ki nem értékelt tipp függőben marad és nem rontja a pontosságot', async () => {
    const c = await h.competitions.createCompetition({
      name: 'Vegyes', leagueKey: 'eng-pl', leagueName: 'Premier League', provider: 'teszt',
      startsAt: hours(-100), endsAt: hours(48), status: 'active',
    });
    await h.competitions.upsertMatches(c.id, [
      { externalMatchId: 'done', homeTeam: 'H1', awayTeam: 'A1', kickoff: hours(-90), homeScore: 2, awayScore: 1, status: 'finished' as const },
      { externalMatchId: 'open', homeTeam: 'H2', awayTeam: 'A2', kickoff: hours(5), homeScore: null, awayScore: null, status: 'scheduled' as const },
    ]);
    const ms = await h.competitions.listMatches(c.id);
    await h.competitions.upsertPrediction(PRO_USER, ms.find((m) => m.externalMatchId === 'done')!.id, 2, 1);
    await h.competitions.upsertPrediction(PRO_USER, ms.find((m) => m.externalMatchId === 'open')!.id, 1, 1);
    await h.competitionSvc.settle(c.id);

    const s = (await call(h, 'GET', '/api/progression/stats', PRO_USER)).body;
    expect(s.totalPredictions).toBe(2);
    expect(s.settledPredictions).toBe(1);
    expect(s.pendingPredictions).toBe(1);
    expect(s.accuracy).toBe(1);               // 1/1, a függőben lévő nem számít bele
    expect(s.exactScores).toBe(1);

    const hist = (await call(h, 'GET', '/api/progression/history', PRO_USER)).body;
    expect(hist.total).toBe(2);
    const pending = hist.entries.find((e: any) => e.status === 'pending');
    expect(pending).toBeDefined();
    expect(pending.actualHome).toBeNull();
    expect(pending.points).toBeNull();
    expect(pending.xpEarned).toBe(0);
  });

  it('S12. ligánkénti bontás a tényleges ligákból számol', async () => {
    await playCompetition(h, PRO_USER, [EXACT, CORRECT], 'eng-pl', -100);
    await playCompetition(h, PRO_USER, [WRONG], 'esp-ll', -60);
    const s = (await call(h, 'GET', '/api/progression/stats', PRO_USER)).body;

    expect(s.distinctLeagues).toBe(2);
    const pl = s.leagues.find((l: any) => l.leagueKey === 'eng-pl');
    const ll = s.leagues.find((l: any) => l.leagueKey === 'esp-ll');
    expect(pl).toMatchObject({ predictions: 2, settled: 2, correct: 2, exact: 1, accuracy: 1 });
    expect(ll).toMatchObject({ predictions: 1, settled: 1, correct: 0, exact: 0, accuracy: 0 });
    expect(s.leagues[0].predictions).toBeGreaterThanOrEqual(s.leagues[1].predictions); // darabszám szerint rendezve
  });

  it('a trend időrendben, futó pontossággal érkezik', async () => {
    await playCompetition(h, PRO_USER, [WRONG, CORRECT, CORRECT]);
    const s = (await call(h, 'GET', '/api/progression/stats', PRO_USER)).body;
    expect(s.trend).toHaveLength(3);
    expect(s.trend.map((t: any) => t.index)).toEqual([1, 2, 3]);
    expect(s.trend.map((t: any) => t.hit)).toEqual([false, true, true]);
    expect(s.trend[0].rollingAccuracy).toBe(0);
    expect(s.trend[2].rollingAccuracy).toBeCloseTo(2 / 3, 6);
    // időrend: a legrégebbi elöl
    expect(s.trend[0].kickoff <= s.trend[2].kickoff).toBe(true);
  });

  it('S3. saját előzmény a mérkőzés adataival, legfrissebb elöl', async () => {
    await playCompetition(h, PRO_USER, [EXACT, CORRECT]);
    const hist = (await call(h, 'GET', '/api/progression/history', PRO_USER)).body;
    expect(hist.entries).toHaveLength(2);
    // legfrissebb elöl
    expect(hist.entries[0].kickoff >= hist.entries[1].kickoff).toBe(true);

    const e = hist.entries.find((x: any) => x.status === 'exact');
    expect(e.homeTeam).toBeTruthy();
    expect(e.awayTeam).toBeTruthy();
    expect(e.leagueName).toBe('eng-pl');
    expect(e.predictedHome).toBe(2);
    expect(e.predictedAway).toBe(1);
    expect(e.actualHome).toBe(2);
    expect(e.actualAway).toBe(1);
    expect(e.points).toBe(5);
    expect(e.xpEarned).toBe(XP_EXACT_SCORE);
    expect(e.submittedAt).toBeTruthy();
  });

  it('S5. más felhasználó előzménye és statisztikája nem érhető el', async () => {
    await playCompetition(h, PRO_USER_B, [EXACT, EXACT, EXACT]);
    // A user saját lekérése üres, hiába küld idegen azonosítót queryben
    const hist = await call(h, 'GET', `/api/progression/history?userId=${PRO_USER_B}&user_id=${PRO_USER_B}`, PRO_USER);
    expect(hist.status).toBe(200);
    expect(hist.body.entries).toEqual([]);
    expect(hist.body.total).toBe(0);

    const stats = await call(h, 'GET', `/api/progression/stats?userId=${PRO_USER_B}`, PRO_USER);
    expect(stats.body.totalPredictions).toBe(0);
    expect(stats.body.exactScores).toBe(0);

    // B saját lekérése viszont látja a sajátját
    expect((await call(h, 'GET', '/api/progression/history', PRO_USER_B)).body.total).toBe(3);
  });

  it('S6. a limitet a szerver kényszeríti ki (alapértelmezés 50, maximum 100)', async () => {
    await playCompetition(h, PRO_USER, Array.from({ length: 6 }, () => CORRECT));
    const base = (await call(h, 'GET', '/api/progression/history', PRO_USER)).body;
    expect(base.limit).toBe(50);
    expect(base.entries).toHaveLength(6);

    expect((await call(h, 'GET', '/api/progression/history?limit=2', PRO_USER)).body.entries).toHaveLength(2);
    // túl nagy, nulla, negatív és értelmezhetetlen limit
    expect((await call(h, 'GET', '/api/progression/history?limit=9999', PRO_USER)).body.limit).toBe(100);
    expect((await call(h, 'GET', '/api/progression/history?limit=0', PRO_USER)).body.limit).toBe(50);
    expect((await call(h, 'GET', '/api/progression/history?limit=-5', PRO_USER)).body.limit).toBe(50);
    expect((await call(h, 'GET', '/api/progression/history?limit=abc', PRO_USER)).body.limit).toBe(50);
  });

  it('S14 + S15. FREE és PRO felhasználó egyaránt látja a SAJÁT adatait', async () => {
    // A FREE user tippjei léteznek (pl. korábbi PRO időszakból), de XP nem jár értük
    await playCompetition(h, FREE_USER, [EXACT, CORRECT]);
    const free = (await call(h, 'GET', '/api/progression/stats', FREE_USER)).body;
    expect(free.totalPredictions).toBe(2);
    expect(free.correctPredictions).toBe(2);
    expect(free.accuracy).toBe(1);
    expect(free.totalXp).toBe(0);     // FREE nem kap XP-t – a meglévő szabály érvényes
    expect(free.level).toBe(1);

    const freeHist = (await call(h, 'GET', '/api/progression/history', FREE_USER)).body;
    expect(freeHist.entries).toHaveLength(2);
    expect(freeHist.entries.every((e: any) => e.xpEarned === 0)).toBe(true);

    // PRO user ugyanazokra az eredményekre XP-t is kap
    await playCompetition(h, PRO_USER, [EXACT, CORRECT], 'esp-ll', -60);
    const pro = (await call(h, 'GET', '/api/progression/stats', PRO_USER)).body;
    expect(pro.totalXp).toBe(XP_EXACT_SCORE + XP_CORRECT_OUTCOME);
  });

  it('a válasz nem tartalmaz e-mailt, user_id-t vagy előfizetési adatot', async () => {
    await playCompetition(h, PRO_USER, [EXACT]);
    for (const path of ['/api/progression/stats', '/api/progression/history']) {
      const r = await call(h, 'GET', path, PRO_USER);
      expect(r.raw, path).not.toContain('@');
      expect(r.raw, path).not.toContain(PRO_USER);
      expect(r.raw, path).not.toContain('subscription');
      expect(r.raw.toLowerCase(), path).not.toContain('user_id');
    }
  });

  it('nincs N+1: a statisztika és az előzmény fix számú lekérdezésből áll elő', async () => {
    const calls: Record<string, number> = {};
    const counted = new Proxy(h.progressionStore, {
      get(target, prop: string) {
        const v = (target as any)[prop];
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => { calls[prop] = (calls[prop] ?? 0) + 1; return v.apply(target, args); };
      },
    }) as typeof h.progressionStore;
    const svc = new ProgressionService(counted, async (id) => h.proUsers.has(id));

    await playCompetition(h, PRO_USER, Array.from({ length: 8 }, () => CORRECT));

    Object.keys(calls).forEach((k) => delete calls[k]);
    await svc.tipsterStats(PRO_USER);
    expect(calls.allPredictions).toBe(1);
    expect(calls.placements).toBe(1);
    expect(calls.totalXp).toBe(1);

    Object.keys(calls).forEach((k) => delete calls[k]);
    await svc.predictionHistory(PRO_USER, 50);
    expect(calls.allPredictions).toBe(1);
    expect(calls.predictionXp).toBe(1);
  });
});
