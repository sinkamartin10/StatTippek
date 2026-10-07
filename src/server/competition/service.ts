/**
 * Tippverseny üzleti logika. MINDEN szabály itt (szerveroldalon) dől el:
 * időablak, PRO-jogosultság ellenőrzése a hívó rétegben, pontszámítás, rangsor, jutalmak.
 * A kliens által küldött points / rank / user_id / status mezőket a rendszer sosem veszi figyelembe.
 */
import type { MatchDataProvider } from '../data/provider';
import type { DisplayNameDirectory } from '../profile/displayNameDirectory';
import {
  COMPETITION_STATUS_LABEL, REWARD_TIERS, compareLeaderboard, displayNameFor, isImmutable,
  predictionWindow, rankEntries, scorePrediction,
  type AdminLeaderboardRow, type Competition, type CompetitionMatch, type CompetitionMatchView,
  type CompetitionReward, type CompetitionStatus, type LeaderboardEntry, type LeaderboardRow,
  type PublicProfile, type RewardStatus, type UserPrediction,
} from '../../shared/competition';
import type { CompetitionStore, SyncMatch } from './store';
import { budapestDayWindow, quotaFrom, type DailyQuota } from '../../shared/freeQuota';
import type { CoinRewardHook } from '../coins/rewards';
import { TOP10_PLACEMENT } from '../../shared/shop';

/**
 * A progression-réteg felé mutató, szándékosan szűk felület.
 * A Tippverseny csak ÉRTESÍT; a pontszámítását semmilyen módon nem befolyásolja,
 * és a hook hibája sem ronthatja el a kiértékelést.
 */
export interface ProgressionHook {
  syncUser(userId: string): Promise<unknown>;
  awardPlacement(userId: string, competitionId: string, placement: number): Promise<unknown>;
  /**
   * A ranglistán megjelenítendő profilok EGY menetben (nincs N+1).
   * Opcionális: ha hiányzik, a ranglista a korábbi, profil nélküli alakot adja vissza.
   */
  publicProfiles?(userIds: string[]): Promise<Map<string, PublicProfile>>;
}

/** Üzleti hiba, amiből a route-réteg HTTP státuszt képez. */
export class CompetitionError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    /** A hibaválaszba beolvasztandó, SZERVER által számolt extra mezők (pl. kvóta-állapot). */
    public details?: Record<string, unknown>,
  ) { super(message); }
}

export interface CreateCompetitionInput {
  name: string;
  leagueKey: string;
  startsAt: string;
  endsAt: string;
}

const MAX_SYNC_MATCHES = 200;

export class CompetitionService {
  /**
   * @param names A megjelenítési nevek tára (a meglévő profiles.display_name mezőn).
   *              A ranglista és a jutalmak KIZÁRÓLAG ezt a szerveroldali nevet használják,
   *              a kliens által küldött display_name mezőt sehol nem olvassuk ki.
   */
  constructor(
    private store: CompetitionStore,
    private data: MatchDataProvider,
    private names: DisplayNameDirectory,
    /**
     * Opcionális progression-réteg (XP / achievement). CSAK RÁÉPÜL a kiértékelésre:
     * ha nincs megadva, a Tippverseny működése bitre azonos a korábbival.
     * A verseny pontszámítását nem befolyásolja.
     */
    private progression?: ProgressionHook,
    /**
     * Kötegelt PRO-feloldó a JUTALOM-jogosultsághoz (nincs N+1).
     * Kizárólag azt dönti el, ki kaphat jutalmat – a pontozást, a sorrendet és a
     * nyilvános ranglistát NEM befolyásolja. Ha nincs megadva (Supabase nélküli
     * helyi mód), mindenki jogosult: a működés bitre azonos a korábbival.
     */
    private proUsers?: (userIds: string[]) => Promise<Set<string>>,
    /**
     * Opcionális coin jutalom-hook (5c). CSAK RÁÉPÜL: a pontszámítást, a
     * rangsort, a holtverseny-feloldást és a jutalom-jogosultságot nem
     * befolyásolja, és a hibája nem bukhatja meg a kiértékelést. Ha nincs
     * megadva, a Tippverseny működése bitre azonos a korábbival.
     */
    private coins?: CoinRewardHook,
  ) {}

