/**
 * In-app értesítések – létrehozás, idempotencia, olvasottság, lapozás,
 * biztonság, battle-integráció, újraszármaztatás és versenyhelyzet.
 *
 * A HTTP-szintű teszteknél valódi Express alkalmazást indítunk a VALÓDI
 * routerekkel és a VALÓDI requireAuthenticated / requirePro őrökkel. Az egyetlen
 * szimulált elem a `res.locals.plan` (élesben az attachPlan tölti ki a tokenből)
 * és a PRO-halmaz forrása (élesben a profiles tábla).
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
import { SqliteNotificationStore } from '../src/server/notifications/store';
import { CompetitionService } from '../src/server/competition/service';
import { BattleService } from '../src/server/battles/service';
import { ProgressionService } from '../src/server/progression/service';
import { MissionService } from '../src/server/missions/service';
import { NotificationService } from '../src/server/notifications/service';
import { battlesRouter } from '../src/server/routes/battles';
import { notificationsRouter } from '../src/server/routes/notifications';
import { competitionRouter, adminCompetitionRouter } from '../src/server/routes/competition';
import { missionsRouter } from '../src/server/routes/missions';
import { requireAdmin } from '../src/server/billing/entitlement';
import { InMemoryDisplayNameDirectory } from '../src/server/profile/displayNameDirectory';
import {
  NOTIFICATION_DEFAULT_LIMIT, NOTIFICATION_MAX_LIMIT, NOTIFICATION_KINDS,
  badgeLabel, battleSourceKey, iconOf, relativeTime, targetPath,
} from '../src/shared/notifications';
import { BATTLE_MATCH_COUNT } from '../src/shared/battles';
import type { MatchDataProvider } from '../src/server/data/provider';
import type { League, Match, MatchResult, Team } from '../src/shared/types';

const ADMIN_EMAIL = 'admin@example.com';
const PRO_A = '11111111-1111-1111-1111-111111111111';
const PRO_B = '22222222-2222-2222-2222-222222222222';
const PRO_C = '33333333-3333-3333-3333-333333333333';
const FREE_D = '44444444-4444-4444-4444-444444444444';
const ADMIN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GHOST = '99999999-9999-9999-9999-999999999999';

const hours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();

// ---------------------------------------------------------------------------

const LEAGUES: League[] = [
  { id: 'eng-pl', name: 'Premier League', country: 'Anglia', countryCode: 'ENG', tier: 1, international: false },
];
const TEAM_IDS = ['liverpool', 'arsenal', 'chelsea', 'everton', 'tottenham', 'newcastle'];
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
  notifications: SqliteNotificationStore;
  notificationSvc: NotificationService;
  battles: SqliteBattleStore;
  battleSvc: BattleService;
  competitions: SqliteCompetitionStore;
  progression: SqliteProgressionStore;
  names: InMemoryDisplayNameDirectory;
  proUsers: Set<string>;
}

async function startApp(): Promise<Harness> {
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  const db = new DatabaseSync(':memory:');
  const competitions = new SqliteCompetitionStore(db);
  const progression = new SqliteProgressionStore(db);
  const battles = new SqliteBattleStore(db);
  const notifications = new SqliteNotificationStore(db);
  const names = new InMemoryDisplayNameDirectory();
  const proUsers = new Set([PRO_A, PRO_B, PRO_C, ADMIN_ID]);

  const progressionSvc = new ProgressionService(progression, async (id) => proUsers.has(id));
  const missionSvc = new MissionService(progression, async (id) => proUsers.has(id));
  const competitionSvc = new CompetitionService(
    competitions, new FakeProvider([
      mk('m1', 'liverpool', 'arsenal', hours(3)),
      mk('m2', 'chelsea', 'everton', hours(5)),
      mk('m3', 'tottenham', 'newcastle', hours(7)),
      mk('m4', 'arsenal', 'chelsea', hours(9)),
      mk('m5', 'everton', 'liverpool', hours(11)),
    ]), names, progressionSvc,
    async (ids) => new Set(ids.filter((id) => proUsers.has(id))),
  );

  // Ugyanaz a kölcsönös, KÉSŐI KÖTÉSŰ összekötés, mint az index.ts-ben
  const notificationSvc: NotificationService = new NotificationService(notifications, [
    (userId) => battleSvc.notificationCandidates(userId),
  ]);
  const battleSvc: BattleService = new BattleService(
    battles, competitions, names,
    (ids) => progressionSvc.publicProfiles(ids),
    (n) => notificationSvc.emit(n),
  );

  for (const [id, name] of [[PRO_A, 'ProAnna'], [PRO_B, 'ProBela'], [PRO_C, 'ProCili'],
    [FREE_D, 'FreeDori'], [ADMIN_ID, 'Admin']] as const) {
    await names.set(id, name);
  }

  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    const email = (req.header('x-test-email') ?? '').toLowerCase();
    const admins = new Set((process.env.ADMIN_EMAILS ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean));
    res.locals.plan = {
      enforced: true,
      user: id ? { id, email } : null,
      pro: !!id && proUsers.has(id),
      admin: !!email && admins.has(email),
    };
    next();
  });
  app.use('/api/admin/competition', requireAdmin, adminCompetitionRouter(competitionSvc));
  app.use('/api/competition', competitionRouter(competitionSvc));
  app.use('/api/missions', missionsRouter(missionSvc));
  app.use('/api/battles', battlesRouter(battleSvc));
  app.use('/api/notifications', notificationsRouter(notificationSvc));

  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    notifications, notificationSvc, battles, battleSvc, competitions, progression, names, proUsers,
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

async function activeCompetition(h: Harness) {
  const created = await call(h, 'POST', '/api/admin/competition', ADMIN, {
    name: 'Értesítés teszt', leagueKey: 'eng-pl', startsAt: hours(-1), endsAt: hours(72),
  });
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  await call(h, 'POST', `/api/admin/competition/${id}/activate`, ADMIN);
  await call(h, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);
  return { id, matches: await h.competitions.listMatches(id) };
}

/** PRO_A/B/C bekerül a ranglistára (a kihívhatóság feltétele). */
async function seedLeaderboard(h: Harness) {
  const { id, matches } = await activeCompetition(h);
  for (const u of [PRO_A, PRO_B, PRO_C]) await h.competitions.upsertPrediction(u, matches[0].id, 1, 0);
  return { competitionId: id, matches };
}

