/**
 * Coin jutalom-hookok (5c) – a MEGLÉVŐ TippStats eseményekre kapcsolva.
 *
 * A tesztek a VALÓDI úton futnak: a tipp leadását a valódi
 * `CompetitionService.submitPrediction()`, a kiértékelés-alapú jutalmakat a
 * valódi `settle()`, a helyezési jutalmakat a valódi `finish()`, a napi/heti
 * jutalmakat pedig a valódi `MissionService.claim()` váltja ki. A coin minden
 * esetben a valódi `CoinService`-en és a `SqliteCoinStore` ugyanazon
 * megszorításain megy át, mint élesben.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { SqliteCompetitionStore } from '../src/server/competition/store';
import { CompetitionService } from '../src/server/competition/service';
import { SqliteProgressionStore } from '../src/server/progression/store';
import { ProgressionService } from '../src/server/progression/service';
import { MissionService } from '../src/server/missions/service';
import { SqliteCoinStore } from '../src/server/coins/store';
import { CoinService } from '../src/server/coins/service';
import { CoinRewardService, DAILY_TIPS_MISSION_KEY, WEEKLY_TIPS_MISSION_KEY } from '../src/server/coins/rewards';
import { InMemoryDisplayNameDirectory } from '../src/server/profile/displayNameDirectory';
import { COIN_REWARDS, STREAK_TARGET, TOP10_PLACEMENT } from '../src/shared/shop';
import { STREAK_BONUS_AT, streakBonusPredictionIds } from '../src/shared/progression';
import { dayKey, periodKeyFor, weekKey } from '../src/shared/missions';
import type { MatchDataProvider } from '../src/server/data/provider';
import type { League, Match, MatchResult, Team } from '../src/shared/types';

const PRO = '11111111-1111-1111-1111-111111111111';
const FREE = '33333333-3333-3333-3333-333333333333';
const OTHER = '22222222-2222-2222-2222-222222222222';

const hours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();

/** Minimális provider – ezek a tesztek nem hívnak külső adatforrást. */
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
  db: InstanceType<typeof DatabaseSync>;
  competitions: SqliteCompetitionStore;
  progressionStore: SqliteProgressionStore;
  competitionSvc: CompetitionService;
  missions: MissionService;
  coins: CoinService;
  rewards: CoinRewardService;
  names: InMemoryDisplayNameDirectory;
}

function build(): Harness {
  const db = new DatabaseSync(':memory:');
  const competitions = new SqliteCompetitionStore(db);
  const progressionStore = new SqliteProgressionStore(db);
  const coinStore = new SqliteCoinStore(db);
  const proUsers = new Set([PRO]);
  const progression = new ProgressionService(progressionStore, async (id) => proUsers.has(id));
  const coins = new CoinService(coinStore);
  // A tipp-adatok forrása a MEGLÉVŐ progression tároló – nincs új tábla, nincs új számláló
  const rewards = new CoinRewardService(coins, progressionStore);
  const names = new InMemoryDisplayNameDirectory();
  const competitionSvc = new CompetitionService(
    competitions, new StubProvider(), names, progression, undefined, rewards,
  );
  const missions = new MissionService(progressionStore, async (id) => proUsers.has(id), rewards);
  return { db, competitions, progressionStore, competitionSvc, missions, coins, rewards, names };
}

let h: Harness;
beforeEach(async () => {
  h = build();
  await h.names.set(PRO, 'Martin23');
  await h.names.set(FREE, 'Ingyenes1');
  await h.names.set(OTHER, 'Zsolti88');
});
afterEach(() => { /* in-memory DB – nincs mit zárni */ });

const balance = (user: string) => h.coins.getBalance(user).then((b) => b.balance);
const history = (user: string) => h.coins.getHistory(user, { limit: 100 }).then((p) => p.transactions);
const coinsOf = async (user: string, type: string) =>
  (await history(user)).filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0);

/**
 * Verseny létrehozása adott eredményekkel. A tippeket a TÁROLÓN keresztül
 * írjuk, hogy a beküldési jutalom ne keveredjen a kiértékelés vizsgálatába;
 * a beküldési útvonalat külön blokk teszteli a valódi service-en.
 */
async function playCompetition(
  user: string,
  rounds: [number, number, number, number][],
  offsetHours = -100,
  leagueKey = 'eng-pl',
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
    await h.competitions.upsertPrediction(user, matches[i].id, rounds[i][0], rounds[i][1]);
  }
  await h.competitionSvc.settle(c.id);
  return c;
}

