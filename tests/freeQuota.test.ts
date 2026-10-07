/**
 * FREE napi Tippverseny-kvóta (Phase 3) – üzleti szabály, időzóna, versenyhelyzet,
 * jutalom-jogosultság, biztonság és regresszió.
 *
 * A HTTP-szintű teszteknél valódi Express alkalmazást indítunk a VALÓDI routerekkel és
 * a VALÓDI requireAuthenticated / requireAdmin őrökkel. Az egyetlen szimulált elem a
 * `res.locals.plan` előállítása (élesben az attachPlan tölti ki a hitelesített tokenből)
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
import { CompetitionService } from '../src/server/competition/service';
import { MissionService } from '../src/server/missions/service';
import { ProgressionService } from '../src/server/progression/service';
import { adminCompetitionRouter, competitionRouter } from '../src/server/routes/competition';
import { missionsRouter } from '../src/server/routes/missions';
import { profileRouter } from '../src/server/routes/profile';
import { InMemoryDisplayNameDirectory } from '../src/server/profile/displayNameDirectory';
import { requireAdmin } from '../src/server/billing/entitlement';
import { FREE_DAILY_PREDICTION_LIMIT, budapestDayWindow, quotaFrom, quotaLabel } from '../src/shared/freeQuota';
import { dayKey } from '../src/shared/missions';
import { scorePrediction } from '../src/shared/competition';
import type { MatchDataProvider } from '../src/server/data/provider';
import type { League, Match, MatchResult, Team } from '../src/shared/types';

const ADMIN_EMAIL = 'admin@example.com';
const FREE_A = '11111111-1111-1111-1111-111111111111';
const FREE_B = '22222222-2222-2222-2222-222222222222';
const PRO_A = '33333333-3333-3333-3333-333333333333';
const PRO_B = '44444444-4444-4444-4444-444444444444';
const PRO_C = '55555555-5555-5555-5555-555555555555';
const ADMIN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const hours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();

// ---------------------------------------------------------------------------
// Teszt meccsadat-szolgáltató (hálózat nélkül)
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
  { id: 'tottenham', name: 'Tottenham', shortName: 'TOT', country: 'Anglia', leagueId: 'eng-pl' },
  { id: 'newcastle', name: 'Newcastle', shortName: 'NEW', country: 'Anglia', leagueId: 'eng-pl' },
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
// Teszt-alkalmazás
// ---------------------------------------------------------------------------

interface Harness {
  url: string;
  close: () => Promise<void>;
  svc: CompetitionService;
  store: SqliteCompetitionStore;
  progressionStore: SqliteProgressionStore;
  names: InMemoryDisplayNameDirectory;
  proUsers: Set<string>;
}

async function startApp(matches: Match[]): Promise<Harness> {
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  const db = new DatabaseSync(':memory:');
  const store = new SqliteCompetitionStore(db);
  const progressionStore = new SqliteProgressionStore(db);
  const names = new InMemoryDisplayNameDirectory();
  // Élesben ez a profiles tábla; itt egy halmaz. Az admin is PRO.
  const proUsers = new Set([PRO_A, PRO_B, PRO_C, ADMIN_ID]);

  const progression = new ProgressionService(progressionStore, async (id) => proUsers.has(id));
  const missions = new MissionService(progressionStore, async (id) => proUsers.has(id));
  const svc = new CompetitionService(
    store, new FakeProvider(matches), names, progression,
    async (ids) => new Set(ids.filter((id) => proUsers.has(id))),
  );

  for (const [id, name] of [[FREE_A, 'FreeAnna'], [FREE_B, 'FreeBela'], [PRO_A, 'ProAnna'],
    [PRO_B, 'ProBela'], [PRO_C, 'ProCili'], [ADMIN_ID, 'Admin']] as const) {
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
      // A csomagot a SZERVER dönti el (itt a proUsers halmaz) – soha nem a kliens fejléce
      pro: !!id && proUsers.has(id),
      admin: !!email && admins.has(email),
    };
    next();
  });
  app.use('/api/admin/competition', requireAdmin, adminCompetitionRouter(svc));
  app.use('/api/competition', competitionRouter(svc));
  app.use('/api/missions', missionsRouter(missions));
  app.use('/api/profile', profileRouter(names));

  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    svc, store, progressionStore, names, proUsers,
  };
}

type Who = { user?: string; email?: string };
const headers = (w: Who = {}): Record<string, string> => ({
  'content-type': 'application/json',
  ...(w.user ? { 'x-test-user': w.user } : {}),
  ...(w.email ? { 'x-test-email': w.email } : {}),
});

const ADMIN: Who = { user: ADMIN_ID, email: ADMIN_EMAIL };

async function call(hh: Harness, method: string, path: string, who: Who = {}, body?: unknown) {
  const res = await fetch(`${hh.url}${path}`, {
    method, headers: headers(who), body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* nem JSON */ }
  return { status: res.status, body: json, raw: text };
}