  /** A tárolt név, vagy – ha valamiért nincs – állandó álnév (soha nem e-mail). */
  private async nameMap(userIds: string[]): Promise<Map<string, string>> {
    const stored = await this.names.getMany(userIds);
    const out = new Map<string, string>();
    for (const id of userIds) out.set(id, stored.get(id) ?? displayNameFor(id));
    return out;
  }

  // -------------------------------------------------------------------------
  // Olvasás
  // -------------------------------------------------------------------------

  /** Nyilvános lista: a piszkozatokat nem mutatjuk, azok csak az adminnak léteznek. */
  listPublic(): Promise<Competition[]> {
    return this.store.listCompetitions(['scheduled', 'active', 'finished']);
  }

  listAll(): Promise<Competition[]> {
    return this.store.listCompetitions();
  }

  async get(id: string): Promise<Competition> {
    const c = await this.store.getCompetition(id);
    if (!c) throw new CompetitionError('A tippverseny nem található.', 404);
    return c;
  }

  /** Nyilvános nézet: a verseny csak akkor látszik, ha nem piszkozat. */
  async getPublic(id: string): Promise<Competition> {
    const c = await this.get(id);
    if (c.status === 'draft') throw new CompetitionError('A tippverseny nem található.', 404);
    return c;
  }

  /**
   * Meccslista a felhasználó saját tippjeivel. A `locked` mezőt a SZERVER számolja,
   * a kliens csak megjeleníti – a tipp beküldésekor mindent újra ellenőrzünk.
   */
  async matchesWithPredictions(competition: Competition, userId: string | null, now = new Date()): Promise<CompetitionMatchView[]> {
    const matches = await this.store.listMatches(competition.id);
    const mine = userId ? await this.store.listPredictionsForUser(userId, competition.id) : [];
    const byMatch = new Map(mine.map((p) => [p.competitionMatchId, p]));
    return matches.map((m) => {
      const w = predictionWindow(competition, m, now);
      const p = byMatch.get(m.id) ?? null;
      return {
        ...m,
        myPrediction: p ? { predictedHomeScore: p.predictedHomeScore, predictedAwayScore: p.predictedAwayScore, points: p.points } : null,
        locked: !w.open,
        lockReason: w.open ? null : w.reason,
      };
    });
  }

  /** A felhasználó SAJÁT tippjei – más felhasználó tippjei ezen az úton sosem érhetők el. */
  myPredictions(competitionId: string, userId: string): Promise<UserPrediction[]> {
    return this.store.listPredictionsForUser(userId, competitionId);
  }

  // -------------------------------------------------------------------------
  // Tipp leadása / módosítása
  // -------------------------------------------------------------------------

  /**
   * A tipp mentése. A hívó (route) előtte ellenőrzi a bejelentkezést és a PRO csomagot;
   * itt az időablak, a verseny-összetartozás és az értékhatárok ellenőrzése történik.
   */
  async submitPrediction(
    competitionId: string,
    userId: string,
    competitionMatchId: string,
    home: number,
    away: number,
    now = new Date(),
    /** false csak a Supabase nélküli, egyfelhasználós helyi módban */
    requireDisplayName = true,
    /**
     * A FREE csomag napi ÚJ tipp limitje, vagy null, ha nincs limit (PRO).
     * A FREE/PRO döntést a hívó réteg hozza a meglévő entitlement rendszerből –
     * a kliens által küldött plan / quota mezőt sosem olvassuk.
     */
    dailyLimit: number | null = null,
  ): Promise<UserPrediction> {
    // Részvételi feltétel: a hitelesített felhasználóhoz TÉNYLEGESEN tartozzon megjelenítési név.
    // A kérésben küldött display_name mezőt sosem vesszük figyelembe.
    if (requireDisplayName && !(await this.names.get(userId))) {
      throw new CompetitionError(
        'A Tippversenyben való részvételhez előbb állíts be egy megjelenítési nevet a profilodban.',
        403, 'DISPLAY_NAME_REQUIRED',
      );
    }
    const competition = await this.getPublic(competitionId);
    if (isImmutable(competition.status)) {
      throw new CompetitionError(`A verseny állapota „${COMPETITION_STATUS_LABEL[competition.status]}” – tipp már nem adható le.`, 409);
    }
    const match = await this.store.getMatch(competitionMatchId);
    // A meccsnek EHHEZ a versenyhez kell tartoznia – így nem lehet másik verseny meccsére tippelni
    if (!match || match.competitionId !== competitionId) throw new CompetitionError('A mérkőzés nem ehhez a tippversenyhez tartozik.', 404);

    const w = predictionWindow(competition, match, now);
    if (!w.open) throw new CompetitionError(w.reason, 409, 'PREDICTION_CLOSED');

    if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0 || home > 99 || away > 99) {
      throw new CompetitionError('Érvénytelen tipp: a gólszám 0 és 99 közötti egész szám lehet.', 400);
    }