const EXACT: [number, number, number, number] = [2, 1, 2, 1];
const CORRECT: [number, number, number, number] = [2, 0, 1, 0];
const WRONG: [number, number, number, number] = [2, 1, 0, 3];

/** Nyitott verseny egy jövőbeli meccsel – a beküldési úthoz. */
async function openCompetition() {
  const c = await h.competitions.createCompetition({
    name: `Nyitott ${Math.random()}`, leagueKey: 'eng-pl', leagueName: 'eng-pl', provider: 'teszt',
    startsAt: hours(-1), endsAt: hours(72), status: 'active',
  });
  await h.competitions.upsertMatches(c.id, [{
    externalMatchId: 'open-1', homeTeam: 'H', awayTeam: 'A',
    kickoff: hours(24), homeScore: null, awayScore: null, status: 'scheduled',
  }]);
  const [m] = await h.competitions.listMatches(c.id);
  return { c, m };
}

// ===========================================================================
// A konfiguráció nem duplikálódik
// ===========================================================================

describe('Coin hookok – a jóváhagyott konfiguráció az authority', () => {
  it('C0. a hookok a shared/shop.ts értékeit használják, nem saját konstansokat', () => {
    expect(COIN_REWARDS.PREDICTION_SUBMITTED).toBe(10);
    expect(COIN_REWARDS.CORRECT_OUTCOME).toBe(75);
    expect(COIN_REWARDS.EXACT_SCORE).toBe(150);
    expect(COIN_REWARDS.STREAK_3).toBe(150);
    expect(COIN_REWARDS.DAILY_TIPS).toBe(20);
    expect(COIN_REWARDS.WEEKLY_TIPS).toBe(250);
    expect(COIN_REWARDS.COMPETITION_TOP10).toBe(400);
    expect(COIN_REWARDS.COMPETITION_FIRST).toBe(1500);
  });

  it('C0b. a coin a MEGLÉVŐ küldetéskulcsokra kapcsolódik (nincs új küldetés)', () => {
    expect(DAILY_TIPS_MISSION_KEY).toBe('daily_prediction_3');
    expect(WEEKLY_TIPS_MISSION_KEY).toBe('weekly_prediction_10');
  });

  it('C0c. a 3-as sorozat a MEGLÉVŐ algoritmust használja, az XP 5-ös küszöbe változatlan', () => {
    const rows = [1, 2, 3, 4].map((n) => ({ predictionId: `p${n}`, points: 3, kickoff: hours(n), leagueKey: 'x' }));
    // alapértelmezés = XP viselkedés (5), paraméterrel = coin viselkedés (3)
    expect(STREAK_BONUS_AT).toBe(5);
    expect(STREAK_TARGET).toBe(3);
    expect(streakBonusPredictionIds(rows)).toEqual([]);          // 4 helyes < 5
    expect(streakBonusPredictionIds(rows, STREAK_TARGET)).toEqual(['p3']);
  });
});

// ===========================================================================
// 1) Tipp leadása
// ===========================================================================