const threeIds = (ms: { id: string }[]) => ms.slice(0, BATTLE_MATCH_COUNT).map((m) => m.id);

const createBattle = (h: Harness, who: Who, opponentId: string, matchIds: string[]) =>
  call(h, 'POST', '/api/battles', who, { opponentId, competitionMatchIds: matchIds });

async function finishMatch(h: Harness, competitionId: string, matchId: string, home: number, away: number) {
  const m = (await h.competitions.listMatches(competitionId)).find((x) => x.id === matchId)!;
  await h.competitions.upsertMatches(competitionId, [{
    externalMatchId: m.externalMatchId, homeTeam: m.homeTeam, awayTeam: m.awayTeam,
    kickoff: m.kickoff, homeScore: home, awayScore: away, status: 'finished',
  }]);
}

/** A felhasználó értesítései a tárolóból (az API megkerülésével). */
const rowsOf = (h: Harness, userId: string) => h.notifications.list(userId, 100).then((p) => p.rows);
const typesOf = async (h: Harness, userId: string) => (await rowsOf(h, userId)).map((n) => n.type).sort();

let h: Harness;
beforeEach(async () => { h = await startApp(); });
afterEach(async () => { await h.close(); });

// ===========================================================================
// N1–N4  Katalógus és tiszta logika
// ===========================================================================