    // A napi kvóta az UTOLSÓ, atomikus lépés: érvénytelen vagy zárolt kérés
    // soha nem fogyaszthat kvótát, mert addig el sem jutunk.
    const window = budapestDayWindow(now);
    const r = await this.store.createOrUpdatePrediction(userId, competitionMatchId, home, away, dailyLimit, window);

    if (r.outcome === 'limit_reached') {
      const quota = quotaFrom(r.used, window, dailyLimit!);
      throw new CompetitionError(
        `Elérted a mai tippkeretet (${quota.limit} tipp naponta). A keret a következő napon újraindul – PRO előfizetéssel nincs napi korlát.`,
        403, 'FREE_DAILY_LIMIT_REACHED', { ...quota },
      );
    }

    // COIN (5c): a tipp ekkor MÁR létezik az adatbázisban (a beküldő RPC
    // commitolt), ezért érvénytelen, zárolt vagy kvótán kívüli kérés sosem
    // fizet. A forráskulcs a tipp azonosítója, így a MÓDOSÍTÁS nem fizet újra.
    // A hook elnyeli a saját hibáját, és az elmaradt jóváírást a következő
    // kiértékelés (settle → reconcileUser) pótolja.
    await this.coins?.onPredictionSubmitted(userId, r.prediction!.id);