describe('Coin hook – tipp leadása', () => {
  it('C1. sikeres beküldés → +10', async () => {
    const { c, m } = await openCompetition();
    await h.competitionSvc.submitPrediction(c.id, PRO, m.id, 2, 1);
    expect(await balance(PRO)).toBe(COIN_REWARDS.PREDICTION_SUBMITTED);
    expect((await history(PRO))[0].type).toBe('PREDICTION_SUBMITTED');
  });

  it('C2. érvénytelen gólszám → 0 coin', async () => {
    const { c, m } = await openCompetition();
    await expect(h.competitionSvc.submitPrediction(c.id, PRO, m.id, -1, 1)).rejects.toThrow();
    await expect(h.competitionSvc.submitPrediction(c.id, PRO, m.id, 2, 100)).rejects.toThrow();
    expect(await balance(PRO)).toBe(0);
    expect(await history(PRO)).toHaveLength(0);
  });

  it('C2b. hiányzó megjelenítési név (részvételi feltétel) → 0 coin', async () => {
    const { c, m } = await openCompetition();
    const nameless = '44444444-4444-4444-4444-444444444444';
    await expect(h.competitionSvc.submitPrediction(c.id, nameless, m.id, 2, 1)).rejects.toThrow();
    expect(await balance(nameless)).toBe(0);
  });

  it('C2c. lezárt tippelési ablak → 0 coin', async () => {
    const c = await h.competitions.createCompetition({
      name: 'Zárt', leagueKey: 'eng-pl', leagueName: 'eng-pl', provider: 'teszt',
      startsAt: hours(-50), endsAt: hours(50), status: 'active',
    });
    await h.competitions.upsertMatches(c.id, [{
      externalMatchId: 'past', homeTeam: 'H', awayTeam: 'A',
      kickoff: hours(-2), homeScore: null, awayScore: null, status: 'scheduled',
    }]);
    const [m] = await h.competitions.listMatches(c.id);
    await expect(h.competitionSvc.submitPrediction(c.id, PRO, m.id, 2, 1)).rejects.toThrow();
    expect(await balance(PRO)).toBe(0);
  });

  it('C2d. FREE napi kvóta elérése → a visszautasított tipp nem fizet', async () => {
    const { c, m } = await openCompetition();
    // dailyLimit = 0: a kvóta azonnal elfogyott
    await expect(h.competitionSvc.submitPrediction(c.id, FREE, m.id, 2, 1, new Date(), true, 0)).rejects.toThrow();
    expect(await balance(FREE)).toBe(0);
  });

  it('C3. a tipp MÓDOSÍTÁSA nem fizet újra (ugyanaz a tipp-azonosító)', async () => {
    const { c, m } = await openCompetition();
    await h.competitionSvc.submitPrediction(c.id, PRO, m.id, 2, 1);
    await h.competitionSvc.submitPrediction(c.id, PRO, m.id, 3, 0);
    await h.competitionSvc.submitPrediction(c.id, PRO, m.id, 1, 1);
    expect(await balance(PRO)).toBe(COIN_REWARDS.PREDICTION_SUBMITTED);
    expect(await history(PRO)).toHaveLength(1);
  });

  it('C3b. ugyanaz az esemény másodszor már nem ad coint (hook közvetlenül)', async () => {
    const first = await h.rewards.onPredictionSubmitted(PRO, 'pred-1');
    const second = await h.rewards.onPredictionSubmitted(PRO, 'pred-1');
    expect(first.awarded).toBe(COIN_REWARDS.PREDICTION_SUBMITTED);
    expect(second.awarded).toBe(0);
    expect(await balance(PRO)).toBe(COIN_REWARDS.PREDICTION_SUBMITTED);
  });
});

// ===========================================================================
// 2–3) Helyes 1X2 és pontos eredmény
// ===========================================================================

describe('Coin hook – helyes 1X2 és pontos eredmény', () => {
  it('C4. helyes 1X2 (3 pont) → +75 (a beküldési 10 mellett)', async () => {
    await playCompetition(PRO, [CORRECT]);
    expect(await coinsOf(PRO, 'CORRECT_OUTCOME')).toBe(COIN_REWARDS.CORRECT_OUTCOME);
    expect(await coinsOf(PRO, 'EXACT_SCORE')).toBe(0);
    expect(await balance(PRO)).toBe(COIN_REWARDS.PREDICTION_SUBMITTED + COIN_REWARDS.CORRECT_OUTCOME);
  });

  it('C5. rossz tipp (0 pont) → se 1X2, se pontos eredmény', async () => {
    await playCompetition(PRO, [WRONG]);
    expect(await coinsOf(PRO, 'CORRECT_OUTCOME')).toBe(0);
    expect(await coinsOf(PRO, 'EXACT_SCORE')).toBe(0);
    expect(await balance(PRO)).toBe(COIN_REWARDS.PREDICTION_SUBMITTED);
  });

  it('C6. pontos eredmény (5 pont) → +150, és NEM jár mellé a +75', async () => {
    await playCompetition(PRO, [EXACT]);
    expect(await coinsOf(PRO, 'EXACT_SCORE')).toBe(COIN_REWARDS.EXACT_SCORE);
    expect(await coinsOf(PRO, 'CORRECT_OUTCOME'), 'kizárólagos, mint a meglévő XP-szabály').toBe(0);
    expect(await balance(PRO)).toBe(COIN_REWARDS.PREDICTION_SUBMITTED + COIN_REWARDS.EXACT_SCORE);
  });

  it('C7. ISMÉTELT kiértékelés nem fizet újra', async () => {
    const c = await playCompetition(PRO, [EXACT, CORRECT, WRONG]);
    const after = await balance(PRO);
    await h.competitionSvc.settle(c.id);
    await h.competitionSvc.settle(c.id);
    await h.rewards.reconcileUser(PRO);
    expect(await balance(PRO)).toBe(after);
  });

  it('C7b. a kiértékelés-alapú jutalom csak KIÉRTÉKELT tippre jár', async () => {
    const { c, m } = await openCompetition();
    await h.competitionSvc.submitPrediction(c.id, PRO, m.id, 2, 1);
    await h.rewards.reconcileUser(PRO);
    // a meccsnek még nincs eredménye → csak a beküldési jutalom van
    expect(await balance(PRO)).toBe(COIN_REWARDS.PREDICTION_SUBMITTED);
  });

  it('C7c. a beküldési jutalom PÓTLÓDIK a kiértékelésnél, ha a beküldéskor elmaradt', async () => {
    // A tippet a tárolón keresztül írjuk (a beküldési hook nem futott le)
    await playCompetition(PRO, [CORRECT]);
    expect(await coinsOf(PRO, 'PREDICTION_SUBMITTED')).toBe(COIN_REWARDS.PREDICTION_SUBMITTED);
  });
});

