/**
 * Tippverseny modul – biztonsági és integrációs tesztek.
 *
 * A HTTP-szintű teszteknél valódi Express alkalmazást indítunk a VALÓDI routerekkel és a
 * VALÓDI requirePro / requireAdmin őrökkel. Az egyetlen szimulált elem a `res.locals.plan`
 * előállítása: élesben ezt az attachPlan tölti ki a hitelesített Supabase tokenből,
 * a tesztben ugyanezt az eredményt állítjuk elő teszt-fejlécekből (az admin jogot itt is
 * az ADMIN_EMAILS környezeti változó dönti el, nem a kliens).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
// A node:sqlite beépített modul – createRequire-rel töltjük be, hogy a Vite ne próbálja feloldani
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { SqliteCompetitionStore } from '../src/server/competition/store';
import { CompetitionService } from '../src/server/competition/service';
import { adminCompetitionRouter, competitionRouter } from '../src/server/routes/competition';
import { profileRouter } from '../src/server/routes/profile';
import { InMemoryDisplayNameDirectory } from '../src/server/profile/displayNameDirectory';
import { requireAdmin } from '../src/server/billing/entitlement';
import { compareLeaderboard, displayNameFor, scorePrediction } from '../src/shared/competition';
import type { MatchDataProvider } from '../src/server/data/provider';
import type { League, Match, MatchResult, Team } from '../src/shared/types';

const ADMIN_EMAIL = 'admin@example.com';
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const USER_C = '33333333-3333-3333-3333-333333333333';

const hours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();

// ---------------------------------------------------------------------------
// Teszt meccsadat-szolgáltató (az ESPN provider helyett – hálózat nélkül)
// ---------------------------------------------------------------------------

const LEAGUES: League[] = [
  { id: 'eng-pl', name: 'Premier League', country: 'Anglia', countryCode: 'ENG', tier: 1, international: false },
  { id: 'esp-ll', name: 'La Liga', country: 'Spanyolország', countryCode: 'ESP', tier: 1, international: false },
];
const TEAMS: Team[] = [
  { id: 'liverpool', name: 'Liverpool', shortName: 'LIV', country: 'Anglia', leagueId: 'eng-pl' },
  { id: 'arsenal', name: 'Arsenal', shortName: 'ARS', country: 'Anglia', leagueId: 'eng-pl' },
  { id: 'chelsea', name: 'Chelsea', shortName: 'CHE', country: 'Anglia', leagueId: 'eng-pl' },
  { id: 'everton', name: 'Everton', shortName: 'EVE', country: 'Anglia', leagueId: 'eng-pl' },
  { id: 'barcelona', name: 'Barcelona', shortName: 'BAR', country: 'Spanyolország', leagueId: 'esp-ll' },
  { id: 'realmadrid', name: 'Real Madrid', shortName: 'RMA', country: 'Spanyolország', leagueId: 'esp-ll' },
];

class FakeProvider implements MatchDataProvider {
  readonly name = 'teszt-provider';
  readonly origin = 'live' as const;
  constructor(public matches: Match[]) {}
  async getLeagues(): Promise<League[]> { return LEAGUES; }
  async getTeams(): Promise<Team[]> { return TEAMS; }
  async getTeam(id: string): Promise<Team | null> { return TEAMS.find((t) => t.id === id) ?? null; }
  async getMatches(q: { leagueId?: string }): Promise<Match[]> {
    return this.matches.filter((m) => !q.leagueId || m.leagueId === q.leagueId);
  }
  async getMatch(id: string): Promise<Match | null> { return this.matches.find((m) => m.id === id) ?? null; }
  async getResultsForAnalysis(): Promise<MatchResult[]> { return []; }
  async getTeamResults(): Promise<MatchResult[]> { return []; }
  async getLeagueResults(): Promise<MatchResult[]> { return []; }
  async getOdds(): Promise<null> { return null; }
}

const match = (id: string, leagueId: string, home: string, away: string, kickoff: string, extra: Partial<Match> = {}): Match => ({
  id, leagueId, homeTeamId: home, awayTeamId: away, kickoff, status: 'scheduled',
  importance: 'normal', importanceReasons: [], origin: 'live', ...extra,
});

// ---------------------------------------------------------------------------
// Teszt-alkalmazás: valódi routerek + valódi őrök
// ---------------------------------------------------------------------------

interface Harness {
  url: string;
  close: () => Promise<void>;
  svc: CompetitionService;
  store: SqliteCompetitionStore;
  provider: FakeProvider;
  names: InMemoryDisplayNameDirectory;
}

async function startApp(matches: Match[]): Promise<Harness> {
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  const store = new SqliteCompetitionStore(new DatabaseSync(':memory:'));
  const provider = new FakeProvider(matches);
  const names = new InMemoryDisplayNameDirectory();
  const svc = new CompetitionService(store, provider, names);
  // A részvételhez megjelenítési név kell – a meglévő eseteknél előre beállítjuk
  await names.set(USER_A, 'Martin23');
  await names.set(USER_B, 'Zsolti88');
  await names.set(USER_C, 'Kata7');

  const app = express();
  app.use(express.json());
  // Élesben ezt az attachPlan tölti ki a hitelesített tokenből; itt ugyanazt az alakot állítjuk elő.
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    const email = (req.header('x-test-email') ?? '').toLowerCase();
    const admins = new Set((process.env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    res.locals.plan = {
      enforced: true,
      user: id ? { id, email } : null,
      pro: req.header('x-test-plan') === 'pro',
      admin: !!email && admins.has(email), // az admin jogot SOHA nem a kliens küldi
    };
    next();
  });
  app.use('/api/admin/competition', requireAdmin, adminCompetitionRouter(svc));
  app.use('/api/competition', competitionRouter(svc));
  app.use('/api/profile', profileRouter(names));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    svc, store, provider, names,
  };
}

type Who = { user?: string; email?: string; pro?: boolean };
const headers = (w: Who = {}): Record<string, string> => ({
  'content-type': 'application/json',
  ...(w.user ? { 'x-test-user': w.user } : {}),
  ...(w.email ? { 'x-test-email': w.email } : {}),
  ...(w.pro ? { 'x-test-plan': 'pro' } : {}),
});

const ADMIN: Who = { user: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: ADMIN_EMAIL, pro: true };

async function call(h: Harness, method: string, path: string, who: Who = {}, body?: unknown) {
  const res = await fetch(`${h.url}${path}`, {
    method, headers: headers(who), body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* nem JSON */ }
  return { status: res.status, body: json, raw: text };
}

