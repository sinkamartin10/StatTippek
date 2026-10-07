/**
 * Kliensoldali URL-építés regressziós tesztje.
 *
 * Miért kell: a `request(path, init, prefix)` harmadik paramétere a TELJES mount-prefix
 * (pl. '/api/competition'), a `path` pedig csak az azon belüli rész. Ha a path megismétli
 * a prefix szegmensét, a hívás a `/api/competition/competition/...` címre menne, amit a
 * szerver 400-zal utasít el – a hiba viszont sem a typecheck, sem a build, sem a
 * szerveroldali tesztek számára nem látszik.
 *
 * Ez a teszt VALÓDI kliensfüggvényeket hív, a fetch-et lecserélve, és a kapott URL-t
 * hasonlítja a szerveren ténylegesen mountolt útvonalakhoz (lásd src/server/index.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../src/client/lib/api';

const UUID = '11111111-1111-1111-1111-111111111111';

let calls: { url: string; method: string }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: (init?.method ?? 'GET').toUpperCase() });
    return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

/** A hívás után visszaadja az egyetlen rögzített kérést. */
async function urlOf(fn: () => Promise<unknown>): Promise<{ url: string; method: string }> {
  await fn();
  expect(calls).toHaveLength(1);
  return calls[0];
}

describe('Kliens API – nyilvános Tippverseny útvonalak', () => {
  it('egyetlen URL sem tartalmazhat duplikált szegmenst', async () => {
    const fns: (() => Promise<unknown>)[] = [
      () => api.competitions(),
      () => api.competition(UUID),
      () => api.competitionMatches(UUID),
      () => api.competitionLeaderboard(UUID),
      () => api.competitionMyPredictions(UUID),
      () => api.competitionMyStats(UUID),
      () => api.submitCompetitionPrediction(UUID, UUID, 2, 1),
      () => api.progressionStats(),
      () => api.progressionHistory(10),
      () => api.missions(),
      () => api.claimMission('daily_exact_1'),
      () => api.battles(),
      () => api.battle(UUID),
      () => api.battleEligibleOpponents(),
      () => api.battleEligibleMatches(),
      () => api.createBattle(UUID, [UUID, UUID, UUID]),
      () => api.acceptBattle(UUID),
      () => api.declineBattle(UUID),
      () => api.cancelBattle(UUID),
      () => api.submitBattlePrediction(UUID, UUID, 2, 1),
      () => api.notifications(),
      () => api.notifications({ limit: 5 }),
      () => api.markNotificationRead(UUID),
      () => api.markAllNotificationsRead(),
    ];
    for (const fn of fns) {
      calls = [];
      const { url } = await urlOf(fn);
      expect(url, url).not.toContain('/competition/competition');
      expect(url, url).not.toContain('/profile/profile');
      expect(url, url).not.toContain('/progression/progression');
      expect(url, url).not.toContain('/missions/missions');
      expect(url, url).not.toContain('/battles/battles');
      expect(url, url).not.toContain('/notifications/notifications');
      expect(url, url).not.toContain('//api');
    }
  });

  it('pontosan a szerveren mountolt útvonalakra mennek a hívások', async () => {
    expect((await urlOf(() => api.competitions())).url).toBe('/api/competition');
    calls = [];
    expect((await urlOf(() => api.competition(UUID))).url).toBe(`/api/competition/${UUID}`);
    calls = [];
    expect((await urlOf(() => api.competitionMatches(UUID))).url).toBe(`/api/competition/${UUID}/matches`);
    calls = [];
    expect((await urlOf(() => api.competitionLeaderboard(UUID))).url).toBe(`/api/competition/${UUID}/leaderboard`);
    calls = [];
    expect((await urlOf(() => api.competitionMyPredictions(UUID))).url).toBe(`/api/competition/${UUID}/my-predictions`);
    calls = [];
    expect((await urlOf(() => api.competitionMyStats(UUID))).url).toBe(`/api/competition/${UUID}/me`);
    calls = [];
    const post = await urlOf(() => api.submitCompetitionPrediction(UUID, UUID, 2, 1));
    expect(post.url).toBe(`/api/competition/${UUID}/predictions`);
    expect(post.method).toBe('POST');
  });
});