// ===========================================================================
// 4) 3-as sorozat
// ===========================================================================

describe('Coin hook – 3 helyes tipp egymás után', () => {
  it('C8. két helyes tipp → nincs sorozat-bónusz', async () => {
    await playCompetition(PRO, [CORRECT, EXACT]);
    expect(await coinsOf(PRO, 'STREAK_3')).toBe(0);
  });

  it('C9. a harmadik helyes tipp → +150', async () => {
    await playCompetition(PRO, [CORRECT, EXACT, CORRECT]);
    expect(await coinsOf(PRO, 'STREAK_3')).toBe(COIN_REWARDS.STREAK_3);
  });

  it('C10. ugyanaz a sorozat ismételt feldolgozásnál nem fizet újra', async () => {
    const c = await playCompetition(PRO, [CORRECT, CORRECT, CORRECT]);
    await h.competitionSvc.settle(c.id);
    await h.rewards.reconcileUser(PRO);
    await h.rewards.reconcileUser(PRO);
    expect(await coinsOf(PRO, 'STREAK_3')).toBe(COIN_REWARDS.STREAK_3);
  });

  it('C10b. négy helyes tipp is CSAK egy sorozat (a sorozat egyszer fizet)', async () => {
    await playCompetition(PRO, [CORRECT, CORRECT, CORRECT, CORRECT]);
    expect(await coinsOf(PRO, 'STREAK_3')).toBe(COIN_REWARDS.STREAK_3);
  });

  it('C10c. egy MEGSZAKÍTÁS NÉLKÜLI sorozat egyszer fizet, akármilyen hosszú', async () => {
    // A MEGLÉVŐ algoritmus szemantikája: a bónusz akkor jár, amikor a futó
    // sorozat ÉPPEN eléri a küszöböt – egy folyamatos 6-os sorozat tehát EGY
    // bónuszt ad, nem kettőt. Ez az XP-rendszer viselkedése is (5-ös küszöbbel),
    // és szándékosan nem írjuk át: nem vezetünk be új gazdasági szabályt.
    await playCompetition(PRO, [CORRECT, CORRECT, CORRECT, CORRECT, CORRECT, CORRECT]);
    expect(await coinsOf(PRO, 'STREAK_3')).toBe(COIN_REWARDS.STREAK_3);
  });

  it('C10c2. KÉT külön sorozat (megszakítással) két bónuszt ad', async () => {
    await playCompetition(PRO, [CORRECT, CORRECT, CORRECT, WRONG, CORRECT, CORRECT, CORRECT]);
    expect(await coinsOf(PRO, 'STREAK_3')).toBe(2 * COIN_REWARDS.STREAK_3);
  });

  it('C10d. a rossz tipp megszakítja a sorozatot', async () => {
    await playCompetition(PRO, [CORRECT, CORRECT, WRONG, CORRECT, CORRECT]);
    expect(await coinsOf(PRO, 'STREAK_3')).toBe(0);
  });
});

// ===========================================================================
// 5) Napi 3 Tippverseny-tipp
// ===========================================================================

/** N tipp a MAI budapesti napra, a meglévő tárolón keresztül. */
async function seedToday(user: string, n: number) {
  const c = await h.competitions.createCompetition({
    name: `Napi ${Math.random()}`, leagueKey: 'eng-pl', leagueName: 'eng-pl', provider: 'teszt',
    startsAt: hours(-200), endsAt: hours(200), status: 'active',
  });
  await h.competitions.upsertMatches(c.id, Array.from({ length: n }, (_, i) => ({
    externalMatchId: `d${i}-${Math.random()}`, homeTeam: `H${i}`, awayTeam: `A${i}`,
    kickoff: hours(24 + i), homeScore: null, awayScore: null, status: 'scheduled' as const,
  })));
  const matches = await h.competitions.listMatches(c.id);
  for (const m of matches) await h.competitions.upsertPrediction(user, m.id, 1, 1);
  return c;
}

