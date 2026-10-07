/**
 * Küldetések (napi / heti) üzleti logikája.
 *
 * Elvek:
 *  - A HALADÁST mindig a szerver számolja a meglévő Tippverseny-tippekből; a kliens
 *    által küldött progress / completed / reward értéket sehol nem olvassuk ki.
 *  - A jutalom átvétele IDEMPOTENS: (user_id, mission_key, period_key) egyediség az
 *    adatbázisban, az XP pedig a MEGLÉVŐ progression_events naplóba kerül
 *    'mission:<kulcs>:<periódus>' forráskulccsal – nincs külön küldetés-XP rendszer.
 *  - FREE felhasználó teljesítheti a küldetéseket, de XP-t NEM kap értük (0 XP).
 */
import {
  MISSIONS, missionByKey, missionProgress, missionSourceKey, missionsFor,
  isMissionComplete, periodEndsAt, periodKeyFor,
  type Mission, type MissionPeriod, type MissionPeriodView, type MissionView,
} from '../../shared/missions';
import type { ProgressionStore } from '../progression/store';

export class MissionError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

export interface MissionsOverview {
  pro: boolean;
  daily: MissionPeriodView;
  weekly: MissionPeriodView;
  /** hány küldetést vett át összesen eddig (motivációs számláló) */
  claimedTotal: number;
}

export class MissionService {
  /**
   * @param store  Ugyanaz a progression tároló (a tippek és az XP-napló is innen jön).
   * @param isPro  Szerveroldali PRO-ellenőrzés a meglévő profiles/Stripe állapotból.
   */
  constructor(
    private store: ProgressionStore,
    private isPro: (userId: string) => Promise<boolean>,
  ) {}

  /** A küldetésekhez szükséges tipp-sorok (egyetlen lekérdezés). */
  private async rows(userId: string) {
    const all = await this.store.allPredictions(userId);
    return all.map((r) => ({
      predictionId: r.predictionId, submittedAt: r.submittedAt,
      kickoff: r.kickoff, leagueKey: r.leagueKey, points: r.points,
    }));
  }

  private view(
    mission: Mission,
    rows: Awaited<ReturnType<MissionService['rows']>>,
    claims: Map<string, { progress: number; xpAwarded: number; claimedAt: string }>,
    pro: boolean,
    now: Date,
  ): MissionView {
    const progress = missionProgress(mission, rows, now);
    const claim = claims.get(mission.key);
    return {
      key: mission.key,
      period: mission.period,
      icon: mission.icon,
      name: mission.name,
      description: mission.description,
      metric: mission.metric,
      target: mission.target,
      progress: Math.min(progress, mission.target),
      completed: isMissionComplete(mission, progress),
      claimed: !!claim,
      claimedAt: claim?.claimedAt ?? null,
      // FREE felhasználónak a küldetés nem ad XP-t – ezt a megjelenítés is tükrözi
      xpReward: pro ? mission.xpReward : 0,
      xpAwarded: claim?.xpAwarded ?? 0,
    };
  }

  /** A bejelentkezett felhasználó összes futó küldetése, szerveroldali állapottal. */
  async overview(userId: string, now: Date = new Date()): Promise<MissionsOverview> {
    const dailyKey = periodKeyFor('daily', now);
    const weeklyKey = periodKeyFor('weekly', now);
    const [pro, rows, claims] = await Promise.all([
      this.isPro(userId),
      this.rows(userId),
      this.store.missionClaims(userId, [dailyKey, weeklyKey]),
    ]);

    const build = (period: MissionPeriod, periodKey: string): MissionPeriodView => {
      const list = missionsFor(period).map((m) => this.view(m, rows, claims, pro, now));
      return {
        period, periodKey,
        resetsAt: periodEndsAt(period, now),
        missions: list,
        completed: list.filter((m) => m.completed).length,
        total: list.length,
      };
    };

    return {
      pro,
      daily: build('daily', dailyKey),
      weekly: build('weekly', weeklyKey),
      claimedTotal: [...claims.values()].length,
    };
  }

  /**
   * Jutalom átvétele. A szerver ÚJRA ellenőrzi a teljesítést – a kliens állítása
   * semmit nem számít. PRO esetén az XP a meglévő progression naplóba kerül.
   */
  async claim(userId: string, missionKey: string, now: Date = new Date()): Promise<{ mission: MissionView; xpAwarded: number; alreadyClaimed: boolean }> {
    const mission = missionByKey(missionKey);
    if (!mission) throw new MissionError('Ismeretlen küldetés.', 404, 'UNKNOWN_MISSION');

    const periodKey = periodKeyFor(mission.period, now);
    const [pro, rows, claims] = await Promise.all([
      this.isPro(userId),
      this.rows(userId),
      this.store.missionClaims(userId, [periodKey]),
    ]);

    if (claims.has(mission.key)) {
      // Már átvette ebben a periódusban – nem jár újra semmi
      return { mission: this.view(mission, rows, claims, pro, now), xpAwarded: 0, alreadyClaimed: true };
    }

    const progress = missionProgress(mission, rows, now);
    if (!isMissionComplete(mission, progress)) {
      throw new MissionError('Ez a küldetés még nincs teljesítve.', 409, 'NOT_COMPLETED');
    }

    // FREE: a teljesítés rögzül, de XP nem jár (üzleti szabály)
    const xp = pro ? mission.xpReward : 0;
    const created = await this.store.claimMission({
      userId, missionKey: mission.key, periodKey, periodType: mission.period, progress, xpAwarded: xp,
    });
    if (!created) {
      // Párhuzamos kérés nyert – nem adunk újabb jutalmat
      const fresh = await this.store.missionClaims(userId, [periodKey]);
      return { mission: this.view(mission, rows, fresh, pro, now), xpAwarded: 0, alreadyClaimed: true };
    }

    if (xp > 0) {
      // A MEGLÉVŐ XP-rendszer: a forráskulcs egyedisége itt is kizárja a duplázást
      await this.store.claimEvent(userId, 'mission', missionSourceKey(mission.key, periodKey), xp);
    }

    const fresh = await this.store.missionClaims(userId, [periodKey]);
    return { mission: this.view(mission, rows, fresh, pro, now), xpAwarded: xp, alreadyClaimed: false };
  }

  /** Teszt-/karbantartási segéd: a katalógus mérete. */
  static get catalogSize(): number { return MISSIONS.length; }
}