describe('Értesítések – katalógus és tiszta logika', () => {
  it('N1. Pontosan a 7 V1 típus létezik, mind ikonnal', () => {
    expect(NOTIFICATION_KINDS.map((k) => k.type).sort()).toEqual([
      'battle_challenge_accepted', 'battle_challenge_declined', 'battle_challenge_expired',
      'battle_challenge_received', 'battle_draw', 'battle_lost', 'battle_won',
    ]);
    for (const k of NOTIFICATION_KINDS) expect(k.icon.length).toBeGreaterThan(0);
    // Szándékosan NINCS „visszavonva" típus
    expect(NOTIFICATION_KINDS.some((k) => k.type.includes('cancel'))).toBe(false);
    // ismeretlen típus sem törheti el a felületet
    expect(iconOf('nincs_ilyen_tipus')).toBe('🔔');
  });

  it('N2. A jelvény: 0 → nincs, 1–9 → pontos szám, 10+ → „9+”', () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(-3)).toBeNull();
    expect(badgeLabel(1)).toBe('1');
    expect(badgeLabel(9)).toBe('9');
    expect(badgeLabel(10)).toBe('9+');
    expect(badgeLabel(250)).toBe('9+');
  });

  it('N3. A forráskulcs kimenet-független a lezárásnál', () => {
    expect(battleSourceKey('abc', 'settled')).toBe('battle:abc:settled');
    expect(battleSourceKey('abc', 'challenge')).toBe('battle:abc:challenge');
    // nincs 'won'/'lost' variáns, ami ellentmondó második értesítést adhatna
    expect(battleSourceKey('abc', 'settled')).not.toContain('won');
  });

  it('N4. A kattintás célja az entity mezőkből épül, típus-ágazás nélkül', () => {
    expect(targetPath({ entityType: 'battle', entityId: 'x1' })).toBe('/battles/x1');
    expect(targetPath({ entityType: 'battle', entityId: null })).toBeNull();
    expect(targetPath({ entityType: null, entityId: 'x1' })).toBeNull();
    expect(relativeTime(new Date().toISOString())).toBe('most');
    expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5 perce');
    expect(relativeTime(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe('3 órája');
  });
});

// ===========================================================================
// N5–N10  Alapműveletek: létrehozás, idempotencia, olvasottság, lapozás
// ===========================================================================