/** Aktív verseny a következő 48 órára, szinkronizált meccsekkel. */
async function activeCompetition(h: Harness, name = 'Premier League Tippverseny', leagueKey = 'eng-pl') {
  const created = await call(h, 'POST', '/api/admin/competition', ADMIN, {
    name, leagueKey, startsAt: hours(-1), endsAt: hours(48),
  });
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  await call(h, 'POST', `/api/admin/competition/${id}/activate`, ADMIN);
  await call(h, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);
  const matches = await call(h, 'GET', `/api/competition/${id}/matches`, ADMIN);
  return { id, matches: matches.body as any[] };
}

// ---------------------------------------------------------------------------

let h: Harness;
const defaultMatches = () => [
  match('espn-1', 'eng-pl', 'liverpool', 'arsenal', hours(3)),
  match('espn-2', 'eng-pl', 'chelsea', 'everton', hours(5)),
  match('espn-3', 'esp-ll', 'barcelona', 'realmadrid', hours(4)),
];

beforeEach(async () => { h = await startApp(defaultMatches()); });
afterEach(async () => { await h.close(); });

// ===========================================================================
// Pontozás (tiszta logika)
// ===========================================================================

describe('Tippverseny – pontozás', () => {
  it('pontos eredmény = 5 pont', () => { expect(scorePrediction(2, 1, 2, 1)).toBe(5); });
  it('helyes 1X2 = 3 pont', () => { expect(scorePrediction(2, 1, 1, 0)).toBe(3); });
  it('helyes döntetlen más gólaránnyal = 3 pont', () => { expect(scorePrediction(1, 1, 2, 2)).toBe(3); });
  it('rossz kimenetel = 0 pont', () => { expect(scorePrediction(2, 1, 0, 2)).toBe(0); });

  it('holtverseny-szabály determinisztikus', () => {
    const base = { predictions: 5, exactHits: 1, lastSubmittedAt: '2026-10-01T10:00:00.000Z' };
    expect(compareLeaderboard({ userId: 'a', points: 10, ...base }, { userId: 'b', points: 9, ...base })).toBeLessThan(0);
    expect(compareLeaderboard({ userId: 'a', points: 10, ...base, exactHits: 2 }, { userId: 'b', points: 10, ...base })).toBeLessThan(0);
    expect(compareLeaderboard({ userId: 'a', points: 10, ...base }, { userId: 'b', points: 10, ...base, predictions: 4 })).toBeLessThan(0);
    // minden egyezik → user_id szerinti állandó sorrend
    expect(compareLeaderboard({ userId: 'a', points: 10, ...base }, { userId: 'b', points: 10, ...base })).toBeLessThan(0);
  });
});

// ===========================================================================
// 1–2. Hitelesítés nélküli hozzáférés
// ===========================================================================

