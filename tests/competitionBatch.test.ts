/**
 * Tippverseny – tömeges (egy műveletes) tippbeküldés.
 *
 * HTTP-szinten a VALÓDI routerrel és requireAuthenticated őrrel, a VALÓDI
 * CompetitionService-szel és SqliteCompetitionStore-ral (in-memory). A
 * `res.locals.plan` előállítása az egyetlen szimulált elem (élesben az
 * attachPlan tölti ki a hitelesített tokenből) – a meglévő competition.test.ts
 * mintájára. A Postgres-függvény (0019) külön, a competitionBatch.pg.test.ts-ben.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { SqliteCompetitionStore } from '../src/server/competition/store';
import { CompetitionService } from '../src/server/competition/service';
import { adminCompetitionRouter, competitionRouter } from '../src/server/routes/competition';
import { InMemoryDisplayNameDirectory } from '../src/server/profile/displayNameDirectory';
import { requireAdmin } from '../src/server/billing/entitlement';
import { scorePrediction, type CompetitionMatchView } from '../src/shared/competition';
import { FREE_DAILY_PREDICTION_LIMIT } from '../src/shared/freeQuota';
import type { MatchDataProvider } from '../src/server/data/provider';
import type { League, Match, MatchResult, Team } from '../src/shared/types';
import {
  clearConfirmed, draftStatus, errorsByMatch, singleFlight, submitBlocker, summarize, type Drafts,
} from '../src/client/lib/competitionDraft';
import { api } from '../src/client/lib/api';
import { BatchBar, ConfirmPanel, MatchCard } from '../src/client/pages/CompetitionDetail';

const ADMIN_EMAIL = 'admin@example.com';
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const NO_NAME = '44444444-4444-4444-4444-444444444444';
const hours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();

const LEAGUES: League[] = [{ id: 'eng-pl', name: 'Premier League', country: 'Anglia', countryCode: 'ENG', tier: 1, international: false }];
const TEAMS: Team[] = ['liverpool', 'arsenal', 'chelsea', 'everton', 'spurs', 'leeds', 'fulham', 'wolves', 'burnley', 'brighton']
  .map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), shortName: id.slice(0, 3).toUpperCase(), country: 'Anglia', leagueId: 'eng-pl' }));

class FakeProvider implements MatchDataProvider {
  readonly name = 'teszt-provider';
  readonly origin = 'live' as const;
  constructor(public matches: Match[]) {}
  async getLeagues(): Promise<League[]> { return LEAGUES; }
  async getTeams(): Promise<Team[]> { return TEAMS; }
  async getTeam(id: string): Promise<Team | null> { return TEAMS.find((t) => t.id === id) ?? null; }
  async getMatches(): Promise<Match[]> { return this.matches; }
  async getMatch(id: string): Promise<Match | null> { return this.matches.find((m) => m.id === id) ?? null; }
  async getResultsForAnalysis(): Promise<MatchResult[]> { return []; }
  async getTeamResults(): Promise<MatchResult[]> { return []; }
  async getLeagueResults(): Promise<MatchResult[]> { return []; }
  async getOdds(): Promise<null> { return null; }
}

const match = (id: string, home: string, away: string, kickoff: string, extra: Partial<Match> = {}): Match => ({
  id, leagueId: 'eng-pl', homeTeamId: home, awayTeamId: away, kickoff, status: 'scheduled',
  importance: 'normal', importanceReasons: [], origin: 'live', ...extra,
});

interface Harness {
  url: string; close: () => Promise<void>;
  svc: CompetitionService; store: SqliteCompetitionStore; db: InstanceType<typeof DatabaseSync>;
  provider: FakeProvider; coinCalls: string[];
}

async function startApp(matches: Match[]): Promise<Harness> {
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  const db = new DatabaseSync(':memory:');
  const store = new SqliteCompetitionStore(db);
  const provider = new FakeProvider(matches);
  const names = new InMemoryDisplayNameDirectory();
  const coinCalls: string[] = [];
  const coins = {
    onPredictionSubmitted: async (_u: string, predictionId: string) => { coinCalls.push(predictionId); },
    reconcileUser: async () => undefined,
    onCompetitionFinished: async () => undefined,
  };
  const svc = new CompetitionService(store, provider, names, undefined, undefined, coins);
  await names.set(USER_A, 'Martin23');
  await names.set(USER_B, 'Zsolti88');

  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    const email = (req.header('x-test-email') ?? '').toLowerCase();
    res.locals.plan = { enforced: true, user: id ? { id, email } : null, pro: req.header('x-test-plan') === 'pro', admin: email === ADMIN_EMAIL };
    next();
  });
  app.use('/api/admin/competition', requireAdmin, adminCompetitionRouter(svc));
  app.use('/api/competition', competitionRouter(svc));
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    svc, store, db, provider, coinCalls,
  };
}

type Who = { user?: string; email?: string; pro?: boolean };
const ADMIN: Who = { user: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: ADMIN_EMAIL, pro: true };
const PRO_A: Who = { user: USER_A, pro: true };
const FREE_A: Who = { user: USER_A };

async function call(h: Harness, method: string, path: string, who: Who = {}, body?: unknown) {
  const res = await fetch(`${h.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(who.user ? { 'x-test-user': who.user } : {}),
      ...(who.email ? { 'x-test-email': who.email } : {}),
      ...(who.pro ? { 'x-test-plan': 'pro' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function activeCompetition(h: Harness) {
  const created = await call(h, 'POST', '/api/admin/competition', ADMIN, { name: 'PL Tippverseny', leagueKey: 'eng-pl', startsAt: hours(-1), endsAt: hours(48) });
  const id = created.body.id as string;
  await call(h, 'POST', `/api/admin/competition/${id}/activate`, ADMIN);
  await call(h, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);
  const list = (await call(h, 'GET', `/api/competition/${id}/matches`, ADMIN)).body as CompetitionMatchView[];
  const byExt = (ext: string) => list.find((m) => m.externalMatchId === ext)!;
  return { id, list, byExt };
}

const tip = (m: { id: string }, home: number, away: number) => ({ competitionMatchId: m.id, predictedHomeScore: home, predictedAwayScore: away });
const batch = (h: Harness, id: string, who: Who, predictions: unknown) => call(h, 'POST', `/api/competition/${id}/predictions/batch`, who, { predictions });
const rowCount = (h: Harness) => (h.db.prepare('SELECT COUNT(*) AS n FROM user_predictions').get() as { n: number }).n;

let h: Harness;
beforeEach(async () => {
  h = await startApp([
    match('e1', 'liverpool', 'arsenal', hours(3)),
    match('e2', 'chelsea', 'everton', hours(5)),
    match('e3', 'spurs', 'leeds', hours(6)),
    match('e4', 'fulham', 'wolves', hours(7)),
    match('e5', 'burnley', 'brighton', hours(8)),
    match('started', 'arsenal', 'chelsea', hours(-0.5)),
  ]);
});
afterEach(async () => { await h.close(); });

describe('Tömeges tippbeküldés – sikeres mentés', () => {
  it('1. több tipp EGY kérésben mentődik, a válasz tételes, a szerverállapot frissül', async () => {
    const { id, byExt } = await activeCompetition(h);
    const r = await batch(h, id, PRO_A, [tip(byExt('e1'), 2, 1), tip(byExt('e2'), 0, 0), tip(byExt('e3'), 1, 3)]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 3, updated: 0, unchanged: 0, dailyQuota: null });
    expect(r.body.saved.map((s: any) => [s.competitionMatchId, s.outcome, s.prediction.predictedHomeScore, s.prediction.predictedAwayScore]))
      .toEqual([[byExt('e1').id, 'created', 2, 1], [byExt('e2').id, 'created', 0, 0], [byExt('e3').id, 'created', 1, 3]]);
    expect(rowCount(h)).toBe(3);
    // 13. a következő olvasás (a felület újratöltése) a mentett tippeket adja vissza
    const after = (await call(h, 'GET', `/api/competition/${id}/matches`, PRO_A)).body as CompetitionMatchView[];
    expect(after.find((m) => m.id === byExt('e3').id)!.myPrediction).toEqual({ predictedHomeScore: 1, predictedAwayScore: 3, points: null });
    expect((await call(h, 'GET', `/api/competition/${id}/me`, PRO_A)).body.predictions).toBe(3);
    // coin-hook tippenként, ugyanúgy, mint az egyenkénti beküldésnél
    expect(h.coinCalls.sort()).toEqual(r.body.saved.map((s: any) => s.prediction.id).sort());
  });

  it('2. részleges beküldés megengedett (a meglévő szabály nem írja elő minden meccs tippelését)', async () => {
    const { id, byExt } = await activeCompetition(h);
    const r = await batch(h, id, PRO_A, [tip(byExt('e4'), 1, 1)]);
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(1);
    expect(rowCount(h)).toBe(1);
  });
});

describe('Tömeges tippbeküldés – elutasítás, semmi nem mentődik', () => {
  it('3. hibás vagy hiányzó tipp, üres / hiányzó lista → 400, nem jön létre sor', async () => {
    const { id, byExt } = await activeCompetition(h);
    const good = tip(byExt('e1'), 2, 1);
    for (const bad of [
      [good, tip(byExt('e2'), 100, 0)],
      [good, tip(byExt('e2'), -1, 0)],
      [good, { competitionMatchId: byExt('e2').id, predictedHomeScore: '2' }],
      [good, { competitionMatchId: byExt('e2').id, predictedHomeScore: 1.5, predictedAwayScore: 0 }],
      [good, { competitionMatchId: 'nem-uuid', predictedHomeScore: 1, predictedAwayScore: 0 }],
    ]) {
      const r = await batch(h, id, PRO_A, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.code).toBe('INVALID_BATCH');
      expect(r.body.errors.length).toBe(1);
    }
    expect((await batch(h, id, PRO_A, [])).body.code).toBe('EMPTY_BATCH');
    expect((await call(h, 'POST', `/api/competition/${id}/predictions/batch`, PRO_A, {})).status).toBe(400);
    expect((await batch(h, id, PRO_A, Array.from({ length: 201 }, () => good))).body.code).toBe('BATCH_TOO_LARGE');
    expect(rowCount(h)).toBe(0);
  });

  it('4. ismeretlen vagy másik versenyhez tartozó mérkőzés → 409, a csomag érvényes tételei sem mentődnek', async () => {
    const { id, byExt } = await activeCompetition(h);
    const other = await activeCompetition(h); // ugyanazokból a meccsekből második verseny
    const foreign = other.byExt('e2');
    const unknown = { id: '99999999-9999-9999-9999-999999999999' };
    const r = await batch(h, id, PRO_A, [tip(byExt('e1'), 2, 1), tip(foreign, 1, 0), tip(unknown, 0, 0)]);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('BATCH_REJECTED');
    expect(r.body.errors.map((e: any) => [e.competitionMatchId, e.code])).toEqual([[foreign.id, 'MATCH_NOT_FOUND'], [unknown.id, 'MATCH_NOT_FOUND']]);
    expect(rowCount(h)).toBe(0);
  });

  it('5. már elkezdődött mérkőzés vagy lezárt verseny → 409, semmi nem mentődik', async () => {
    const { id, byExt } = await activeCompetition(h);
    const r = await batch(h, id, PRO_A, [tip(byExt('e1'), 2, 1), tip(byExt('started'), 1, 1)]);
    expect(r.status).toBe(409);
    expect(r.body.errors).toEqual([expect.objectContaining({ competitionMatchId: byExt('started').id, code: 'PREDICTION_CLOSED' })]);
    expect(rowCount(h)).toBe(0);

    await call(h, 'POST', `/api/admin/competition/${id}/cancel`, ADMIN);
    expect((await batch(h, id, PRO_A, [tip(byExt('e1'), 2, 1)])).status).toBe(409);
    expect(rowCount(h)).toBe(0);
  });

  it('6. bejelentkezés nélkül → 401; a törzsben küldött userId nem azonosít', async () => {
    const { id, byExt } = await activeCompetition(h);
    const r = await call(h, 'POST', `/api/competition/${id}/predictions/batch`, {}, { userId: USER_A, predictions: [tip(byExt('e1'), 2, 1)] });
    expect(r.status).toBe(401);
    expect(rowCount(h)).toBe(0);
  });

  it('7. jogosultság és limit: név nélkül 403; FREE: a csomag új tippjei együtt nem léphetik át a napi keretet', async () => {
    const { id, byExt } = await activeCompetition(h);
    expect((await batch(h, id, { user: NO_NAME, pro: true }, [tip(byExt('e1'), 1, 0)])).body.code).toBe('DISPLAY_NAME_REQUIRED');

    const four = ['e1', 'e2', 'e3', 'e4'].map((e, i) => tip(byExt(e), i, 0));
    const over = await batch(h, id, FREE_A, four);
    expect(over.status).toBe(403);
    expect(over.body).toMatchObject({ code: 'FREE_DAILY_LIMIT_REACHED', limit: FREE_DAILY_PREDICTION_LIMIT, used: 0, remaining: 3, newPredictions: 4 });
    expect(rowCount(h)).toBe(0); // az első 3 SEM mentődött

    const ok = await batch(h, id, FREE_A, four.slice(0, 3));
    expect(ok.status).toBe(200);
    expect(ok.body.dailyQuota).toMatchObject({ used: 3, remaining: 0 });
    // a módosítás nem fogyaszt keretet – a teljes keret elfogyása után is mehet
    const edit = await batch(h, id, FREE_A, [tip(byExt('e1'), 5, 5), tip(byExt('e2'), 4, 4)]);
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ created: 0, updated: 2 });
    // módosítás + új tipp vegyesen: az új nem fér bele → az egész csomag elutasítva, a módosítás sem íródik
    const mixed = await batch(h, id, FREE_A, [tip(byExt('e1'), 9, 9), tip(byExt('e5'), 1, 0)]);
    expect(mixed.body.code).toBe('FREE_DAILY_LIMIT_REACHED');
    expect((await h.store.getPrediction(USER_A, byExt('e1').id))!.predictedHomeScore).toBe(5);
    // PRO-nak nincs napi keret
    expect((await batch(h, id, { user: USER_B, pro: true }, four)).status).toBe(200);
  });

  it('7b. a kliens által küldött points / userId / plan mezőt a szerver figyelmen kívül hagyja', async () => {
    const { id, byExt } = await activeCompetition(h);
    const r = await call(h, 'POST', `/api/competition/${id}/predictions/batch`, { user: USER_B, pro: true }, {
      plan: 'pro', userId: USER_A,
      predictions: [{ ...tip(byExt('e1'), 2, 1), points: 5, userId: USER_A }],
    });
    expect(r.status).toBe(200);
    expect(r.body.saved[0].prediction).toMatchObject({ userId: USER_B, points: null });
    expect(await h.store.getPrediction(USER_A, byExt('e1').id)).toBeNull();
  });

  it('8. duplikált mérkőzés-azonosító ugyanabban a csomagban → 400 DUPLICATE_MATCH, semmi nem mentődik', async () => {
    const { id, byExt } = await activeCompetition(h);
    const r = await batch(h, id, PRO_A, [tip(byExt('e1'), 2, 1), tip(byExt('e2'), 0, 0), tip(byExt('e1'), 3, 3)]);
    expect(r.status).toBe(400);
    expect(r.body.errors).toEqual([expect.objectContaining({ competitionMatchId: byExt('e1').id, code: 'DUPLICATE_MATCH' })]);
    expect(rowCount(h)).toBe(0);
  });

  it('9. írás közbeni hiba → a tranzakció visszagörgetődik, az addig írt tételek sem maradnak meg', async () => {
    const { id, byExt } = await activeCompetition(h);
    await batch(h, id, PRO_A, [tip(byExt('e1'), 1, 1)]);
    // a második beszúrásnál az adatbázis hibát dob (a validáció után, az írás KÖZBEN)
    h.db.exec(`CREATE TRIGGER fail_77 BEFORE INSERT ON user_predictions WHEN NEW.predicted_home_score = 77
      BEGIN SELECT RAISE(ABORT, 'szimulált írási hiba'); END;`);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await batch(h, id, PRO_A, [tip(byExt('e1'), 4, 2), tip(byExt('e2'), 3, 0), tip(byExt('e3'), 77, 0)]);
    err.mockRestore();
    expect(r.status).toBe(500);
    expect(rowCount(h)).toBe(1);
    expect((await h.store.getPrediction(USER_A, byExt('e1').id))!.predictedHomeScore).toBe(1); // a módosítás is visszagörgetve
    expect(await h.store.getPrediction(USER_A, byExt('e2').id)).toBeNull();
    expect(h.coinCalls).toHaveLength(1); // a sikertelen csomag nem fizet
  });
});

describe('Tömeges tippbeküldés – ismétlés és meglévő tippek', () => {
  it('10. dupla kattintás (párhuzamos) és újrapróbálás: nincs duplikált sor, nincs dupla keretfogyasztás', async () => {
    const { id, byExt } = await activeCompetition(h);
    const pkg = [tip(byExt('e1'), 2, 1), tip(byExt('e2'), 1, 1)];
    const [a, b] = await Promise.all([batch(h, id, FREE_A, pkg), batch(h, id, FREE_A, pkg)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(rowCount(h)).toBe(2);
    expect([a.body.created + b.body.created, a.body.unchanged + b.body.unchanged]).toEqual([2, 2]);
    const retry = await batch(h, id, FREE_A, pkg);
    expect(retry.body).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(retry.body.dailyQuota).toMatchObject({ used: 2, remaining: 1 });
    expect(rowCount(h)).toBe(2);
  });

  it('11. meglévő tipp: módosítható kezdésig (submitted_at és points marad); változatlan nem íródik; lezárt nem módosítható', async () => {
    const { id, byExt } = await activeCompetition(h);
    await call(h, 'POST', `/api/competition/${id}/predictions`, PRO_A, tip(byExt('e1'), 1, 0));
    const before = (await h.store.getPrediction(USER_A, byExt('e1').id))!;
    await new Promise((r) => setTimeout(r, 5));
    const r = await batch(h, id, PRO_A, [tip(byExt('e1'), 1, 0), tip(byExt('e2'), 2, 2)]);
    expect(r.body.saved.map((s: any) => s.outcome)).toEqual(['unchanged', 'created']);
    expect((await h.store.getPrediction(USER_A, byExt('e1').id))!.updatedAt).toBe(before.updatedAt);
    const upd = await batch(h, id, PRO_A, [tip(byExt('e1'), 3, 0)]);
    expect(upd.body.saved[0]).toMatchObject({ outcome: 'updated', prediction: { predictedHomeScore: 3, submittedAt: before.submittedAt, points: null } });

    // már elkezdődött meccs meglévő tippje: a batch sem írhatja át
    h.db.prepare('INSERT INTO user_predictions VALUES (?, ?, ?, 0, 0, NULL, ?, ?)').run('p-started', byExt('started').id, USER_A, hours(-2), hours(-2));
    expect((await batch(h, id, PRO_A, [tip(byExt('started'), 5, 5)])).status).toBe(409);
    expect((await h.store.getPrediction(USER_A, byExt('started').id))!.predictedHomeScore).toBe(0);
  });

  it('14. a pontozás és a ranglista változatlan: batch- és egyenkénti tipp ugyanazt a pontot adja', async () => {
    const { id, byExt } = await activeCompetition(h);
    await batch(h, id, PRO_A, [tip(byExt('e1'), 2, 1), tip(byExt('e2'), 1, 0)]);
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_B, pro: true }, tip(byExt('e1'), 2, 1));
    await call(h, 'POST', `/api/competition/${id}/predictions`, { user: USER_B, pro: true }, tip(byExt('e2'), 1, 0));
    // eredmények: e1 2–1 (pontos), e2 0–2 (nem talált)
    h.provider.matches = h.provider.matches.map((m) => (m.id === 'e1' ? { ...m, status: 'finished', homeGoals: 2, awayGoals: 1 }
      : m.id === 'e2' ? { ...m, status: 'finished', homeGoals: 0, awayGoals: 2 } : m)) as Match[];
    await call(h, 'POST', `/api/admin/competition/${id}/sync`, ADMIN);
    const board = (await call(h, 'GET', `/api/competition/${id}/leaderboard`, PRO_A)).body as any[];
    const expected = scorePrediction(2, 1, 2, 1) + scorePrediction(1, 0, 0, 2);
    expect(board.map((r) => [r.displayName, r.points, r.exactHits, r.predictions])).toEqual(
      expect.arrayContaining([['Martin23', expected, 1, 2], ['Zsolti88', expected, 1, 2]]));
  });
});

// ---------------------------------------------------------------------------
// Felület (tiszta logika + statikus renderelés; DOM nélkül)
// ---------------------------------------------------------------------------

const view = (id: string, extra: Partial<CompetitionMatchView> = {}): CompetitionMatchView => ({
  id, competitionId: 'c', externalMatchId: id, homeTeam: `H-${id}`, awayTeam: `A-${id}`, kickoff: hours(3),
  homeScore: null, awayScore: null, status: 'scheduled', myPrediction: null, locked: false, lockReason: null, ...extra,
});
const saved = (h: number, a: number) => ({ predictedHomeScore: h, predictedAwayScore: a, points: null });

describe('Tömeges tippelés – felület', () => {
  const list = [
    view('m1'), view('m2'), view('m3', { myPrediction: saved(1, 0) }), view('m4', { myPrediction: saved(2, 2) }),
    view('m5'), view('m6', { locked: true, lockReason: 'Lezárva' }),
  ];

  it('összesítő: új / módosított / változatlan / hiányos / hiányzó – csak az új és a módosított kerül a csomagba', () => {
    const drafts: Drafts = { m1: { home: '2', away: '0' }, m3: { home: '1', away: '0' }, m4: { home: '3', away: '2' }, m5: { home: '1', away: '' } };
    const s = summarize(list, drafts);
    expect(s.open).toBe(5);
    expect(s.toSend).toEqual([
      { competitionMatchId: 'm1', predictedHomeScore: 2, predictedAwayScore: 0 },
      { competitionMatchId: 'm4', predictedHomeScore: 3, predictedAwayScore: 2 },
    ]);
    expect([s.newCount, s.changedCount, s.withTip]).toEqual([1, 1, 3]);
    expect(s.missing.map((m) => m.id)).toEqual(['m2']);
    expect(s.incomplete.map((m) => m.id)).toEqual(['m5']);
    expect(draftStatus(list[2], drafts.m3)).toBe('saved'); // a mentettel egyező vázlat nem megy újra
    expect(draftStatus(list[5], { home: '1', away: '1' })).toBe('locked');
    expect(submitBlocker(s, null)).toMatch(/csak az egyik gólszám/);
    expect(submitBlocker(summarize(list, { m1: { home: '2', away: '0' } }), null)).toBeNull();
  });

  it('a FREE napi keret túllépését a felület előre jelzi (a szerver ugyanígy elutasítaná)', () => {
    const s = summarize(list, { m1: { home: '1', away: '0' }, m2: { home: '1', away: '0' }, m5: { home: '0', away: '0' } });
    expect(submitBlocker(s, { remaining: 2 })).toMatch(/Ma még 2 új tippet adhatsz le, a csomagban 3 új tipp van\. Törölj 1/);
    expect(submitBlocker(s, { remaining: 3 })).toBeNull();
    expect(submitBlocker(summarize(list, {}), null)).toMatch(/Nincs új vagy módosított/);
  });

  it('12. hiba esetén a választások megmaradnak, és a szerver tételes hibája a kártyán látszik', () => {
    const drafts: Drafts = { m1: { home: '2', away: '0' }, m2: { home: '1', away: '1' } };
    const errs = errorsByMatch([{ competitionMatchId: 'm2', code: 'PREDICTION_CLOSED', message: 'A mérkőzés kezdése után már nem lehet tippelni.' }]);
    expect(errs).toEqual({ m2: 'A mérkőzés kezdése után már nem lehet tippelni.' });
    const html = renderToStaticMarkup(createElement(MatchCard, {
      m: list[1], draft: drafts.m2, canPlay: true, quotaUsedUp: false, disabled: false, error: errs.m2, onChange: () => {},
    }));
    expect(html).toContain('value="1"');
    expect(html).toContain('A mérkőzés kezdése után már nem lehet tippelni.');
    expect(html).toContain('Új tipp – beküldésre vár');
    // sikerkor CSAK a szerver által igazolt tételek vázlata törlődik
    expect(clearConfirmed(drafts, ['m1'])).toEqual({ m2: { home: '1', away: '1' } });
  });

  it('13. sikeres mentés után a mentett (szerver) állapot látszik, nem a vázlat', () => {
    const after = view('m1', { myPrediction: saved(2, 0) });
    expect(draftStatus(after, undefined)).toBe('saved');
    const html = renderToStaticMarkup(createElement(MatchCard, {
      m: after, draft: undefined, canPlay: true, quotaUsedUp: false, disabled: false, error: null, onChange: () => {},
    }));
    expect(html).toContain('Tipp mentve');
    expect(html).toContain('value="2"');
  });

  it('összesítő sáv és megerősítés: darabszám, hiányzó meccsek, a beküldés gomb tiltása', () => {
    const s = summarize(list, { m1: { home: '2', away: '0' }, m4: { home: '3', away: '2' } });
    const bar = renderToStaticMarkup(createElement(BatchBar, { summary: s, blocker: null, busy: false, confirmOpen: false, onReview: () => {} }));
    expect(bar).toContain('Tippek beküldése (2)');
    expect(bar).toMatch(/<b>3\/5<\/b> tippelhető mérkőzésre van tipped/);
    const busy = renderToStaticMarkup(createElement(BatchBar, { summary: s, blocker: null, busy: true, confirmOpen: false, onReview: () => {} }));
    expect(busy).toMatch(/<button[^>]*disabled[^>]*>.*Beküldés…/);
    const panel = renderToStaticMarkup(createElement(ConfirmPanel, { summary: s, matches: list, quota: { remaining: 3, limit: 3 }, busy: false, onCancel: () => {}, onConfirm: () => {} }));
    expect(panel).toContain('<b>2</b> tipp kerül beküldésre (1 új, 1 módosított)');
    expect(panel).toContain('2 tippelhető mérkőzésre nincs tipped');
    expect(panel).toContain('H-m2 – A-m2');
  });

  it('10b. a beküldés egyfutásos: gyors dupla kattintás egyetlen kérést indít', async () => {
    let calls = 0;
    let release!: () => void;
    const go = singleFlight(() => { calls++; return new Promise<void>((r) => { release = r; }); });
    const first = go();
    expect(await go()).toBeNull();
    release();
    await first;
    expect(calls).toBe(1);
  });

  it('a kliens egyetlen POST-ot küld a batch végpontra, csak a tételekkel', async () => {
    const seen: { url: string; method: string; body: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), method: String(init?.method), body: String(init?.body) });
      return new Response(JSON.stringify({ saved: [], created: 0, updated: 0, unchanged: 0, dailyQuota: null }), { status: 200 });
    }));
    try {
      await api.submitCompetitionPredictions('c-1', [{ competitionMatchId: 'm1', predictedHomeScore: 1, predictedAwayScore: 0 }]);
    } finally { vi.unstubAllGlobals(); }
    expect(seen).toEqual([{ url: '/api/competition/c-1/predictions/batch', method: 'POST', body: JSON.stringify({ predictions: [{ competitionMatchId: 'm1', predictedHomeScore: 1, predictedAwayScore: 0 }] }) }]);
  });
});
