/**
 * 1v1 Tipp Battle – életciklus, jogosultság, IZOLÁCIÓ, biztonság, versenyhelyzet,
 * lezárás és tipp-láthatóság.
 *
 * A HTTP-szintű teszteknél valódi Express alkalmazást indítunk a VALÓDI routerekkel
 * és a VALÓDI requirePro / requireAuthenticated őrökkel. Az egyetlen szimulált elem
 * a `res.locals.plan` (élesben az attachPlan tölti ki a tokenből) és a PRO-halmaz
 * forrása (élesben a profiles tábla).
 *
 * Az IZOLÁCIÓS blokk a legfontosabb: azt bizonyítja, hogy a battle egyetlen
 * meglévő Tippverseny / FREE kvóta / küldetés / progression adatot sem módosít.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { SqliteCompetitionStore } from '../src/server/competition/store';
import { SqliteProgressionStore } from '../src/server/progression/store';
import { SqliteBattleStore } from '../src/server/battles/store';
import { CompetitionService } from '../src/server/competition/service';
import { BattleService } from '../src/server/battles/service';
import { MissionService } from '../src/server/missions/service';
import { ProgressionService } from '../src/server/progression/service';
import { battlesRouter } from '../src/server/routes/battles';
import { competitionRouter, adminCompetitionRouter } from '../src/server/routes/competition';
import { missionsRouter } from '../src/server/routes/missions';
import { requireAdmin } from '../src/server/billing/entitlement';
import { InMemoryDisplayNameDirectory } from '../src/server/profile/displayNameDirectory';
import {
  BATTLE_MATCH_COUNT, BATTLE_XP, INVITE_TTL_HOURS, MAX_PENDING_BATTLES,
  battleWinner, effectiveStatus, outcomeFor,
} from '../src/shared/battles';
import { FREE_DAILY_PREDICTION_LIMIT, budapestDayWindow } from '../src/shared/freeQuota';
import { scorePrediction } from '../src/shared/competition';
import type { MatchDataProvider } from '../src/server/data/provider';
import type { League, Match, MatchResult, Team } from '../src/shared/types';

const ADMIN_EMAIL = 'admin@example.com';
const PRO_A = '11111111-1111-1111-1111-111111111111';
const PRO_B = '22222222-2222-2222-2222-222222222222';
const PRO_C = '33333333-3333-3333-3333-333333333333';
const FREE_D = '44444444-4444-4444-4444-444444444444';
const PRO_NONAME = '55555555-5555-5555-5555-555555555555';
const ADMIN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GHOST = '99999999-9999-9999-9999-999999999999';

const hours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();

// ---------------------------------------------------------------------------

const LEAGUES: League[] = [
  { id: 'eng-pl', name: 'Premier League', country: 'Anglia', countryCode: 'ENG', tier: 1, international: false },
];
const TEAM_IDS = ['liverpool', 'arsenal', 'chelsea', 'everton', 'tottenham', 'newcastle', 'fulham', 'brentford'];
const TEAMS: Team[] = TEAM_IDS.map((id) => ({
  id, name: id, shortName: id.slice(0, 3).toUpperCase(), country: 'Anglia', leagueId: 'eng-pl',
}));

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

const mk = (id: string, home: string, away: string, kickoff: string): Match => ({
  id, leagueId: 'eng-pl', homeTeamId: home, awayTeamId: away, kickoff, status: 'scheduled',
  importance: 'normal', importanceReasons: [], origin: 'live',
});

// ---------------------------------------------------------------------------

interface Harness {
  url: string;
  close: () => Promise<void>;
  battles: SqliteBattleStore;
  competitions: SqliteCompetitionStore;
  progression: SqliteProgressionStore;
  svc: BattleService;
  competitionSvc: CompetitionService;
  names: InMemoryDisplayNameDirectory;
  proUsers: Set<string>;
}

async function startApp(): Promise<Harness> {
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  const db = new DatabaseSync(':memory:');
  const competitions = new SqliteCompetitionStore(db);
  const progression = new SqliteProgressionStore(db);
  const battles = new SqliteBattleStore(db);
  const names = new InMemoryDisplayNameDirectory();
  const proUsers = new Set([PRO_A, PRO_B, PRO_C, PRO_NONAME, ADMIN_ID]);

  const matches: Match[] = [
    mk('m1', 'liverpool', 'arsenal', hours(3)),
    mk('m2', 'chelsea', 'everton', hours(5)),
    mk('m3', 'tottenham', 'newcastle', hours(7)),
    mk('m4', 'fulham', 'brentford', hours(9)),
    mk('m5', 'arsenal', 'chelsea', hours(11)),
    mk('m6', 'everton', 'liverpool', hours(13)),
  ];
  const provider = new FakeProvider(matches);
  const progressionSvc = new ProgressionService(progression, async (id) => proUsers.has(id));
  const missionSvc = new MissionService(progression, async (id) => proUsers.has(id));
  const competitionSvc = new CompetitionService(
    competitions, provider, names, progressionSvc,
    async (ids) => new Set(ids.filter((id) => proUsers.has(id))),
  );
  const svc = new BattleService(
    battles, competitions, names,
    async (id) => proUsers.has(id),
    async (ids) => new Set(ids.filter((id) => proUsers.has(id))),
    (ids) => progressionSvc.publicProfiles(ids),
  );

  for (const [id, name] of [[PRO_A, 'ProAnna'], [PRO_B, 'ProBela'], [PRO_C, 'ProCili'],
    [FREE_D, 'FreeDori'], [ADMIN_ID, 'Admin']] as const) {
    await names.set(id, name);
  }
  // PRO_NONAME szándékosan NEM kap megjelenítési nevet

  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    const email = (req.header('x-test-email') ?? '').toLowerCase();
    const admins = new Set((process.env.ADMIN_EMAILS ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean));
    res.locals.plan = {
      enforced: true,
      user: id ? { id, email } : null,
      // A csomagot a SZERVER dönti el – soha nem a kliens fejléce
      pro: !!id && proUsers.has(id),
      admin: !!email && admins.has(email),
    };
    next();
  });
  app.use('/api/admin/competition', requireAdmin, adminCompetitionRouter(competitionSvc));
  app.use('/api/competition', competitionRouter(competitionSvc));
  app.use('/api/missions', missionsRouter(missionSvc));
  app.use('/api/battles', battlesRouter(svc));

  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    battles, competitions, progression, svc, competitionSvc, names, proUsers,
  };
}

type Who = { user?: string; email?: string };
async function call(h: Harness, method: string, path: string, who: Who = {}, body?: unknown) {
  const res = await fetch(`${h.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(who.user ? { 'x-test-user': who.user } : {}),
      ...(who.email ? { 'x-test-email': who.email } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* nem JSON */ }
  return { status: res.status, body: json, raw: text };
}

const ADMIN: Who = { user: ADMIN_ID, email: ADMIN_EMAIL };

/** Aktív Tippverseny, szinkronizált meccsekkel. A battle ebből hivatkoz meccseket. */
async function activeCompetition(h: Harness) {
  const created = await call(h, 'POST', '/api/admin/competition', ADMIN, {
    name: 'Battle teszt verseny', leagueKey: 'eng-pl', startsAt: hours(-1), endsAt: hours(72),
  });
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  await call(h, 'POST', `/api/admin/competition/${id}/activate`, ADMIN);
  await call(h, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);
  const matches = await h.competitions.listMatches(id);
  return { id, matches };
}

