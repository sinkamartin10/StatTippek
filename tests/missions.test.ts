/**
 * Napi és heti küldetések – katalógus, haladás, jutalom, idempotencia, FREE/PRO, biztonság.
 *
 * A HTTP-szintű teszteknél valódi Express alkalmazást indítunk a VALÓDI routerrel;
 * az egyetlen szimulált elem a `res.locals.plan` (élesben az attachPlan tölti ki a tokenből)
 * és a PRO-ellenőrzés forrása (élesben a profiles tábla).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { SqliteCompetitionStore } from '../src/server/competition/store';
import { SqliteProgressionStore } from '../src/server/progression/store';
import { MissionService } from '../src/server/missions/service';
import { missionsRouter } from '../src/server/routes/missions';
import {
  MISSIONS, dayKey, missionByKey, missionSourceKey, missionsFor,
  periodEndsAt, periodKeyFor, weekKey,
} from '../src/shared/missions';

const PRO_USER = '11111111-1111-1111-1111-111111111111';
const PRO_USER_B = '22222222-2222-2222-2222-222222222222';
const FREE_USER = '33333333-3333-3333-3333-333333333333';

const hoursAgo = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();

/**
 * Olyan időpont, amely BIZTOSAN a jelenlegi budapesti naphoz (és héthez) tartozik.
 * Nem fix óra-eltolást használunk, mert a teszt bármikor futhat – akár éjfél után is.
 */
function todayIso(minutesAgo = 5): string {
  const t = new Date(Date.now() - minutesAgo * 60_000);
  return dayKey(t) === dayKey() ? t.toISOString() : new Date().toISOString();
}
/** Biztosan egy korábbi héthez tartozó időpont. */
const lastWeekIso = () => new Date(Date.now() - 8 * 86400_000).toISOString();

interface Harness {
  url: string;
  close: () => Promise<void>;
  competitions: SqliteCompetitionStore;
  store: SqliteProgressionStore;
  missions: MissionService;
  proUsers: Set<string>;
}

async function startApp(): Promise<Harness> {
  const db = new DatabaseSync(':memory:');
  const competitions = new SqliteCompetitionStore(db);
  const store = new SqliteProgressionStore(db);
  const proUsers = new Set([PRO_USER, PRO_USER_B]);
  const missions = new MissionService(store, async (id) => proUsers.has(id));

  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    res.locals.plan = { enforced: true, user: id ? { id, email: '' } : null, pro: !!id && proUsers.has(id), admin: false };
    next();
  });
  app.use('/api/missions', missionsRouter(missions));

  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    competitions, store, missions, proUsers,
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

/** Tippek létrehozása: a beküldés ideje MOST, a kezdési idő a `when` szerint. */
async function seedPredictions(
  h: Harness,
  userId: string,
  specs: { when?: 'today' | 'lastWeek'; points: number | null; league?: string }[],
) {
  let i = 0;
  for (const spec of specs) {
    const league = spec.league ?? 'eng-pl';
    const c = await h.competitions.createCompetition({
      name: `M-${league}-${Math.random()}`, leagueKey: league, leagueName: league, provider: 'teszt',
      startsAt: hoursAgo(1000), endsAt: new Date(Date.now() + 1000 * 3600_000).toISOString(), status: 'active',
    });
    await h.competitions.upsertMatches(c.id, [{
      externalMatchId: `x${i}`, homeTeam: `H${i}`, awayTeam: `A${i}`,
      kickoff: spec.when === 'lastWeek' ? lastWeekIso() : todayIso(5 + i),
      homeScore: spec.points == null ? null : 2, awayScore: spec.points == null ? null : 1,
      status: spec.points == null ? 'scheduled' : 'finished',
    }]);
    const [m] = await h.competitions.listMatches(c.id);
    await h.competitions.upsertPrediction(userId, m.id, 2, 1);
    if (spec.points != null) {
      const p = await h.competitions.getPrediction(userId, m.id);
      await h.competitions.setPredictionPoints(p!.id, spec.points);
    }
    i++;
  }
}

/** A küldetések kulcs szerint, egy periódus nézetéből. */
const byKey = (view: { missions: any[] }) => Object.fromEntries(view.missions.map((m) => [m.key, m]));