describe('Coin hook – napi 3 Tippverseny-tipp', () => {
  it('C11. 1 és 2 tipp után még nem teljesített → 0 coin', async () => {
    await seedToday(FREE, 2);
    await expect(h.missions.claim(FREE, DAILY_TIPS_MISSION_KEY)).rejects.toThrow();
    expect(await coinsOf(FREE, 'DAILY_TIPS')).toBe(0);
  });

  it('C12. a 3. tipp után az átvétel +20 coint ad – FREE felhasználónak is', async () => {
    await seedToday(FREE, 3);
    const r = await h.missions.claim(FREE, DAILY_TIPS_MISSION_KEY);
    expect(r.alreadyClaimed).toBe(false);
    expect(r.xpAwarded, 'FREE nem kap XP-t, de coint IGEN').toBe(0);
    expect(await coinsOf(FREE, 'DAILY_TIPS')).toBe(COIN_REWARDS.DAILY_TIPS);
  });

  it('C13. a 4. és 5. tipp NEM ad újabb +20-at, és az ismételt átvétel sem', async () => {
    await seedToday(FREE, 5);
    await h.missions.claim(FREE, DAILY_TIPS_MISSION_KEY);
    const again = await h.missions.claim(FREE, DAILY_TIPS_MISSION_KEY);
    expect(again.alreadyClaimed).toBe(true);
    expect(await coinsOf(FREE, 'DAILY_TIPS')).toBe(COIN_REWARDS.DAILY_TIPS);
  });

  it('C14. a következő budapesti nap új jutalmat tesz lehetővé', async () => {
    const today = periodKeyFor('daily');
    expect(today).toBe(dayKey());
    await h.rewards.onMissionClaimed(FREE, DAILY_TIPS_MISSION_KEY, today);
    const tomorrow = new Date(Date.now() + 86400_000);
    await h.rewards.onMissionClaimed(FREE, DAILY_TIPS_MISSION_KEY, dayKey(tomorrow));
    expect(await coinsOf(FREE, 'DAILY_TIPS')).toBe(2 * COIN_REWARDS.DAILY_TIPS);
    // ugyanaz a nap harmadszor sem fizet
    await h.rewards.onMissionClaimed(FREE, DAILY_TIPS_MISSION_KEY, today);
    expect(await coinsOf(FREE, 'DAILY_TIPS')).toBe(2 * COIN_REWARDS.DAILY_TIPS);
  });

  it('C14b. a napi forráskulcs a küldetés budapesti nap-kulcsa', async () => {
    await seedToday(FREE, 3);
    await h.missions.claim(FREE, DAILY_TIPS_MISSION_KEY);
    const tx = (await history(FREE)).find((t) => t.type === 'DAILY_TIPS')!;
    expect(tx.sourceKey).toBe(`daily:${dayKey()}`);
  });

  it('C14c. a többi küldetés nem ad coint (csak a két mennyiségi küldetés)', async () => {
    await seedToday(FREE, 1);
    await h.missions.claim(FREE, 'daily_prediction_1');
    expect(await balance(FREE)).toBe(0);
  });
});

// ===========================================================================
// 6) Heti 10 tipp
// ===========================================================================

describe('Coin hook – heti 10 tipp', () => {
  it('C15. 9 tipp → 0 coin', async () => {
    await seedToday(FREE, 9);
    await expect(h.missions.claim(FREE, WEEKLY_TIPS_MISSION_KEY)).rejects.toThrow();
    expect(await coinsOf(FREE, 'WEEKLY_TIPS')).toBe(0);
  });

  it('C16. 10 tipp → +250', async () => {
    await seedToday(FREE, 10);
    await h.missions.claim(FREE, WEEKLY_TIPS_MISSION_KEY);
    expect(await coinsOf(FREE, 'WEEKLY_TIPS')).toBe(COIN_REWARDS.WEEKLY_TIPS);
  });

  it('C17. ismételt teljesítés/átvétel nem fizet újra', async () => {
    await seedToday(FREE, 12);
    await h.missions.claim(FREE, WEEKLY_TIPS_MISSION_KEY);
    await h.missions.claim(FREE, WEEKLY_TIPS_MISSION_KEY);
    await h.rewards.onMissionClaimed(FREE, WEEKLY_TIPS_MISSION_KEY, weekKey());
    expect(await coinsOf(FREE, 'WEEKLY_TIPS')).toBe(COIN_REWARDS.WEEKLY_TIPS);
  });

  it('C18. a következő hét új jutalmat tesz lehetővé', async () => {
    await h.rewards.onMissionClaimed(FREE, WEEKLY_TIPS_MISSION_KEY, weekKey());
    await h.rewards.onMissionClaimed(FREE, WEEKLY_TIPS_MISSION_KEY, weekKey(new Date(Date.now() + 8 * 86400_000)));
    expect(await coinsOf(FREE, 'WEEKLY_TIPS')).toBe(2 * COIN_REWARDS.WEEKLY_TIPS);
  });

  it('C18b. a heti forráskulcs a küldetés ISO hét-kulcsa', async () => {
    await seedToday(FREE, 10);
    await h.missions.claim(FREE, WEEKLY_TIPS_MISSION_KEY);
    const tx = (await history(FREE)).find((t) => t.type === 'WEEKLY_TIPS')!;
    expect(tx.sourceKey).toBe(`weekly:${weekKey()}`);
  });
});