describe('Tippverseny – hitelesítés', () => {
  it('1. hitelesítés nélküli GET: a nyilvános lista olvasható, a saját adat nem', async () => {
    const { id } = await activeCompetition(h);
    expect((await call(h, 'GET', '/api/competition')).status).toBe(200);
    expect((await call(h, 'GET', `/api/competition/${id}`)).status).toBe(200);
    expect((await call(h, 'GET', `/api/competition/${id}/matches`)).status).toBe(200);
    expect((await call(h, 'GET', `/api/competition/${id}/leaderboard`)).status).toBe(200);
    // saját adat bejelentkezés nélkül nem érhető el
    expect((await call(h, 'GET', `/api/competition/${id}/my-predictions`)).status).toBe(401);
    expect((await call(h, 'GET', `/api/competition/${id}/me`)).status).toBe(401);
  });

  it('2. hitelesítés nélküli POST → 401', async () => {
    const { id, matches } = await activeCompetition(h);
    const r = await call(h, 'POST', `/api/competition/${id}/predictions`, {}, {
      competitionMatchId: matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1,
    });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('AUTH_REQUIRED');
  });
});

// ===========================================================================
// 3–4. FREE / PRO
// ===========================================================================

describe('Tippverseny – FREE és PRO', () => {
  it('3. FREE felhasználó tippbeküldése → 403', async () => {
    const { id, matches } = await activeCompetition(h);
    const r = await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, email: 'free@example.com' }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1,
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PRO_REQUIRED');
    // és valóban nem jött létre tipp
    expect(await h.store.getPrediction(USER_A, matches[0].id)).toBeNull();
  });

  it('3b. FREE felhasználó a versenyt és a ranglistát látja', async () => {
    const { id } = await activeCompetition(h);
    const free = { user: USER_A, email: 'free@example.com' };
    expect((await call(h, 'GET', `/api/competition/${id}`, free)).status).toBe(200);
    expect((await call(h, 'GET', `/api/competition/${id}/leaderboard`, free)).status).toBe(200);
    expect((await call(h, 'GET', `/api/competition/${id}/matches`, free)).status).toBe(200);
  });

  it('4. PRO felhasználó sikeresen tippel', async () => {
    const { id, matches } = await activeCompetition(h);
    const r = await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, pro: true }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1,
    });
    expect(r.status).toBe(200);
    expect(r.body.predictedHomeScore).toBe(2);
    expect(r.body.predictedAwayScore).toBe(1);
    expect(r.body.points).toBeNull();
  });
});

// ===========================================================================
// 5–9. Adatizoláció és a kliens által küldött mezők figyelmen kívül hagyása
// ===========================================================================

describe('Tippverseny – adatizoláció', () => {
  it('5. A felhasználó nem látja más tippjét', async () => {
    const { id, matches } = await activeCompetition(h);
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_B, pro: true }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 3, predictedAwayScore: 0,
    });
    const mine = await call(h, 'GET', `/api/competition/${id}/my-predictions`, { user: USER_A, pro: true });
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual([]);
    // a meccslistában sem jelenik meg más tippje
    const list = await call(h, 'GET', `/api/competition/${id}/matches`, { user: USER_A, pro: true });
    expect(list.body.every((m: any) => m.myPrediction === null)).toBe(true);
  });

  it('6. A felhasználó nem módosíthatja más tippjét', async () => {
    const { id, matches } = await activeCompetition(h);
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_B, pro: true }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 3, predictedAwayScore: 0,
    });
    // A user ugyanarra a meccsre küld tippet – ettől SAJÁT tippje lesz, B tippje változatlan
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, pro: true }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 0, predictedAwayScore: 4,
    });
    const b = await h.store.getPrediction(USER_B, matches[0].id);
    expect(b!.predictedHomeScore).toBe(3);
    expect(b!.predictedAwayScore).toBe(0);
  });

  it('7. A kérésben küldött user_id-t a rendszer figyelmen kívül hagyja', async () => {
    const { id, matches } = await activeCompetition(h);
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, pro: true }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 1, predictedAwayScore: 1,
      user_id: USER_B, userId: USER_B, // ezt soha nem olvassuk ki
    });
    expect(await h.store.getPrediction(USER_B, matches[0].id)).toBeNull();
    expect((await h.store.getPrediction(USER_A, matches[0].id))!.predictedHomeScore).toBe(1);
  });

  it('8. A kérésben küldött points értéket a rendszer figyelmen kívül hagyja', async () => {
    const { id, matches } = await activeCompetition(h);
    const r = await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, pro: true }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 1, predictedAwayScore: 1, points: 999,
    });
    expect(r.body.points).toBeNull();
    expect((await h.store.getPrediction(USER_A, matches[0].id))!.points).toBeNull();
  });

  it('9. A kérésben küldött rank / total_points értéket a rendszer figyelmen kívül hagyja', async () => {
    const { id, matches } = await activeCompetition(h);
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, pro: true }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 1, predictedAwayScore: 1,
      rank: 1, total_points: 500, result: 'nyert', status: 'finished',
    });
    const lb = await call(h, 'GET', `/api/competition/${id}/leaderboard`, { user: USER_A, pro: true });
    expect(lb.body[0].points).toBe(0); // nincs még eredmény → 0 pont
    expect(lb.body[0].rank).toBe(1);
    // a verseny státuszát sem lehetett átírni
    const c = await call(h, 'GET', `/api/competition/${id}`);
    expect(c.body.competition.status).toBe('active');
  });
});