let h: Harness;
beforeEach(async () => { h = await startApp(); });
afterEach(async () => { await h.close(); });

// ===========================================================================
// Katalógus – pontosan a specifikáció szerinti négy küldetés
// ===========================================================================

describe('Küldetések – katalógus', () => {
  it('M1. pontosan 4 küldetés létezik, a megadott kulcsokkal', () => {
    expect(MISSIONS).toHaveLength(4);
    expect(MISSIONS.map((m) => m.key)).toEqual([
      'daily_prediction_1', 'daily_prediction_3', 'weekly_prediction_10', 'weekly_exact_2',
    ]);
    expect(missionsFor('daily').map((m) => m.key)).toEqual(['daily_prediction_1', 'daily_prediction_3']);
    expect(missionsFor('weekly').map((m) => m.key)).toEqual(['weekly_prediction_10', 'weekly_exact_2']);
  });

  it('M2. a célértékek és az XP-jutalmak pontosan a specifikáció szerintiek', () => {
    const expected = [
      { key: 'daily_prediction_1', name: 'Első tipped', period: 'daily', metric: 'predictions', target: 1, xpReward: 25 },
      { key: 'daily_prediction_3', name: 'Napi forma', period: 'daily', metric: 'predictions', target: 3, xpReward: 50 },
      { key: 'weekly_prediction_10', name: 'Heti forma', period: 'weekly', metric: 'predictions', target: 10, xpReward: 150 },
      { key: 'weekly_exact_2', name: 'Pontos kéz', period: 'weekly', metric: 'exact', target: 2, xpReward: 200 },
    ];
    for (const e of expected) expect(missionByKey(e.key)).toMatchObject(e);
  });

  it('M3. a korábbi, eltávolított küldetések NEM léteznek', () => {
    for (const key of [
      'daily_predictions_3', 'daily_correct_2', 'daily_exact_1',
      'weekly_predictions_20', 'weekly_correct_10', 'weekly_exact_3', 'weekly_leagues_3',
    ]) {
      expect(missionByKey(key), key).toBeUndefined();
    }
    // és egyik küldetés sem használ 'correct' vagy 'leagues' mérőszámot
    expect(MISSIONS.some((m) => m.metric === 'correct' || m.metric === 'leagues')).toBe(false);
  });
});

// ===========================================================================
// Periódus-kulcsok (Europe/Budapest)
// ===========================================================================