describe('Értesítések – alapműveletek', () => {
  const seed = (h2: Harness, userId: string, key: string, title = 'Teszt') =>
    h2.notificationSvc.emit({ userId, type: 'battle_won', title, sourceKey: key, entityType: 'battle', entityId: GHOST });

  it('N5. Létrehozás és listázás', async () => {
    expect(await seed(h, PRO_A, 'k1', 'Első')).toBe(true);
    const r = await call(h, 'GET', '/api/notifications', { user: PRO_A });
    expect(r.status).toBe(200);
    expect(r.body.notifications).toHaveLength(1);
    expect(r.body.notifications[0]).toMatchObject({ type: 'battle_won', title: 'Első', readAt: null });
    expect(r.body.unreadCount).toBe(1);
    expect(r.body.hasMore).toBe(false);
    expect(r.body.nextBefore).toBeNull();
  });

  it('N6. IDEMPOTENCIA: ugyanaz a forráskulcs másodszor NEM hoz létre sort', async () => {
    expect(await seed(h, PRO_A, 'ugyanaz')).toBe(true);
    expect(await seed(h, PRO_A, 'ugyanaz')).toBe(false);
    expect(await seed(h, PRO_A, 'ugyanaz')).toBe(false);
    expect((await rowsOf(h, PRO_A)).length).toBe(1);
    // ugyanaz a kulcs MÁS usernél viszont külön sor
    expect(await seed(h, PRO_B, 'ugyanaz')).toBe(true);
    expect((await rowsOf(h, PRO_B)).length).toBe(1);
  });

  it('N7. Olvasottra állítás; másodszor nem írja újra az időbélyeget', async () => {
    await seed(h, PRO_A, 'k1');
    const [n] = await rowsOf(h, PRO_A);
    const r = await call(h, 'POST', `/api/notifications/${n.id}/read`, { user: PRO_A });
    expect(r.status).toBe(200);
    expect(r.body.notification.readAt).not.toBeNull();
    const firstAt = r.body.notification.readAt;

    const again = await call(h, 'POST', `/api/notifications/${n.id}/read`, { user: PRO_A });
    expect(again.status).toBe(200);
    expect(again.body.notification.readAt).toBe(firstAt);

    expect((await call(h, 'GET', '/api/notifications', { user: PRO_A })).body.unreadCount).toBe(0);
  });

  it('N8. Összes megjelölése olvasottként', async () => {
    for (const k of ['a', 'b', 'c']) await seed(h, PRO_A, k);
    expect((await call(h, 'GET', '/api/notifications', { user: PRO_A })).body.unreadCount).toBe(3);

    const r = await call(h, 'POST', '/api/notifications/read-all', { user: PRO_A });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(3);
    expect((await call(h, 'GET', '/api/notifications', { user: PRO_A })).body.unreadCount).toBe(0);

    // másodszor már nincs mit megjelölni
    expect((await call(h, 'POST', '/api/notifications/read-all', { user: PRO_A })).body.updated).toBe(0);
  });

  it('N9. Lapozás cursorral; a limitet a szerver vágja', async () => {
    for (let i = 0; i < 7; i++) {
      await h.notificationSvc.emit({
        userId: PRO_A, type: 'battle_won', title: `#${i}`, sourceKey: `p${i}`,
        entityType: 'battle', entityId: GHOST,
      });
      await new Promise((r) => setTimeout(r, 2)); // eltérő created_at a determinisztikus sorrendhez
    }
    const first = await call(h, 'GET', '/api/notifications?limit=3', { user: PRO_A });
    expect(first.body.notifications).toHaveLength(3);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.unreadCount).toBe(7);

    const second = await call(h, 'GET', `/api/notifications?limit=3&before=${encodeURIComponent(first.body.nextBefore)}`, { user: PRO_A });
    expect(second.body.notifications).toHaveLength(3);
    // nincs átfedés a két lap között
    const ids = new Set(first.body.notifications.map((n: any) => n.id));
    expect(second.body.notifications.some((n: any) => ids.has(n.id))).toBe(false);

    const third = await call(h, 'GET', `/api/notifications?limit=3&before=${encodeURIComponent(second.body.nextBefore)}`, { user: PRO_A });
    expect(third.body.notifications).toHaveLength(1);
    expect(third.body.hasMore).toBe(false);
    expect(third.body.nextBefore).toBeNull();

    // a limit felső korlátja szerveroldali
    const over = await call(h, 'GET', `/api/notifications?limit=${NOTIFICATION_MAX_LIMIT + 500}`, { user: PRO_A });
    expect(over.status).toBe(200);
    expect(over.body.notifications.length).toBeLessThanOrEqual(NOTIFICATION_MAX_LIMIT);
    // érvénytelen limit → alapértelmezés
    expect((await call(h, 'GET', '/api/notifications?limit=abc', { user: PRO_A })).status).toBe(200);
    expect(NOTIFICATION_DEFAULT_LIMIT).toBe(20);
  });

  it('N10. Érvénytelen cursor és azonosító elutasítva; 0 értesítésnél üres lista', async () => {
    expect((await call(h, 'GET', '/api/notifications?before=nem-datum', { user: PRO_A })).status).toBe(400);
    expect((await call(h, 'POST', '/api/notifications/nem-uuid/read', { user: PRO_A })).status).toBe(400);
    const empty = await call(h, 'GET', '/api/notifications', { user: PRO_C });
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ notifications: [], unreadCount: 0, hasMore: false, nextBefore: null });
  });
});

// ===========================================================================
// N11–N15  Biztonság
// ===========================================================================