async function activeCompetition(hh: Harness, name = 'Teszt Tippverseny', leagueKey = 'eng-pl') {
  const created = await call(hh, 'POST', '/api/admin/competition', ADMIN, {
    name, leagueKey, startsAt: hours(-1), endsAt: hours(48),
  });
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  await call(hh, 'POST', `/api/admin/competition/${id}/activate`, ADMIN);
  await call(hh, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);
  const matches = await call(hh, 'GET', `/api/competition/${id}/matches`, ADMIN);
  return { id, matches: matches.body as any[] };
}

/** Tipp beküldése a VALÓDI végponton. */
const submit = (hh: Harness, compId: string, matchId: string, who: Who, home = 1, away = 0) =>
  call(hh, 'POST', `/api/competition/${compId}/predictions`, who, {
    competitionMatchId: matchId, predictedHomeScore: home, predictedAwayScore: away,
  });

const quotaOf = (hh: Harness, compId: string, who: Who) =>
  call(hh, 'GET', `/api/competition/${compId}/me`, who).then((r) => r.body?.dailyQuota);

let h: Harness;
const defaultMatches = () => [
  match('espn-1', 'eng-pl', 'liverpool', 'arsenal', hours(3)),
  match('espn-2', 'eng-pl', 'chelsea', 'everton', hours(5)),
  match('espn-3', 'eng-pl', 'tottenham', 'newcastle', hours(7)),
  match('espn-4', 'eng-pl', 'arsenal', 'chelsea', hours(9)),
  match('espn-5', 'esp-ll', 'barcelona', 'realmadrid', hours(4)),
  // Késői kezdés: a „másnap" teszt ezen tud tippelni anélkül, hogy a kickoff-zárolásba futna
  match('espn-6', 'eng-pl', 'everton', 'tottenham', hours(40)),
];

beforeEach(async () => { h = await startApp(defaultMatches()); });
afterEach(async () => { await h.close(); });

// ===========================================================================
// Q1–Q3  Konfiguráció és időablak (tiszta logika)
// ===========================================================================

describe('FREE kvóta – konfiguráció és budapesti nap', () => {
  it('Q1. A napi limit pontosan 3, egyetlen helyen definiálva', () => {
    expect(FREE_DAILY_PREDICTION_LIMIT).toBe(3);
  });

  it('Q2. A budapesti nap félig nyitott [start, end), a kulcs a mai nap', () => {
    const now = new Date();
    const w = budapestDayWindow(now);
    expect(w.key).toBe(dayKey(now));
    expect(new Date(w.start).getTime()).toBeLessThanOrEqual(now.getTime());
    expect(new Date(w.end).getTime()).toBeGreaterThan(now.getTime());
    // A nap hossza az időszámítás-váltás miatt 23, 24 vagy 25 óra lehet
    const len = (new Date(w.end).getTime() - new Date(w.start).getTime()) / 3600_000;
    expect([23, 24, 25]).toContain(Math.round(len));
    // A nyitó pillanat MÁR a mai naphoz tartozik, az előtte lévő perc már nem
    expect(dayKey(new Date(w.start))).toBe(w.key);
    expect(dayKey(new Date(new Date(w.start).getTime() - 60_000))).not.toBe(w.key);
    // A záró pillanat MÁR a következő napé
    expect(dayKey(new Date(w.end))).not.toBe(w.key);
  });

  it('Q3. Időszámítás-váltás (DST) átlépése sem csúsztatja el a napot', () => {
    // 2026-03-29 és 2026-10-25 a budapesti óraátállítás napjai
    for (const iso of ['2026-03-29T01:30:00Z', '2026-03-29T12:00:00Z', '2026-10-25T00:30:00Z', '2026-10-25T12:00:00Z']) {
      const at = new Date(iso);
      const w = budapestDayWindow(at);
      expect(w.key).toBe(dayKey(at));
      expect(dayKey(new Date(w.start))).toBe(w.key);
      expect(dayKey(new Date(new Date(w.start).getTime() - 60_000))).not.toBe(w.key);
      expect(dayKey(new Date(w.end))).not.toBe(w.key);
    }
    // A váltás napjai valóban 23 és 25 órásak
    const spring = budapestDayWindow(new Date('2026-03-29T12:00:00Z'));
    const autumn = budapestDayWindow(new Date('2026-10-25T12:00:00Z'));
    expect(Math.round((new Date(spring.end).getTime() - new Date(spring.start).getTime()) / 3600_000)).toBe(23);
    expect(Math.round((new Date(autumn.end).getTime() - new Date(autumn.start).getTime()) / 3600_000)).toBe(25);
  });

  it('Q3b. quotaFrom és quotaLabel a szerver értékeiből képez állapotot', () => {
    const w = budapestDayWindow();
    expect(quotaFrom(0, w)).toMatchObject({ limit: 3, used: 0, remaining: 3, resetAt: w.end });
    expect(quotaFrom(2, w)).toMatchObject({ used: 2, remaining: 1 });
    // túlfutás esetén a remaining nem lehet negatív
    expect(quotaFrom(5, w).remaining).toBe(0);
    expect(quotaLabel(quotaFrom(2, w))).toBe('Mai tippek: 2 / 3');
    expect(quotaLabel(quotaFrom(3, w))).toBe('Mai tippkereted elfogyott.');
  });
});