describe('Kliens API – admin Tippverseny útvonalak', () => {
  it('az admin hívások a /api/admin/competition alá mennek', async () => {
    expect((await urlOf(() => api.adminCompetitions())).url).toBe('/api/admin/competition');
    calls = [];
    expect((await urlOf(() => api.adminCompetitionLeagues())).url).toBe('/api/admin/competition/leagues');
    calls = [];
    expect((await urlOf(() => api.adminCompetition(UUID))).url).toBe(`/api/admin/competition/${UUID}`);
    calls = [];
    expect((await urlOf(() => api.adminCreateCompetition({ name: 'X', leagueKey: 'eng-pl', startsAt: '', endsAt: '' }))).url)
      .toBe('/api/admin/competition');
    calls = [];
    expect((await urlOf(() => api.adminCompetitionAction(UUID, 'activate'))).url).toBe(`/api/admin/competition/${UUID}/activate`);
    calls = [];
    expect((await urlOf(() => api.adminCompetitionSync(UUID))).url).toBe(`/api/admin/competition/${UUID}/sync`);
    calls = [];
    expect((await urlOf(() => api.adminCompetitionFinish(UUID))).url).toBe(`/api/admin/competition/${UUID}/finish`);
    calls = [];
    expect((await urlOf(() => api.adminCompetitionLeaderboard(UUID))).url).toBe(`/api/admin/competition/${UUID}/leaderboard`);
    calls = [];
    expect((await urlOf(() => api.adminCompetitionRewards(UUID))).url).toBe(`/api/admin/competition/${UUID}/rewards`);
    calls = [];
    const patch = await urlOf(() => api.adminSetRewardStatus(UUID, UUID, 'granted'));
    expect(patch.url).toBe(`/api/admin/competition/${UUID}/rewards/${UUID}`);
    expect(patch.method).toBe('PATCH');
  });
});

describe('Kliens API – 1v1 Battle útvonalak', () => {
  it('pontosan a szerveren mountolt /api/battles útvonalakra mennek a hívások', async () => {
    expect((await urlOf(() => api.battles())).url).toBe('/api/battles');
    calls = [];
    expect((await urlOf(() => api.battle(UUID))).url).toBe(`/api/battles/${UUID}`);
    calls = [];
    expect((await urlOf(() => api.battleEligibleOpponents())).url).toBe('/api/battles/eligible-opponents');
    calls = [];
    expect((await urlOf(() => api.battleEligibleMatches())).url).toBe('/api/battles/eligible-matches');
    calls = [];
    const create = await urlOf(() => api.createBattle(UUID, [UUID, UUID, UUID]));
    expect(create.url).toBe('/api/battles');
    expect(create.method).toBe('POST');
    calls = [];
    const accept = await urlOf(() => api.acceptBattle(UUID));
    expect(accept.url).toBe(`/api/battles/${UUID}/accept`);
    expect(accept.method).toBe('POST');
    calls = [];
    expect((await urlOf(() => api.declineBattle(UUID))).url).toBe(`/api/battles/${UUID}/decline`);
    calls = [];
    expect((await urlOf(() => api.cancelBattle(UUID))).url).toBe(`/api/battles/${UUID}/cancel`);
    calls = [];
    const pred = await urlOf(() => api.submitBattlePrediction(UUID, UUID, 2, 1));
    expect(pred.url).toBe(`/api/battles/${UUID}/predictions`);
    expect(pred.method).toBe('POST');
  });

  it('a battle hívások SOHA nem mennek a Tippverseny vagy a küldetés útvonalaira', async () => {
    for (const fn of [
      () => api.battles(), () => api.battle(UUID), () => api.createBattle(UUID, [UUID, UUID, UUID]),
      () => api.submitBattlePrediction(UUID, UUID, 2, 1),
    ]) {
      calls = [];
      const { url } = await urlOf(fn);
      expect(url, url).toMatch(/^\/api\/battles(\/|$)/);
      expect(url, url).not.toContain('/api/competition');
      expect(url, url).not.toContain('/api/missions');
      expect(url, url).not.toContain('/api/progression');
    }
  });
});