describe('Értesítések – biztonság', () => {
  const seed = (userId: string, key: string) =>
    h.notificationSvc.emit({ userId, type: 'battle_won', title: 'Privát', sourceKey: key, entityType: 'battle', entityId: GHOST });

  it('N11. Bejelentkezés nélkül mindhárom végpont 401', async () => {
    for (const [m, p] of [['GET', '/api/notifications'], ['POST', `/api/notifications/${GHOST}/read`],
      ['POST', '/api/notifications/read-all']] as const) {
      const r = await call(h, m, p);
      expect(r.status, `${m} ${p}`).toBe(401);
      expect(r.body.code).toBe('AUTH_REQUIRED');
    }
  });

  it('N12. A user NEM látja más értesítéseit', async () => {
    await seed(PRO_A, 'a-sajat');
    await seed(PRO_B, 'b-sajat');
    const a = await call(h, 'GET', '/api/notifications', { user: PRO_A });
    expect(a.body.notifications).toHaveLength(1);
    expect(a.body.unreadCount).toBe(1);
    const b = await call(h, 'GET', '/api/notifications', { user: PRO_B });
    expect(b.body.notifications).toHaveLength(1);
    // és a két lista nem ugyanaz a sor
    expect(a.body.notifications[0].id).not.toBe(b.body.notifications[0].id);
  });

  it('N13. A user NEM tudja más értesítését olvasottra állítani', async () => {
    await seed(PRO_B, 'b-sajat');
    const [bRow] = await rowsOf(h, PRO_B);

    const r = await call(h, 'POST', `/api/notifications/${bRow.id}/read`, { user: PRO_A });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NOTIFICATION_NOT_FOUND');
    // B sora érintetlen
    expect((await rowsOf(h, PRO_B))[0].readAt).toBeNull();
  });

  it('N14. A read-all csak a HÍVÓ értesítéseit érinti', async () => {
    await seed(PRO_A, 'a1');
    await seed(PRO_B, 'b1');
    expect((await call(h, 'POST', '/api/notifications/read-all', { user: PRO_A })).body.updated).toBe(1);
    expect((await rowsOf(h, PRO_B))[0].readAt).toBeNull();
  });

  it('N15. A bodyból küldött user_id / type / title / read_at hatástalan', async () => {
    await seed(PRO_A, 'a1');
    const [n] = await rowsOf(h, PRO_A);
    const r = await call(h, 'POST', `/api/notifications/${n.id}/read`, { user: PRO_A }, {
      user_id: PRO_B, userId: PRO_B, type: 'hamis_tipus', title: 'HAMIS',
      read_at: null, readAt: null, metadata: { hamis: true },
    });
    expect(r.status).toBe(200);
    const [after] = await rowsOf(h, PRO_A);
    expect(after.type).toBe('battle_won');     // nem 'hamis_tipus'
    expect(after.title).toBe('Privát');        // nem 'HAMIS'
    expect(after.readAt).not.toBeNull();       // a szerver állította be
    expect(after.metadata).toEqual({});
    // B-nek nem keletkezett semmi
    expect((await rowsOf(h, PRO_B)).length).toBe(0);
  });

  it('N16. FREE felhasználó is használhatja az értesítéseket', async () => {
    await seed(FREE_D, 'free1');
    const r = await call(h, 'GET', '/api/notifications', { user: FREE_D });
    expect(r.status).toBe(200);
    expect(r.body.notifications).toHaveLength(1);
    expect((await call(h, 'POST', '/api/notifications/read-all', { user: FREE_D })).status).toBe(200);
  });
});

// ===========================================================================
// N17–N23  Battle-integráció
// ===========================================================================