    return r.prediction!;
  }

  /**
   * A felhasználó mai kvóta-állapota. `dailyLimit = null` (PRO) esetén nincs kvóta → null.
   * Kizárólag tájékoztató adat a felületnek; a tényleges kikényszerítés a beküldésnél történik.
   */
  async dailyQuota(userId: string, dailyLimit: number | null, now = new Date()): Promise<DailyQuota | null> {
    if (dailyLimit == null) return null;
    const window = budapestDayWindow(now);
    return quotaFrom(await this.store.countPredictionsCreatedIn(userId, window), window, dailyLimit);
  }

  // -------------------------------------------------------------------------
  // Pontozás (idempotens)
  // -------------------------------------------------------------------------

  /**
   * Minden lezárt, eredménnyel rendelkező mérkőzés tippjeire kiszámolja a pontot.
   * IDEMPOTENS: a pont ÉRTÉKADÁSSAL íródik (nem hozzáadással), ezért a többszöri
   * futtatás ugyanazt az eredményt adja – senki nem kaphat kétszer pontot.
   */
  async settle(competitionId: string): Promise<{ scoredMatches: number; scoredPredictions: number }> {
    const matches = await this.store.listMatches(competitionId);
    const finished = matches.filter((m) => m.status === 'finished' && m.homeScore != null && m.awayScore != null);
    if (!finished.length) return { scoredMatches: 0, scoredPredictions: 0 };

    const predictions = await this.store.listPredictionsForCompetition(competitionId);
    const byMatch = new Map(finished.map((m) => [m.id, m]));
    let scored = 0;
    const touched = new Set<string>();
    for (const p of predictions) {
      const m = byMatch.get(p.competitionMatchId);
      if (!m) continue;
      const points = scorePrediction(p.predictedHomeScore, p.predictedAwayScore, m.homeScore!, m.awayScore!);
      if (p.points === points) continue; // már pontosan ennyi – felesleges írás nélkül is idempotens
      await this.store.setPredictionPoints(p.id, points);
      scored++;
      touched.add(p.userId);
    }
    // A progression KÜLÖN rendszer: a pontszámítás már lezárult, ez csak ráépül.
    // Hibája nem bukhatja meg a verseny kiértékelését.
    for (const userId of touched) {
      try { await this.progression?.syncUser(userId); }
      catch (e) { console.error('[competition] progression szinkron hiba:', (e as Error).message); }
      // COIN (5c): a kiértékelés ESEMÉNYÉHEZ kötve, nem oldalmegtekintéshez.
      // A pont ekkor már ki van írva, ezért a jutalom bizonyított eredményre
      // épül. Idempotens; a hibája nem bukhatja meg a kiértékelést.
      try { await this.coins?.reconcileUser(userId); }
      catch (e) { console.error('[competition] coin jutalom hiba:', (e as Error).message); }
    }
    return { scoredMatches: finished.length, scoredPredictions: scored };
  }

  // -------------------------------------------------------------------------
  // Ranglista (mindig szerveroldalon számolva)
  // -------------------------------------------------------------------------

  private async entries(competitionId: string): Promise<LeaderboardEntry[]> {
    const matches = await this.store.listMatches(competitionId);
    const byId = new Map(matches.map((m) => [m.id, m]));
    const predictions = await this.store.listPredictionsForCompetition(competitionId);
    const acc = new Map<string, LeaderboardEntry>();
    for (const p of predictions) {
      const e = acc.get(p.userId) ?? { userId: p.userId, points: 0, predictions: 0, exactHits: 0, lastSubmittedAt: p.submittedAt };
      e.points += p.points ?? 0;
      e.predictions += 1;
      const m = byId.get(p.competitionMatchId);
      if (m && m.homeScore != null && m.awayScore != null
        && p.predictedHomeScore === m.homeScore && p.predictedAwayScore === m.awayScore) e.exactHits += 1;
      if (p.submittedAt > e.lastSubmittedAt) e.lastSubmittedAt = p.submittedAt;
      acc.set(p.userId, e);
    }
    return [...acc.values()];
  }

  /** Nyilvános ranglista: SOHA nem tartalmaz e-mailt és user_id-t. */
  async leaderboard(competitionId: string, meUserId: string | null): Promise<LeaderboardRow[]> {
    const ranked = rankEntries(await this.entries(competitionId));
    const userIds = ranked.map((e) => e.userId);
    // A sorrendet és a pontokat a progression NEM befolyásolja – csak a megjelenés bővül.
    const [names, profiles] = await Promise.all([
      this.nameMap(userIds),
      this.progression?.publicProfiles?.(userIds).catch((err) => {
        console.error('[competition] ranglista-profilok hiba:', (err as Error).message);
        return undefined;
      }) ?? Promise.resolve(undefined),
    ]);
    return ranked.map((e) => ({
      rank: e.rank,
      displayName: names.get(e.userId)!,
      points: e.points,
      predictions: e.predictions,
      exactHits: e.exactHits,
      isMe: !!meUserId && e.userId === meUserId,
      ...(profiles?.get(e.userId) ? { profile: profiles.get(e.userId) } : {}),
    }));
  }

  /** Admin ranglista: a jutalmazáshoz a user_id is kell – e-mail itt sem szerepel. */
  async adminLeaderboard(competitionId: string): Promise<AdminLeaderboardRow[]> {
    const ranked = rankEntries(await this.entries(competitionId));
    const names = await this.nameMap(ranked.map((e) => e.userId));
    return ranked.map((e) => ({
      rank: e.rank,
      userId: e.userId,
      displayName: names.get(e.userId)!,
      points: e.points,
      predictions: e.predictions,
      exactHits: e.exactHits,
    }));
  }

  /**
   * JUTALOM-sorrend: a normál ranglistával AZONOS pontozással és holtverseny-szabállyal,
   * de kizárólag a PRO résztvevőkkel. A FREE felhasználó pontja és ranglistás helye
   * változatlan marad – csak jutalomra nem jogosult.
   *
   * Példa: PRO A 18 / FREE B 17 / PRO C 15 / PRO D 12
   *   normál ranglista : 1. A, 2. B, 3. C, 4. D   (változatlan)
   *   jutalom-sorrend  : 1. A, 2. C, 3. D
   */
  async rewardRanking(competitionId: string): Promise<AdminLeaderboardRow[]> {
    const ranked = await this.adminLeaderboard(competitionId);
    if (!this.proUsers) return ranked; // helyi mód: nincs csomag-fogalom, mindenki jogosult
    const pro = await this.proUsers(ranked.map((r) => r.userId));
    // A szűrés megőrzi a már kialakult sorrendet, csak a helyezéseket zárja fel 1..n-re
    return ranked.filter((r) => pro.has(r.userId)).map((r, i) => ({ ...r, rank: i + 1 }));
  }

  /** A bejelentkezett felhasználó saját összesítője az adott versenyben. */
  async myStats(
    competitionId: string,
    userId: string,
    /** FREE napi limit, vagy null, ha nincs (PRO). A hívó entitlement rétege adja. */
    dailyLimit: number | null = null,
    now = new Date(),
  ): Promise<{ rank: number | null; points: number; predictions: number; exactHits: number; participants: number; displayName: string | null; canPredict: boolean; dailyQuota: DailyQuota | null }> {
    const ranked = rankEntries(await this.entries(competitionId));
    const me = ranked.find((e) => e.userId === userId);
    const displayName = await this.names.get(userId);
    return {
      displayName,
      canPredict: !!displayName,
      rank: me?.rank ?? null,
      points: me?.points ?? 0,
      predictions: me?.predictions ?? 0,
      exactHits: me?.exactHits ?? 0,
      participants: ranked.length,
      dailyQuota: await this.dailyQuota(userId, dailyLimit, now),
    };
  }

  // -------------------------------------------------------------------------
  // Admin: életciklus
  // -------------------------------------------------------------------------

  /** A szolgáltatótól ténylegesen elérhető ligák – csak ezekből lehet versenyt indítani. */
  async availableLeagues(): Promise<{ leagueKey: string; leagueName: string; country: string; provider: string }[]> {
    const leagues = await this.data.getLeagues();
    return leagues.map((l) => ({ leagueKey: l.id, leagueName: l.name, country: l.country, provider: this.data.name }));
  }

  async create(input: CreateCompetitionInput): Promise<Competition> {
    const name = input.name?.trim() ?? '';
    if (name.length < 2 || name.length > 120) throw new CompetitionError('A verseny neve 2 és 120 karakter között legyen.', 400);

    const leagues = await this.data.getLeagues();
    const league = leagues.find((l) => l.id === input.leagueKey);
    // Nem elérhető liga esetén nem hozunk létre használhatatlan versenyt
    if (!league) throw new CompetitionError('Ez a liga jelenleg nem érhető el a meccsadat-szolgáltatóból.', 400);

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new CompetitionError('Érvénytelen dátum.', 400);
    if (endsAt.getTime() <= startsAt.getTime()) throw new CompetitionError('A befejezés időpontja legyen későbbi a kezdésnél.', 400);

    return this.store.createCompetition({
      name,
      leagueKey: league.id,
      leagueName: league.name,
      provider: this.data.name,
      // Az adatbázisban UTC-ben tároljuk; a felület a helyi (Europe/Budapest) időt mutatja
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      status: 'draft',
    });
  }

  /** draft/scheduled → active. Lezárt vagy érvénytelenített verseny nem aktiválható. */
  async activate(id: string): Promise<Competition> {
    await this.get(id);
    const c = await this.store.setCompetitionStatus(id, 'active', ['draft', 'scheduled', 'active']);
    if (!c) throw new CompetitionError('Ez a verseny a jelenlegi állapotában nem aktiválható.', 409);
    return c;
  }

  async schedule(id: string): Promise<Competition> {
    await this.get(id);
    const c = await this.store.setCompetitionStatus(id, 'scheduled', ['draft', 'scheduled']);
    if (!c) throw new CompetitionError('Ez a verseny a jelenlegi állapotában nem ütemezhető.', 409);
    return c;
  }

  /** Törlés helyett érvénytelenítés – a már használt verseny adatai megmaradnak. */
  async cancel(id: string): Promise<Competition> {
    await this.get(id);
    const c = await this.store.setCompetitionStatus(id, 'cancelled', ['draft', 'scheduled', 'active', 'cancelled']);
    if (!c) throw new CompetitionError('A lezárt verseny nem érvényteleníthető.', 409);
    return c;
  }

  /**
   * Meccsek szinkronizálása a szolgáltatóból a verseny időszakára.
   * IDEMPOTENS: a (verseny, külső meccsazonosító) pár egyedi, ezért az ismételt
   * futtatás frissít, nem duplikál – és a meglévő tippeket sosem törli.
   */
  async syncMatches(id: string): Promise<{ inserted: number; updated: number; total: number; scoredPredictions: number }> {
    const competition = await this.get(id);
    if (isImmutable(competition.status)) {
      throw new CompetitionError('Lezárt vagy érvénytelenített versenyhez nem szinkronizálhatók meccsek.', 409);
    }
    const from = competition.startsAt.slice(0, 10);
    const to = competition.endsAt.slice(0, 10);
    const raw = await this.data.getMatches({ leagueId: competition.leagueKey, from, to });
    const teams = new Map((await this.data.getTeams()).map((t) => [t.id, t.name]));

    const inPeriod = raw.filter((m) => {
      const k = new Date(m.kickoff).getTime();
      return k >= new Date(competition.startsAt).getTime() && k < new Date(competition.endsAt).getTime();
    }).slice(0, MAX_SYNC_MATCHES);

    const mapped: SyncMatch[] = inPeriod.map((m) => ({
      externalMatchId: m.id,
      homeTeam: teams.get(m.homeTeamId) ?? m.homeTeamId,
      awayTeam: teams.get(m.awayTeamId) ?? m.awayTeamId,
      kickoff: m.kickoff,
      homeScore: m.homeGoals ?? null,
      awayScore: m.awayGoals ?? null,
      status: m.status === 'finished' ? 'finished' : m.status === 'live' ? 'live' : m.status === 'postponed' ? 'postponed' : 'scheduled',
    }));

    const r = await this.store.upsertMatches(competition.id, mapped);
    // A frissen beérkezett eredmények alapján azonnal pontozunk (szintén idempotens)
    const settled = await this.settle(competition.id);
    const total = (await this.store.listMatches(competition.id)).length;
    return { ...r, total, scoredPredictions: settled.scoredPredictions };
  }

  /**
   * Verseny lezárása. IDEMPOTENS: többszöri hívás nem hoz létre dupla jutalmat,
   * és nem módosítja a már kiosztott jutalmak státuszát.
   * A rendszer CSAK nyilvántartást készít – Stripe előfizetést nem módosít.
   */
  async finish(id: string): Promise<{ competition: Competition; rewards: CompetitionReward[]; createdRewards: number; warnings: string[] }> {
    const competition = await this.get(id);
    if (competition.status === 'cancelled') throw new CompetitionError('Érvénytelenített verseny nem zárható le.', 409);

    const matches = await this.store.listMatches(id);
    const withResult = matches.filter((m) => m.status === 'finished' && m.homeScore != null && m.awayScore != null);
    if (!withResult.length) {
      throw new CompetitionError('Nincs egyetlen lezárt, eredménnyel rendelkező mérkőzés sem – előbb szinkronizáld a meccseket.', 409, 'NO_RESULTS');
    }

    await this.settle(id);
    const ranked = await this.adminLeaderboard(id);
    // A jutalom CSAK PRO résztvevőnek jár; a normál ranglista (ranked) ettől független és változatlan.
    const eligible = await this.rewardRanking(id);

    let createdRewards = 0;
    for (const tier of REWARD_TIERS) {
      const winner = eligible.find((r) => r.rank === tier.placement);
      if (!winner) continue;
      const created = await this.store.createRewardIfAbsent({
        competitionId: id, userId: winner.userId, placement: tier.placement,
        rewardType: tier.rewardType, rewardLabel: tier.rewardLabel,
      });
      if (created) createdRewards++;
      // Helyezési XP – a (verseny, helyezés) kulcs miatt az ismételt lezárás sem ad újra XP-t
      try { await this.progression?.awardPlacement(winner.userId, id, tier.placement); }
      catch (e) { console.error('[competition] progression helyezés hiba:', (e as Error).message); }
    }

    // 'finished' is szerepel a megengedett kiinduló állapotok közt → az ismételt lezárás nem hibázik
    const updated = await this.store.setCompetitionStatus(id, 'finished', ['draft', 'scheduled', 'active', 'finished']);
    if (!updated) throw new CompetitionError('A verseny nem zárható le a jelenlegi állapotában.', 409);

    // COIN (5c): KIZÁRÓLAG a sikeres 'finished' átmenet UTÁN. Érvénytelenített
    // verseny ide nem jut el (fentebb 409-cel elszáll), nem lezárható állapotban
    // sem. A helyezés a NYILVÁNOS ranglistából jön, amely FREE és PRO
    // résztvevőt egyaránt tartalmaz – a PRO-only `competition_rewards`
    // jutalomrangsor ettől külön rendszer, és változatlan.
    for (const row of ranked) {
      // A lezárás GARANTÁLT utánvezetési pont: itt MINDEN résztvevő tipp-alapú
      // jutalmát pótoljuk, mert a `settle()` csak azokat vezeti utána, akiknek
      // a pontja éppen változott. Idempotens, ezért felesleges jóváírást nem ad.
      try { await this.coins?.reconcileUser(row.userId); }
      catch (e) { console.error('[competition] coin utánvezetés hiba:', (e as Error).message); }
      if (row.rank > TOP10_PLACEMENT) continue;
      try { await this.coins?.onCompetitionFinished(row.userId, id, row.rank); }
      catch (e) { console.error('[competition] coin helyezés hiba:', (e as Error).message); }
    }

    const warnings: string[] = [];
    const pending = matches.length - withResult.length;
    if (pending > 0) warnings.push(`${pending} mérkőzésnek még nincs végeredménye – azok pont nélkül maradtak.`);
    if (ranked.length < 3) warnings.push('Háromnál kevesebb résztvevő volt, ezért nem minden helyezéshez készült jutalom.');

    return { competition: updated, rewards: await this.rewards(id), createdRewards, warnings };
  }

  /** Jutalmak a megjelenítendő (anonim) névvel kiegészítve. */
  async rewards(competitionId: string): Promise<CompetitionReward[]> {
    const rows = await this.store.listRewards(competitionId);
    // A jutalom azonosítója MINDIG a user_id; a név csak megjelenítésre szolgál
    const names = await this.nameMap(rows.map((r) => r.userId));
    return rows.map((r) => ({ ...r, displayName: names.get(r.userId)! }));
  }

  async setRewardStatus(competitionId: string, rewardId: string, status: RewardStatus): Promise<CompetitionReward> {
    const r = await this.store.setRewardStatus(competitionId, rewardId, status);
    if (!r) throw new CompetitionError('A jutalom nem található ebben a versenyben.', 404);
    const names = await this.nameMap([r.userId]);
    return { ...r, displayName: names.get(r.userId)! };
  }

  /** Csak az admin felületnek: a verseny meccsei nyers formában. */
  listMatches(competitionId: string): Promise<CompetitionMatch[]> {
    return this.store.listMatches(competitionId);
  }

  /** Teszt-/karbantartási segéd: a kiírt státuszcímke (a UI is ezt használja). */
  static statusLabel(s: CompetitionStatus): string { return COMPETITION_STATUS_LABEL[s]; }

  /** Rangsor-összehasonlító újraexportálva, hogy a tesztek a szolgáltatáson át is elérjék. */
  static compare = compareLeaderboard;
}