// ===========================================================================
// 7–8) Top 10 és 1. hely
// ===========================================================================

describe('Coin hook – Top 10 és verseny-győzelem', () => {
  it('C19. a verseny lezárása után az 1. helyezett megkapja a Top 10-et ÉS a győzelmet', async () => {
    const c = await playCompetition(PRO, [EXACT, EXACT]);
    const before = await balance(PRO);
    await h.competitionSvc.finish(c.id);
    expect(await coinsOf(PRO, 'COMPETITION_TOP10')).toBe(COIN_REWARDS.COMPETITION_TOP10);
    expect(await coinsOf(PRO, 'COMPETITION_FIRST')).toBe(COIN_REWARDS.COMPETITION_FIRST);
    expect(await balance(PRO)).toBe(before + COIN_REWARDS.COMPETITION_TOP10 + COIN_REWARDS.COMPETITION_FIRST);
  });

  it('C20. 10. helyezés → +400, de nincs győzelmi jutalom', async () => {
    const s = await h.rewards.onCompetitionFinished(PRO, 'comp-1', TOP10_PLACEMENT);
    expect(s.byType.COMPETITION_TOP10).toBe(COIN_REWARDS.COMPETITION_TOP10);
    expect(s.byType.COMPETITION_FIRST).toBeUndefined();
    expect(await balance(PRO)).toBe(COIN_REWARDS.COMPETITION_TOP10);
  });

  it('C21. 11. helyezés → 0 coin', async () => {
    const s = await h.rewards.onCompetitionFinished(PRO, 'comp-1', TOP10_PLACEMENT + 1);
    expect(s.awarded).toBe(0);
    expect(await balance(PRO)).toBe(0);
  });

  it('C22. a 2. helyezett Top 10-et kap, győzelmi jutalmat nem', async () => {
    await h.rewards.onCompetitionFinished(OTHER, 'comp-1', 2);
    expect(await coinsOf(OTHER, 'COMPETITION_TOP10')).toBe(COIN_REWARDS.COMPETITION_TOP10);
    expect(await coinsOf(OTHER, 'COMPETITION_FIRST')).toBe(0);
  });

  it('C23. ISMÉTELT lezárás nem fizet újra', async () => {
    const c = await playCompetition(PRO, [EXACT]);
    await h.competitionSvc.finish(c.id);
    const after = await balance(PRO);
    await h.competitionSvc.finish(c.id);
    await h.competitionSvc.finish(c.id);
    expect(await balance(PRO)).toBe(after);
  });

  it('C24. ÉRVÉNYTELENÍTETT verseny nem fizet', async () => {
    const c = await playCompetition(PRO, [EXACT]);
    const before = await balance(PRO);
    await h.competitions.setCompetitionStatus(c.id, 'cancelled', ['active']);
    await expect(h.competitionSvc.finish(c.id)).rejects.toThrow();
    expect(await balance(PRO)).toBe(before);
    expect(await coinsOf(PRO, 'COMPETITION_TOP10')).toBe(0);
    expect(await coinsOf(PRO, 'COMPETITION_FIRST')).toBe(0);
  });

  it('C24b. eredmény nélküli verseny nem zárható le → nincs helyezési coin', async () => {
    const { c } = await openCompetition();
    await expect(h.competitionSvc.finish(c.id)).rejects.toThrow();
    expect(await coinsOf(PRO, 'COMPETITION_TOP10')).toBe(0);
  });

  it('C24c. a helyezési jutalom a verseny AZONOSÍTÓJÁHOZ kötött', async () => {
    await h.rewards.onCompetitionFinished(PRO, 'comp-1', 1);
    await h.rewards.onCompetitionFinished(PRO, 'comp-2', 1);
    expect(await coinsOf(PRO, 'COMPETITION_FIRST')).toBe(2 * COIN_REWARDS.COMPETITION_FIRST);
  });

  it('C24d. érvénytelen helyezés (0, negatív, tört) nem fizet', async () => {
    for (const rank of [0, -1, 1.5, Number.NaN]) {
      expect((await h.rewards.onCompetitionFinished(PRO, 'comp-x', rank)).awarded).toBe(0);
    }
    expect(await balance(PRO)).toBe(0);
  });
});