describe('Értesítések – battle integráció', () => {
  it('N17. Kihívás → az ELLENFÉL kap értesítést, a kihívó nem', async () => {
    const { matches } = await seedLeaderboard(h);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;

    expect(await typesOf(h, PRO_B)).toEqual(['battle_challenge_received']);
    expect(await typesOf(h, PRO_A)).toEqual([]);

    const [n] = await rowsOf(h, PRO_B);
    expect(n.title).toContain('ProAnna');          // a kihívó megjelenítési neve
    expect(n.entityType).toBe('battle');
    expect(n.entityId).toBe(b.id);
    expect(targetPath(n)).toBe(`/battles/${b.id}`);
    // soha nem szivárog ki azonosító vagy e-mail
    expect(JSON.stringify(n)).not.toContain(PRO_A);
    expect(JSON.stringify(n)).not.toContain('@');
  });

  it('N18. Elfogadás → a KIHÍVÓ kap értesítést', async () => {
    const { matches } = await seedLeaderboard(h);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;
    expect((await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B })).status).toBe(200);

    expect(await typesOf(h, PRO_A)).toEqual(['battle_challenge_accepted']);
    expect((await rowsOf(h, PRO_A))[0].title).toContain('ProBela');
  });

  it('N19. Elutasítás → a KIHÍVÓ kap értesítést', async () => {
    const { matches } = await seedLeaderboard(h);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;
    expect((await call(h, 'POST', `/api/battles/${b.id}/decline`, { user: PRO_B })).status).toBe(200);
    expect(await typesOf(h, PRO_A)).toEqual(['battle_challenge_declined']);
  });

  it('N20. Visszavonás → SENKI nem kap értesítést (szándékosan nincs ilyen típus)', async () => {
    const { matches } = await seedLeaderboard(h);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;
    expect((await call(h, 'POST', `/api/battles/${b.id}/cancel`, { user: PRO_A })).status).toBe(200);
    expect(await typesOf(h, PRO_A)).toEqual([]);
    // a kihívásról szóló értesítése megmarad, de újat nem kap
    expect(await typesOf(h, PRO_B)).toEqual(['battle_challenge_received']);
  });

  it('N21. Lejárat → a KIHÍVÓ kap értesítést, az ellenfél nem', async () => {
    const { matches } = await seedLeaderboard(h);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;
    h.battles['db'].prepare('UPDATE battles SET invite_expires_at = ? WHERE id = ?').run(hours(-1), b.id);

    // bármelyik fél olvasása kiváltja a lusta lejáratot
    await call(h, 'GET', '/api/battles', { user: PRO_B });

    expect(await typesOf(h, PRO_A)).toEqual(['battle_challenge_expired']);
    expect(await typesOf(h, PRO_B)).toEqual(['battle_challenge_received']);
  });

  it('N22. Lezárás → a győztes battle_won, a vesztes battle_lost értesítést kap', async () => {
    const { competitionId, matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    for (const mid of ids) {
      await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_A }, {
        competitionMatchId: mid, predictedHomeScore: 2, predictedAwayScore: 1,
      });
      await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_B }, {
        competitionMatchId: mid, predictedHomeScore: 0, predictedAwayScore: 4,
      });
      await finishMatch(h, competitionId, mid, 2, 1);
    }
    expect((await call(h, 'GET', `/api/battles/${b.id}`, { user: PRO_A })).body.status).toBe('settled');

    expect(await typesOf(h, PRO_A)).toEqual(['battle_challenge_accepted', 'battle_won'].sort());
    expect(await typesOf(h, PRO_B)).toEqual(['battle_challenge_received', 'battle_lost'].sort());

    const won = (await rowsOf(h, PRO_A)).find((n) => n.type === 'battle_won')!;
    expect(won.title).toContain('Megnyerted');
    expect(won.body).toContain('ProBela');
    expect(won.metadata).toMatchObject({ outcome: 'win', myPoints: 15, opponentPoints: 0 });
  });

  it('N23. Döntetlen → MINDKÉT játékos battle_draw értesítést kap', async () => {
    const { competitionId, matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    for (const mid of ids) {
      for (const u of [PRO_A, PRO_B]) {
        await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: u }, {
          competitionMatchId: mid, predictedHomeScore: 1, predictedAwayScore: 0,
        });
      }
      await finishMatch(h, competitionId, mid, 1, 0);
    }
    expect((await call(h, 'GET', `/api/battles/${b.id}`, { user: PRO_A })).body.myOutcome).toBe('draw');

    expect((await rowsOf(h, PRO_A)).some((n) => n.type === 'battle_draw')).toBe(true);
    expect((await rowsOf(h, PRO_B)).some((n) => n.type === 'battle_draw')).toBe(true);
    // azonos forráskulcs, mégis két külön sor (külön user)
    const a = (await rowsOf(h, PRO_A)).find((n) => n.type === 'battle_draw')!;
    const bb = (await rowsOf(h, PRO_B)).find((n) => n.type === 'battle_draw')!;
    expect(a.id).not.toBe(bb.id);
    expect(a.body).toContain('ProBela');
    expect(bb.body).toContain('ProAnna');
  });
});