/**
 * PRO_A és PRO_B bekerül a Tippverseny ranglistájára (ez a kihívhatóság feltétele),
 * és visszaadja a használható mérkőzés-azonosítókat.
 */
async function seedLeaderboard(h: Harness) {
  const { id, matches } = await activeCompetition(h);
  for (const u of [PRO_A, PRO_B, PRO_C]) {
    await h.competitions.upsertPrediction(u, matches[0].id, 1, 0);
  }
  return { competitionId: id, matches };
}

const threeIds = (matches: { id: string }[]) => matches.slice(0, BATTLE_MATCH_COUNT).map((m) => m.id);

const createBattle = (h: Harness, who: Who, opponentId: string, matchIds: string[]) =>
  call(h, 'POST', '/api/battles', who, { opponentId, competitionMatchIds: matchIds });

/** Eredmény beírása a mérkőzésre (admin úton, a meglévő szinkronnal). */
async function finishMatch(h: Harness, competitionId: string, matchId: string, home: number, away: number) {
  const m = (await h.competitions.listMatches(competitionId)).find((x) => x.id === matchId)!;
  await h.competitions.upsertMatches(competitionId, [{
    externalMatchId: m.externalMatchId, homeTeam: m.homeTeam, awayTeam: m.awayTeam,
    kickoff: m.kickoff, homeScore: home, awayScore: away, status: 'finished',
  }]);
}

let h: Harness;
beforeEach(async () => { h = await startApp(); });
afterEach(async () => { await h.close(); });

// ===========================================================================
// B1–B4  Konfiguráció és tiszta logika
// ===========================================================================

describe('Battle – fix szabályok', () => {
  it('B1. A battle pontosan 3 mérkőzésből áll, a kihívás 24 óra, max 5 nyitott, XP = 0', () => {
    expect(BATTLE_MATCH_COUNT).toBe(3);
    expect(INVITE_TTL_HOURS).toBe(24);
    expect(MAX_PENDING_BATTLES).toBe(5);
    expect(BATTLE_XP).toBe(0);
  });

  it('B2. A pontozás a MEGLÉVŐ scorePrediction 5/3/0 szabálya', () => {
    expect(scorePrediction(2, 1, 2, 1)).toBe(5);
    expect(scorePrediction(3, 1, 2, 1)).toBe(3);
    expect(scorePrediction(0, 2, 2, 1)).toBe(0);
  });

  it('B3. A győztes VALÓDI döntetlent ad: egyenlő pontnál null (nem a ranglista tie-break)', () => {
    expect(battleWinner(PRO_A, PRO_B, 10, 7)).toBe(PRO_A);
    expect(battleWinner(PRO_A, PRO_B, 7, 10)).toBe(PRO_B);
    expect(battleWinner(PRO_A, PRO_B, 8, 8)).toBeNull();
    // a user_id SEM dönt el döntetlent – ez a lényegi különbség a ranglistához képest
    expect(battleWinner(PRO_B, PRO_A, 5, 5)).toBeNull();
  });

  it('B4. A lejárt kihívás állapota számítottan már „expired"', () => {
    const base = { status: 'pending' as const, inviteExpiresAt: hours(-1) };
    expect(effectiveStatus(base)).toBe('expired');
    expect(effectiveStatus({ status: 'pending', inviteExpiresAt: hours(1) })).toBe('pending');
    expect(outcomeFor({ status: 'settled', winnerUserId: null }, PRO_A)).toBe('draw');
    expect(outcomeFor({ status: 'settled', winnerUserId: PRO_A }, PRO_A)).toBe('win');
    expect(outcomeFor({ status: 'settled', winnerUserId: PRO_B }, PRO_A)).toBe('loss');
    expect(outcomeFor({ status: 'active', winnerUserId: null }, PRO_A)).toBeNull();
  });
});

// ===========================================================================
// B5–B12  Életciklus
// ===========================================================================

describe('Battle – életciklus', () => {
  it('B5. Létrehozás: 3 meccs, pending állapot, 24 órás lejárat', async () => {
    const { matches } = await seedLeaderboard(h);
    const r = await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('pending');
    expect(r.body.matches).toHaveLength(3);
    expect(r.body.iAmChallenger).toBe(true);
    expect(r.body.canCancel).toBe(true);
    expect(r.body.canAccept).toBe(false);
    const ttl = new Date(r.body.inviteExpiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(23 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3600_000 + 5000);
  });

  it('B6. Elfogadás: csak az ellenfél, és az állapot active lesz', async () => {
    const { matches } = await seedLeaderboard(h);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;

    // a kihívó nem fogadhatja el a sajátját
    const wrong = await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_A });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('NOT_YOUR_BATTLE');

    const ok = await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('active');
  });

  it('B7. Elutasítás: csak az ellenfél, az állapot declined', async () => {
    const { matches } = await seedLeaderboard(h);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;
    expect((await call(h, 'POST', `/api/battles/${b.id}/decline`, { user: PRO_A })).status).toBe(403);
    const r = await call(h, 'POST', `/api/battles/${b.id}/decline`, { user: PRO_B });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('declined');
  });

  it('B8. Visszavonás: csak a kihívó, az állapot cancelled', async () => {
    const { matches } = await seedLeaderboard(h);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;
    expect((await call(h, 'POST', `/api/battles/${b.id}/cancel`, { user: PRO_B })).status).toBe(403);
    const r = await call(h, 'POST', `/api/battles/${b.id}/cancel`, { user: PRO_A });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('cancelled');
  });

  it('B9. Lejárt kihívás nem fogadható el (CHALLENGE_EXPIRED), és lustán expired lesz', async () => {
    const { matches } = await seedLeaderboard(h);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;
    // A lejáratot a múltba toljuk – a tároló szintjén, az API megkerülésével
    h.battles['db'].prepare('UPDATE battles SET invite_expires_at = ? WHERE id = ?')
      .run(hours(-1), b.id);

    const r = await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CHALLENGE_EXPIRED');
    // a tárolt állapot lustán utánvezetődött
    expect((await h.battles.getBattle(b.id))!.status).toBe('expired');
  });

  it('B10. Már elfogadott battle nem fogadható el újra (BATTLE_INVALID_STATE)', async () => {
    const { matches } = await seedLeaderboard(h);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;
    expect((await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B })).status).toBe(200);
    const again = await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('BATTLE_INVALID_STATE');
    // aktív battle-t visszavonni sem lehet
    const cancel = await call(h, 'POST', `/api/battles/${b.id}/cancel`, { user: PRO_A });
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe('BATTLE_INVALID_STATE');
  });

  it('B11. A lista a megfelelő rekeszekbe sorolja a párbajokat', async () => {
    const { matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const b1 = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    await createBattle(h, { user: PRO_A }, PRO_C, ids);
    await call(h, 'POST', `/api/battles/${b1.id}/accept`, { user: PRO_B });

    const mineA = await call(h, 'GET', '/api/battles', { user: PRO_A });
    expect(mineA.body.active).toHaveLength(1);
    expect(mineA.body.outgoing).toHaveLength(1);
    expect(mineA.body.incoming).toHaveLength(0);

    const mineB = await call(h, 'GET', '/api/battles', { user: PRO_B });
    expect(mineB.body.active).toHaveLength(1);
    expect(mineB.body.incoming).toHaveLength(0);

    const mineC = await call(h, 'GET', '/api/battles', { user: PRO_C });
    expect(mineC.body.incoming).toHaveLength(1);
    expect(mineC.body.pendingIncoming).toBe(1);
  });

  it('B11b. A 3 mérkőzés MINDIG kickoff szerint, determinisztikus sorrendben jön', async () => {
    const { matches } = await seedLeaderboard(h);
    // szándékosan NEM kickoff-sorrendben adjuk meg a hármat
    const shuffled = [matches[2].id, matches[0].id, matches[1].id];
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, shuffled)).body;
    const kickoffs = (b.matches as any[]).map((m) => m.kickoff);
    expect(kickoffs).toEqual([...kickoffs].sort());
    // és ismételt olvasásra ugyanaz a sorrend
    for (let i = 0; i < 3; i++) {
      const again = await call(h, 'GET', `/api/battles/${b.id}`, { user: PRO_A });
      expect((again.body.matches as any[]).map((m) => m.competitionMatchId))
        .toEqual((b.matches as any[]).map((m) => m.competitionMatchId));
    }
    // a lista nézet is ugyanabban a sorrendben adja
    const list = await call(h, 'GET', '/api/battles', { user: PRO_A });
    expect((list.body.outgoing[0].matches as any[]).map((m) => m.competitionMatchId))
      .toEqual((b.matches as any[]).map((m) => m.competitionMatchId));
  });

  it('B12. A lista és a részletek csak display name / avatar / keret / címet adnak', async () => {
    const { matches } = await seedLeaderboard(h);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;
    const detail = await call(h, 'GET', `/api/battles/${b.id}`, { user: PRO_A });
    const raw = JSON.stringify(detail.body);
    expect(detail.body.challenger.displayName).toBe('ProAnna');
    expect(detail.body.opponent.displayName).toBe('ProBela');
    // SOHA nem kerülhet ki e-mail vagy auth azonosító
    expect(raw).not.toContain('@');
    expect(raw).not.toContain(PRO_A);
    expect(raw).not.toContain(PRO_B);
    expect(detail.body.challenger.userId).toBeUndefined();
    expect(Object.keys(detail.body.challenger).sort())
      .toEqual(['avatar', 'borderKey', 'displayName', 'points', 'predictions', 'titleKey']);
  });
});