// ===========================================================================
// FREE / PRO és izoláció
// ===========================================================================

describe('Coin hook – FREE/PRO és izoláció', () => {
  it('C25. FREE és PRO UGYANANNYI coint kap ugyanazért a teljesítményért', async () => {
    await playCompetition(PRO, [EXACT, CORRECT, CORRECT]);
    await playCompetition(FREE, [EXACT, CORRECT, CORRECT], -300, 'esp-ll');
    expect(await balance(FREE)).toBe(await balance(PRO));
    expect(await coinsOf(FREE, 'STREAK_3')).toBe(await coinsOf(PRO, 'STREAK_3'));
  });

  it('C26. a coin nem ad XP-t, és nem változtatja a Tippverseny-pontokat', async () => {
    const c = await playCompetition(FREE, [EXACT, EXACT]);
    // FREE-nek nincs XP (változatlan üzleti szabály), de van coin
    expect(await h.progressionStore.totalXp(FREE)).toBe(0);
    expect(await balance(FREE)).toBeGreaterThan(0);
    // a verseny pontjai érintetlenek: 2 pontos eredmény = 10 pont
    const rows = await h.competitionSvc.adminLeaderboard(c.id);
    expect(rows[0].points).toBe(10);
  });

  it('C27. a coin nem befolyásolja a ranglista sorrendjét', async () => {
    const c = await h.competitions.createCompetition({
      name: 'Sorrend', leagueKey: 'eng-pl', leagueName: 'eng-pl', provider: 'teszt',
      startsAt: hours(-200), endsAt: hours(-100), status: 'active',
    });
    await h.competitions.upsertMatches(c.id, [{
      externalMatchId: 'r1', homeTeam: 'H', awayTeam: 'A',
      kickoff: hours(-150), homeScore: 2, awayScore: 1, status: 'finished',
    }]);
    const [m] = await h.competitions.listMatches(c.id);
    await h.competitions.upsertPrediction(PRO, m.id, 2, 1);   // pontos → 5 pont
    await h.competitions.upsertPrediction(OTHER, m.id, 3, 1); // helyes → 3 pont
    await h.competitionSvc.settle(c.id);
    // OTHER-nek sok coint adunk: a sorrend ettől nem változhat
    await h.rewards.onCompetitionFinished(OTHER, 'kulso-comp', 1);
    const rows = await h.competitionSvc.adminLeaderboard(c.id);
    expect(rows[0].userId).toBe(PRO);
    expect(rows[1].userId).toBe(OTHER);
  });

  it('C28. a coin más felhasználó egyenlegét nem érinti', async () => {
    await playCompetition(PRO, [EXACT, CORRECT, CORRECT]);
    expect(await balance(OTHER)).toBe(0);
    expect(await balance(FREE)).toBe(0);
  });
});

// ===========================================================================
// Tranzakciós biztonság: a coin hibája nem törheti meg az üzleti műveletet
// ===========================================================================