describe('Kliens API – értesítés útvonalak', () => {
  it('pontosan a szerveren mountolt /api/notifications útvonalakra mennek a hívások', async () => {
    expect((await urlOf(() => api.notifications())).url).toBe('/api/notifications');
    calls = [];
    expect((await urlOf(() => api.notifications({ limit: 5 }))).url).toBe('/api/notifications?limit=5');
    calls = [];
    expect((await urlOf(() => api.notifications({ before: '2026-10-07T10:00:00.000Z' }))).url)
      .toBe('/api/notifications?before=2026-10-07T10%3A00%3A00.000Z');
    calls = [];
    const read = await urlOf(() => api.markNotificationRead(UUID));
    expect(read.url).toBe(`/api/notifications/${UUID}/read`);
    expect(read.method).toBe('POST');
    calls = [];
    const all = await urlOf(() => api.markAllNotificationsRead());
    expect(all.url).toBe('/api/notifications/read-all');
    expect(all.method).toBe('POST');
  });

  it('az értesítés-hívások SOHA nem mennek más modul útvonalaira', async () => {
    for (const fn of [
      () => api.notifications(), () => api.markNotificationRead(UUID), () => api.markAllNotificationsRead(),
    ]) {
      calls = [];
      const { url } = await urlOf(fn);
      expect(url, url).toMatch(/^\/api\/notifications(\/|\?|$)/);
      expect(url, url).not.toContain('/api/battles');
      expect(url, url).not.toContain('/api/competition');
      expect(url, url).not.toContain('/api/missions');
    }
  });
});

describe('Kliens API – profil és a meglévő végpontok', () => {
  it('a profil hívások a /api/profile alá mennek', async () => {
    expect((await urlOf(() => api.profileMe())).url).toBe('/api/profile/me');
    calls = [];
    const put = await urlOf(() => api.saveDisplayName('Martin23'));
    expect(put.url).toBe('/api/profile/display-name');
    expect(put.method).toBe('PUT');
  });

  it('a progression hívások a /api/progression alá mennek', async () => {
    expect((await urlOf(() => api.progressionMe())).url).toBe('/api/progression/me');
    calls = [];
    const put = await urlOf(() => api.saveProgressionSettings({ border: 'classic' }));
    expect(put.url).toBe('/api/progression/settings');
    expect(put.method).toBe('PUT');
    calls = [];
    expect((await urlOf(() => api.progressionStats())).url).toBe('/api/progression/stats');
    calls = [];
    expect((await urlOf(() => api.progressionHistory())).url).toBe('/api/progression/history');
    calls = [];
    expect((await urlOf(() => api.progressionHistory(25))).url).toBe('/api/progression/history?limit=25');
  });

  it('a küldetés-hívások a /api/missions alá mennek', async () => {
    expect((await urlOf(() => api.missions())).url).toBe('/api/missions');
    calls = [];
    const post = await urlOf(() => api.claimMission('daily_exact_1'));
    expect(post.url).toBe('/api/missions/daily_exact_1/claim');
    expect(post.method).toBe('POST');
  });

  it('a korábbi végpontok változatlanul a /api alá mennek', async () => {
    expect((await urlOf(() => api.status())).url).toBe('/api/status');
    calls = [];
    expect((await urlOf(() => api.leagues())).url).toBe('/api/leagues');
    calls = [];
    expect((await urlOf(() => api.tips('2026-10-05'))).url).toBe('/api/tips?date=2026-10-05');
    calls = [];
    expect((await urlOf(() => api.savedSlips())).url).toBe('/api/slips/saved');
    calls = [];
    expect((await urlOf(() => api.billingConfig())).url).toBe('/api/billing/config');
  });
});