// ===========================================================================
// 10–11. Időablak és egyediség
// ===========================================================================

describe('Tippverseny – időablak és egyediség', () => {
  it('10. Kickoff után a tipp elutasítva', async () => {
    const past = [match('espn-past', 'eng-pl', 'liverpool', 'arsenal', hours(-2))];
    const h2 = await startApp(past);
    try {
      // A verseny időszaka visszanyúlik a meccs kezdése elé, így a meccs bekerül – de tippelni már nem lehet rá
      const created = await call(h2, 'POST', '/api/admin/competition', ADMIN, { name: 'Múltbeli', leagueKey: 'eng-pl', startsAt: hours(-5), endsAt: hours(24) });
      const id = created.body.id as string;
      await call(h2, 'POST', `/api/admin/competition/${id}/activate`, ADMIN);
      await call(h2, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);
      const matches = (await call(h2, 'GET', `/api/competition/${id}/matches`, ADMIN)).body as any[];
      expect(matches).toHaveLength(1);
      expect(matches[0].locked).toBe(true);
      const r = await call(h2, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, pro: true }, {
        competitionMatchId: matches[0].id, predictedHomeScore: 1, predictedAwayScore: 0,
      });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('PREDICTION_CLOSED');
    } finally { await h2.close(); }
  });

  it('11. Ugyanarra a meccsre a második tipp MÓDOSÍT, nem duplikál', async () => {
    const { id, matches } = await activeCompetition(h);
    const who = { user: USER_A, pro: true };
    await call(h, 'POST', `/api/competition/${id}/predictions`, who, { competitionMatchId: matches[0].id, predictedHomeScore: 1, predictedAwayScore: 0 });
    await call(h, 'POST', `/api/competition/${id}/predictions`, who, { competitionMatchId: matches[0].id, predictedHomeScore: 3, predictedAwayScore: 2 });
    const mine = await h.svc.myPredictions(id, USER_A);
    expect(mine).toHaveLength(1);
    expect(mine[0].predictedHomeScore).toBe(3);
    expect(mine[0].predictedAwayScore).toBe(2);
  });

  it('11b. Másik verseny meccsére nem lehet tippelni', async () => {
    const pl = await activeCompetition(h, 'PL', 'eng-pl');
    const ll = await activeCompetition(h, 'LaLiga', 'esp-ll');
    const r = await call(h, 'POST', `/api/competition/${pl.id}/predictions`, { user: USER_A, pro: true }, {
      competitionMatchId: ll.matches[0].id, predictedHomeScore: 1, predictedAwayScore: 1,
    });
    expect(r.status).toBe(404);
  });
});

// ===========================================================================
// 12–15. Idempotencia
// ===========================================================================