// ===========================================================================
// B13–B19  Jogosultság és biztonság
// ===========================================================================

describe('Battle – jogosultság és biztonság', () => {
  it('B13. Bejelentkezés nélkül minden battle végpont 401', async () => {
    for (const [method, path] of [
      ['GET', '/api/battles'], ['POST', '/api/battles'], ['GET', `/api/battles/${GHOST}`],
      ['POST', `/api/battles/${GHOST}/accept`], ['POST', `/api/battles/${GHOST}/decline`],
      ['POST', `/api/battles/${GHOST}/cancel`], ['POST', `/api/battles/${GHOST}/predictions`],
      ['GET', '/api/battles/eligible-matches'], ['GET', '/api/battles/eligible-opponents'],
    ] as const) {
      const r = await call(h, method, path);
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.body.code).toBe('AUTH_REQUIRED');
    }
  });

  it('B14. FREE felhasználó nem indíthat és nem fogadhat el párbajt (PRO_REQUIRED)', async () => {
    const { matches } = await seedLeaderboard(h);
    const create = await createBattle(h, { user: FREE_D }, PRO_A, threeIds(matches));
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('PRO_REQUIRED');

    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;
    // FREE harmadik fél nem fogadhatja el (PRO_REQUIRED előbb fut)
    expect((await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: FREE_D })).body.code).toBe('PRO_REQUIRED');
    expect((await call(h, 'GET', '/api/battles/eligible-opponents', { user: FREE_D })).status).toBe(403);
    expect((await call(h, 'GET', '/api/battles/eligible-matches', { user: FREE_D })).status).toBe(403);
  });

  it('B15. Harmadik fél nem látja és nem módosíthatja más párbaját', async () => {
    const { matches } = await seedLeaderboard(h);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;

    const peek = await call(h, 'GET', `/api/battles/${b.id}`, { user: PRO_C });
    expect(peek.status).toBe(403);
    expect(peek.body.code).toBe('NOT_YOUR_BATTLE');
    for (const action of ['accept', 'decline', 'cancel']) {
      const r = await call(h, 'POST', `/api/battles/${b.id}/${action}`, { user: PRO_C });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('NOT_YOUR_BATTLE');
    }
    // a lista sem szivárogtatja
    expect((await call(h, 'GET', '/api/battles', { user: PRO_C })).body.active).toHaveLength(0);
  });

  it('B16. Önmaga kihívása tiltott, és nem létező / nem jogosult ellenfél sem választható', async () => {
    const { matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);

    const self = await createBattle(h, { user: PRO_A }, PRO_A, ids);
    expect(self.status).toBe(422);
    expect(self.body.code).toBe('OPPONENT_NOT_ELIGIBLE');

    // kitalált azonosító
    expect((await createBattle(h, { user: PRO_A }, GHOST, ids)).body.code).toBe('OPPONENT_NOT_ELIGIBLE');
    // FREE felhasználó nem hívható ki
    expect((await createBattle(h, { user: PRO_A }, FREE_D, ids)).body.code).toBe('OPPONENT_NOT_ELIGIBLE');
    // PRO, de nincs megjelenítési neve és nem is ranglista-résztvevő
    expect((await createBattle(h, { user: PRO_A }, PRO_NONAME, ids)).body.code).toBe('OPPONENT_NOT_ELIGIBLE');
  });

  it('B17. Kihívható kör: KIZÁRÓLAG a Tippverseny ranglistán szereplő PRO résztvevők', async () => {
    await seedLeaderboard(h); // PRO_A, PRO_B, PRO_C tippelt
    const r = await call(h, 'GET', '/api/battles/eligible-opponents', { user: PRO_A });
    expect(r.status).toBe(200);
    const ids = (r.body as any[]).map((o) => o.userId).sort();
    expect(ids).toEqual([PRO_B, PRO_C].sort());
    // sem önmaga, sem FREE, sem a név nélküli PRO nincs benne
    expect(ids).not.toContain(PRO_A);
    expect(ids).not.toContain(FREE_D);
    expect(ids).not.toContain(PRO_NONAME);
    for (const o of r.body as any[]) {
      expect(Object.keys(o).sort()).toEqual(['avatar', 'borderKey', 'displayName', 'titleKey', 'userId']);
    }
  });

  it('B18. A kihívónak kell megjelenítési név (DISPLAY_NAME_REQUIRED)', async () => {
    const { matches } = await seedLeaderboard(h);
    // PRO_NONAME ranglista-résztvevővé tesszük, de név nélkül marad
    const r = await createBattle(h, { user: PRO_NONAME }, PRO_A, threeIds(matches));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('DISPLAY_NAME_REQUIRED');
  });

  it('B19. A kliens által küldött user_id / plan / points / winner / status / xp hatástalan', async () => {
    const { matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const r = await call(h, 'POST', '/api/battles', { user: PRO_A }, {
      opponentId: PRO_B, competitionMatchIds: ids,
      // mindezt figyelmen kívül kell hagyni
      user_id: PRO_C, userId: PRO_C, challengerId: PRO_C, challenger_id: PRO_C,
      plan: 'pro', isPro: true, subscription: 'pro',
      status: 'settled', winner_user_id: PRO_C, winnerUserId: PRO_C,
      challenger_points: 999, opponent_points: 0, points: 999, xp: 5000,
      settled_at: new Date().toISOString(), invite_expires_at: hours(9999),
    });
    expect(r.status).toBe(200);
    const row = (await h.battles.listBattlesForUser(PRO_A))[0];
    expect(row.challengerId).toBe(PRO_A);       // a hitelesített hívó, nem a bodyban küldött
    expect(row.opponentId).toBe(PRO_B);
    expect(row.status).toBe('pending');          // nem 'settled'
    expect(row.winnerUserId).toBeNull();
    expect(row.challengerPoints).toBeNull();
    expect(row.opponentPoints).toBeNull();
    expect(row.settledAt).toBeNull();
    // a lejárat a szerver 24 órája, nem a bodyból jött érték
    expect(new Date(row.inviteExpiresAt).getTime() - Date.now()).toBeLessThan(25 * 3600_000);
    // XP nem keletkezett
    expect(await h.progression.totalXp(PRO_A)).toBe(0);
  });
});