describe('Coin hook – a jutalom hibája nem törheti meg az üzleti műveletet', () => {
  /** Olyan coin-szolgáltatás, amely MINDEN jóváírásnál elhasal. */
  function breakCoins() {
    (h.coins as unknown as { awardReward: () => Promise<never> }).awardReward =
      () => Promise.reject(new Error('szimulált coin hiba'));
  }

  it('C29. elhasaló jutalom mellett is létrejön a tipp', async () => {
    breakCoins();
    const { c, m } = await openCompetition();
    const p = await h.competitionSvc.submitPrediction(c.id, PRO, m.id, 2, 1);
    expect(p.id).toBeTruthy();
    expect(await h.competitions.getPrediction(PRO, m.id)).toBeTruthy();
    expect(await balance(PRO)).toBe(0);
  });

  it('C30. elhasaló jutalom mellett is lefut a kiértékelés és a pontozás', async () => {
    breakCoins();
    const c = await playCompetition(PRO, [EXACT, CORRECT]);
    const rows = await h.competitionSvc.adminLeaderboard(c.id);
    expect(rows[0].points, 'a Tippverseny pontozás érintetlen').toBe(8);
    expect(await balance(PRO)).toBe(0);
  });

  it('C31. elhasaló jutalom mellett is lezárható a verseny', async () => {
    const c = await playCompetition(PRO, [EXACT]);
    breakCoins();
    const r = await h.competitionSvc.finish(c.id);
    expect(r.competition.status).toBe('finished');
  });

  it('C32. elhasaló jutalom mellett is átvehető a küldetés', async () => {
    await seedToday(FREE, 3);
    breakCoins();
    const r = await h.missions.claim(FREE, DAILY_TIPS_MISSION_KEY);
    expect(r.alreadyClaimed).toBe(false);
    expect(await coinsOf(FREE, 'DAILY_TIPS')).toBe(0);
  });

  it('C33. az elmaradt jutalom az ÚJRASZÁRMAZTATÁSNÁL pótlódik', async () => {
    breakCoins();
    const c = await playCompetition(PRO, [EXACT, CORRECT, CORRECT]);
    expect(await balance(PRO)).toBe(0);

    // a coin-szolgáltatás helyreáll
    delete (h.coins as unknown as Record<string, unknown>).awardReward;
    await h.rewards.reconcileUser(PRO);

    expect(await coinsOf(PRO, 'EXACT_SCORE')).toBe(COIN_REWARDS.EXACT_SCORE);
    expect(await coinsOf(PRO, 'CORRECT_OUTCOME')).toBe(2 * COIN_REWARDS.CORRECT_OUTCOME);
    expect(await coinsOf(PRO, 'STREAK_3')).toBe(COIN_REWARDS.STREAK_3);
    expect(await coinsOf(PRO, 'PREDICTION_SUBMITTED')).toBe(3 * COIN_REWARDS.PREDICTION_SUBMITTED);
    void c;
  });

  it('C33b. a verseny LEZÁRÁSA garantált utánvezetési pont minden résztvevőnek', async () => {
    breakCoins();
    const c = await playCompetition(PRO, [EXACT, CORRECT, CORRECT]);
    expect(await balance(PRO)).toBe(0);

    // A settle() csak azokat vezeti utána, akiknek a pontja ÉPPEN változott,
    // ezért az ismételt settle itt nem pótol. A lezárás viszont igen.
    delete (h.coins as unknown as Record<string, unknown>).awardReward;
    await h.competitionSvc.settle(c.id);
    expect(await balance(PRO), 'a pont nem változott → a settle nem vezet utána').toBe(0);

    await h.competitionSvc.finish(c.id);
    expect(await coinsOf(PRO, 'EXACT_SCORE')).toBe(COIN_REWARDS.EXACT_SCORE);
    expect(await coinsOf(PRO, 'CORRECT_OUTCOME')).toBe(2 * COIN_REWARDS.CORRECT_OUTCOME);
    expect(await coinsOf(PRO, 'STREAK_3')).toBe(COIN_REWARDS.STREAK_3);
    expect(await coinsOf(PRO, 'COMPETITION_FIRST')).toBe(COIN_REWARDS.COMPETITION_FIRST);
  });
});

// ===========================================================================
// Hook nélkül a meglévő működés bitre azonos
// ===========================================================================

describe('Coin hook – opcionális', () => {
  it('C34. coin hook NÉLKÜL a Tippverseny és a küldetés ugyanúgy működik', async () => {
    const db = new DatabaseSync(':memory:');
    const competitions = new SqliteCompetitionStore(db);
    const progressionStore = new SqliteProgressionStore(db);
    const names = new InMemoryDisplayNameDirectory();
    await names.set(PRO, 'Martin23');
    const svc = new CompetitionService(competitions, new StubProvider(), names);
    const missions = new MissionService(progressionStore, async () => true);

    const c = await competitions.createCompetition({
      name: 'Hook nélkül', leagueKey: 'eng-pl', leagueName: 'eng-pl', provider: 'teszt',
      startsAt: hours(-200), endsAt: hours(-100), status: 'active',
    });
    await competitions.upsertMatches(c.id, [{
      externalMatchId: 'n1', homeTeam: 'H', awayTeam: 'A',
      kickoff: hours(-150), homeScore: 2, awayScore: 1, status: 'finished',
    }]);
    const [m] = await competitions.listMatches(c.id);
    await competitions.upsertPrediction(PRO, m.id, 2, 1);
    const settled = await svc.settle(c.id);
    expect(settled.scoredPredictions).toBe(1);
    const finished = await svc.finish(c.id);
    expect(finished.competition.status).toBe('finished');
    const overview = await missions.overview(PRO);
    expect(overview.daily.missions).toHaveLength(2);
  });
});