describe('Tippverseny – idempotencia', () => {
  it('12. Ismételt szinkronizálás nem hoz létre duplikált meccset, és a tippeket nem törli', async () => {
    const { id, matches } = await activeCompetition(h);
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, pro: true }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1,
    });
    const first = (await h.svc.listMatches(id)).length;
    await call(h, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);
    await call(h, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);
    expect((await h.svc.listMatches(id)).length).toBe(first);
    expect(await h.svc.myPredictions(id, USER_A)).toHaveLength(1);
  });

  it('13. A pontozás idempotens – kétszeri futtatás sem ad dupla pontot', async () => {
    const { id, matches } = await activeCompetition(h);
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, pro: true }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1,
    });
    // végeredmény megérkezik a szolgáltatóból
    h.provider.matches[0] = { ...h.provider.matches[0], status: 'finished', homeGoals: 2, awayGoals: 1 };
    await call(h, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);
    await h.svc.settle(id);
    await h.svc.settle(id);
    const mine = await h.svc.myPredictions(id, USER_A);
    expect(mine[0].points).toBe(5);
    const lb = await h.svc.leaderboard(id, USER_A);
    expect(lb[0].points).toBe(5);
  });

  it('14–15. A lezárás és a jutalomképzés idempotens', async () => {
    const { id, matches } = await activeCompetition(h);
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, pro: true }, { competitionMatchId: matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1 });
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_B, pro: true }, { competitionMatchId: matches[0].id, predictedHomeScore: 1, predictedAwayScore: 0 });
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_C, pro: true }, { competitionMatchId: matches[0].id, predictedHomeScore: 0, predictedAwayScore: 3 });
    h.provider.matches[0] = { ...h.provider.matches[0], status: 'finished', homeGoals: 2, awayGoals: 1 };
    await call(h, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);

    const first = await call(h, 'POST', `/api/admin/competition/${id}/finish`, ADMIN);
    expect(first.status).toBe(200);
    expect(first.body.competition.status).toBe('finished');
    expect(first.body.createdRewards).toBe(3);

    const second = await call(h, 'POST', `/api/admin/competition/${id}/finish`, ADMIN);
    expect(second.status).toBe(200);
    expect(second.body.createdRewards).toBe(0); // nincs dupla jutalom
    expect(second.body.rewards).toHaveLength(3);

    const rewards = await h.svc.rewards(id);
    expect(rewards.map((r) => r.placement)).toEqual([1, 2, 3]);
    expect(rewards.map((r) => r.rewardType)).toEqual(['free_pro_1_month', 'free_pro_2_weeks', 'free_pro_1_week']);
    expect(rewards.every((r) => r.status === 'pending')).toBe(true);
    // 5 pont (pontos eredmény) → A az első
    expect(rewards[0].userId).toBe(USER_A);
  });

  it('14b. Lezárt versenyre nem lehet tippelni és nem lehet szinkronizálni', async () => {
    const { id, matches } = await activeCompetition(h);
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, pro: true }, { competitionMatchId: matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1 });
    h.provider.matches[0] = { ...h.provider.matches[0], status: 'finished', homeGoals: 2, awayGoals: 1 };
    await call(h, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);
    await call(h, 'POST', `/api/admin/competition/${id}/finish`, ADMIN);

    const tip = await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_B, pro: true }, { competitionMatchId: matches[1].id, predictedHomeScore: 1, predictedAwayScore: 1 });
    expect(tip.status).toBe(409);
    const sync = await call(h, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);
    expect(sync.status).toBe(409);
    const activate = await call(h, 'POST', `/api/admin/competition/${id}/activate`, ADMIN);
    expect(activate.status).toBe(409);
  });

  it('14c. Eredmény nélkül a verseny nem zárható le', async () => {
    const { id } = await activeCompetition(h);
    const r = await call(h, 'POST', `/api/admin/competition/${id}/finish`, ADMIN);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('NO_RESULTS');
  });
});

// ===========================================================================
// 16. Ranglista – nincs benne személyes adat
// ===========================================================================

describe('Tippverseny – ranglista', () => {
  it('16. A ranglista nem tartalmaz e-mailt és user_id-t', async () => {
    const { id, matches } = await activeCompetition(h);
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, email: 'titkos@example.com', pro: true }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1,
    });
    const lb = await call(h, 'GET', `/api/competition/${id}/leaderboard`, { user: USER_B, pro: true });
    expect(lb.status).toBe(200);
    expect(lb.raw).not.toContain('@');
    expect(lb.raw).not.toContain(USER_A);
    expect(lb.body[0].displayName).toBe('Martin23'); // a profilban tárolt név, nem e-mail
    expect(lb.body[0].isMe).toBe(false);
    // a saját sor meg van jelölve
    const mine = await call(h, 'GET', `/api/competition/${id}/leaderboard`, { user: USER_A, pro: true });
    expect(mine.body[0].isMe).toBe(true);
  });
});

// ===========================================================================
// 17–18. Admin jogosultság
// ===========================================================================