// ===========================================================================
// B20–B24  Mérkőzés-választás és korlátok
// ===========================================================================

describe('Battle – mérkőzés-választás és korlátok', () => {
  it('B20. Pontosan 3 mérkőzés kell: 2 és 4 elutasítva (BATTLE_MATCH_COUNT_INVALID)', async () => {
    const { matches } = await seedLeaderboard(h);
    const all = matches.map((m) => m.id);
    for (const sel of [all.slice(0, 1), all.slice(0, 2), all.slice(0, 4), all.slice(0, 5), []]) {
      const r = await createBattle(h, { user: PRO_A }, PRO_B, sel);
      expect(r.status, `${sel.length} meccs`).toBe(422);
      expect(r.body.code).toBe('BATTLE_MATCH_COUNT_INVALID');
    }
    expect((await h.battles.listBattlesForUser(PRO_A)).length).toBe(0);
  });

  it('B21. Duplikált mérkőzés-azonosító elutasítva (nem "tölti fel" a hármat)', async () => {
    const { matches } = await seedLeaderboard(h);
    const r = await createBattle(h, { user: PRO_A }, PRO_B, [matches[0].id, matches[0].id, matches[1].id]);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('BATTLE_MATCH_COUNT_INVALID');
    expect((await h.battles.listBattlesForUser(PRO_A)).length).toBe(0);
  });

  it('B22. Már elkezdődött vagy nem létező mérkőzés nem választható (INVALID_MATCH_SELECTION)', async () => {
    const { competitionId, matches } = await seedLeaderboard(h);
    // m1 kezdését a múltba toljuk
    await h.competitions.upsertMatches(competitionId, [{
      externalMatchId: matches[0].externalMatchId, homeTeam: matches[0].homeTeam, awayTeam: matches[0].awayTeam,
      kickoff: hours(-1), homeScore: null, awayScore: null, status: 'scheduled',
    }]);
    const past = await createBattle(h, { user: PRO_A }, PRO_B, [matches[0].id, matches[1].id, matches[2].id]);
    expect(past.status).toBe(422);
    expect(past.body.code).toBe('INVALID_MATCH_SELECTION');

    const ghost = await createBattle(h, { user: PRO_A }, PRO_B, [GHOST, matches[1].id, matches[2].id]);
    expect(ghost.status).toBe(422);
    expect(ghost.body.code).toBe('INVALID_MATCH_SELECTION');
    expect((await h.battles.listBattlesForUser(PRO_A)).length).toBe(0);
  });

  it('B23. Ugyanarra a párosra nincs második nyitott kihívás (ALREADY_CHALLENGED)', async () => {
    const { matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    expect((await createBattle(h, { user: PRO_A }, PRO_B, ids)).status).toBe(200);
    const again = await createBattle(h, { user: PRO_A }, PRO_B, ids);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_CHALLENGED');
    expect((await h.battles.listBattlesForUser(PRO_A)).length).toBe(1);
  });

  it('B23b. LEJÁRT kihívás után ugyanaz az ellenfél ÚJRA kihívható', async () => {
    const { matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const first = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    // a kihívás lejár, de SENKI nem nyitja meg a listát (nincs lusta utánvezetés)
    h.battles['db'].prepare('UPDATE battles SET invite_expires_at = ? WHERE id = ?')
      .run(hours(-1), first.id);

    const again = await createBattle(h, { user: PRO_A }, PRO_B, ids);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('pending');
    // a régi sor lejártra állt, nem maradt két nyitott kihívás ugyanarra a párosra
    expect((await h.battles.getBattle(first.id))!.status).toBe('expired');
    const rows = await h.battles.listBattlesForUser(PRO_A);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('B23c. A lejárt kihívás nem számít bele az 5-ös korlátba', async () => {
    const { matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const extras = Array.from({ length: 6 }, (_, i) => `6666666${i}-6666-6666-6666-66666666666${i}`);
    for (const [i, id] of extras.entries()) {
      h.proUsers.add(id);
      await h.names.set(id, `Lejart${i}`);
      await h.competitions.upsertPrediction(id, matches[0].id, 1, 0);
    }
    for (let i = 0; i < MAX_PENDING_BATTLES; i++) {
      expect((await createBattle(h, { user: PRO_A }, extras[i], ids)).status).toBe(200);
    }
    // mind az 5 lejár
    h.battles['db'].prepare("UPDATE battles SET invite_expires_at = ? WHERE challenger_id = ? AND status = 'pending'")
      .run(hours(-1), PRO_A);
    // így a 6. kihívás már belefér
    const sixth = await createBattle(h, { user: PRO_A }, extras[MAX_PENDING_BATTLES], ids);
    expect(sixth.status).toBe(200);
  });

  it('B24. Legfeljebb 5 nyitott kihívás (PENDING_BATTLE_LIMIT)', async () => {
    const { matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    // 5 különböző ellenfél kell – vegyük fel őket a ranglistára és adjunk nevet
    const extras = Array.from({ length: 6 }, (_, i) => `7777777${i}-7777-7777-7777-77777777777${i}`);
    for (const [i, id] of extras.entries()) {
      h.proUsers.add(id);
      await h.names.set(id, `Extra${i}`);
      await h.competitions.upsertPrediction(id, matches[0].id, 1, 0);
    }
    for (let i = 0; i < MAX_PENDING_BATTLES; i++) {
      const r = await createBattle(h, { user: PRO_A }, extras[i], ids);
      expect(r.status, `${i + 1}. kihívás`).toBe(200);
    }
    const over = await createBattle(h, { user: PRO_A }, extras[MAX_PENDING_BATTLES], ids);
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('PENDING_BATTLE_LIMIT');
    expect(over.body.maxPending).toBe(MAX_PENDING_BATTLES);
    expect((await h.battles.listBattlesForUser(PRO_A)).length).toBe(MAX_PENDING_BATTLES);
  });
});

// ===========================================================================
// B25–B30  Tippbeküldés és láthatóság
// ===========================================================================

describe('Battle – tippbeküldés és az ellenfél tippjének kitakarása', () => {
  async function activeBattle(hh: Harness) {
    const { competitionId, matches } = await seedLeaderboard(hh);
    const ids = threeIds(matches);
    const b = (await createBattle(hh, { user: PRO_A }, PRO_B, ids)).body;
    await call(hh, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    return { battleId: b.id as string, competitionId, matches, ids };
  }

  it('B25. Pending állapotban nem adható tipp (PREDICTION_CLOSED)', async () => {
    const { matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    const r = await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_A }, {
      competitionMatchId: ids[0], predictedHomeScore: 1, predictedAwayScore: 0,
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PREDICTION_CLOSED');
  });

  it('B26. Aktív battle-ben adható és módosítható a tipp; a submitted_at nem változik', async () => {
    const { battleId, ids } = await activeBattle(h);
    const first = await call(h, 'POST', `/api/battles/${battleId}/predictions`, { user: PRO_A }, {
      competitionMatchId: ids[0], predictedHomeScore: 2, predictedAwayScore: 1,
    });
    expect(first.status).toBe(200);
    const before = (await h.battles.listPredictions(battleId)).find((p) => p.userId === PRO_A)!;

    const second = await call(h, 'POST', `/api/battles/${battleId}/predictions`, { user: PRO_A }, {
      competitionMatchId: ids[0], predictedHomeScore: 3, predictedAwayScore: 3,
    });
    expect(second.status).toBe(200);
    const after = (await h.battles.listPredictions(battleId)).find((p) => p.userId === PRO_A)!;
    expect(after.id).toBe(before.id);
    expect(after.submittedAt).toBe(before.submittedAt);
    expect(after.predictedHomeScore).toBe(3);
    expect((await h.battles.listPredictions(battleId)).length).toBe(1);
  });

  it('B27. Érvénytelen gólszám és idegen mérkőzés elutasítva', async () => {
    const { battleId, ids, matches } = await activeBattle(h);
    for (const body of [
      { competitionMatchId: ids[0], predictedHomeScore: -1, predictedAwayScore: 0 },
      { competitionMatchId: ids[0], predictedHomeScore: 100, predictedAwayScore: 0 },
      { competitionMatchId: ids[0], predictedHomeScore: 'x', predictedAwayScore: 0 },
      { competitionMatchId: ids[0], predictedAwayScore: 1 },
    ]) {
      const r = await call(h, 'POST', `/api/battles/${battleId}/predictions`, { user: PRO_A }, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    // a battle-hez nem tartozó mérkőzés
    const alien = await call(h, 'POST', `/api/battles/${battleId}/predictions`, { user: PRO_A }, {
      competitionMatchId: matches[5].id, predictedHomeScore: 1, predictedAwayScore: 0,
    });
    expect(alien.status).toBe(404);
    expect(alien.body.code).toBe('BATTLE_NOT_FOUND');
    expect((await h.battles.listPredictions(battleId)).length).toBe(0);
  });

  it('B28. Kickoff ELŐTT az ellenfél tippje nincs a válaszban, csak a ténye', async () => {
    const { battleId, ids } = await activeBattle(h);
    await call(h, 'POST', `/api/battles/${battleId}/predictions`, { user: PRO_B }, {
      competitionMatchId: ids[0], predictedHomeScore: 4, predictedAwayScore: 2,
    });

    const seen = await call(h, 'GET', `/api/battles/${battleId}`, { user: PRO_A });
    const m = (seen.body.matches as any[]).find((x) => x.competitionMatchId === ids[0]);
    expect(m.opponentHasPredicted).toBe(true);
    expect(m.opponentPrediction).toBeNull();
    // a konkrét gólszám a SZERIALIZÁLT válaszban sem szerepel sehol
    expect(JSON.stringify(seen.body)).not.toContain('"predictedHomeScore":4');
  });

  it('B29. Kickoff UTÁN az ellenfél tippje láthatóvá válik', async () => {
    const { battleId, competitionId, ids, matches } = await activeBattle(h);
    await call(h, 'POST', `/api/battles/${battleId}/predictions`, { user: PRO_B }, {
      competitionMatchId: ids[0], predictedHomeScore: 4, predictedAwayScore: 2,
    });
    // a mérkőzés kezdése elmúlik
    await h.competitions.upsertMatches(competitionId, [{
      externalMatchId: matches[0].externalMatchId, homeTeam: matches[0].homeTeam, awayTeam: matches[0].awayTeam,
      kickoff: hours(-1), homeScore: null, awayScore: null, status: 'live',
    }]);

    const seen = await call(h, 'GET', `/api/battles/${battleId}`, { user: PRO_A });
    const m = (seen.body.matches as any[]).find((x) => x.competitionMatchId === ids[0]);
    expect(m.opponentPrediction).toMatchObject({ predictedHomeScore: 4, predictedAwayScore: 2 });
    expect(m.open).toBe(false); // és már nem tippelhető
  });

  it('B30. Kickoff után a saját tipp sem módosítható (PREDICTION_CLOSED)', async () => {
    const { battleId, competitionId, ids, matches } = await activeBattle(h);
    await call(h, 'POST', `/api/battles/${battleId}/predictions`, { user: PRO_A }, {
      competitionMatchId: ids[0], predictedHomeScore: 1, predictedAwayScore: 1,
    });
    await h.competitions.upsertMatches(competitionId, [{
      externalMatchId: matches[0].externalMatchId, homeTeam: matches[0].homeTeam, awayTeam: matches[0].awayTeam,
      kickoff: hours(-1), homeScore: null, awayScore: null, status: 'live',
    }]);
    const r = await call(h, 'POST', `/api/battles/${battleId}/predictions`, { user: PRO_A }, {
      competitionMatchId: ids[0], predictedHomeScore: 9, predictedAwayScore: 9,
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PREDICTION_CLOSED');
    const p = (await h.battles.listPredictions(battleId))[0];
    expect(p.predictedHomeScore).toBe(1); // változatlan
  });
});

// ===========================================================================
// B31–B33  PRO lejárat battle közben
// ===========================================================================

describe('Battle – PRO lejárat futó párbaj közben', () => {
  it('B31. A már elfogadott párbaj a PRO elvesztése után is végigvihető', async () => {
    const { matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    expect((await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B })).status).toBe(200);

    // PRO_A elveszíti a PRO-t (élesben: lejárt subscription_end)
    h.proUsers.delete(PRO_A);

    // a párbaj továbbra is látható…
    expect((await call(h, 'GET', `/api/battles/${b.id}`, { user: PRO_A })).status).toBe(200);
    expect((await call(h, 'GET', '/api/battles', { user: PRO_A })).body.active).toHaveLength(1);
    // …és a tipp leadható és módosítható
    const p1 = await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_A }, {
      competitionMatchId: ids[0], predictedHomeScore: 2, predictedAwayScore: 1,
    });
    expect(p1.status).toBe(200);
    const p2 = await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_A }, {
      competitionMatchId: ids[0], predictedHomeScore: 3, predictedAwayScore: 1,
    });
    expect(p2.status).toBe(200);
  });

  it('B32. PRO nélkül viszont ÚJ párbaj nem indítható és nem fogadható el', async () => {
    const { matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const incoming = (await createBattle(h, { user: PRO_B }, PRO_A, ids)).body;

    h.proUsers.delete(PRO_A);

    expect((await createBattle(h, { user: PRO_A }, PRO_C, ids)).body.code).toBe('PRO_REQUIRED');
    expect((await call(h, 'POST', `/api/battles/${incoming.id}/accept`, { user: PRO_A })).body.code).toBe('PRO_REQUIRED');
  });

  it('B33. PRO nélkül a bejövő kihívás elutasítható és a kimenő visszavonható', async () => {
    const { matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const incoming = (await createBattle(h, { user: PRO_B }, PRO_A, ids)).body;
    const outgoing = (await createBattle(h, { user: PRO_A }, PRO_C, ids)).body;

    h.proUsers.delete(PRO_A);

    expect((await call(h, 'POST', `/api/battles/${incoming.id}/decline`, { user: PRO_A })).status).toBe(200);
    expect((await call(h, 'POST', `/api/battles/${outgoing.id}/cancel`, { user: PRO_A })).status).toBe(200);
  });
});

// ===========================================================================
// B34–B40  IZOLÁCIÓ – a legfontosabb blokk
// ===========================================================================

describe('Battle – IZOLÁCIÓ a Tippversenytől, a FREE kvótától, a küldetésektől és a progressiontől', () => {
  /** Minden meglévő rendszer állapota egy pillanatfelvételen. */
  async function snapshot(hh: Harness, competitionId: string) {
    const [board, quotaA, quotaB, missionsA, xpA, xpB] = await Promise.all([
      call(hh, 'GET', `/api/competition/${competitionId}/leaderboard`, { user: PRO_A }),
      hh.competitions.countPredictionsCreatedIn(PRO_A, budapestDayWindow()),
      hh.competitions.countPredictionsCreatedIn(PRO_B, budapestDayWindow()),
      call(hh, 'GET', '/api/missions', { user: PRO_A }),
      hh.progression.totalXp(PRO_A),
      hh.progression.totalXp(PRO_B),
    ]);
    const preds = hh.competitions['db'].prepare('SELECT COUNT(*) AS n FROM user_predictions').get() as any;
    const events = hh.progression['db'].prepare('SELECT COUNT(*) AS n FROM progression_events').get() as any;
    // A küldetéseknél a HALADÁST hasonlítjuk, nem a nyers JSON-t: a `resetsAt` mező
    // a missions.ts bináris keresése miatt milliszekundumos szórást mutat két hívás
    // között (ismert, kozmetikai viselkedés), ami elrejtené a valódi összehasonlítást.
    const missionProgress = (r: any) => JSON.stringify({
      daily: (r.body?.daily?.missions ?? []).map((m: any) => [m.key, m.progress, m.completed, m.claimed, m.xpAwarded]),
      weekly: (r.body?.weekly?.missions ?? []).map((m: any) => [m.key, m.progress, m.completed, m.claimed, m.xpAwarded]),
      claimedTotal: r.body?.claimedTotal,
    });
    return {
      board: JSON.stringify(board.body),
      quotaA, quotaB,
      missions: missionProgress(missionsA),
      xpA, xpB,
      userPredictions: preds.n as number,
      progressionEvents: events.n as number,
    };
  }

  it('B34. Egy teljes battle (3 tipp mindkét féltől + lezárás) SEMMIT nem változtat', async () => {
    const { competitionId, matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const before = await snapshot(h, competitionId);

    const b = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    for (const [i, mid] of ids.entries()) {
      for (const u of [PRO_A, PRO_B]) {
        const r = await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: u }, {
          competitionMatchId: mid, predictedHomeScore: i + 1, predictedAwayScore: u === PRO_A ? 0 : 1,
        });
        expect(r.status).toBe(200);
      }
    }
    // Minden mérkőzés lezárul → lusta battle-lezárás.
    // SZÁNDÉKOSAN 4-2 az eredmény: a seedLeaderboard Tippverseny-tippje 1-0, így az
    // eredmény nem egyezik vele. A Tippverseny ranglista `exactHits` mezője ugyanis
    // ÉLŐBEN számított a mérkőzés eredményéből – ha egyeznének, a ranglista a
    // megosztott eredmény miatt változna, nem a battle miatt. Így a pillanatfelvétel
    // kizárólag a battle hatását méri.
    for (const mid of ids) await finishMatch(h, competitionId, mid, 4, 2);
    const settled = await call(h, 'GET', `/api/battles/${b.id}`, { user: PRO_A });
    expect(settled.body.status).toBe('settled');

    const after = await snapshot(h, competitionId);
    expect(after.board).toBe(before.board);                       // 1. ranglista változatlan
    expect(after.quotaA).toBe(before.quotaA);                     // 2. FREE kvóta változatlan
    expect(after.quotaB).toBe(before.quotaB);
    expect(after.missions).toBe(before.missions);                 // 3. küldetés-haladás változatlan
    expect(after.progressionEvents).toBe(before.progressionEvents); // 4. progression események változatlan
    expect(after.xpA).toBe(before.xpA);
    expect(after.xpB).toBe(before.xpB);
    expect(after.userPredictions).toBe(before.userPredictions);   // 5. user_predictions darabszám változatlan
  });

  it('B35. A battle tipp a battle_predictions táblába kerül, a user_predictions-be SOHA', async () => {
    const { competitionId, matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const beforeRows = h.competitions['db'].prepare('SELECT id, predicted_home_score, predicted_away_score FROM user_predictions ORDER BY id').all();

    const b = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_A }, {
      competitionMatchId: ids[0], predictedHomeScore: 7, predictedAwayScore: 7,
    });

    expect((await h.battles.listPredictions(b.id)).length).toBe(1);
    const afterRows = h.competitions['db'].prepare('SELECT id, predicted_home_score, predicted_away_score FROM user_predictions ORDER BY id').all();
    expect(afterRows).toEqual(beforeRows);
    // a jellegzetes 7–7 tipp SEHOL nem jelenik meg a Tippverseny tábláiban
    const seven = h.competitions['db'].prepare(
      'SELECT COUNT(*) AS n FROM user_predictions WHERE predicted_home_score = 7 AND predicted_away_score = 7',
    ).get() as any;
    expect(seven.n).toBe(0);
    void competitionId;
  });

  it('B36. Ugyanarra a mérkőzésre Tippverseny-tipp ÉS battle-tipp együtt él, egymást nem írja felül', async () => {
    const { competitionId, matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });

    // Tippverseny-tipp a VALÓDI végponton ugyanarra a mérkőzésre
    const comp = await call(h, 'POST', `/api/competition/${competitionId}/predictions`, { user: PRO_A }, {
      competitionMatchId: ids[0], predictedHomeScore: 2, predictedAwayScore: 2,
    });
    expect(comp.status).toBe(200);
    // battle-tipp ugyanarra, MÁS értékkel
    const bat = await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_A }, {
      competitionMatchId: ids[0], predictedHomeScore: 5, predictedAwayScore: 0,
    });
    expect(bat.status).toBe(200);

    // Mindkettő megmaradt, a saját táblájában, a saját értékével
    const cp = await h.competitions.getPrediction(PRO_A, ids[0]);
    expect(cp).toMatchObject({ predictedHomeScore: 2, predictedAwayScore: 2 });
    const bp = (await h.battles.listPredictions(b.id)).find((p) => p.userId === PRO_A)!;
    expect(bp).toMatchObject({ predictedHomeScore: 5, predictedAwayScore: 0 });
  });

  it('B37. A battle tipp nem fogyaszt FREE napi Tippverseny-kvótát', async () => {
    const { matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });

    const w = budapestDayWindow();
    const before = await h.competitions.countPredictionsCreatedIn(PRO_A, w);
    for (const mid of ids) {
      await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_A }, {
        competitionMatchId: mid, predictedHomeScore: 1, predictedAwayScore: 0,
      });
    }
    expect(await h.competitions.countPredictionsCreatedIn(PRO_A, w)).toBe(before);
    expect(FREE_DAILY_PREDICTION_LIMIT).toBe(3); // a Tippverseny kvóta szabálya változatlan
  });

  it('B38. A battle tipp nem számít küldetés-haladásba', async () => {
    const { matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const before = await call(h, 'GET', '/api/missions', { user: PRO_A });
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    for (const mid of ids) {
      await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_A }, {
        competitionMatchId: mid, predictedHomeScore: 1, predictedAwayScore: 0,
      });
    }
    const after = await call(h, 'GET', '/api/missions', { user: PRO_A });
    const prog = (r: any) => Object.fromEntries((r.body.daily.missions as any[]).map((m) => [m.key, m.progress]));
    expect(prog(after)).toEqual(prog(before));
  });

  it('B39. A battle lezárása NEM hoz létre progression eseményt (V1: 0 XP)', async () => {
    const { competitionId, matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    // PRO_A mindhármat eltalálja, PRO_B egyiket sem → biztos győzelem
    for (const mid of ids) {
      await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_A }, {
        competitionMatchId: mid, predictedHomeScore: 2, predictedAwayScore: 1,
      });
      await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_B }, {
        competitionMatchId: mid, predictedHomeScore: 0, predictedAwayScore: 3,
      });
      await finishMatch(h, competitionId, mid, 2, 1);
    }
    const r = await call(h, 'GET', `/api/battles/${b.id}`, { user: PRO_A });
    expect(r.body.status).toBe('settled');
    expect(r.body.myOutcome).toBe('win');

    const events = h.progression['db'].prepare("SELECT COUNT(*) AS n FROM progression_events").get() as any;
    expect(events.n).toBe(0);
    expect(await h.progression.totalXp(PRO_A)).toBe(0);
    const battleTyped = h.progression['db'].prepare("SELECT COUNT(*) AS n FROM progression_events WHERE type = 'battle'").get() as any;
    expect(battleTyped.n).toBe(0);
  });

  it('B40. A battle nem ad Tippverseny-helyezést és nem hoz létre jutalmat', async () => {
    const { competitionId, matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    for (const mid of ids) {
      await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_A }, {
        competitionMatchId: mid, predictedHomeScore: 2, predictedAwayScore: 1,
      });
      await finishMatch(h, competitionId, mid, 2, 1);
    }
    await call(h, 'GET', `/api/battles/${b.id}`, { user: PRO_A });

    const rewards = await h.competitions.listRewards(competitionId);
    expect(rewards).toHaveLength(0);
    // a Tippverseny saját statisztikája sem mozdult (a battle pontok nem kerültek bele)
    const me = await call(h, 'GET', `/api/competition/${competitionId}/me`, { user: PRO_A });
    expect(me.body.predictions).toBe(1); // csak a seedLeaderboard egyetlen tippje
  });
});