// ===========================================================================
// Q4–Q12  AUTH és a napi limit a valódi végponton
// ===========================================================================

describe('FREE napi tippkeret – végpont', () => {
  it('Q4. Bejelentkezés nélkül → 401 AUTH_REQUIRED', async () => {
    const { id, matches } = await activeCompetition(h);
    const r = await submit(h, id, matches[0].id, {});
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('AUTH_REQUIRED');
    expect(await h.store.getPrediction(FREE_A, matches[0].id)).toBeNull();
  });

  it('Q5. FREE 0 → 1/3, 1 → 2/3, 2 → 3/3 (a számláló a szerveren nő)', async () => {
    const { id, matches } = await activeCompetition(h);
    const free = { user: FREE_A };

    expect(await quotaOf(h, id, free)).toMatchObject({ limit: 3, used: 0, remaining: 3 });

    expect((await submit(h, id, matches[0].id, free)).status).toBe(200);
    expect(await quotaOf(h, id, free)).toMatchObject({ used: 1, remaining: 2 });

    expect((await submit(h, id, matches[1].id, free)).status).toBe(200);
    expect(await quotaOf(h, id, free)).toMatchObject({ used: 2, remaining: 1 });

    expect((await submit(h, id, matches[2].id, free)).status).toBe(200);
    expect(await quotaOf(h, id, free)).toMatchObject({ used: 3, remaining: 0 });
  });

  it('Q6. FREE 3/3 → új tipp → 403 FREE_DAILY_LIMIT_REACHED, és NEM jön létre sor', async () => {
    const { id, matches } = await activeCompetition(h);
    const free = { user: FREE_A };
    for (let i = 0; i < 3; i++) expect((await submit(h, id, matches[i].id, free)).status).toBe(200);

    const r = await submit(h, id, matches[3].id, free);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FREE_DAILY_LIMIT_REACHED');
    // A válasz gépi feldolgozásra alkalmas kvóta-adatot ad
    expect(r.body).toMatchObject({ limit: 3, used: 3, remaining: 0 });
    expect(typeof r.body.resetAt).toBe('string');
    expect(new Date(r.body.resetAt).getTime()).toBeGreaterThan(Date.now());
    // a resetAt a KÖVETKEZŐ budapesti nap kezdete
    expect(r.body.resetAt).toBe(budapestDayWindow().end);
    // és determinisztikus: két külön számítás bitre azonos értéket ad
    expect(budapestDayWindow().end).toBe(budapestDayWindow(new Date(Date.now() + 1000)).end);

    expect(await h.store.getPrediction(FREE_A, matches[3].id)).toBeNull();
    expect((await h.store.listPredictionsForUser(FREE_A, id)).length).toBe(3);
  });

  it('Q7. 3/3 mellett a MEGLÉVŐ tipp módosítása sikeres, és nem fogyaszt kvótát', async () => {
    const { id, matches } = await activeCompetition(h);
    const free = { user: FREE_A };
    for (let i = 0; i < 3; i++) expect((await submit(h, id, matches[i].id, free)).status).toBe(200);

    const before = await h.store.getPrediction(FREE_A, matches[0].id);

    for (const [hs, as] of [[4, 2], [0, 0], [7, 7]] as const) {
      const r = await submit(h, id, matches[0].id, free, hs, as);
      expect(r.status).toBe(200);
      expect(r.body.predictedHomeScore).toBe(hs);
      expect(r.body.predictedAwayScore).toBe(as);
    }

    // a kvóta továbbra is 3/3 – a módosítások nem növelték
    expect(await quotaOf(h, id, free)).toMatchObject({ used: 3, remaining: 0 });
    expect((await h.store.listPredictionsForUser(FREE_A, id)).length).toBe(3);

    // a LÉTREHOZÁS ideje (submitted_at) változatlan – ezen alapul a kvótaszámítás
    const after = await h.store.getPrediction(FREE_A, matches[0].id);
    expect(after!.id).toBe(before!.id);
    expect(after!.submittedAt).toBe(before!.submittedAt);
    // és új tipp továbbra sem adható le
    expect((await submit(h, id, matches[3].id, free)).body.code).toBe('FREE_DAILY_LIMIT_REACHED');
  });

  it('Q8. A következő budapesti napon a számláló újraindul (0/3)', async () => {
    const { id, matches } = await activeCompetition(h);
    const free = { user: FREE_A };
    for (let i = 0; i < 3; i++) expect((await submit(h, id, matches[i].id, free)).status).toBe(200);
    expect((await submit(h, id, matches[3].id, free)).status).toBe(403);

    // Másnap: a szolgáltatás a kapott `now` szerinti budapesti napot számolja
    const tomorrow = new Date(Date.now() + 26 * 3600_000);
    expect(await h.svc.dailyQuota(FREE_A, FREE_DAILY_PREDICTION_LIMIT, tomorrow))
      .toMatchObject({ used: 0, remaining: 3 });

    // A legkésőbbi kezdésű mérkőzés – így a kickoff-zárolás nem zavar bele
    const late = [...matches].sort((x: any, y: any) => y.kickoff.localeCompare(x.kickoff))[0];
    const saved = await h.svc.submitPrediction(
      id, FREE_A, late.id, 2, 2, tomorrow, true, FREE_DAILY_PREDICTION_LIMIT,
    );
    expect(saved.predictedHomeScore).toBe(2);
    expect((await h.store.listPredictionsForUser(FREE_A, id)).length).toBe(4);
  });

  it('Q9. A napi keret USER-szintű: két külön verseny EGYÜTT számít (2 + 1 = 3/3)', async () => {
    const a = await activeCompetition(h, 'A verseny', 'eng-pl');
    const b = await activeCompetition(h, 'B verseny', 'esp-ll');
    const free = { user: FREE_A };

    expect((await submit(h, a.id, a.matches[0].id, free)).status).toBe(200);
    expect((await submit(h, a.id, a.matches[1].id, free)).status).toBe(200);
    expect(await quotaOf(h, a.id, free)).toMatchObject({ used: 2, remaining: 1 });
    // a kvóta a MÁSIK versenyen is ugyanazt mutatja
    expect(await quotaOf(h, b.id, free)).toMatchObject({ used: 2, remaining: 1 });

    expect((await submit(h, b.id, b.matches[0].id, free)).status).toBe(200);
    expect(await quotaOf(h, a.id, free)).toMatchObject({ used: 3, remaining: 0 });
  });

  it('Q10. 3/3 után a B versenyen sincs új tipp (nem versenyenkénti a keret)', async () => {
    const a = await activeCompetition(h, 'A verseny', 'eng-pl');
    const b = await activeCompetition(h, 'B verseny', 'esp-ll');
    const free = { user: FREE_A };
    for (let i = 0; i < 3; i++) expect((await submit(h, a.id, a.matches[i].id, free)).status).toBe(200);

    const r = await submit(h, b.id, b.matches[0].id, free);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FREE_DAILY_LIMIT_REACHED');
    expect((await h.store.listPredictionsForUser(FREE_A, b.id)).length).toBe(0);
  });

  it('Q11. PRO felhasználóra nincs napi limit, és a /me nem ad kvótát', async () => {
    const a = await activeCompetition(h, 'A verseny', 'eng-pl');
    const b = await activeCompetition(h, 'B verseny', 'esp-ll');
    const pro = { user: PRO_A };

    for (const m of a.matches) expect((await submit(h, a.id, m.id, pro)).status).toBe(200);
    for (const m of b.matches) expect((await submit(h, b.id, m.id, pro)).status).toBe(200);
    const total = a.matches.length + b.matches.length;
    expect(total).toBeGreaterThan(FREE_DAILY_PREDICTION_LIMIT);
    expect((await h.store.listPredictionsForUser(PRO_A, a.id)).length).toBe(a.matches.length);

    // PRO-nál nincs kvóta-objektum (null) – a felület így nem jelez limitet
    expect(await quotaOf(h, a.id, pro)).toBeNull();
  });

  it('Q12. A FREE felhasználók kvótája egymástól független', async () => {
    const { id, matches } = await activeCompetition(h);
    for (let i = 0; i < 3; i++) expect((await submit(h, id, matches[i].id, { user: FREE_A })).status).toBe(200);
    expect((await submit(h, id, matches[3].id, { user: FREE_A })).status).toBe(403);
    // B felhasználót ez nem érinti
    expect(await quotaOf(h, id, { user: FREE_B })).toMatchObject({ used: 0, remaining: 3 });
    expect((await submit(h, id, matches[3].id, { user: FREE_B })).status).toBe(200);
  });
});