describe('Tippverseny – admin jogosultság', () => {
  it('17. Nem admin felhasználó admin végponton → 403, bejelentkezés nélkül → 401', async () => {
    const { id } = await activeCompetition(h);
    const user = { user: USER_A, email: 'sima@example.com', pro: true };
    for (const [method, path] of [
      ['GET', '/api/admin/competition'],
      ['POST', '/api/admin/competition'],
      ['POST', `/api/admin/competition/${id}/activate`],
      ['POST', `/api/admin/competition/${id}/sync`],
      ['POST', `/api/admin/competition/${id}/finish`],
      ['GET', `/api/admin/competition/${id}/leaderboard`],
    ] as const) {
      const body = method === 'GET' ? undefined : {};
      expect((await call(h, method, path, user, body)).status, `${method} ${path}`).toBe(403);
      expect((await call(h, method, path, {}, body)).status, `${method} ${path} (anonim)`).toBe(401);
    }
  });

  it('17b. PRO csomag önmagában nem ad admin jogot', async () => {
    const r = await call(h, 'POST', '/api/admin/competition', { user: USER_A, email: 'pro@example.com', pro: true }, {
      name: 'Saját verseny', leagueKey: 'eng-pl', startsAt: hours(1), endsAt: hours(10),
    });
    expect(r.status).toBe(403);
    expect(await h.svc.listAll()).toHaveLength(0);
  });

  it('18. Admin végpontok működnek az ADMIN_EMAILS-ben szereplő fiókkal', async () => {
    const leagues = await call(h, 'GET', '/api/admin/competition/leagues', ADMIN);
    expect(leagues.status).toBe(200);
    expect(leagues.body.map((l: any) => l.leagueKey)).toContain('eng-pl');

    const created = await call(h, 'POST', '/api/admin/competition', ADMIN, {
      name: 'Premier League Tippverseny', leagueKey: 'eng-pl', startsAt: hours(1), endsAt: hours(50),
    });
    expect(created.status).toBe(200);
    expect(created.body.status).toBe('draft'); // létrehozáskor mindig piszkozat
    expect(created.body.leagueName).toBe('Premier League');

    const activated = await call(h, 'POST', `/api/admin/competition/${created.body.id}/activate`, ADMIN);
    expect(activated.status).toBe(200);
    expect(activated.body.status).toBe('active');

    const synced = await call(h, 'POST', `/api/admin/competition/${created.body.id}/sync`, ADMIN);
    expect(synced.status).toBe(200);
    expect(synced.body.inserted).toBe(2); // csak az eng-pl meccsek
  });

  it('18b. Nem elérhető ligára nem hozható létre verseny', async () => {
    const r = await call(h, 'POST', '/api/admin/competition', ADMIN, {
      name: 'Nemlétező liga', leagueKey: 'hun-nb1', startsAt: hours(1), endsAt: hours(10),
    });
    expect(r.status).toBe(400);
  });

  it('18c. A jutalom státusza csak admin végponton módosítható', async () => {
    const { id, matches } = await activeCompetition(h);
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, pro: true }, { competitionMatchId: matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1 });
    h.provider.matches[0] = { ...h.provider.matches[0], status: 'finished', homeGoals: 2, awayGoals: 1 };
    await call(h, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);
    await call(h, 'POST', `/api/admin/competition/${id}/finish`, ADMIN);
    const rewards = await h.svc.rewards(id);

    const denied = await call(h, 'PATCH', `/api/admin/competition/${id}/rewards/${rewards[0].id}`, { user: USER_A, pro: true }, { status: 'granted' });
    expect(denied.status).toBe(403);

    const ok = await call(h, 'PATCH', `/api/admin/competition/${id}/rewards/${rewards[0].id}`, ADMIN, { status: 'granted' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('granted');

    const bad = await call(h, 'PATCH', `/api/admin/competition/${id}/rewards/${rewards[0].id}`, ADMIN, { status: 'pro_forever' });
    expect(bad.status).toBe(400);
  });
});

// ===========================================================================
// 19–20. Több verseny egyszerre, egymástól függetlenül
// ===========================================================================

describe('Tippverseny – több verseny egyszerre', () => {
  it('19. Két verseny egyszerre aktív lehet', async () => {
    const pl = await activeCompetition(h, 'Premier League Tippverseny', 'eng-pl');
    const ll = await activeCompetition(h, 'LaLiga Tippverseny', 'esp-ll');
    const list = await call(h, 'GET', '/api/competition');
    expect(list.body).toHaveLength(2);
    expect(list.body.every((c: any) => c.status === 'active')).toBe(true);
    expect(pl.matches).toHaveLength(2);
    expect(ll.matches).toHaveLength(1);
  });

  it('20. A Premier League és a LaLiga verseny adatai elkülönülnek', async () => {
    const pl = await activeCompetition(h, 'Premier League Tippverseny', 'eng-pl');
    const ll = await activeCompetition(h, 'LaLiga Tippverseny', 'esp-ll');

    await call(h, 'POST', `/api/competition/${pl.id}/predictions`, { user: USER_A, pro: true }, { competitionMatchId: pl.matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1 });
    await call(h, 'POST', `/api/competition/${ll.id}/predictions`, { user: USER_B, pro: true }, { competitionMatchId: ll.matches[0].id, predictedHomeScore: 1, predictedAwayScore: 1 });

    expect(await h.svc.myPredictions(pl.id, USER_B)).toEqual([]);
    expect(await h.svc.myPredictions(ll.id, USER_A)).toEqual([]);

    const plLb = await h.svc.leaderboard(pl.id, null);
    const llLb = await h.svc.leaderboard(ll.id, null);
    expect(plLb).toHaveLength(1);
    expect(llLb).toHaveLength(1);
    expect(plLb[0].displayName).toBe('Martin23');
    expect(llLb[0].displayName).toBe('Zsolti88');

    // az egyik verseny lezárása nem érinti a másikat
    h.provider.matches[0] = { ...h.provider.matches[0], status: 'finished', homeGoals: 2, awayGoals: 1 };
    await call(h, 'POST', `/api/admin/competition/${pl.id}/sync`, ADMIN);
    await call(h, 'POST', `/api/admin/competition/${pl.id}/finish`, ADMIN);
    expect((await h.svc.get(pl.id)).status).toBe('finished');
    expect((await h.svc.get(ll.id)).status).toBe('active');
    expect(await h.svc.rewards(ll.id)).toEqual([]);
  });
});

// ===========================================================================
// Megjelenítési név (Display Name) – a Tippverseny részvételi feltétele
// ===========================================================================