// ===========================================================================
// B41–B46  Lezárás (settlement)
// ===========================================================================

describe('Battle – lezárás', () => {
  /** Aktív battle, mindkét fél tippjeivel. */
  async function ready(hh: Harness, aScores: [number, number][], bScores: [number, number][]) {
    const { competitionId, matches } = await seedLeaderboard(hh);
    const ids = threeIds(matches);
    const b = (await createBattle(hh, { user: PRO_A }, PRO_B, ids)).body;
    await call(hh, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    for (const [i, mid] of ids.entries()) {
      await call(hh, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_A }, {
        competitionMatchId: mid, predictedHomeScore: aScores[i][0], predictedAwayScore: aScores[i][1],
      });
      await call(hh, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_B }, {
        competitionMatchId: mid, predictedHomeScore: bScores[i][0], predictedAwayScore: bScores[i][1],
      });
    }
    return { battleId: b.id as string, competitionId, ids };
  }

  it('B41. Részben lezárt mérkőzésekkel NEM zár le', async () => {
    const { battleId, competitionId, ids } = await ready(h, [[2, 1], [2, 1], [2, 1]], [[0, 0], [0, 0], [0, 0]]);
    await finishMatch(h, competitionId, ids[0], 2, 1);
    await finishMatch(h, competitionId, ids[1], 2, 1);
    const r = await call(h, 'GET', `/api/battles/${battleId}`, { user: PRO_A });
    expect(r.body.status).toBe('active');
    expect(r.body.challenger.points).toBeNull();
    expect((await h.battles.getBattle(battleId))!.settledAt).toBeNull();
  });

  it('B42. Mindhárom mérkőzés után lezár, 5/3/0 szerinti pontokkal és győztessel', async () => {
    // Eredmények: 2-1, 3-1, 1-1
    // PRO_A: 2-1 pontos (5) · 1-0 helyes kimenet 1 (3) · 0-0 helyes kimenet X (3) → 11
    // PRO_B: 0-3 rossz (0) · 2-2 rossz (0)             · 1-1 pontos (5)          →  5
    const { battleId, competitionId, ids } = await ready(
      h, [[2, 1], [1, 0], [0, 0]], [[0, 3], [2, 2], [1, 1]],
    );
    await finishMatch(h, competitionId, ids[0], 2, 1); // A: 5  B: 0
    await finishMatch(h, competitionId, ids[1], 3, 1); // A: 3  B: 0
    await finishMatch(h, competitionId, ids[2], 1, 1); // A: 0  B: 5

    const r = await call(h, 'GET', `/api/battles/${battleId}`, { user: PRO_A });
    expect(r.body.status).toBe('settled');
    expect(r.body.challenger.points).toBe(11);
    expect(r.body.opponent.points).toBe(5);
    expect(r.body.myOutcome).toBe('win');
    const row = (await h.battles.getBattle(battleId))!;
    expect(row.winnerUserId).toBe(PRO_A);
    expect(row.settledAt).not.toBeNull();
    // a pontok a tippekre is beíródtak
    const pts = (await h.battles.listPredictions(battleId)).filter((p) => p.userId === PRO_A).map((p) => p.points).sort();
    expect(pts).toEqual([3, 3, 5]);
    const ptsB = (await h.battles.listPredictions(battleId)).filter((p) => p.userId === PRO_B).map((p) => p.points).sort();
    expect(ptsB).toEqual([0, 0, 5]);
  });

  it('B43. Egyenlő pontszám → VALÓDI döntetlen, winner_user_id = null', async () => {
    const { battleId, competitionId, ids } = await ready(
      h, [[1, 0], [1, 0], [1, 0]], [[1, 0], [1, 0], [1, 0]],
    );
    for (const mid of ids) await finishMatch(h, competitionId, mid, 1, 0);

    const r = await call(h, 'GET', `/api/battles/${battleId}`, { user: PRO_A });
    expect(r.body.status).toBe('settled');
    expect(r.body.challenger.points).toBe(15);
    expect(r.body.opponent.points).toBe(15);
    expect(r.body.myOutcome).toBe('draw');
    expect((await h.battles.getBattle(battleId))!.winnerUserId).toBeNull();
    // a másik fél is döntetlent lát
    const other = await call(h, 'GET', `/api/battles/${battleId}`, { user: PRO_B });
    expect(other.body.myOutcome).toBe('draw');
  });

  it('B44. A lezárás IDEMPOTENS: a második olvasás nem változtat semmit', async () => {
    const { battleId, competitionId, ids } = await ready(
      h, [[2, 1], [2, 1], [2, 1]], [[0, 3], [0, 3], [0, 3]],
    );
    for (const mid of ids) await finishMatch(h, competitionId, mid, 2, 1);

    const first = await call(h, 'GET', `/api/battles/${battleId}`, { user: PRO_A });
    expect(first.body.status).toBe('settled');
    const snap = await h.battles.getBattle(battleId);

    for (let i = 0; i < 3; i++) await call(h, 'GET', `/api/battles/${battleId}`, { user: PRO_A });
    const again = await h.battles.getBattle(battleId);
    expect(again).toEqual(snap); // settledAt, pontok, győztes – mind bitre azonos
  });

  it('B45. Utólagos eredmény-korrekció NEM írja át a már kiosztott győzelmet', async () => {
    const { battleId, competitionId, ids } = await ready(
      h, [[2, 1], [2, 1], [2, 1]], [[0, 3], [0, 3], [0, 3]],
    );
    for (const mid of ids) await finishMatch(h, competitionId, mid, 2, 1);
    const settled = await call(h, 'GET', `/api/battles/${battleId}`, { user: PRO_A });
    expect(settled.body.myOutcome).toBe('win');

    // az eredmény utólag megfordul – a battle már lezárt, nem számol újra
    for (const mid of ids) await finishMatch(h, competitionId, mid, 0, 3);
    const after = await call(h, 'GET', `/api/battles/${battleId}`, { user: PRO_A });
    expect(after.body.status).toBe('settled');
    expect(after.body.myOutcome).toBe('win');
    expect((await h.battles.getBattle(battleId))!.winnerUserId).toBe(PRO_A);
  });

  it('B46. Hiányzó tipp 0 pontot ér (a lezárás nem hiúsul meg)', async () => {
    const { competitionId, matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    // csak PRO_A tippel, és csak egy mérkőzésre
    await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_A }, {
      competitionMatchId: ids[0], predictedHomeScore: 2, predictedAwayScore: 1,
    });
    for (const mid of ids) await finishMatch(h, competitionId, mid, 2, 1);

    const r = await call(h, 'GET', `/api/battles/${b.id}`, { user: PRO_A });
    expect(r.body.status).toBe('settled');
    expect(r.body.challenger.points).toBe(5);
    expect(r.body.opponent.points).toBe(0);
    expect(r.body.myOutcome).toBe('win');
  });
});