describe('Küldetések – periódusok (Europe/Budapest)', () => {
  it('M4. a napi kulcs budapesti naptári dátum, a heti ISO hét', () => {
    // 2026-03-01 23:30 UTC → Budapestben már 2026-03-02
    expect(dayKey(new Date('2026-03-01T23:30:00Z'))).toBe('2026-03-02');
    // 2026-03-01 22:30 UTC → Budapestben még 2026-03-01 (télen UTC+1)
    expect(dayKey(new Date('2026-03-01T22:30:00Z'))).toBe('2026-03-01');
    // nyári időszámítás: UTC+2
    expect(dayKey(new Date('2026-07-01T21:30:00Z'))).toBe('2026-07-01');
    expect(dayKey(new Date('2026-07-01T22:30:00Z'))).toBe('2026-07-02');

    expect(weekKey(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01');
    expect(weekKey(new Date('2026-10-07T12:00:00Z'))).toBe('2026-W41');
    // a hét hétfővel kezdődik: vasárnap még az előző héthez tartozik
    expect(weekKey(new Date('2026-10-11T12:00:00Z'))).toBe('2026-W41');
    expect(weekKey(new Date('2026-10-12T12:00:00Z'))).toBe('2026-W42');
  });

  it('M5. a periódus vége a következő kulcsváltás pillanata', () => {
    const now = new Date('2026-07-07T10:00:00Z');
    const dayEnd = new Date(periodEndsAt('daily', now));
    expect(dayKey(new Date(dayEnd.getTime() - 60_000))).toBe(dayKey(now));
    expect(dayKey(dayEnd)).not.toBe(dayKey(now));

    const weekEnd = new Date(periodEndsAt('weekly', now));
    expect(weekKey(new Date(weekEnd.getTime() - 60_000))).toBe(weekKey(now));
    expect(weekKey(weekEnd)).not.toBe(weekKey(now));
  });
});

// ===========================================================================
// Haladás számítása
// ===========================================================================

describe('Küldetések – haladás', () => {
  it('M6. a „leadott tipp" a beküldés ideje szerint számol (napi és heti egyaránt)', async () => {
    await seedPredictions(h, PRO_USER, [{ points: 3 }, { points: 5 }]);
    const r = await call(h, 'GET', '/api/missions', PRO_USER);
    expect(r.status).toBe(200);

    const daily = byKey(r.body.daily);
    expect(daily.daily_prediction_1.progress).toBe(1);   // a célnál megáll
    expect(daily.daily_prediction_1.completed).toBe(true);
    expect(daily.daily_prediction_3.progress).toBe(2);
    expect(daily.daily_prediction_3.completed).toBe(false);

    const weekly = byKey(r.body.weekly);
    expect(weekly.weekly_prediction_10.progress).toBe(2);
    expect(weekly.weekly_prediction_10.completed).toBe(false);
  });

  it('M7. a „pontos eredmény" a mérkőzés kezdése szerint számol', async () => {
    // két pontos találat: az egyik mérkőzés EZEN a héten, a másik egy hete volt
    await seedPredictions(h, PRO_USER, [
      { points: 5 },
      { when: 'lastWeek', points: 5 },
    ]);
    const weekly = byKey((await call(h, 'GET', '/api/missions', PRO_USER)).body.weekly);
    expect(weekly.weekly_exact_2.progress).toBe(1);      // csak a héten lejátszott számít
    expect(weekly.weekly_exact_2.completed).toBe(false);

    await seedPredictions(h, PRO_USER, [{ points: 5 }]);
    const weekly2 = byKey((await call(h, 'GET', '/api/missions', PRO_USER)).body.weekly);
    expect(weekly2.weekly_exact_2.progress).toBe(2);
    expect(weekly2.weekly_exact_2.completed).toBe(true);
  });

  it('M8. a rossz tipp nem számít pontos találatnak, de leadott tippnek igen', async () => {
    await seedPredictions(h, PRO_USER, [{ points: 0 }, { points: 3 }]);
    const r = await call(h, 'GET', '/api/missions', PRO_USER);
    expect(byKey(r.body.daily).daily_prediction_3.progress).toBe(2);
    expect(byKey(r.body.weekly).weekly_exact_2.progress).toBe(0);
  });

  it('M9. üres állapot: minden küldetés 0 haladással, teljesítés nélkül', async () => {
    const r = await call(h, 'GET', '/api/missions', PRO_USER);
    expect(r.body.daily.missions.every((m: any) => m.progress === 0 && !m.completed && !m.claimed)).toBe(true);
    expect(r.body.weekly.missions.every((m: any) => m.progress === 0)).toBe(true);
    expect(r.body.daily.completed).toBe(0);
    expect(r.body.daily.total).toBe(2);
    expect(r.body.weekly.total).toBe(2);
    expect(r.body.claimedTotal).toBe(0);
    expect(new Date(r.body.daily.resetsAt).getTime()).toBeGreaterThan(Date.now());
  });
});

// ===========================================================================
// Jutalom: idempotencia és FREE/PRO
// ===========================================================================

describe('Küldetések – jutalom', () => {
  it('M10. PRO felhasználó a pontos XP-t kapja, a MEGLÉVŐ XP-naplóba', async () => {
    await seedPredictions(h, PRO_USER, [{ points: 3 }]);
    const r = await call(h, 'POST', '/api/missions/daily_prediction_1/claim', PRO_USER);
    expect(r.status).toBe(200);
    expect(r.body.xpAwarded).toBe(25);
    expect(r.body.alreadyClaimed).toBe(false);
    expect(r.body.mission.claimed).toBe(true);

    expect(await h.store.totalXp(PRO_USER)).toBe(25);
    const claims = await h.store.missionClaims(PRO_USER, [periodKeyFor('daily')]);
    expect(claims.get('daily_prediction_1')?.xpAwarded).toBe(25);
  });

  it('M11. mind a négy küldetés a saját XP-jét adja', async () => {
    // 10 tipp, köztük 2 pontos találat → mind a négy küldetés teljesül
    await seedPredictions(h, PRO_USER, [
      { points: 5 }, { points: 5 }, { points: 3 }, { points: 3 }, { points: 0 },
      { points: 0 }, { points: 3 }, { points: 3 }, { points: 0 }, { points: 3 },
    ]);
    const list = await call(h, 'GET', '/api/missions', PRO_USER);
    expect(byKey(list.body.daily).daily_prediction_3.completed).toBe(true);
    expect(byKey(list.body.weekly).weekly_prediction_10.completed).toBe(true);
    expect(byKey(list.body.weekly).weekly_exact_2.completed).toBe(true);

    let expected = 0;
    for (const [key, xp] of [['daily_prediction_1', 25], ['daily_prediction_3', 50], ['weekly_prediction_10', 150], ['weekly_exact_2', 200]] as const) {
      const r = await call(h, 'POST', `/api/missions/${key}/claim`, PRO_USER);
      expect(r.status, key).toBe(200);
      expect(r.body.xpAwarded, key).toBe(xp);
      expected += xp;
    }
    expect(await h.store.totalXp(PRO_USER)).toBe(expected); // 425
  });

  it('M12. ugyanaz a küldetés ugyanabban a periódusban csak egyszer jutalmaz', async () => {
    await seedPredictions(h, PRO_USER, [{ points: 3 }]);
    await call(h, 'POST', '/api/missions/daily_prediction_1/claim', PRO_USER);
    const xpAfterFirst = await h.store.totalXp(PRO_USER);

    const second = await call(h, 'POST', '/api/missions/daily_prediction_1/claim', PRO_USER);
    expect(second.status).toBe(200);
    expect(second.body.xpAwarded).toBe(0);
    expect(second.body.alreadyClaimed).toBe(true);
    expect(await h.store.totalXp(PRO_USER)).toBe(xpAfterFirst);
  });

  it('M13. párhuzamos átvétel sem ad dupla jutalmat', async () => {
    await seedPredictions(h, PRO_USER, [{ points: 3 }]);
    const results = await Promise.all([1, 2, 3, 4].map(() => h.missions.claim(PRO_USER, 'daily_prediction_1')));
    expect(results.filter((r) => !r.alreadyClaimed)).toHaveLength(1);
    expect(await h.store.totalXp(PRO_USER)).toBe(25);
  });

  it('M14. nem teljesített küldetés jutalma elutasítva', async () => {
    const r = await call(h, 'POST', '/api/missions/daily_prediction_1/claim', PRO_USER);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('NOT_COMPLETED');
    expect(await h.store.totalXp(PRO_USER)).toBe(0);
  });

  it('M15. FREE felhasználó teljesítheti a küldetést, de 0 XP-t kap', async () => {
    await seedPredictions(h, FREE_USER, [{ points: 3 }]);
    const list = await call(h, 'GET', '/api/missions', FREE_USER);
    expect(list.body.pro).toBe(false);
    const daily = byKey(list.body.daily);
    expect(daily.daily_prediction_1.completed).toBe(true);
    expect(daily.daily_prediction_1.xpReward).toBe(0); // FREE-nek nem jár XP

    const r = await call(h, 'POST', '/api/missions/daily_prediction_1/claim', FREE_USER);
    expect(r.status).toBe(200);
    expect(r.body.xpAwarded).toBe(0);
    expect(r.body.mission.claimed).toBe(true);        // a teljesítés rögzül
    expect(await h.store.totalXp(FREE_USER)).toBe(0); // de XP nem keletkezik
    expect(await h.store.listAchievements(FREE_USER)).toEqual([]);
  });

  it('M16. a küldetés-XP forráskulcsa egyedi periódusonként', async () => {
    const key = missionSourceKey('daily_prediction_1', '2026-10-07');
    expect(key).toBe('mission:daily_prediction_1:2026-10-07');
    expect(missionSourceKey('daily_prediction_1', '2026-10-08')).not.toBe(key);
    // a tároló szintjén is idempotens
    expect(await h.store.claimEvent(PRO_USER, 'mission', key, 25)).toBe(true);
    expect(await h.store.claimEvent(PRO_USER, 'mission', key, 25)).toBe(false);
    expect(await h.store.totalXp(PRO_USER)).toBe(25);
  });
});

// ===========================================================================
// Biztonság
// ===========================================================================

describe('Küldetések – biztonság', () => {
  it('M17. hitelesítés nélkül mindkét végpont 401', async () => {
    expect((await call(h, 'GET', '/api/missions')).status).toBe(401);
    expect((await call(h, 'POST', '/api/missions/daily_prediction_1/claim')).status).toBe(401);
  });

  it('M18. a kliens által küldött haladás, teljesítés és XP figyelmen kívül marad', async () => {
    const r = await call(h, 'POST', '/api/missions/daily_prediction_1/claim', PRO_USER, {
      progress: 999, completed: true, xp: 999999, xpAwarded: 999999, reward: 'legend', user_id: PRO_USER_B,
    });
    expect(r.status).toBe(409);             // a szerver újraszámolt: nincs tipp, nincs teljesítés
    expect(await h.store.totalXp(PRO_USER)).toBe(0);
    expect(await h.store.totalXp(PRO_USER_B)).toBe(0);
  });

  it('M19. más felhasználó küldetése nem vehető át és nem látható', async () => {
    await seedPredictions(h, PRO_USER_B, [{ points: 3 }]);
    // A user saját listája üres marad, hiába küld idegen azonosítót
    const list = await call(h, 'GET', '/api/missions?userId=' + PRO_USER_B, PRO_USER);
    expect(byKey(list.body.daily).daily_prediction_1.progress).toBe(0);

    // és A nem tudja átvenni B teljesítését
    expect((await call(h, 'POST', '/api/missions/daily_prediction_1/claim', PRO_USER)).status).toBe(409);
    expect(await h.store.totalXp(PRO_USER_B)).toBe(0); // B XP-je sem mozdul
  });

  it('M20. ismeretlen vagy érvénytelen küldetés-azonosító', async () => {
    expect((await call(h, 'POST', '/api/missions/nincs_ilyen/claim', PRO_USER)).status).toBe(404);
    // a régi, eltávolított kulcs már ismeretlen
    expect((await call(h, 'POST', '/api/missions/weekly_leagues_3/claim', PRO_USER)).status).toBe(404);
    expect((await call(h, 'POST', '/api/missions/VAN%20BENNE/claim', PRO_USER)).status).toBe(400);
  });

  it('M21. a válasz nem tartalmaz e-mailt, user_id-t vagy előfizetési adatot', async () => {
    await seedPredictions(h, PRO_USER, [{ points: 5 }]);
    const r = await call(h, 'GET', '/api/missions', PRO_USER);
    expect(r.raw).not.toContain('@');
    expect(r.raw).not.toContain(PRO_USER);
    expect(r.raw).not.toContain('subscription');
  });

  it('M22. a periódus váltásával a küldetés újra teljesíthető (külön kulcs)', async () => {
    await seedPredictions(h, PRO_USER, [{ points: 3 }]);
    await call(h, 'POST', '/api/missions/daily_prediction_1/claim', PRO_USER);
    const xpToday = await h.store.totalXp(PRO_USER);

    // másnapi periódus-kulccsal a tároló új sort fogad el (az egyediség kulcsonként él)
    const tomorrow = new Date(Date.now() + 26 * 3600_000);
    const created = await h.store.claimMission({
      userId: PRO_USER, missionKey: 'daily_prediction_1', periodKey: periodKeyFor('daily', tomorrow),
      periodType: 'daily', progress: 1, xpAwarded: 25,
    });
    expect(created).toBe(true);
    expect(periodKeyFor('daily', tomorrow)).not.toBe(periodKeyFor('daily'));
    expect(xpToday).toBe(25);
  });

  it('M23. nincs N+1: a lista fix számú lekérdezésből áll elő', async () => {
    const calls: Record<string, number> = {};
    const counted = new Proxy(h.store, {
      get(target, prop: string) {
        const v = (target as any)[prop];
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => { calls[prop] = (calls[prop] ?? 0) + 1; return v.apply(target, args); };
      },
    }) as typeof h.store;
    const svc = new MissionService(counted, async (id) => h.proUsers.has(id));

    await seedPredictions(h, PRO_USER, Array.from({ length: 8 }, () => ({ points: 3 })));
    Object.keys(calls).forEach((k) => delete calls[k]);
    await svc.overview(PRO_USER);

    expect(calls.allPredictions).toBe(1);
    expect(calls.missionClaims).toBe(1);
  });
});