// ===========================================================================
// N24–N27  Újraszármaztatás és versenyhelyzet
// ===========================================================================

describe('Értesítések – újraszármaztatás és versenyhelyzet', () => {
  /** Lezárt battle, de az értesítések TÖRÖLVE – mintha a kibocsátás elmaradt volna. */
  async function settledWithoutNotifications() {
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
    // minden értesítés eltávolítása: így szimuláljuk az elveszett kibocsátást
    h.notifications['db'].prepare('DELETE FROM notifications').run();
    return b.id as string;
  }

  it('N24. ÚJRASZÁRMAZTATÁS: az elveszett lezárás-értesítést a listázás pótolja', async () => {
    const battleId = await settledWithoutNotifications();
    expect((await rowsOf(h, PRO_A)).length).toBe(0);

    const r = await call(h, 'GET', '/api/notifications', { user: PRO_A });
    expect(r.status).toBe(200);
    expect(r.body.notifications.some((n: any) => n.type === 'battle_won')).toBe(true);
    expect(r.body.notifications[0].entityId).toBe(battleId);

    // és a vesztes is megkapja a SAJÁT listázásán
    const rb = await call(h, 'GET', '/api/notifications', { user: PRO_B });
    expect(rb.body.notifications.some((n: any) => n.type === 'battle_lost')).toBe(true);
  });

  it('N25. ÚJRASZÁRMAZTATÁS: az elveszett lejárat-értesítést is pótolja (csak a kihívónak)', async () => {
    const { matches } = await seedLeaderboard(h);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;
    h.battles['db'].prepare('UPDATE battles SET invite_expires_at = ?, status = ? WHERE id = ?')
      .run(hours(-1), 'expired', b.id);
    h.notifications['db'].prepare('DELETE FROM notifications').run();

    expect((await call(h, 'GET', '/api/notifications', { user: PRO_A })).body.notifications
      .some((n: any) => n.type === 'battle_challenge_expired')).toBe(true);
    // az ellenfélnek NEM jár lejárat-értesítés
    expect((await call(h, 'GET', '/api/notifications', { user: PRO_B })).body.notifications
      .some((n: any) => n.type === 'battle_challenge_expired')).toBe(false);
  });

  it('N26. Az újraszármaztatás IDEMPOTENS: többszöri listázás nem duplikál', async () => {
    await settledWithoutNotifications();
    for (let i = 0; i < 4; i++) await call(h, 'GET', '/api/notifications', { user: PRO_A });
    const won = (await rowsOf(h, PRO_A)).filter((n) => n.type === 'battle_won');
    expect(won).toHaveLength(1);
  });

  it('N27. Két párhuzamos lezárás → PONTOSAN egy értesítés játékosonként', async () => {
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

    // mindkét fél EGYSZERRE olvas – mindkettő megkísérli a lusta lezárást
    await Promise.all([
      call(h, 'GET', `/api/battles/${b.id}`, { user: PRO_A }),
      call(h, 'GET', `/api/battles/${b.id}`, { user: PRO_B }),
      call(h, 'GET', '/api/battles', { user: PRO_A }),
      call(h, 'GET', '/api/battles', { user: PRO_B }),
    ]);

    expect((await rowsOf(h, PRO_A)).filter((n) => n.type === 'battle_won')).toHaveLength(1);
    expect((await rowsOf(h, PRO_B)).filter((n) => n.type === 'battle_lost')).toHaveLength(1);
  });

  it('N28. Két párhuzamos elfogadás → pontosan egy accepted értesítés', async () => {
    const { matches } = await seedLeaderboard(h);
    const b = (await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches))).body;
    await Promise.all([
      call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B }),
      call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B }),
    ]);
    expect((await rowsOf(h, PRO_A)).filter((n) => n.type === 'battle_challenge_accepted')).toHaveLength(1);
  });

  it('N29. Az értesítés hibája NEM törheti meg a battle műveletet', async () => {
    const { matches } = await seedLeaderboard(h);
    // a tároló create()-je dob – a párbaj ettől nem bukhat el
    const broken = { ...h.notifications, create: async () => { throw new Error('szimulált tárolóhiba'); } };
    const svc = new NotificationService(broken as any, []);
    expect(await svc.emit({
      userId: PRO_A, type: 'battle_won', title: 'x', sourceKey: 'k', entityType: 'battle', entityId: GHOST,
    })).toBe(false); // elnyeli a hibát, nem dob

    // és a valódi párbaj-művelet végig megy
    const r = await createBattle(h, { user: PRO_A }, PRO_B, threeIds(matches));
    expect(r.status).toBe(200);
  });
});