// ===========================================================================
// B47–B52  Versenyhelyzet
// ===========================================================================

describe('Battle – versenyhelyzet', () => {
  async function pending(hh: Harness) {
    const { competitionId, matches } = await seedLeaderboard(hh);
    const ids = threeIds(matches);
    const b = (await createBattle(hh, { user: PRO_A }, PRO_B, ids)).body;
    return { battleId: b.id as string, competitionId, ids };
  }

  it('B47. Két párhuzamos accept → pontosan egy sikeres', async () => {
    const { battleId } = await pending(h);
    const [r1, r2] = await Promise.all([
      call(h, 'POST', `/api/battles/${battleId}/accept`, { user: PRO_B }),
      call(h, 'POST', `/api/battles/${battleId}/accept`, { user: PRO_B }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect((await h.battles.getBattle(battleId))!.status).toBe('active');
  });

  it('B48. Accept vs decline → pontosan egy sikeres', async () => {
    const { battleId } = await pending(h);
    const [r1, r2] = await Promise.all([
      call(h, 'POST', `/api/battles/${battleId}/accept`, { user: PRO_B }),
      call(h, 'POST', `/api/battles/${battleId}/decline`, { user: PRO_B }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(['active', 'declined']).toContain((await h.battles.getBattle(battleId))!.status);
  });

  it('B49. Accept vs cancel → pontosan egy sikeres', async () => {
    const { battleId } = await pending(h);
    const [r1, r2] = await Promise.all([
      call(h, 'POST', `/api/battles/${battleId}/accept`, { user: PRO_B }),
      call(h, 'POST', `/api/battles/${battleId}/cancel`, { user: PRO_A }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(['active', 'cancelled']).toContain((await h.battles.getBattle(battleId))!.status);
  });

  it('B50. Accept vs lejárat: az időfeltétel az ÍRÁS része (tároló szintű, determinisztikus)', async () => {
    const { battleId } = await pending(h);
    const past = hours(-1);
    // A már lejárt kihívás feltételes UPDATE-je NEM írhat
    const blocked = await h.battles.transition(battleId, 'active', ['pending'], {
      expectOpponent: PRO_B, notExpiredAt: new Date().toISOString(),
    });
    expect(blocked).not.toBeNull(); // még nem járt le → sikeres

    // most tegyük lejárttá, és próbáljuk újra egy friss pending battle-ön
    const { battleId: b2 } = await pending(h);
    h.battles['db'].prepare('UPDATE battles SET invite_expires_at = ? WHERE id = ?').run(past, b2);
    const after = await h.battles.transition(b2, 'active', ['pending'], {
      expectOpponent: PRO_B, notExpiredAt: new Date().toISOString(),
    });
    expect(after).toBeNull();
    expect((await h.battles.getBattle(b2))!.status).toBe('pending'); // nem íródott át
  });

  it('B51. Ugyanaz a user + battle + match párhuzamosan → egyetlen tipp-sor', async () => {
    const { battleId, ids } = await pending(h);
    await call(h, 'POST', `/api/battles/${battleId}/accept`, { user: PRO_B });
    const results = await Promise.all([1, 2, 3].map((n) =>
      call(h, 'POST', `/api/battles/${battleId}/predictions`, { user: PRO_A }, {
        competitionMatchId: ids[0], predictedHomeScore: n, predictedAwayScore: 0,
      })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await h.battles.listPredictions(battleId)).length).toBe(1);
  });

  it('B52. Két párhuzamos lezárás → pontosan egy settlement (tároló szintű, determinisztikus)', async () => {
    const { competitionId, matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    for (const mid of ids) await finishMatch(h, competitionId, mid, 1, 0);

    const at = new Date().toISOString();
    const [s1, s2] = await Promise.all([
      h.battles.settle(b.id, { challengerPoints: 9, opponentPoints: 3, winnerUserId: PRO_A, settledAt: at }),
      h.battles.settle(b.id, { challengerPoints: 0, opponentPoints: 99, winnerUserId: PRO_B, settledAt: at }),
    ]);
    // pontosan egy írt
    expect([s1, s2].filter((x) => x !== null)).toHaveLength(1);
    const row = (await h.battles.getBattle(b.id))!;
    expect(row.status).toBe('settled');
    // a második hívás nem írta felül az elsőt
    const winner = s1 ? PRO_A : PRO_B;
    expect(row.winnerUserId).toBe(winner);

    // a HTTP úton érkező újabb olvasás sem változtat
    const snap = await h.battles.getBattle(b.id);
    await call(h, 'GET', `/api/battles/${b.id}`, { user: PRO_A });
    expect(await h.battles.getBattle(b.id)).toEqual(snap);
  });
});