const USER_D = '44444444-4444-4444-4444-444444444444';

describe('Display Name – részvételi feltétel', () => {
  it('DN1. PRO felhasználó megjelenítési név nélkül → 403 DISPLAY_NAME_REQUIRED', async () => {
    const { id, matches } = await activeCompetition(h);
    const r = await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_D, pro: true }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1,
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('DISPLAY_NAME_REQUIRED');
    expect(await h.store.getPrediction(USER_D, matches[0].id)).toBeNull();
  });

  it('DN2. PRO felhasználó érvényes névvel sikeresen tippel', async () => {
    const { id, matches } = await activeCompetition(h);
    const saved = await call(h, 'PUT', '/api/profile/display-name', { user: USER_D, pro: true }, { displayName: 'UjJatekos' });
    expect(saved.status).toBe(200);
    const r = await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_D, pro: true }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1,
    });
    expect(r.status).toBe(200);
  });

  it('DN3. FREE felhasználó érvényes névvel is 403-at kap', async () => {
    const { id, matches } = await activeCompetition(h);
    const r = await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 1, predictedAwayScore: 1,
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PRO_REQUIRED'); // a PRO-ellenőrzés előbb fut
  });
});

describe('Display Name – mentés és egyediség', () => {
  it('DN4. A név menthető és visszaolvasható', async () => {
    const who = { user: USER_D, pro: true };
    expect((await call(h, 'GET', '/api/profile/me', who)).body.hasDisplayName).toBe(false);
    const saved = await call(h, 'PUT', '/api/profile/display-name', who, { displayName: '  Martin_99  ' });
    expect(saved.status).toBe(200);
    expect(saved.body.displayName).toBe('Martin_99'); // normalizálva (körbevágva)
    const me = await call(h, 'GET', '/api/profile/me', who);
    expect(me.body).toEqual(expect.objectContaining({ displayName: 'Martin_99', hasDisplayName: true }));
  });

  it('DN5. A név később módosítható, és a régi név felszabadul', async () => {
    const who = { user: USER_D, pro: true };
    await call(h, 'PUT', '/api/profile/display-name', who, { displayName: 'ElsoNev' });
    const second = await call(h, 'PUT', '/api/profile/display-name', who, { displayName: 'MasodikNev' });
    expect(second.status).toBe(200);
    expect((await call(h, 'GET', '/api/profile/me', who)).body.displayName).toBe('MasodikNev');
    // a felszabadult nevet más már elveheti
    const other = await call(h, 'PUT', '/api/profile/display-name', { user: USER_B, pro: true }, { displayName: 'ElsoNev' });
    expect(other.status).toBe(200);
  });

  it('DN6. Foglalt név → 409', async () => {
    const r = await call(h, 'PUT', '/api/profile/display-name', { user: USER_D, pro: true }, { displayName: 'Martin23' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('TAKEN');
  });

  it('DN7. Az egyediség kis-nagybetűtől független', async () => {
    const r = await call(h, 'PUT', '/api/profile/display-name', { user: USER_D, pro: true }, { displayName: 'mArTiN23' });
    expect(r.status).toBe(409);
    // a saját nevét viszont bárki átírhatja más írásmódra
    const own = await call(h, 'PUT', '/api/profile/display-name', { user: USER_A, pro: true }, { displayName: 'MARTIN23' });
    expect(own.status).toBe(200);
  });

  it('DN8–DN10. Megtévesztő nevek tiltva – nagybetűvel, szóközzel és leet-írásmóddal is', async () => {
    const who = { user: USER_D, pro: true };
    for (const name of ['adminisztrator', 'ADMIN99', 'A d m i n', 'a.d.m.i.n', 'Moderator1', 'Official_Page', 'TippStats Admin']) {
      const r = await call(h, 'PUT', '/api/profile/display-name', who, { displayName: name });
      expect(r.status, name).toBe(400);
      expect(r.body.error, name).toBe('Ez a megjelenítési név nem használható.');
      expect(JSON.stringify(r.body).toLowerCase(), name).not.toContain('tiltott szó:');
    }
    expect((await call(h, 'GET', '/api/profile/me', who)).body.hasDisplayName).toBe(false);
  });

  it('DN8b. Trágár név elutasítva kisbetűvel, nagybetűvel és leet-írásmóddal is', async () => {
    const who = { user: USER_D, pro: true };
    for (const name of ['faszfej', 'FaszFej', 'f a s z f e j', 'fuckyou', 'FUCK_YOU', 'n1gger']) {
      const r = await call(h, 'PUT', '/api/profile/display-name', who, { displayName: name });
      expect(r.status, name).toBe(400);
    }
  });

  it('DN11. Hosszúság és karakterkészlet ellenőrzése', async () => {
    const who = { user: USER_D, pro: true };
    expect((await call(h, 'PUT', '/api/profile/display-name', who, { displayName: 'ab' })).status).toBe(400);
    expect((await call(h, 'PUT', '/api/profile/display-name', who, { displayName: 'a'.repeat(21) })).status).toBe(400);
    expect((await call(h, 'PUT', '/api/profile/display-name', who, { displayName: '<script>x</script>' })).status).toBe(400);
    expect((await call(h, 'PUT', '/api/profile/display-name', who, { displayName: 'a\\b' })).status).toBe(400); // visszaper tiltott
    expect((await call(h, 'PUT', '/api/profile/display-name', who, { displayName: 'Jó Név 7' })).status).toBe(200);
  });
});

describe('Display Name – biztonság', () => {
  it('DN12. Más felhasználó neve nem módosítható (a törzsben küldött user_id-t nem olvassuk)', async () => {
    const r = await call(h, 'PUT', '/api/profile/display-name', { user: USER_D, pro: true }, {
      displayName: 'SajatNev', user_id: USER_A, userId: USER_A, id: USER_A,
    });
    expect(r.status).toBe(200);
    expect(await h.names.get(USER_A)).toBe('Martin23'); // változatlan
    expect(await h.names.get(USER_D)).toBe('SajatNev');
  });

  it('DN13. Bejelentkezés nélkül a profil nem olvasható és nem írható', async () => {
    expect((await call(h, 'GET', '/api/profile/me')).status).toBe(401);
    expect((await call(h, 'PUT', '/api/profile/display-name', {}, { displayName: 'Barki' })).status).toBe(401);
  });

  it('DN14. A prediction kérésben küldött display_name mezőt a rendszer figyelmen kívül hagyja', async () => {
    const { id, matches } = await activeCompetition(h);
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, pro: true }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1,
      display_name: 'Admin', displayName: 'Admin',
    });
    expect(await h.names.get(USER_A)).toBe('Martin23'); // a profil nem íródott felül
    const lb = await call(h, 'GET', `/api/competition/${id}/leaderboard`);
    expect(lb.body[0].displayName).toBe('Martin23');
  });

  it('DN15. A ranglista a tárolt nevet mutatja, user_id, e-mail és előfizetési adat nélkül', async () => {
    const { id, matches } = await activeCompetition(h);
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, email: 'valaki@example.com', pro: true }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1,
    });
    const lb = await call(h, 'GET', `/api/competition/${id}/leaderboard`, { user: USER_B, pro: true });
    expect(lb.raw).not.toContain('@');
    expect(lb.raw).not.toContain(USER_A);
    expect(lb.raw).not.toContain('subscription');
    expect(Object.keys(lb.body[0]).sort()).toEqual(['displayName', 'exactHits', 'isMe', 'points', 'predictions', 'rank']);
    expect(lb.body[0].displayName).toBe('Martin23');
  });

  it('DN16. Az "Admin" jellegű név nem ad admin jogosultságot (és nem is állítható be)', async () => {
    expect((await call(h, 'PUT', '/api/profile/display-name', { user: USER_D, pro: true }, { displayName: 'Admin' })).status).toBe(400);
    // még ha a tárban mégis szerepelne, akkor sem adna admin jogot
    await h.names.set(USER_D, 'Admin');
    const r = await call(h, 'GET', '/api/admin/competition', { user: USER_D, email: 'nem-admin@example.com', pro: true });
    expect(r.status).toBe(403);
  });

  it('DN17. A jutalom a user_id-hoz kötődik, nem a névhez – névváltás után is', async () => {
    const { id, matches } = await activeCompetition(h);
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_A, pro: true }, { competitionMatchId: matches[0].id, predictedHomeScore: 2, predictedAwayScore: 1 });
    h.provider.matches[0] = { ...h.provider.matches[0], status: 'finished', homeGoals: 2, awayGoals: 1 };
    await call(h, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);
    await call(h, 'POST', `/api/admin/competition/${id}/finish`, ADMIN);

    const before = await h.svc.rewards(id);
    expect(before[0].userId).toBe(USER_A);
    expect(before[0].displayName).toBe('Martin23');

    await call(h, 'PUT', '/api/profile/display-name', { user: USER_A, pro: true }, { displayName: 'UjNevem' });
    const after = await h.svc.rewards(id);
    expect(after[0].userId).toBe(USER_A);         // az azonosító változatlan
    expect(after[0].displayName).toBe('UjNevem'); // csak a megjelenítés követi
  });

  it('DN18. Név nélküli felhasználóhoz is van nem azonosító jellegű tartaléknév', async () => {
    const { id, matches } = await activeCompetition(h);
    await h.store.upsertPrediction(USER_D, matches[0].id, 1, 1); // tároló szintű beszúrás, az API megkerülésével
    const lb = await h.svc.leaderboard(id, null);
    expect(lb[0].displayName).toBe(displayNameFor(USER_D));
    expect(lb[0].displayName).not.toContain('@');
  });
});