// ===========================================================================
// Q13–Q16  Versenyhelyzet (race condition)
// ===========================================================================

describe('FREE napi tippkeret – versenyhelyzet', () => {
  it('Q13. 2/3 állapotból két PÁRHUZAMOS új tipp → pontosan 1 siker, soha nem 4/3', async () => {
    const { id, matches } = await activeCompetition(h);
    const free = { user: FREE_A };
    for (let i = 0; i < 2; i++) expect((await submit(h, id, matches[i].id, free)).status).toBe(200);

    const [r1, r2] = await Promise.all([
      submit(h, id, matches[2].id, free, 1, 0),
      submit(h, id, matches[3].id, free, 2, 0),
    ]);

    expect([r1.status, r2.status].sort()).toEqual([200, 403]);
    const blocked = [r1, r2].find((r) => r.status === 403)!;
    expect(blocked.body.code).toBe('FREE_DAILY_LIMIT_REACHED');

    // A döntő ellenőrzés: összesen PONTOSAN 3 tipp létezik
    expect((await h.store.listPredictionsForUser(FREE_A, id)).length).toBe(3);
    expect(await quotaOf(h, id, free)).toMatchObject({ used: 3, remaining: 0 });
  });

  it('Q13b. 2/3 állapotból két párhuzamos tárolóhívás → pontosan 1 „created"', async () => {
    // Determinisztikus, HTTP-ütemezés nélküli ellenőrzés KÖZVETLENÜL a tárolón:
    // ez a teszt a kvóta-ellenőrzés és az írás ATOMICITÁSÁT méri. Ha a két műveletet
    // bármi elválasztja (pl. naiv „count → if < limit → INSERT"), mindkét hívás
    // létrehozná a tippet, és 4/3 keletkezne.
    const { id, matches } = await activeCompetition(h);
    const free = { user: FREE_A };
    for (let i = 0; i < 2; i++) expect((await submit(h, id, matches[i].id, free)).status).toBe(200);

    const w = budapestDayWindow();
    const [a, b] = await Promise.all([
      h.store.createOrUpdatePrediction(FREE_A, matches[2].id, 1, 0, FREE_DAILY_PREDICTION_LIMIT, w),
      h.store.createOrUpdatePrediction(FREE_A, matches[3].id, 2, 0, FREE_DAILY_PREDICTION_LIMIT, w),
    ]);

    expect([a.outcome, b.outcome].sort()).toEqual(['created', 'limit_reached']);
    expect((await h.store.listPredictionsForUser(FREE_A, id)).length).toBe(3);
    // a visszaadott számláló sem futhat a limit fölé
    expect(Math.max(a.used, b.used)).toBe(3);
  });

  it('Q14. 0/3 állapotból öt párhuzamos új tipp → pontosan 3 siker', async () => {
    const { id, matches } = await activeCompetition(h);
    const free = { user: FREE_A };

    const results = await Promise.all(matches.map((m: any) => submit(h, id, m.id, free)));
    expect(results.filter((r) => r.status === 200).length).toBe(3);
    const rejected = results.filter((r) => r.status === 403);
    expect(rejected.length).toBe(matches.length - 3);
    for (const r of rejected) expect(r.body.code).toBe('FREE_DAILY_LIMIT_REACHED');

    expect((await h.store.listPredictionsForUser(FREE_A, id)).length).toBe(3);
  });

  it('Q15. Ugyanarra a mérkőzésre párhuzamosan → legfeljebb 1 ÚJ sor, 1 kvóta', async () => {
    const { id, matches } = await activeCompetition(h);
    const free = { user: FREE_A };

    const results = await Promise.all([
      submit(h, id, matches[0].id, free, 1, 0),
      submit(h, id, matches[0].id, free, 2, 0),
      submit(h, id, matches[0].id, free, 3, 0),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);

    // a (user, meccs) egyediség miatt pontosan egy sor, és csak 1 kvótát fogyasztott
    expect((await h.store.listPredictionsForUser(FREE_A, id)).length).toBe(1);
    expect(await quotaOf(h, id, free)).toMatchObject({ used: 1, remaining: 2 });
  });

  it('Q16. Különböző felhasználók párhuzamos kérései nem zavarják egymást', async () => {
    const { id, matches } = await activeCompetition(h);
    const results = await Promise.all([
      submit(h, id, matches[0].id, { user: FREE_A }),
      submit(h, id, matches[0].id, { user: FREE_B }),
      submit(h, id, matches[1].id, { user: PRO_A }),
      submit(h, id, matches[1].id, { user: FREE_A }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await h.store.listPredictionsForUser(FREE_A, id)).length).toBe(2);
    expect((await h.store.listPredictionsForUser(FREE_B, id)).length).toBe(1);
    expect((await h.store.listPredictionsForUser(PRO_A, id)).length).toBe(1);
  });
});

// ===========================================================================
// Q17–Q20  A meglévő szabályok változatlansága
// ===========================================================================

describe('Meglévő tippelési szabályok – változatlanok', () => {
  it('Q17. Kickoff utáni tipp továbbra is tiltott, és nem fogyaszt kvótát', async () => {
    const { id } = await activeCompetition(h);
    const free = { user: FREE_A };
    const [m] = await h.store.listMatches(id);
    // A mérkőzés kezdését a MÚLTBA toljuk – a tippelési ablak ettől bezár
    await h.store.upsertMatches(id, [{
      externalMatchId: m.externalMatchId, homeTeam: m.homeTeam, awayTeam: m.awayTeam,
      kickoff: hours(-2), homeScore: null, awayScore: null, status: 'scheduled',
    }]);

    const r = await submit(h, id, m.id, free);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PREDICTION_CLOSED');
    // az érvénytelen kérés NEM fogyasztott kvótát
    expect(await quotaOf(h, id, free)).toMatchObject({ used: 0, remaining: 3 });
    expect(await h.store.getPrediction(FREE_A, m.id)).toBeNull();
  });

  it('Q18. A megjelenítési név követelménye változatlan, és nem fogyaszt kvótát', async () => {
    const { id, matches } = await activeCompetition(h);
    const NONAME = '99999999-9999-9999-9999-999999999999';
    const r = await submit(h, id, matches[0].id, { user: NONAME });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('DISPLAY_NAME_REQUIRED');
    expect(await h.svc.dailyQuota(NONAME, FREE_DAILY_PREDICTION_LIMIT))
      .toMatchObject({ used: 0, remaining: 3 });
  });

  it('Q19. Érvénytelen gólszám 400, és nem fogyaszt kvótát', async () => {
    const { id, matches } = await activeCompetition(h);
    const free = { user: FREE_A };
    for (const body of [
      { competitionMatchId: matches[0].id, predictedHomeScore: -1, predictedAwayScore: 0 },
      { competitionMatchId: matches[0].id, predictedHomeScore: 'x', predictedAwayScore: 0 },
      { competitionMatchId: matches[0].id, predictedAwayScore: 1 },
    ]) {
      const r = await call(h, 'POST', `/api/competition/${id}/predictions`, free, body);
      expect(r.status).toBe(400);
    }
    expect(await quotaOf(h, id, free)).toMatchObject({ used: 0, remaining: 3 });
  });

  it('Q20. A 5/3/0 pontozás változatlan, FREE tippre is', async () => {
    // tiszta logika
    expect(scorePrediction(2, 1, 2, 1)).toBe(5);
    expect(scorePrediction(3, 1, 2, 1)).toBe(3);
    expect(scorePrediction(0, 2, 2, 1)).toBe(0);

    const { id, matches } = await activeCompetition(h);
    expect((await submit(h, id, matches[0].id, { user: FREE_A }, 2, 1)).status).toBe(200);
    expect((await submit(h, id, matches[0].id, { user: PRO_A }, 3, 1)).status).toBe(200);

    const [m] = await h.store.listMatches(id);
    await h.store.upsertMatches(id, [{
      externalMatchId: m.externalMatchId, homeTeam: m.homeTeam, awayTeam: m.awayTeam,
      kickoff: m.kickoff, homeScore: 2, awayScore: 1, status: 'finished',
    }]);
    await h.svc.settle(id);

    expect((await h.store.getPrediction(FREE_A, m.id))!.points).toBe(5);
    expect((await h.store.getPrediction(PRO_A, m.id))!.points).toBe(3);
  });
});

// ===========================================================================
// Q21–Q24  Ranglista és JUTALOM-jogosultság
// ===========================================================================

describe('Ranglista és jutalom – FREE versenyez, de nem jogosult jutalomra', () => {
  /** A specifikáció példája: PRO A 18 / FREE B 17 / PRO B 15 / PRO C 12 */
  async function seedSpecExample() {
    const { id } = await activeCompetition(h);
    const ms = await h.store.listMatches(id);
    // A pontokat közvetlenül állítjuk be: itt a RANGSOROLÁST vizsgáljuk, nem a pontozást
    const points: [string, number][] = [[PRO_A, 18], [FREE_B, 17], [PRO_B, 15], [PRO_C, 12]];
    for (const [userId, total] of points) {
      await h.store.upsertPrediction(userId, ms[0].id, 1, 0);
      const p = await h.store.getPrediction(userId, ms[0].id);
      await h.store.setPredictionPoints(p!.id, total);
    }
    return id;
  }

  it('Q21. A normál ranglista VÁLTOZATLAN: a FREE felhasználó rajta van a pontjaival', async () => {
    const id = await seedSpecExample();
    const board = await call(h, 'GET', `/api/competition/${id}/leaderboard`, { user: PRO_A });
    expect(board.status).toBe(200);
    const rows = board.body as any[];
    expect(rows.map((r) => [r.rank, r.displayName, r.points])).toEqual([
      [1, 'ProAnna', 18], [2, 'FreeBela', 17], [3, 'ProBela', 15], [4, 'ProCili', 12],
    ]);
    // a nyilvános ranglista továbbra sem ad ki azonosítót vagy e-mailt
    for (const r of rows) {
      expect(r.userId).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain('@');
    }
  });

  it('Q22. A jutalom-sorrend csak PRO résztvevőket tartalmaz, a meglévő tie-break szabállyal', async () => {
    const id = await seedSpecExample();
    const reward = await h.svc.rewardRanking(id);
    expect(reward.map((r) => [r.rank, r.displayName, r.points])).toEqual([
      [1, 'ProAnna', 18], [2, 'ProBela', 15], [3, 'ProCili', 12],
    ]);
    expect(reward.some((r) => r.userId === FREE_B)).toBe(false);
  });

  it('Q23. Lezáráskor a jutalmakat a PRO sorrend kapja – a FREE kimarad', async () => {
    const { id } = await activeCompetition(h);
    const ms = await h.store.listMatches(id);
    await h.store.upsertMatches(id, [{
      externalMatchId: ms[0].externalMatchId, homeTeam: ms[0].homeTeam, awayTeam: ms[0].awayTeam,
      kickoff: ms[0].kickoff, homeScore: 1, awayScore: 0, status: 'finished',
    }]);
    // A lezárás újraszámolja a pontokat, ezért a sorrendet a tippek döntik el:
    // FREE_B pontos találattal (5) a ranglista élére kerül, mégsem kap jutalmat.
    for (const [userId, hs, as] of [[FREE_B, 1, 0], [PRO_A, 2, 0], [PRO_B, 3, 0], [PRO_C, 0, 2]] as const) {
      await h.store.upsertPrediction(userId, ms[0].id, hs, as);
    }
    const fin = await call(h, 'POST', `/api/admin/competition/${id}/finish`, ADMIN);
    expect(fin.status).toBe(200);

    // A normál ranglistán a FREE felhasználó az ELSŐ (5 pont)
    const board = await call(h, 'GET', `/api/competition/${id}/leaderboard`, { user: FREE_B });
    const rows = board.body as any[];
    expect(rows[0].displayName).toBe('FreeBela');
    expect(rows[0].points).toBe(5);

    // A jutalmak viszont kizárólag PRO résztvevőkhöz kerültek
    const rewards = await call(h, 'GET', `/api/admin/competition/${id}/rewards`, ADMIN);
    const rw = rewards.body as any[];
    expect(rw.length).toBeGreaterThan(0);
    expect(rw.some((r) => r.userId === FREE_B)).toBe(false);
    for (const r of rw) expect(h.proUsers.has(r.userId)).toBe(true);
    // a jutalmak típusa változatlan
    expect(rw.find((r) => r.placement === 1)?.rewardType).toBe('free_pro_1_month');
    expect(rw.find((r) => r.placement === 2)?.rewardType).toBe('free_pro_2_weeks');
    expect(rw.find((r) => r.placement === 3)?.rewardType).toBe('free_pro_1_week');
    // az 1. helyezett jutalom a legjobb PRO-hoz (PRO_A, 3 pont) került
    expect(rw.find((r) => r.placement === 1)?.userId).toBe(PRO_A);
  });

  it('Q24. Ha nincs PRO-feloldó (helyi mód), mindenki jogosult – a korábbi működés', async () => {
    const store = new SqliteCompetitionStore(new DatabaseSync(':memory:'));
    const names = new InMemoryDisplayNameDirectory();
    await names.set(FREE_A, 'FreeAnna');
    const svc = new CompetitionService(store, new FakeProvider([]), names); // proUsers nélkül
    const c = await store.createCompetition({
      name: 'Helyi', leagueKey: 'eng-pl', leagueName: 'PL', provider: 'teszt',
      startsAt: hours(-1), endsAt: hours(48), status: 'active',
    });
    await store.upsertMatches(c.id, [{
      externalMatchId: 'x', homeTeam: 'H', awayTeam: 'A', kickoff: hours(3),
      homeScore: null, awayScore: null, status: 'scheduled',
    }]);
    const [m] = await store.listMatches(c.id);
    await store.upsertPrediction(FREE_A, m.id, 1, 0);
    const reward = await svc.rewardRanking(c.id);
    expect(reward.map((r) => r.userId)).toEqual([FREE_A]);
  });
});

// ===========================================================================
// Q25–Q28  Küldetések a FREE tippekből
// ===========================================================================

describe('Küldetések – a FREE tippek beszámítanak, de XP nem jár', () => {
  it('Q25. 1 FREE tipp → daily_prediction_1 teljesítve, daily_prediction_3 1/3', async () => {
    const { id, matches } = await activeCompetition(h);
    expect((await submit(h, id, matches[0].id, { user: FREE_A })).status).toBe(200);

    const r = await call(h, 'GET', '/api/missions', { user: FREE_A });
    expect(r.status).toBe(200);
    const daily = Object.fromEntries((r.body.daily.missions as any[]).map((m) => [m.key, m]));
    expect(daily.daily_prediction_1).toMatchObject({ progress: 1, target: 1, completed: true });
    expect(daily.daily_prediction_3).toMatchObject({ progress: 1, target: 3, completed: false });
    expect(r.body.pro).toBe(false);
  });

  it('Q26. 3 FREE tipp → daily_prediction_3 3/3 teljesítve', async () => {
    const { id, matches } = await activeCompetition(h);
    for (let i = 0; i < 3; i++) expect((await submit(h, id, matches[i].id, { user: FREE_A })).status).toBe(200);

    const r = await call(h, 'GET', '/api/missions', { user: FREE_A });
    const daily = Object.fromEntries((r.body.daily.missions as any[]).map((m) => [m.key, m]));
    expect(daily.daily_prediction_3).toMatchObject({ progress: 3, completed: true });
    const weekly = Object.fromEntries((r.body.weekly.missions as any[]).map((m) => [m.key, m]));
    expect(weekly.weekly_prediction_10).toMatchObject({ progress: 3, target: 10 });
  });

  it('Q27. FREE küldetés-jutalom 0 XP, PRO-nál a katalógus XP-je változatlan', async () => {
    const { id, matches } = await activeCompetition(h);
    expect((await submit(h, id, matches[0].id, { user: FREE_A })).status).toBe(200);
    expect((await submit(h, id, matches[0].id, { user: PRO_A })).status).toBe(200);

    const free = await call(h, 'POST', '/api/missions/daily_prediction_1/claim', { user: FREE_A });
    expect(free.status).toBe(200);
    expect(free.body.xpAwarded).toBe(0);
    expect(await h.progressionStore.totalXp(FREE_A)).toBe(0);

    const pro = await call(h, 'POST', '/api/missions/daily_prediction_1/claim', { user: PRO_A });
    expect(pro.status).toBe(200);
    expect(pro.body.xpAwarded).toBe(25);
    expect(await h.progressionStore.totalXp(PRO_A)).toBe(25);
  });

  it('Q28. FREE tipp nem keletkeztet progression XP-t a kiértékelés után sem', async () => {
    const { id, matches } = await activeCompetition(h);
    expect((await submit(h, id, matches[0].id, { user: FREE_A }, 2, 1)).status).toBe(200);
    const [m] = await h.store.listMatches(id);
    await h.store.upsertMatches(id, [{
      externalMatchId: m.externalMatchId, homeTeam: m.homeTeam, awayTeam: m.awayTeam,
      kickoff: m.kickoff, homeScore: 2, awayScore: 1, status: 'finished',
    }]);
    await h.svc.settle(id);
    // versenypontot kap (5), XP-t nem
    expect((await h.store.getPrediction(FREE_A, m.id))!.points).toBe(5);
    expect(await h.progressionStore.totalXp(FREE_A)).toBe(0);
  });
});

// ===========================================================================
// Q29–Q33  Biztonság
// ===========================================================================

describe('FREE kvóta – biztonság', () => {
  it('Q29. A kérés törzsében küldött user_id / userId figyelmen kívül marad', async () => {
    const { id, matches } = await activeCompetition(h);
    const r = await call(h, 'POST', `/api/competition/${id}/predictions`, { user: FREE_A }, {
      competitionMatchId: matches[0].id, predictedHomeScore: 1, predictedAwayScore: 0,
      user_id: PRO_A, userId: PRO_A, user: PRO_A,
    });
    expect(r.status).toBe(200);
    // a tipp a HITELESÍTETT felhasználóhoz került, nem a bodyban megadotthoz
    expect(await h.store.getPrediction(FREE_A, matches[0].id)).not.toBeNull();
    expect(await h.store.getPrediction(PRO_A, matches[0].id)).toBeNull();
  });

  it('Q30. A bodyban küldött plan / pro / subscription nem ad korlátlan tippelést', async () => {
    const { id, matches } = await activeCompetition(h);
    for (let i = 0; i < 3; i++) expect((await submit(h, id, matches[i].id, { user: FREE_A })).status).toBe(200);

    const r = await call(h, 'POST', `/api/competition/${id}/predictions`, { user: FREE_A }, {
      competitionMatchId: matches[3].id, predictedHomeScore: 1, predictedAwayScore: 0,
      plan: 'pro', pro: true, subscription: 'pro', subscription_status: 'pro', isPro: true,
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FREE_DAILY_LIMIT_REACHED');
    expect((await h.store.listPredictionsForUser(FREE_A, id)).length).toBe(3);
  });

  it('Q31. A bodyban küldött dailyCount / used / remaining / limit nem változtat a kvótán', async () => {
    const { id, matches } = await activeCompetition(h);
    for (let i = 0; i < 3; i++) expect((await submit(h, id, matches[i].id, { user: FREE_A })).status).toBe(200);

    const r = await call(h, 'POST', `/api/competition/${id}/predictions`, { user: FREE_A }, {
      competitionMatchId: matches[3].id, predictedHomeScore: 1, predictedAwayScore: 0,
      dailyCount: 0, used: 0, remaining: 99, limit: 999, dailyQuota: { used: 0, remaining: 99 },
      submitted_at: new Date(Date.now() - 5 * 86400_000).toISOString(),
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ limit: 3, used: 3, remaining: 0 });
    expect((await h.store.listPredictionsForUser(FREE_A, id)).length).toBe(3);
  });

  it('Q32. A points és a kvóta a queryből sem állítható, a /me csak a sajátot adja', async () => {
    const { id, matches } = await activeCompetition(h);
    expect((await submit(h, id, matches[0].id, { user: FREE_A })).status).toBe(200);

    // points a bodyban → a szerver figyelmen kívül hagyja
    const r = await call(h, 'POST', `/api/competition/${id}/predictions`, { user: FREE_A }, {
      competitionMatchId: matches[1].id, predictedHomeScore: 1, predictedAwayScore: 0, points: 5,
    });
    expect(r.status).toBe(200);
    expect((await h.store.getPrediction(FREE_A, matches[1].id))!.points).toBeNull();

    // query paraméterrel sem manipulálható a kvóta
    const me = await call(h, 'GET', `/api/competition/${id}/me?used=0&remaining=99&limit=999&user_id=${PRO_A}`, { user: FREE_A });
    expect(me.body.dailyQuota).toMatchObject({ limit: 3, used: 2, remaining: 1 });

    // a /me a hitelesített felhasználó adatát adja: PRO_A-nak nincs kvótája
    const other = await call(h, 'GET', `/api/competition/${id}/me`, { user: PRO_A });
    expect(other.body.dailyQuota).toBeNull();
  });

  it('Q33. Bejelentkezés nélkül a /me továbbra is 401', async () => {
    const { id } = await activeCompetition(h);
    expect((await call(h, 'GET', `/api/competition/${id}/me`)).status).toBe(401);
  });
});