// ===========================================================================
// N30  Regresszió: a Phase 1–4 adatai érintetlenek
// ===========================================================================

describe('Értesítések – regresszió', () => {
  it('N30. Egy teljes battle + értesítések SEMMIT nem változtatnak a meglévő rendszerekben', async () => {
    const { competitionId, matches } = await seedLeaderboard(h);
    const ids = threeIds(matches);

    const board0 = JSON.stringify((await call(h, 'GET', `/api/competition/${competitionId}/leaderboard`, { user: PRO_A })).body);
    const preds0 = (h.competitions['db'].prepare('SELECT COUNT(*) AS n FROM user_predictions').get() as any).n;
    const events0 = (h.progression['db'].prepare('SELECT COUNT(*) AS n FROM progression_events').get() as any).n;
    const xp0 = await h.progression.totalXp(PRO_A);

    const b = (await createBattle(h, { user: PRO_A }, PRO_B, ids)).body;
    await call(h, 'POST', `/api/battles/${b.id}/accept`, { user: PRO_B });
    for (const mid of ids) {
      await call(h, 'POST', `/api/battles/${b.id}/predictions`, { user: PRO_A }, {
        competitionMatchId: mid, predictedHomeScore: 2, predictedAwayScore: 1,
      });
      await finishMatch(h, competitionId, mid, 2, 1);
    }
    await call(h, 'GET', `/api/battles/${b.id}`, { user: PRO_A });
    await call(h, 'GET', '/api/notifications', { user: PRO_A });
    await call(h, 'POST', '/api/notifications/read-all', { user: PRO_A });

    // Tippverseny ranglista változatlan
    expect(JSON.stringify((await call(h, 'GET', `/api/competition/${competitionId}/leaderboard`, { user: PRO_A })).body)).toBe(board0);
    // user_predictions darabszám változatlan
    expect((h.competitions['db'].prepare('SELECT COUNT(*) AS n FROM user_predictions').get() as any).n).toBe(preds0);
    // progression esemény és XP változatlan – értesítésért NEM jár XP
    expect((h.progression['db'].prepare('SELECT COUNT(*) AS n FROM progression_events').get() as any).n).toBe(events0);
    expect(await h.progression.totalXp(PRO_A)).toBe(xp0);
    // és nincs 'notification' típusú progression esemény
    expect((h.progression['db'].prepare("SELECT COUNT(*) AS n FROM progression_events WHERE type LIKE '%notif%'").get() as any).n).toBe(0);
  });
});
